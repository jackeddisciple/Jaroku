// The generic flow, against a fixture provider and no network.
//
// A fixture rather than Google, and that is not mocking for its own sake. The properties worth
// asserting here are ours — that the authorize URL carries a challenge and not a verifier, that a
// token never reaches a row, that a declined consent is not reported as a failure, that
// `invalid_grant` is terminal and a 503 is not — and every one of them would be untestable
// against a real provider without a network, an OAuth app, and somebody willing to click a
// consent screen on every run. The provider-specific halves (Google's rotation, Slack's `ok:
// false`) get their own suites beside their own descriptors.
//
// THE ASSERTION THIS FILE EXISTS FOR is the third one: after a complete flow, the access token
// and the refresh token are in the vault and appear NOWHERE ELSE — not on the connection row,
// not in the redirect, not in anything the service returned. It is checked by serialising every
// artefact the flow produced and searching for the literal token values, which is blunt and is
// exactly the point: a future field holding a token fails this without anybody having to have
// predicted the field.
//
//   npm run test:oauth-service

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "../db/migrate.ts";
import { SqliteDb } from "../db/sqlite.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { SecretRefRepository } from "../db/repositories/secretRefs.ts";
import { OAuthRepository } from "../db/repositories/oauth.ts";
import { KmsSecretStore } from "../secrets/kmsSecretStore.ts";
import { LocalMasterKeyProvider } from "../secrets/masterKey.ts";
import { GENERIC_MASK } from "../secrets/mask.ts";
import { OAuthError, OAuthService, stripControl, type TokenTransport } from "./service.ts";
import type { OAuthClientConfig, OAuthProvider } from "./provider.ts";
import { returnUrl } from "./provider.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const MIGRATIONS = join(fileURLToPath(new URL("../..", import.meta.url)), "migrations");
const MASTER = "a-master-key-with-enough-entropy-behind-it-0123456789";

const ACCESS = "fixture-access-token-8f2a1c";
const REFRESH = "fixture-refresh-token-91bb3d";

/** A provider that exists only here, shaped like the real ones and answering like neither. */
const FIXTURE: OAuthProvider = {
  id: "fixture",
  label: "Fixture",
  authorizeUrl: "https://fixture.example/authorize",
  tokenUrl: "https://fixture.example/token",
  revokeUrl: "https://fixture.example/revoke",
  authorizeParams: { access_type: "offline" },
  connectors: [
    {
      connectorId: "gmail",
      label: "Fixture Mail",
      scopes: ["mail.read", "mail.compose"],
      accessSecretName: "GMAIL_ACCESS_TOKEN",
      refreshSecretName: "GMAIL_REFRESH_TOKEN",
      consent: ["Read your mail", "Create drafts, never send them"],
    },
  ],
  readTokenResponse(body) {
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b["access_token"] !== "string") return null;
    return {
      accessToken: b["access_token"],
      refreshToken: typeof b["refresh_token"] === "string" ? b["refresh_token"] : null,
      expiresInS: typeof b["expires_in"] === "number" ? b["expires_in"] : null,
      scopes: typeof b["scope"] === "string" ? b["scope"].split(" ").filter(Boolean) : [],
      accountId: typeof b["account_id"] === "string" ? b["account_id"] : null,
      accountLabel: typeof b["account"] === "string" ? b["account"] : null,
    };
  },
};

const CONFIG: OAuthClientConfig = {
  clientId: "fixture-client-id",
  clientSecret: "fixture-client-secret",
  redirectUri: "https://jaroku.example.com/v1/oauth/fixture/callback",
};

/** A transport whose answer the test chooses, recording what it was asked. */
function transportOf(
  answer: () => { status: number; body: unknown },
): { transport: TokenTransport; calls: URLSearchParams[] } {
  const calls: URLSearchParams[] = [];
  return {
    calls,
    transport: async (_url, body) => {
      calls.push(body);
      return answer();
    },
  };
}

const scratch: string[] = [];
const tmpDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "jaroku-oauthsvc-"));
  scratch.push(d);
  return d;
};

const dir = tmpDir();
const db = new SqliteDb(join(dir, "svc.db"));
await migrate(db.migrationTarget(), join(MIGRATIONS, "sqlite"), () => {});

const identity = new IdentityRepository(db);
const refs = new SecretRefRepository(db);
const repo = new OAuthRepository(db);
const secrets = new KmsSecretStore({
  db,
  master: new LocalMasterKeyProvider(MASTER),
  refs,
  runWorkspace: async () => null,
});

async function workspace(label: string): Promise<TenantContext> {
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `svc ${label} ${randomUUID().slice(0, 6)}`,
  });
  return systemContextFor(ws.id, newRequestId());
}

function service(transport: TokenTransport, config: OAuthClientConfig | null = CONFIG): OAuthService {
  return new OAuthService({
    repo,
    secrets,
    providers: [FIXTURE],
    config: () => config,
    transport,
    env: { JAROKU_APP_URL: "https://app.jaroku.example" },
    // The same wiring `index.ts` uses. Without it the flow's tokens are classified `custom`, which
    // is what put a connector's OAuth token in the Secrets tab's Custom group with Rotate, Revoke
    // and Reveal beside it.
    classify: async (ctx, name, detail) =>
      refs.setMetadata(ctx, name, {
        kind: "managed",
        connectorId: detail.connectorId,
        maskedHint: GENERIC_MASK,
        status: "valid",
        expiresAt: detail.expiresAt,
      }),
  });
}

/** Pull the `state` back out of an authorize URL, the way a provider's redirect would. */
const stateOf = (url: string): string => new URL(url).searchParams.get("state") ?? "";

const A = await workspace("a");

// --- the authorize URL -------------------------------------------------------------------
console.log("\nthe authorize URL says what it must and nothing else");
{
  const { transport } = transportOf(() => ({ status: 200, body: {} }));
  const svc = service(transport);
  const begun = await svc.begin(A, "gmail", { returnTo: "/connections" });
  const url = new URL(begun.url);
  const p = url.searchParams;

  check(url.origin + url.pathname === "https://fixture.example/authorize", "it points at the provider");
  check(p.get("response_type") === "code", "it asks for a code");
  check(p.get("client_id") === CONFIG.clientId, "it names our OAuth app");
  check(p.get("redirect_uri") === CONFIG.redirectUri, "...and where the answer must land");
  check(p.get("scope") === "mail.read mail.compose", "it asks for the connector's own scopes and no others");
  check(p.get("code_challenge_method") === "S256", "PKCE is S256");
  check((p.get("code_challenge") ?? "").length > 0, "...and the challenge is on the URL");
  check(p.get("access_type") === "offline", "the provider's own extra params ride along");

  // The one that matters. The URL travels through a browser, a redirect chain and somebody's
  // history; the verifier is the half that must not.
  const flow = await repo.consumeState(stateOf(begun.url));
  check(flow !== null, "the state resolves to the flow it opened");
  check(
    !begun.url.includes(flow?.codeVerifier ?? "IMPOSSIBLE"),
    "and the VERIFIER is nowhere on the URL — only its hash is",
  );
  check(flow?.workspaceId === A.workspaceId, "the flow carries the workspace that opened it");
}

// --- an unconfigured deployment ----------------------------------------------------------
console.log("\nan unconfigured deployment refuses clearly rather than redirecting to a 400");
{
  const { transport } = transportOf(() => ({ status: 200, body: {} }));
  const svc = service(transport, null);
  check(!svc.configured("gmail"), "configured() is false when the client credentials are absent");
  const err = await svc.begin(A, "gmail").then(() => null, (e: OAuthError) => e);
  check(err?.kind === "config", "beginning a flow is refused as a configuration problem");
  check(
    (err?.message ?? "").includes("JAROKU_OAUTH_FIXTURE_CLIENT_ID"),
    "...naming the variable somebody has to set",
  );
}

// --- a complete flow ---------------------------------------------------------------------
console.log("\na completed flow: the tokens go to the vault and nowhere else");
{
  const { transport, calls } = transportOf(() => ({
    status: 200,
    body: {
      access_token: ACCESS,
      refresh_token: REFRESH,
      expires_in: 3600,
      scope: "mail.read mail.compose",
      account: "ada@example.com",
      account_id: "acct-1",
    },
  }));
  const svc = service(transport);
  const begun = await svc.begin(A, "gmail", { returnTo: "/connections" });
  const done = await svc.complete({ state: stateOf(begun.url), code: "the-authorization-code" });

  check(done.connection.status === "active", "the connection lands active");
  check(done.connection.external_account_label === "ada@example.com", "...naming the account it points at");
  check(done.connection.scopes.join(" ") === "mail.read mail.compose", "...and what was granted");
  check(done.missingScopes.length === 0, "nothing was withheld");
  check(done.redirectTo === "https://app.jaroku.example/connections", "the browser goes back to our own app");

  const exchange = calls[0];
  check(exchange?.get("grant_type") === "authorization_code", "the exchange is an authorization_code grant");
  check(exchange?.get("code") === "the-authorization-code", "...carrying the code");
  check((exchange?.get("code_verifier") ?? "").length > 0, "...and the PKCE verifier, which the URL never had");
  check(exchange?.get("client_secret") === CONFIG.clientSecret, "...authenticating our app in the body");

  // THE ASSERTION THIS SUITE EXISTS FOR. Everything the flow produced, flattened, searched for
  // the literal values. Blunt on purpose: a field added later that holds a token fails this
  // without anybody having had to predict the field.
  const artefacts = JSON.stringify({
    result: done,
    row: await repo.forConnector(A, "gmail"),
    listing: await repo.list(A),
    names: await secrets.listNames(A),
    beganWith: begun,
  });
  check(!artefacts.includes(ACCESS), "the access token appears in nothing the flow returned or stored");
  check(!artefacts.includes(REFRESH), "...and neither does the refresh token");
  check(
    done.connection.access_secret_name === "GMAIL_ACCESS_TOKEN",
    "the row carries the NAME the vault holds it under",
  );
  check(
    (await secrets.getForPlatformCall(A, ["GMAIL_ACCESS_TOKEN"]))["GMAIL_ACCESS_TOKEN"] === ACCESS,
    "...and the value is genuinely in the vault, reachable only through the store",
  );
  check(
    (await secrets.getForPlatformCall(A, ["GMAIL_REFRESH_TOKEN"]))["GMAIL_REFRESH_TOKEN"] === REFRESH,
    "...both halves of it",
  );

  // WHOSE CREDENTIAL THE SECRETS TAB THINKS THIS IS. `SecretStore.set` classifies what it stores
  // `custom`, which is right for a value somebody typed and wrong for one a provider issued — and
  // the Custom group is the one that offers Rotate, Revoke, Usage and Reveal. Rotating writes a
  // token the far end never heard of; revoking leaves this connection reporting itself active
  // while handing a run nothing; revealing puts a live access token in a browser.
  const access = await refs.get(A, "GMAIL_ACCESS_TOKEN");
  const refresh = await refs.get(A, "GMAIL_REFRESH_TOKEN");
  check(access?.kind === "managed", `the access token is a MANAGED credential (${access?.kind})`);
  check(access?.connector_id === "gmail", `...naming the connector that owns it (${access?.connector_id})`);
  check(refresh?.kind === "managed", "and so is the refresh token");
  check(access?.expires_at !== null, "the access token carries the grant's expiry, so it can warn before it breaks");
  check(access?.masked_hint === GENERIC_MASK, "with a generic mask — deriving a real one would need the plaintext");
  check(!JSON.stringify({ access, refresh }).includes(ACCESS), "and the classification carries no token");
}

// --- a partial grant ---------------------------------------------------------------------
console.log("\na partial grant connects, and says what is missing");
{
  const { transport } = transportOf(() => ({
    status: 200,
    body: { access_token: "partial-token", expires_in: 3600, scope: "mail.read" },
  }));
  const svc = service(transport);
  const begun = await svc.begin(A, "gmail");
  const done = await svc.complete({ state: stateOf(begun.url), code: "c" });
  check(done.connection.status === "active", "ticking one box of two still connects");
  check(
    done.missingScopes.length === 1 && done.missingScopes[0] === "mail.compose",
    "...and the scope that was withheld is named, so the panel can say which tools will fail",
  );
  check(
    done.connection.scopes.length === 1,
    "the row records what was GRANTED rather than what was asked for",
  );
}

// --- refusals ------------------------------------------------------------------------------
console.log("\nfailures are classified, and the classification decides behaviour");
{
  const svc = service(transportOf(() => ({ status: 200, body: {} })).transport);

  const begun = await svc.begin(A, "gmail");
  const declined = await svc
    .complete({ state: stateOf(begun.url), error: "access_denied" })
    .then(() => null, (e: OAuthError) => e);
  check(declined?.kind === "denied", "somebody clicking Cancel is `denied`, which is not an error");
  check(
    !(declined?.message ?? "").toLowerCase().includes("failed"),
    "...and is not worded as a failure",
  );
  check(
    (await repo.consumeState(stateOf(begun.url))) === null,
    "...and the state was burnt anyway, so a declined flow cannot be completed later",
  );

  const gone = service(
    transportOf(() => ({ status: 400, body: { error: "invalid_grant", error_description: "expired" } })).transport,
  );
  const b2 = await gone.begin(A, "gmail");
  const dead = await gone
    .complete({ state: stateOf(b2.url), code: "c" })
    .then(() => null, (e: OAuthError) => e);
  check(dead?.kind === "reauth_required", "invalid_grant is terminal — a human has to reconnect");

  const down = service(transportOf(() => ({ status: 503, body: { error: "unavailable" } })).transport);
  const b3 = await down.begin(A, "gmail");
  const blip = await down
    .complete({ state: stateOf(b3.url), code: "c" })
    .then(() => null, (e: OAuthError) => e);
  check(blip?.kind === "transient", "a 503 is transient and does not mark anything reauth_required");

  const wrong = service(
    transportOf(() => ({ status: 401, body: { error: "invalid_client" } })).transport,
  );
  const b4 = await wrong.begin(A, "gmail");
  const ours = await wrong
    .complete({ state: stateOf(b4.url), code: "c" })
    .then(() => null, (e: OAuthError) => e);
  check(ours?.kind === "config", "invalid_client is OUR app being wrong, not the user's account");

  const empty = service(transportOf(() => ({ status: 200, body: { token_type: "bearer" } })).transport);
  const b5 = await empty.begin(A, "gmail");
  const nothing = await empty
    .complete({ state: stateOf(b5.url), code: "c" })
    .then(() => null, (e: OAuthError) => e);
  check(nothing?.kind === "error", "a 200 with no token is an error rather than a silent success");
  check(
    (await repo.forConnector(A, "gmail"))?.access_secret_name === "GMAIL_ACCESS_TOKEN",
    "and no failure above overwrote the connection that was already there",
  );

  const forged = await svc
    .complete({ state: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", code: "c" })
    .then(() => null, (e: OAuthError) => e);
  check(forged !== null, "a state nothing issued is refused");
  check(
    (forged?.message ?? "").includes("expired or has already been used"),
    "...with one message for expired, replayed and forged alike",
  );
}

// --- return_to is not an open redirect ---------------------------------------------------
console.log("\nreturn_to chooses a path, never a destination");
{
  const env = { JAROKU_APP_URL: "https://app.jaroku.example" };
  check(returnUrl("/connections", env) === "https://app.jaroku.example/connections", "a plain path is kept");
  check(returnUrl("https://evil.example", env) === "https://app.jaroku.example/", "an absolute URL is discarded");
  check(returnUrl("//evil.example", env) === "https://app.jaroku.example/", "a protocol-relative URL is discarded");
  check(returnUrl("/\\evil.example", env) === "https://app.jaroku.example/", "a backslash-led path is discarded");
  check(returnUrl(null, env) === "https://app.jaroku.example/", "and absent falls back to the app root");
}

// --- the text a provider gets to put on our screen ---------------------------------------
console.log("\na provider's own words are bounded before they are stored");
{
  // Built from character codes rather than written as literals, for the reason `stripControl`
  // itself is: an escape written into a source file is invisible in a diff and matches nothing.
  const esc = String.fromCharCode(27);
  const bounded = stripControl(`red${esc}[31m and a\nnewline`);
  check(!bounded.includes(esc), "an ANSI escape is stripped rather than stored");
  check(!bounded.includes("\n"), "...and so is a newline, which would forge a second log line");
  check(bounded.includes("red") && bounded.includes("newline"), "...while the words survive");
  check(stripControl("plain text") === "plain text", "and ordinary text is untouched");
}

await db.close();
for (const d of scratch) rmSync(d, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
