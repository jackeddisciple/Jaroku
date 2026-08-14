// The client's half of the Secrets surface.
//
// WHY THIS IS HTTP WHEN EVERYTHING ELSE IS A SOCKET. Every other panel in this app talks over the
// one WebSocket. This does not, for the same reason authentication does not: the elevation token
// rides on a request HEADER, and a browser cannot set a header on a WebSocket. Putting the gate on
// the socket would mean inventing a per-frame authorisation, which is a header with extra steps.
//
// WHERE THE ELEVATION TOKEN LIVES, AND WHY IT IS NOT WHERE THE SESSION TOKEN LIVES.
//
// `auth.ts` keeps the session JWT in `localStorage`, with the trade-off written down: it survives a
// reload, and an attacker who can run script can read it — but such an attacker could also mint a
// fresh one through the same API, so the storage choice buys little.
//
// THAT ARGUMENT DOES NOT TRANSFER, which is why this token is different. An elevation cannot be
// re-minted by script: getting one requires the passcode, which is not on this machine. So keeping
// it in memory is the difference between "an XSS reads localStorage and now holds ten minutes of
// credential access" and "an XSS must run inside the live tab while somebody is unlocked". That is
// a real difference, and it is the brief's rule: never `localStorage`, never `sessionStorage`,
// never the URL.
//
// A module-level variable, therefore. It dies with the tab, which is correct — the SERVER-side
// elevation outlives it, and a reloaded tab rejoins the session's existing elevation through
// `joinElevation()` rather than asking for the passcode again.

import { AuthFailure, storedToken, storedWorkspace } from "./auth.ts";

function viteEnv(name: string): string | undefined {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  return env?.[name];
}

const BASE =
  viteEnv("VITE_JAROKU_API") ??
  (viteEnv("VITE_JAROKU_WS") ?? "ws://localhost:4317").replace(/^ws/, "http").replace(/\/+$/, "");

/** The header the server reads an elevation from. Must match `secrets/elevation.ts`. */
export const ELEVATION_HEADER = "x-jaroku-elevation";

/**
 * The live elevation token for THIS TAB.
 *
 * In memory, never persisted, and deliberately not in any store — a zustand store is a thing
 * devtools serialise, session-replay tools capture, and error reporters attach. See the header.
 */
let elevationToken: string | null = null;

export function setElevationToken(token: string | null): void {
  elevationToken = token;
}

export function hasElevationToken(): boolean {
  return elevationToken !== null;
}

/**
 * Forget this tab's token.
 *
 * Local only: it does NOT end the elevation server-side. `lockNow()` does that. The two are
 * separate because they answer different events — a TTL expiry has already ended it on the server
 * and only needs the local copy dropped, while pressing "Lock now" has to reach across to the
 * other tabs of the session.
 */
export function forgetElevation(): void {
  elevationToken = null;
}

export interface SecretSummary {
  name: string;
  kind: "provider_key" | "managed" | "custom";
  provider: string | null;
  scope: "workspace" | "agent";
  agentId: string | null;
  configured: boolean;
  maskedHint: string | null;
  status: "valid" | "invalid" | "expiring" | "unknown";
  expiresAt: string | null;
  lastUsedAt: string | null;
  rotatedAt: string | null;
  connectorId: string | null;
  rotateEveryDays: number | null;
  createdAt: string;
}

export interface SecretsHealth {
  total: number;
  expiringSoon: number;
  invalid: number;
  rotationDue: number;
  unusedNinetyDays: number;
}

export interface ElevationState {
  elevated: boolean;
  expiresAt: string | null;
  remainingMs: number;
  passcodeSet: boolean;
  gate: "tab" | "mutations";
  /** Present only when `join=1` asked for one. */
  token?: string;
}

/**
 * One request, with whatever credentials it needs.
 *
 * The elevation header is attached WHENEVER this tab holds a token, rather than per call site.
 * Deciding per call which routes need it would mean a list to keep in step with the server's, and
 * the failure mode of forgetting one is a lock screen appearing during an operation the user is
 * entitled to perform.
 */
async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { elevate?: boolean } = {},
): Promise<T> {
  const token = storedToken();
  const workspace = storedWorkspace();
  const url = `${BASE}${path}${workspace ? `${path.includes("?") ? "&" : "?"}workspace=${encodeURIComponent(workspace)}` : ""}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(opts.elevate !== false && elevationToken ? { [ELEVATION_HEADER]: elevationToken } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    // Same shape as auth.ts's failure, so the app's existing retry-versus-stop handling applies
    // unchanged: status 0 and retryable means "could not reach the server".
    throw new AuthFailure((err as Error).message || "could not reach the server", 0, true);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (res.ok) return (text ? JSON.parse(text) : undefined) as T;

  let message = text.slice(0, 300);
  let code = "";
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; code?: string } };
    message = parsed?.error?.message ?? message;
    code = parsed?.error?.code ?? "";
  } catch {
    /* a body that is not our envelope; the status line says enough */
  }
  // AN EXPIRED ELEVATION IS NOT A SIGN-OUT. The session is fine; what ran out is the ten minutes.
  // Dropping the local token here means the very next render shows the lock screen rather than
  // retrying with a token the server has already refused.
  if (code === "elevation_required" || code === "step_up_required") {
    forgetElevation();
  }
  const failure = new AuthFailure(message || res.statusText, res.status, res.status >= 500 || res.status === 429);
  (failure as AuthFailure & { code?: string }).code = code;
  throw failure;
}

/** The error code the server sent, when it sent one. Lets a caller branch without parsing text. */
export function failureCode(err: unknown): string {
  return (err as { code?: string })?.code ?? "";
}

// --- the gate ---------------------------------------------------------------------------------

/** Counts only. Answers while locked, which is what makes the tab badge possible. */
export async function fetchHealth(): Promise<SecretsHealth> {
  return request<SecretsHealth>("GET", "/v1/secrets/health", undefined, { elevate: false });
}

/** Remaining TTL and whether a passcode exists. Drives the countdown and the setup-vs-unlock choice. */
export async function fetchElevation(): Promise<ElevationState> {
  return request<ElevationState>("GET", "/v1/secrets/elevation", undefined, { elevate: false });
}

/**
 * Rejoin an elevation this SESSION already holds, in a tab that has no token.
 *
 * What makes a reload, or a second tab, not ask for the passcode again. The token it returns
 * inherits the original expiry rather than starting a new ten minutes — that is enforced on the
 * server, and it is the reason this is a separate call rather than a flag on `unlock`.
 */
export async function joinElevation(): Promise<ElevationState> {
  const state = await request<ElevationState>("GET", "/v1/secrets/elevation?join=1", undefined, { elevate: false });
  if (state.token) setElevationToken(state.token);
  return state;
}

export async function unlock(passcode: string): Promise<{ expiresAt: string }> {
  const granted = await request<{ token: string; expiresAt: string }>(
    "POST",
    "/v1/secrets/elevation",
    { method: "passcode", credential: passcode },
    { elevate: false },
  );
  setElevationToken(granted.token);
  return { expiresAt: granted.expiresAt };
}

/** End the elevation for every tab of this session, then drop the local copy. */
export async function lockNow(): Promise<void> {
  try {
    await request<{ elevated: boolean }>("DELETE", "/v1/secrets/elevation");
  } finally {
    // In a `finally` on purpose: a lock that failed to reach the server must still lock THIS tab.
    // Leaving a usable token behind because the network blipped is the wrong way to fail.
    forgetElevation();
  }
}

export async function setPasscode(passcode: string): Promise<void> {
  await request<{ passcodeSet: boolean }>("POST", "/v1/secrets/passcode", { passcode });
}

export async function changePasscode(current: string, passcode: string): Promise<void> {
  await request<{ passcodeSet: boolean }>("PATCH", "/v1/secrets/passcode", { current, passcode });
  // The server ends every elevation when the passcode changes, so this tab's token is already
  // dead. Dropping it here means the UI shows the lock screen instead of one refused request.
  forgetElevation();
}

export async function resetPasscode(passcode: string): Promise<void> {
  await request<{ passcodeSet: boolean }>("POST", "/v1/secrets/passcode/reset", { passcode });
  forgetElevation();
}

// --- the credentials --------------------------------------------------------------------------

export async function fetchSecrets(): Promise<SecretSummary[]> {
  return (await request<{ secrets: SecretSummary[] }>("GET", "/v1/secrets")).secrets;
}

export interface CreateSecretInput {
  name: string;
  value: string;
  kind?: "provider_key" | "custom";
  provider?: string | null;
  expiresAt?: string | null;
  rotateEveryDays?: number | null;
}

export async function createSecret(input: CreateSecretInput): Promise<SecretSummary | null> {
  return (await request<{ secret: SecretSummary | null }>("POST", "/v1/secrets", input)).secret;
}

export async function rotateSecret(name: string, value: string): Promise<SecretSummary | null> {
  return (
    await request<{ secret: SecretSummary | null }>("POST", `/v1/secrets/${encodeURIComponent(name)}/rotate`, { value })
  ).secret;
}

export async function testSecret(name: string): Promise<{ ok: boolean; message: string | null }> {
  return request("POST", `/v1/secrets/${encodeURIComponent(name)}/test`);
}

/**
 * Read a credential back. ADR-035.
 *
 * The value is returned to the caller and deliberately NOT stored anywhere — not in the store, not
 * in a ref that outlives the dialog. The component that shows it holds it in local state for as
 * long as it is on screen.
 */
export async function revealSecret(name: string): Promise<string> {
  return (await request<{ value: string }>("POST", `/v1/secrets/${encodeURIComponent(name)}/reveal`)).value;
}

/** `confirm` is required when the credential is referenced — the server decides, not the client. */
export async function revokeSecret(name: string, confirm?: string): Promise<void> {
  await request("DELETE", `/v1/secrets/${encodeURIComponent(name)}`, confirm ? { confirm } : {});
}

export interface UsageSite {
  name: string;
  agent_id: string | null;
  /** `static_scan` is a guess about code that may never run; `runtime_read` is a fact about code
   *  that did. The UI labels them separately rather than merging them into one count. */
  source: "static_scan" | "runtime_read";
  location: string | null;
  hits: number;
  first_seen_at: string;
  detected_at: string;
}

/** What breaks if I revoke this. Refreshes the static half server-side before answering. */
export async function fetchUsage(name: string): Promise<UsageSite[]> {
  return (await request<{ usage: UsageSite[] }>("GET", `/v1/secrets/${encodeURIComponent(name)}/usage`)).usage;
}

export interface ImportResult {
  format: string;
  imported: string[];
  rejected: { name: string; reason: string }[];
}

export async function importSecrets(text: string): Promise<ImportResult> {
  return request<ImportResult>("POST", "/v1/secrets/import", { text });
}
