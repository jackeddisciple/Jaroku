// The App itself: who Jaroku is to GitHub, and the two tokens that follow from that.
//
// WHY AN APP RATHER THAN A TOKEN, in one fact: `POST /check-runs` answers 403 "You must
// authenticate via a GitHub App." to EVERY personal access token — classic, fine-grained, scope
// ticked or not. §B.1's whole design is a check run carrying a rendered pass-rate table, and under
// PAT auth it was unreachable; the product shipped a 140-character commit status in its place. An
// App is not a nicer onboarding for the same capability. It is the only way to have the capability.
//
// Everything else the move buys is real but secondary: installation tokens live one hour and are
// minted server-side, so nothing long-lived is stored and nothing expires under somebody; the user
// picks repositories in GitHub's own UI and can add more later without re-issuing anything; the
// webhook arrives configured; commits are attributed to a bot rather than to a person.
//
// TWO TOKENS, AND THE SPLIT IS NOT A CHOICE. An installation token can do everything to a
// REPOSITORY and nothing about a USER: `GET /user`, `GET /user/repos` and `POST /user/repos` all
// refuse it, and the third of those is §2.2's "Create new repo" — the flow the empty state walks a
// new user down. So the App also requests user authorization at install time, and exactly three
// calls travel on the user token. `apiFor` is where that rule lives; nothing below it knows.
//
// THE MANIFEST FLOW IS WHY THERE IS STILL NOTHING TO PASTE. Registering an App by hand ends with
// downloading a .pem and putting it somewhere — which is the copy-paste this migration exists to
// delete, moved one level up. `POST github.com/settings/apps/new` with a manifest instead shows the
// user one confirmation screen, and GitHub hands the private key, the client secret and the webhook
// secret straight back to a callback on this server. A person clicks Create. Nothing is copied.
//
// NO CREDENTIAL IS LOGGED, RETURNED OR HELD. The private key is read to sign a JWT and is not kept
// beyond the call; a minted installation token is cached against ITS OWN expiry and never longer;
// and every function here that could return a secret returns a token that GitHub will invalidate on
// a clock rather than one that lives until somebody notices.

import { createSign, randomUUID, timingSafeEqual, createHmac } from "node:crypto";

import { setEnvVar } from "./envWriter.ts";

/**
 * Where the App's own credentials live: `runtime/.env`, beside the Anthropic key and the Stripe
 * secret.
 *
 * PLATFORM SECRETS, NOT WORKSPACE ONES, which is why this is not `SecretStore`. That store is
 * keyed by workspace and exists so one tenant's credential cannot be read while acting for
 * another; the App's private key belongs to the DEPLOYMENT and is the same for every workspace on
 * it. Putting it in a per-workspace store would mean writing the same secret once per tenant and
 * answering "whose is it" with a lie.
 */
export const APP_ENV = {
  appId: "JAROKU_GITHUB_APP_ID",
  slug: "JAROKU_GITHUB_APP_SLUG",
  clientId: "JAROKU_GITHUB_APP_CLIENT_ID",
  clientSecret: "JAROKU_GITHUB_APP_CLIENT_SECRET",
  /** Base64, because `setEnvVar` refuses a newline and a PEM is nothing but newlines. */
  privateKey: "JAROKU_GITHUB_APP_PRIVATE_KEY_B64",
  webhookSecret: "JAROKU_GITHUB_WEBHOOK_SECRET",
} as const;

export interface GithubAppConfig {
  appId: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  /** PEM, decoded. Held only for the life of a signing call — see `appJwt`. */
  privateKey: string;
  webhookSecret: string;
}

/**
 * The App this deployment is, or null when nobody has registered one.
 *
 * NULL IS A STATE AND NOT AN ERROR: a fresh checkout has no App, and the connect screen's job in
 * that case is to offer the one-click registration rather than to report a misconfiguration.
 */
export function githubAppConfig(env: NodeJS.ProcessEnv = process.env): GithubAppConfig | null {
  const appId = env[APP_ENV.appId];
  const b64 = env[APP_ENV.privateKey];
  const clientId = env[APP_ENV.clientId];
  const clientSecret = env[APP_ENV.clientSecret];
  if (!appId || !b64 || !clientId || !clientSecret) return null;
  return {
    appId,
    slug: env[APP_ENV.slug] ?? "jaroku",
    clientId,
    clientSecret,
    privateKey: Buffer.from(b64, "base64").toString("utf8"),
    webhookSecret: env[APP_ENV.webhookSecret] ?? "",
  };
}

/**
 * The manifest GitHub renders a confirmation screen from.
 *
 * THE PERMISSION LIST IS THE SECURITY BOUNDARY AND IS WRITTEN OUT RATHER THAN COMPUTED, so that
 * reading this function is the same as reading what the App may do. Each line names the calls it
 * exists for, because a permission nobody can justify is one nobody will remove:
 *
 *   contents      the whole push — blobs, trees, commits, refs — and the pull's tree read.
 *   workflows     `.github/workflows/jaroku-build.yml`. Writing a file under that path is refused
 *                 by `contents` alone, which is a rule GitHub enforces separately and one that
 *                 would otherwise surface as a 403 on §B.6.2 and nowhere else.
 *   administration  creating a repository, and reading collaborator permission for §B.1.3's
 *                 boundary — the check that decides whose provider balance a stranger's pull
 *                 request may spend.
 *   pull_requests opening §3.9's PR, reading §B.5's review comments, posting the threaded reply.
 *   checks        WRITE, not read. §B.1 POSTS a check run; read-only would let the panel see
 *                 checks and never publish one, which is the exact failure this migration is
 *                 being done to fix, arrived at from the other side.
 *   statuses      `checksFor` reads the combined status as the second half of §3.9's verdict, and
 *                 the commit-status fallback writes one on a deployment that is not an App.
 *   metadata      mandatory on every App, and implied by all of the above.
 */
export function buildManifest(input: { baseUrl: string; name?: string }): Record<string, unknown> {
  const base = input.baseUrl.replace(/\/+$/, "");
  return {
    name: input.name ?? "Jaroku",
    url: "https://github.com/jackeddisciple/Jaroku",
    hook_attributes: {
      // §B.1.2's trigger and the push watermark, configured by the installation rather than per
      // repository by hand — which is the other thing a PAT could never do.
      url: `${base}/v1/github/webhook`,
      active: true,
    },
    redirect_url: `${base}/v1/github/app/registered`,
    // Where GitHub sends the user after they choose repositories. Carries `installation_id` and,
    // because of `request_oauth_on_install`, the `code` for the user token in the same round trip.
    setup_url: `${base}/v1/github/install/callback`,
    callback_urls: [`${base}/v1/github/install/callback`],
    setup_on_update: true,
    public: false,
    default_permissions: {
      contents: "write",
      workflows: "write",
      administration: "write",
      pull_requests: "write",
      checks: "write",
      statuses: "write",
      metadata: "read",
    },
    default_events: ["push", "pull_request"],
    // The half that makes "Create new repo" possible at all — see the header.
    request_oauth_on_install: true,
  };
}

/** What `POST /app-manifests/{code}/conversions` hands back. Every field is a credential but two. */
export interface ManifestConversion {
  id: number;
  slug: string;
  client_id: string;
  client_secret: string;
  pem: string;
  webhook_secret: string | null;
}

/**
 * Turn the one-time code GitHub redirects with into the App's own credentials, and write them.
 *
 * THE ONLY PLACE THE PRIVATE KEY IS EVER SEEN, and it is seen for the length of one function. It
 * goes from the response body into `runtime/.env` base64-encoded and is not logged, not returned
 * and not put in an error. The caller learns the app's slug, which is public — it is in the URL of
 * the App's own page on github.com.
 */
export async function convertManifest(
  code: string,
  opts: { apiBase?: string; envPath: string },
): Promise<{ ok: true; slug: string } | { ok: false; message: string }> {
  const base = opts.apiBase ?? "https://api.github.com";
  const response = await fetch(`${base}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jaroku",
    },
  });
  if (!response.ok) {
    // GitHub's own words are not quoted here: this response is to a request that carried a
    // one-time registration code, and the status is the whole of what a caller can act on.
    return { ok: false, message: `GitHub refused the app registration (${response.status}).` };
  }
  const data = (await response.json()) as ManifestConversion;
  if (!data.id || !data.pem || !data.client_id) {
    return { ok: false, message: "GitHub's registration response was missing the app's credentials." };
  }

  const written: string[] = [];
  const put = (key: string, value: string): boolean => {
    const result = setEnvVar(opts.envPath, key, value);
    if (result.ok) written.push(key);
    return result.ok;
  };
  const all =
    put(APP_ENV.appId, String(data.id)) &&
    put(APP_ENV.slug, data.slug) &&
    put(APP_ENV.clientId, data.client_id) &&
    put(APP_ENV.clientSecret, data.client_secret) &&
    put(APP_ENV.privateKey, Buffer.from(data.pem, "utf8").toString("base64")) &&
    put(APP_ENV.webhookSecret, data.webhook_secret ?? randomUUID());
  if (!all) {
    return { ok: false, message: "the app was registered but its credentials could not be stored." };
  }

  // INTO THE LIVE PROCESS AS WELL AS THE FILE, so the very next request can use the App. Writing
  // only the file would mean registration appears to succeed and then does nothing until somebody
  // restarts the server — a gap measured in whichever screen the user opens next.
  process.env[APP_ENV.appId] = String(data.id);
  process.env[APP_ENV.slug] = data.slug;
  process.env[APP_ENV.clientId] = data.client_id;
  process.env[APP_ENV.clientSecret] = data.client_secret;
  process.env[APP_ENV.privateKey] = Buffer.from(data.pem, "utf8").toString("base64");
  process.env[APP_ENV.webhookSecret] = data.webhook_secret ?? process.env[APP_ENV.webhookSecret] ?? "";

  return { ok: true, slug: data.slug };
}

/** base64url, which is what a JWT is made of and what `Buffer` does not do by name. */
const b64url = (input: Buffer | string): string =>
  (typeof input === "string" ? Buffer.from(input, "utf8") : input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/**
 * The App's own JWT: how Jaroku proves it is Jaroku, before any installation is involved.
 *
 * TEN MINUTES IS GITHUB'S CEILING AND NINE IS WHAT IS ASKED FOR, because `iat` is compared against
 * GitHub's clock rather than ours and a machine sixty seconds fast would mint a token GitHub reads
 * as issued in the future. Backdating `iat` by a minute is the documented remedy and costs nothing.
 *
 * SIGNED HERE RATHER THAN CACHED. A JWT is cheap — one RSA signature — and caching it would mean
 * holding the private key's output in memory to save a millisecond.
 */
export function appJwt(appId: string, privateKey: string, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 9 * 60, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${b64url(signer.sign(privateKey))}`;
}

export interface MintedToken {
  token: string;
  /** ISO. GitHub's own expiry, never one this code chose. */
  expiresAt: string;
}

/**
 * An installation access token — the credential every repository call actually travels on.
 *
 * ONE HOUR, DECIDED BY GITHUB. Nothing here extends it, and the cache below expires against this
 * value rather than against a duration written in our source, so a change on GitHub's side is
 * followed rather than guessed at.
 */
export async function mintInstallationToken(
  config: GithubAppConfig,
  installationId: string,
  opts: { apiBase?: string } = {},
): Promise<MintedToken> {
  const base = opts.apiBase ?? "https://api.github.com";
  const response = await fetch(`${base}/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appJwt(config.appId, config.privateKey)}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jaroku",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub refused an installation token (${response.status}).`);
  }
  const data = (await response.json()) as { token: string; expires_at: string };
  return { token: data.token, expiresAt: data.expires_at };
}

/**
 * Whose account an installation is on, asked of GitHub rather than read from a redirect.
 *
 * `installation_id` ARRIVES IN A QUERY STRING, which is to say from a browser, which is to say
 * from somewhere a person can edit. The account it belongs to therefore has to come from GitHub —
 * and asking also proves the App can address this installation at all before a row claims it can.
 */
export async function readInstallation(
  config: GithubAppConfig,
  installationId: string,
  opts: { apiBase?: string } = {},
): Promise<{ login: string; type: "user" | "org" }> {
  const base = opts.apiBase ?? "https://api.github.com";
  const response = await fetch(`${base}/app/installations/${encodeURIComponent(installationId)}`, {
    headers: {
      Authorization: `Bearer ${appJwt(config.appId, config.privateKey)}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jaroku",
    },
  });
  if (!response.ok) throw new Error(`GitHub would not describe that installation (${response.status}).`);
  const data = (await response.json()) as { account?: { login?: string; type?: string } };
  const login = data.account?.login ?? "";
  if (!login) throw new Error("GitHub did not say which account that installation belongs to.");
  return { login, type: data.account?.type === "Organization" ? "org" : "user" };
}

/**
 * Minted tokens, held no longer than GitHub says they are good for.
 *
 * THE RE-FETCH-PER-CALL DISCIPLINE IS KEPT, and this is not a contradiction of it. What
 * `githubIdentity` refuses to cache is AUTHORITY — whether this workspace still has a grant —
 * because a cached "yes" keeps working after somebody revokes it in the Secrets tab. What is
 * cached here is a token that GitHub will itself reject sixty minutes from now whatever we
 * believe. The grant is still read from the database on every call; only the minting is skipped.
 *
 * SIXTY SECONDS OF SKEW. A token that expires between the check and the request is a 401 on a
 * push, which is the one place in this product a spurious auth failure is most expensive.
 */
export class InstallationTokens {
  private readonly cache = new Map<string, MintedToken>();

  constructor(private readonly skewMs = 60_000) {}

  /** The live token for an installation, minting one only when what we hold will not survive. */
  async get(
    config: GithubAppConfig,
    installationId: string,
    mint: (config: GithubAppConfig, id: string) => Promise<MintedToken> = mintInstallationToken,
  ): Promise<string> {
    const held = this.cache.get(installationId);
    if (held && Date.parse(held.expiresAt) - this.skewMs > Date.now()) return held.token;
    const minted = await mint(config, installationId);
    this.cache.set(installationId, minted);
    return minted.token;
  }

  /** Forget one, so the next call mints. Called when GitHub says a token is no longer good. */
  forget(installationId: string): void {
    this.cache.delete(installationId);
  }
}

export interface UserToken {
  token: string;
  /** ISO, or null for an App whose user tokens do not expire. Both are GitHub's answer. */
  expiresAt: string | null;
  refreshToken: string | null;
  refreshExpiresAt: string | null;
}

/**
 * Exchange the `code` the install redirect carries for a user-to-server token.
 *
 * THE THREE CALLS THIS EXISTS FOR are `GET /user`, `GET /user/repos` and `POST /user/repos` — the
 * account line, the repository picker and "Create new repo". Every one of them is about a PERSON
 * rather than a repository, and an installation token is refused by all three.
 */
export async function exchangeUserCode(
  config: GithubAppConfig,
  code: string,
  opts: { authBase?: string; redirectUri?: string } = {},
): Promise<UserToken> {
  return await postToken(config, opts.authBase, {
    grant_type: "authorization_code",
    code,
    ...(opts.redirectUri ? { redirect_uri: opts.redirectUri } : {}),
  });
}

/**
 * Trade a refresh token for a live one.
 *
 * PRESENT BECAUSE AN APP CAN BE CONFIGURED EITHER WAY. With user token expiry turned on, a user
 * token lasts eight hours and this is what keeps "Create new repo" working on hour nine; with it
 * off, `expiresAt` is null and this is never reached. Written now rather than discovered later,
 * because the setting is a checkbox somebody can tick after launch.
 */
export async function refreshUserToken(
  config: GithubAppConfig,
  refreshToken: string,
  opts: { authBase?: string } = {},
): Promise<UserToken> {
  return await postToken(config, opts.authBase, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

async function postToken(
  config: GithubAppConfig,
  authBase: string | undefined,
  body: Record<string, string>,
): Promise<UserToken> {
  const base = authBase ?? "https://github.com";
  const response = await fetch(`${base}/login/oauth/access_token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "jaroku" },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, ...body }),
  });
  if (!response.ok) throw new Error(`GitHub refused the token exchange (${response.status}).`);
  const data = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
    error?: string;
    error_description?: string;
  };
  // A 200 WITH AN `error` FIELD IS HOW THIS ENDPOINT FAILS, which is unlike every other GitHub
  // endpoint and is the reason this is checked rather than trusted from the status alone.
  if (!data.access_token) {
    throw new Error(`GitHub refused the token exchange: ${data.error ?? "no token was returned"}.`);
  }
  const at = (seconds: number | undefined): string | null =>
    seconds === undefined ? null : new Date(Date.now() + seconds * 1000).toISOString();
  return {
    token: data.access_token,
    expiresAt: at(data.expires_in),
    refreshToken: data.refresh_token ?? null,
    refreshExpiresAt: at(data.refresh_token_expires_in),
  };
}

/**
 * A one-time value tying a registration or install round trip to the browser that started it.
 *
 * THE SAME JOB `oauth/state.ts` DOES FOR CONNECTORS, and deliberately not the same code: that
 * module's states are workspace-scoped rows with a connector id on them, and these are about a
 * deployment registering itself before any installation exists. Bounded and in memory, because a
 * state that outlives a restart is a state nobody is still waiting on.
 */
export class RoundTripStates {
  private readonly issued = new Map<string, { workspaceId: string; at: number }>();

  constructor(private readonly ttlMs = 10 * 60_000, private readonly limit = 200) {}

  issue(workspaceId: string): string {
    this.sweep();
    const state = randomUUID();
    this.issued.set(state, { workspaceId, at: Date.now() });
    return state;
  }

  /** The workspace that started this round trip, or null. Single-use: claiming consumes it. */
  claim(state: string | undefined | null): string | null {
    if (!state) return null;
    this.sweep();
    const held = this.issued.get(state);
    if (!held) return null;
    this.issued.delete(state);
    return held.workspaceId;
  }

  private sweep(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [state, held] of this.issued) if (held.at < cutoff) this.issued.delete(state);
    while (this.issued.size > this.limit) {
      const oldest = this.issued.keys().next().value;
      if (oldest === undefined) break;
      this.issued.delete(oldest);
    }
  }
}

/**
 * Whether a webhook secret this deployment generated matches the one on a delivery.
 *
 * Re-exported shape rather than logic: `githubWebhook.verifyGithubSignature` is the verifier, and
 * this exists only so the registration path can prove the secret it stored is the secret GitHub
 * signs with, without importing the route.
 */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

/** Constant-time compare for the above. Kept beside it so neither is used without the other. */
export function sameSignature(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
