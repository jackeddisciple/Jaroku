// The secret boundary. Everything that is a credential goes through this interface, and the
// shape of the interface is the security property — not the implementations behind it.
//
// THERE IS NO `get(ctx, name)`. That absence is the whole design. A request handler cannot ask
// for a plaintext value, because there is no method that would answer, so no code path exists
// down which a credential could reach a WebSocket frame, a log line, an error message or a
// JSON response. Values move in exactly one direction: in through `set`, and out only into a
// run's environment through `getForRun`. Every other question a caller has — is it configured,
// what is it called, when was it last used — is answered by `listNames`, which returns names
// and never a value.
//
// That is not a new rule. It is the rule `envWriter.ts` has followed since the day it was
// written ("callers learn that a key IS SET; they do not learn what is in it"), stated as a
// type instead of as a discipline. The difference matters hosted: locally the value was in a
// file the user owned, and the worst case of a leak was showing somebody their own key.
//
// `getForRun` TAKES A RUN ID, NOT A CONTEXT, and that is deliberate too. In Session 4 the
// caller is a worker assembling a sandbox spec, and the only identity it holds is the run's —
// a run outlives the request that started it, and by the time its environment is being built
// the asking context is long gone. So the run is the unit of authorisation for a secret, and
// which workspace it belongs to is resolved from the run rather than asserted by the caller.
//
// TWO IMPLEMENTATIONS, ALWAYS. `DotEnvSecretStore` wraps `envWriter.ts` unchanged and keeps
// `runtime/.env` working exactly as it does today, so `npm run dev` needs no KMS, no cloud
// account and no key material. `KmsSecretStore` is production. Selected by config.

import type { TenantContext } from "../db/tenant.ts";

export type SecretStoreKind = "dotenv" | "kms";

/** What a caller may know about a secret. Never a value, on any implementation, ever. */
export interface SecretRef {
  /** The environment variable name a run will see it under. */
  name: string;
  /**
   * Always true for anything this returns.
   *
   * Present as a field rather than implied by presence in the list, because that is what the
   * client renders and what the README promises it learns: `configured: true` and nothing
   * more. A shape that says so is harder to widen by accident than a bare array of strings.
   */
  configured: true;
  /** `anthropic`, `openai`, `mcp`, `railway`, `connector` — what it is for, when known. */
  provider: string | null;
  /** ISO-8601. When a run last received this value, or null if it never has. */
  lastUsedAt: string | null;
}

/** What `set` reports back. A warning is not a failure; a refusal is. */
export interface SetResult {
  ok: boolean;
  /**
   * Something the user needs to know, or null.
   *
   * The local store's is load-bearing: a variable already exported in the developer's shell
   * beats the file on the next restart, so a token written here works now and silently reverts
   * later. That is a genuinely baffling bug to hit, and saying so is the fix.
   */
  warning: string | null;
}

export interface SecretStore {
  readonly kind: SecretStoreKind;

  /**
   * Store `value` under `name` for this workspace.
   *
   * The value is used here and nowhere else: not logged, not returned, not held in any
   * structure that outlives the call. A value that cannot be stored FAITHFULLY is refused
   * rather than mangled — see envWriter.ts for why a silently altered credential is worse than
   * a rejected one.
   */
  set(ctx: TenantContext, name: string, value: string): Promise<SetResult>;

  /**
   * The values a run's environment needs, by name.
   *
   * The only method that returns plaintext, and its caller is the thing that builds a run's
   * environment. Names not configured are simply absent from the result — a missing credential
   * is the agent's problem to report at the point of use, and inventing an empty string for one
   * turns a clear "not configured" into an opaque 401 from a third party.
   */
  getForRun(runId: string, names: string[]): Promise<Record<string, string>>;

  /** What this workspace has configured. Names only. */
  listNames(ctx: TenantContext): Promise<SecretRef[]>;

  /** Forget one. Idempotent: deleting what is not there is not an error. */
  delete(ctx: TenantContext, name: string): Promise<void>;
}

/**
 * The gate a secret NAME passes through.
 *
 * A name becomes an environment variable in a subprocess and, in the hosted store, part of a
 * primary key. `MCP_TOKEN=x; rm -rf /` is not a variable name, and neither is one with an equals
 * sign or a newline in it — the `.env` format has no escape for either, which is the same
 * reason envWriter refuses a value containing one.
 */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;

export function isSecretName(name: unknown): name is string {
  return typeof name === "string" && SECRET_NAME.test(name);
}

export function assertSecretName(name: unknown): string {
  if (!isSecretName(name)) {
    throw new Error(
      `not a usable credential name: ${JSON.stringify(name)} — it must be UPPER_SNAKE_CASE, ` +
        `start with a letter, and be at most 128 characters`,
    );
  }
  return name;
}

/**
 * Why a value cannot be stored, or null when it can.
 *
 * ONE RULE FOR BOTH IMPLEMENTATIONS, which is why it lives here rather than in either of them.
 * AES-GCM would happily seal a value containing a newline and the `.env` format cannot hold
 * one — so a hosted store that accepted it would produce a credential that works in production
 * and fails locally, and an exported project (which the README promises is portable, and which
 * writes a `.env`) would silently lose it.
 *
 * The local store applies a SECOND, narrower rule on top of this: `envWriter.renderLine`
 * refuses anything that would not read back byte-identically through the real loader. That one
 * is a property of the file format and cannot be shared.
 */
export function unstorableReason(value: unknown): string | null {
  if (typeof value !== "string") return "a credential must be a string";
  if (/[\r\n]/.test(value)) {
    // Refusing rather than stripping: a value with a line break in it is not the value the user
    // meant to paste, and silently truncating a credential produces a confusing 401 instead of
    // a clear error. Same judgement, same words, as envWriter.
    return "a credential cannot contain a line break";
  }
  if (value.includes("\u0000")) {
    // Postgres cannot store one in a text column at all — the driver fails the whole statement.
    // Refusing here makes the two drivers agree instead of one of them losing the write.
    return "a credential cannot contain a NUL byte";
  }
  return null;
}

/**
 * Which workspace a run belongs to.
 *
 * Injected into a store rather than looked up by it, so the secrets layer does not grow a
 * dependency on the trace store — and so the test for a store can hand it a map. Returning null
 * means "no such run", which every implementation must treat as "no secrets", never as "all of
 * them".
 */
export type RunWorkspaceResolver = (runId: string) => Promise<string | null>;
