// The three short-lived secrets a sign-in is built out of, and the Google round trip on top of them.
//
// THE STORE HALF RUNS THREE TIMES — in memory, on SQLite, and on Postgres when one is configured —
// because "exactly one caller wins" is implemented differently in each and is the kind of property
// that holds on one and not the others. `tickets.test.ts` makes exactly this argument for the
// ws-ticket and it applies with more force here: a session ticket buys an ACCOUNT rather than a
// socket, and a double-spend is two sessions from one sign-in.
//
// THE GOOGLE HALF NEEDS NO GOOGLE. Every check `verifyGoogleIdToken` makes is against a token this
// suite signs with a key pair it generates, so the whole of the verification — signature, `iss`,
// `aud`, `exp`, `nonce`, `email_verified` — is exercised without a network, a client id, or a
// project in somebody's console. That is the only way these get run at all: a suite that needed a
// real Google application is a suite that runs when somebody remembers.
//
// AND THE REFUSALS ARE THE POINT. A verifier that accepts a good token is a verifier that has been
// half-tested; every assertion below that matters is about a token that is wrong in exactly one way.
//
//   npm run test:sign-in
//   JAROKU_PG_URL=postgres://… npm run test:sign-in    # runs the store half a third time

import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { openTestSqlite, withScratchPostgres } from "../db/testDb.ts";
import { DbSignInStore, memorySignInStore } from "../db/repositories/signIn.ts";
import { JwksClient } from "./jwks.ts";
import {
  GOOGLE_SIGN_IN_SCOPES,
  GoogleSignInError,
  completeDeepLink,
  googleConfigFrom,
  startGoogleSignIn,
  verifyGoogleIdToken,
} from "./googleSignIn.ts";
import {
  MAGIC_LINK_LIMITS,
  SIGN_IN_PROVIDERS,
  hashSecret,
  isEmailAddress,
  isSignInProvider,
  looksLikeSecret,
  mintSecret,
  normaliseEmail,
  rateKeyForEmail,
  rateKeyForIp,
  type SignInStore,
} from "./signIn.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

// --- the pure rules -----------------------------------------------------------------------------

console.log("\nwhat an email address is, for the purpose of sending one message to it");
{
  check(isEmailAddress("ada@example.com"), "an ordinary address");
  check(isEmailAddress("ada.lovelace+jaroku@sub.example.co.uk"), "...with a plus tag and a subdomain");
  check(isEmailAddress("a@b.io"), "...and a very short one");
  // THE FAILURE THAT COSTS MOST is rejecting a real address: that person cannot sign in at all.
  check(isEmailAddress("o'brien@example.com"), "an apostrophe is a real local part, not an injection");
  check(isEmailAddress("ada-l_2@example.com"), "...and so are hyphens, underscores and digits");
}
{
  check(!isEmailAddress("ada"), "a bare word is not an address");
  check(!isEmailAddress("ada@"), "...nor a local part with nothing after it");
  check(!isEmailAddress("@example.com"), "...nor a domain with nothing before it");
  check(!isEmailAddress("ada@example"), "...nor a domain with no dot, which no mail provider routes");
  check(!isEmailAddress("ada@example."), "...nor one that ends in the dot");
  check(!isEmailAddress("ada example@x.com"), "a space is not part of an address here");
  check(!isEmailAddress("ada@ex ample.com"), "...on either side of the @");
  check(!isEmailAddress('"ada"@example.com'), "a quoted local part is RFC-legal and undeliverable in practice");
  check(!isEmailAddress("ada@[127.0.0.1]"), "...and so is an IP literal");
  check(!isEmailAddress(`${"a".repeat(250)}@example.com`), "an address past 254 characters is refused on length");
  check(!isEmailAddress(null), "nothing at all is not an address");
  check(!isEmailAddress(123), "and neither is a number");
}
{
  // NOT CATASTROPHIC. This runs on an unauthenticated route against input somebody chooses, so a
  // pattern that can be made to take a second is a denial of service spelled as a validation.
  const started = Date.now();
  isEmailAddress(`${"a".repeat(60)}@${"a".repeat(60)}${"!".repeat(40)}`);
  isEmailAddress(`${"a@".repeat(80)}example.com`);
  check(Date.now() - started < 100, "a pathological input is refused in milliseconds, not seconds");
}

console.log("\nhow an address is compared, and what is deliberately not normalised");
{
  // §10: "normalize to lowercase before comparison; store as user entered but match as lowercase."
  check(normaliseEmail("Ada@Example.COM") === "ada@example.com", "case is folded for comparison");
  check(normaliseEmail("  ada@example.com \n") === "ada@example.com", "...and surrounding whitespace goes");
  // THE OMISSIONS ARE THE DECISION. Gmail ignores dots and everything after a `+`; almost nothing
  // else does. Stripping dots would MERGE two genuinely different accounts at any host that does
  // not — an account takeover dressed as a convenience.
  check(normaliseEmail("a.b@fastmail.com") !== normaliseEmail("ab@fastmail.com"), "dots are NOT stripped");
  check(normaliseEmail("ada+x@example.com") !== normaliseEmail("ada@example.com"), "a plus tag is NOT stripped");
}

console.log("\nthe shape of a secret, checked before anything becomes a query");
{
  const secret = mintSecret();
  check(looksLikeSecret(secret), "a minted secret looks like one");
  check(secret.length >= 40, `...and carries real entropy (${secret.length} chars)`);
  check(hashSecret(secret) !== secret, "the digest is not the secret");
  check(hashSecret(secret) === hashSecret(secret), "...and is stable");
  check(hashSecret(secret).length === 64, "...and is a sha256 hex digest");
}
{
  check(!looksLikeSecret(""), "an empty string is refused before it reaches a query");
  check(!looksLikeSecret("x"), "a short string is refused on shape");
  check(!looksLikeSecret("a".repeat(500)), "an absurdly long one is refused on shape");
  check(!looksLikeSecret("../../etc/passwd"), "a path is refused on shape");
  check(!looksLikeSecret("abc def ghi jkl mno pqr stu vwx yz0 123 456"), "spaces are not base64url");
  check(!looksLikeSecret(null), "nothing at all is refused");
}

console.log("\nthe provider set the schema deliberately does not constrain");
{
  check(SIGN_IN_PROVIDERS.join(",") === "google,magic_link", "two providers, and §13 puts the rest out of scope");
  check(isSignInProvider("google") && isSignInProvider("magic_link"), "both are recognised");
  check(!isSignInProvider("github"), "an unbuilt one is not");
  check(!isSignInProvider(""), "and neither is nothing");
}

// --- the store, on every driver -----------------------------------------------------------------

async function storeSuite(label: string, store: SignInStore): Promise<void> {
  console.log(`\n${label}`);

  console.log("  · a magic link, once");
  {
    const issued = await store.issueMagicLink({ email: "Ada@Example.com", ip: "10.0.0.1", userAgent: "jaroku/1" });
    check(looksLikeSecret(issued.token), "an issued token looks like one");
    check(issued.expiresAt > Date.now(), "...and is not born expired");

    const spent = await store.consumeMagicLink(issued.token, "ada@example.com");
    check(spent?.email === "ada@example.com", "spending it yields the address it was minted for, lowercased");
    const again = await store.consumeMagicLink(issued.token, "ada@example.com");
    check(again === null, "SINGLE USE — the same token cannot be spent twice");
  }
  {
    // §10: "Magic link clicked 3 times in quick succession (browser preview + user click +
    // prefetcher) → Atomic consumption ensures exactly one succeeds." The race, run for real.
    const issued = await store.issueMagicLink({ email: "race@example.com", ip: null, userAgent: null });
    const results = await Promise.all([
      store.consumeMagicLink(issued.token, "race@example.com"),
      store.consumeMagicLink(issued.token, "race@example.com"),
      store.consumeMagicLink(issued.token, "race@example.com"),
    ]);
    check(results.filter(Boolean).length === 1, "three simultaneous clicks: EXACTLY ONE wins");
  }
  {
    // §10's LAST PROPERTY, and it is the one a careless implementation loses: "a token for
    // alice@example.com cannot sign someone in as bob@example.com even if leaked".
    const issued = await store.issueMagicLink({ email: "alice@example.com", ip: null, userAgent: null });
    check((await store.consumeMagicLink(issued.token, "bob@example.com")) === null, "a token is bound to its address");
    check(
      (await store.consumeMagicLink(issued.token, "alice@example.com")) !== null,
      "...and a refused attempt did NOT spend it, so the real owner can still use it",
    );
  }
  {
    const expired = await store.issueMagicLink({ email: "old@example.com", ip: null, userAgent: null, ttlS: -1 });
    check((await store.consumeMagicLink(expired.token, "old@example.com")) === null, "an expired token is refused");
    check((await store.consumeMagicLink("never-issued-" + "a".repeat(30), "x@example.com")) === null, "an invented one is refused");
    check((await store.consumeMagicLink("", "x@example.com")) === null, "an empty one is refused before a query");
  }

  console.log("  · an oauth state, once");
  {
    const issued = await store.issueOAuthState({
      provider: "google",
      codeVerifier: "verifier.noncevalue",
      nonce: "app-nonce",
    });
    const spent = await store.consumeOAuthState(issued.state);
    check(spent?.codeVerifier === "verifier.noncevalue", "spending it yields the PKCE verifier the exchange needs");
    check(spent?.nonceHash === hashSecret("app-nonce"), "...and the app instance's nonce, as a DIGEST rather than raw");
    // §12's criterion 6: "State token is single-use — a replayed callback returns an error."
    check((await store.consumeOAuthState(issued.state)) === null, "SINGLE USE — a replayed callback gets nothing");
  }
  {
    const issued = await store.issueOAuthState({ provider: "google", codeVerifier: "v.n", nonce: "n", ttlS: -1 });
    check((await store.consumeOAuthState(issued.state)) === null, "an expired state is refused");
  }

  console.log("  · a session ticket, once, and bound to the window that asked");
  {
    const userId = randomUUID();
    const issued = await store.issueSessionTicket({ userId, provider: "google", nonceHash: hashSecret("window-1") });
    const spent = await store.consumeSessionTicket(issued.ticket);
    check(spent?.userId === userId, "spending it yields the account it was minted for");
    check(spent?.provider === "google", "...and how they signed in");
    check(spent?.nonceHash === hashSecret("window-1"), "...and which window may spend it");
    check((await store.consumeSessionTicket(issued.ticket)) === null, "SINGLE USE — a second exchange gets nothing");
  }
  {
    // §10: a magic link clicked on a DIFFERENT device is a feature. There is no app instance on
    // that device that generated a nonce, so the ticket carries none and the exchange requires none.
    const issued = await store.issueSessionTicket({ userId: randomUUID(), provider: "magic_link" });
    const spent = await store.consumeSessionTicket(issued.ticket);
    check(spent?.nonceHash === null, "a magic-link ticket is deliberately unbound, so a second device works");
  }
  {
    const userId = randomUUID();
    const issued = await store.issueSessionTicket({ userId, provider: "google" });
    const results = await Promise.all([
      store.consumeSessionTicket(issued.ticket),
      store.consumeSessionTicket(issued.ticket),
    ]);
    check(results.filter(Boolean).length === 1, "two racing exchanges: EXACTLY ONE session, never two");
  }
  {
    const expired = await store.issueSessionTicket({ userId: randomUUID(), provider: "google", ttlS: -1 });
    check((await store.consumeSessionTicket(expired.ticket)) === null, "an expired ticket is refused (§12 criterion 9)");
  }

  console.log("  · the two rate limits, which both apply");
  {
    // §3.3: max 3 requests per email per hour. §12's criterion 11: "Rate limit blocks a 4th
    // request from the same email in an hour."
    const key = rateKeyForEmail(`limits-${randomUUID()}@example.com`);
    const counts: number[] = [];
    for (let i = 0; i < 4; i++) counts.push((await store.countAttempt(key, MAGIC_LINK_LIMITS.windowS)).count);
    check(counts.join(",") === "1,2,3,4", "each attempt is counted, INCLUDING the one about to be refused");
    check(counts[3]! > MAGIC_LINK_LIMITS.perEmail, "...so the fourth exceeds the per-address limit");
  }
  {
    // ...and an 11th from the same IP. A separate counter, because a request refused on the
    // address limit writes no token row — counting rows would let one address's refusals fund
    // another's attempts from the same machine.
    const key = rateKeyForIp(`203.0.113.${Math.floor(Math.random() * 250)}`);
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await store.countAttempt(key, MAGIC_LINK_LIMITS.windowS)).count;
    check(last === 11 && last > MAGIC_LINK_LIMITS.perIp, "the eleventh from one address exceeds the per-IP limit");
  }
  {
    const key = rateKeyForEmail(`window-${randomUUID()}@example.com`);
    await store.countAttempt(key, MAGIC_LINK_LIMITS.windowS);
    await store.countAttempt(key, MAGIC_LINK_LIMITS.windowS);
    // A window that has run out RESTARTS rather than continuing, which is what makes it a window
    // rather than a lifetime total. Asserted by asking with a window of zero seconds.
    const rolled = await store.countAttempt(key, 0);
    check(rolled.count === 1, "a window that has run out starts again rather than accumulating forever");
  }

  console.log("  · addresses that must not be written to again");
  {
    const bounced = `bounced-${randomUUID()}@example.com`;
    check(!(await store.isBlocked(bounced)), "an ordinary address is not blocked");
    await store.block(bounced, "bounce", "550 5.1.1 user unknown");
    check(await store.isBlocked(bounced), "a hard bounce blocks it (§8.4)");
    check(await store.isBlocked(bounced.toUpperCase()), "...case-insensitively, like every other comparison");
    // The FIRST reason is the interesting one: an address that hard-bounced and was later marked
    // as spam by an autoresponder is still an address that does not exist.
    await store.block(bounced, "complaint");
    check(await store.isBlocked(bounced), "...and blocking it again is not an error");
  }

  console.log("  · the sweep");
  {
    // ASSERTED BY EFFECT RATHER THAN BY COUNT, and the reason is worth writing down because the
    // first version of this suite got it wrong. `DbSignInStore` sweeps OPPORTUNISTICALLY on every
    // issue — cheap, and it means a scheduled job is a backstop rather than the only cleanup — so
    // by the time an explicit sweep runs there is frequently nothing left for it to find, and it
    // honestly reports zero. A count assertion therefore passes on the in-memory store, which does
    // not sweep on issue, and fails on both real drivers, which do. What actually matters is the
    // property §6 asks for: expired and spent rows do not survive.
    const dead = await store.issueMagicLink({ email: "sweep@example.com", ip: null, userAgent: null, ttlS: -1 });
    const spent = await store.issueMagicLink({ email: "spent@example.com", ip: null, userAgent: null });
    await store.consumeMagicLink(spent.token, "spent@example.com");
    await store.sweep();
    check((await store.consumeMagicLink(dead.token, "sweep@example.com")) === null, "an expired token does not survive a sweep");
    check((await store.consumeMagicLink(spent.token, "spent@example.com")) === null, "...and neither does a spent one");
    // AND `blocked_emails` IS NOT SWEPT. A bounce is a fact about an address that stays true, and
    // expiring it would quietly resume delivery to a mailbox that does not exist — which is how a
    // sending domain's reputation goes.
    const bounced = `survives-${randomUUID()}@example.com`;
    await store.block(bounced, "bounce");
    await store.sweep();
    check(await store.isBlocked(bounced), "a blocked address survives every sweep, because a bounce stays true");
  }
}

await storeSuite("the store, in memory", memorySignInStore());

{
  // Migrated by  itself, in memory, so this leaves nothing on disk to collide
  // with the next run.
  const db = await openTestSqlite();
  try {
    await storeSuite("the store, on SQLite", new DbSignInStore(db));
  } finally {
    await db.close();
  }
}

// SKIPS OUT LOUD WITH NO Postgres, and runs the WHOLE store suite again when there is one. That
// third run is the one that matters: single-use consumption is a row lock there and a serialised
// transaction on SQLite, and "exactly one caller wins" is precisely the kind of property that
// holds on one driver and not the other.
await withScratchPostgres(async (db) => {
  await storeSuite("the store, on Postgres", new DbSignInStore(db));
});

// --- Google, without Google ---------------------------------------------------------------------

console.log("\nwhat is asked of Google");
{
  const store = memorySignInStore();
  const config = {
    clientId: "1234.apps.googleusercontent.com",
    clientSecret: "shh",
    authOrigin: "https://auth.jaroku.dev",
    redirectUri: "https://auth.jaroku.dev/oauth/google/callback",
  };
  const started = await startGoogleSignIn(store, config, { appNonce: mintSecret() });
  const url = new URL(started.authorizeUrl);

  check(url.origin + url.pathname === "https://accounts.google.com/o/oauth2/v2/auth", "the authorization endpoint is Google's own");
  // §12's criterion 8: "Scope requested is exactly `openid email profile` — no more."
  check(url.searchParams.get("scope") === "openid email profile", "the scope is EXACTLY openid email profile");
  check(GOOGLE_SIGN_IN_SCOPES.length === 3, "...and the constant behind it has three entries, not four");
  // §12's criterion 5: "OAuth flow uses PKCE with S256 — verified by inspecting the actual URL."
  check(url.searchParams.get("code_challenge_method") === "S256", "PKCE is S256, never plain");
  check((url.searchParams.get("code_challenge") ?? "").length >= 40, "...and the challenge is really there");
  check(url.searchParams.get("state") === started.state, "the state we minted is the state on the URL");
  check((url.searchParams.get("nonce") ?? "").length >= 40, "a nonce goes to Google, for the ID token to carry back");
  check(url.searchParams.get("redirect_uri") === config.redirectUri, "the redirect is our own HTTPS callback");
  check(url.searchParams.get("response_type") === "code", "the authorization-code flow, not implicit");
  // `select_account` rather than `consent`: this flow needs no refresh token, and forcing the
  // consent screen every time would make returning users re-approve an app they already approved.
  check(url.searchParams.get("prompt") === "select_account", "somebody with two Google accounts is asked which");
  check(!url.searchParams.has("access_type"), "no offline access is requested — nothing here is ever called again");
}
{
  // The authorization URL is worth nothing on its own; the value that matters never leaves us.
  const store = memorySignInStore();
  const config = { clientId: "c", clientSecret: "s", authOrigin: "https://auth.jaroku.dev", redirectUri: "https://auth.jaroku.dev/oauth/google/callback" };
  const started = await startGoogleSignIn(store, config, { appNonce: "app-nonce-value-aaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  check(!started.authorizeUrl.includes("code_verifier"), "the PKCE VERIFIER is never on the URL, only its challenge");
  const claimed = await store.consumeOAuthState(started.state);
  check(claimed !== null, "...and the verifier is on our side, spendable exactly once");
  check(!claimed!.codeVerifier.includes(started.state), "the state is not the verifier");
}

console.log("\nGoogle's configuration, and what it refuses to be half of");
{
  const full = {
    JAROKU_GOOGLE_CLIENT_ID: "id",
    JAROKU_GOOGLE_CLIENT_SECRET: "secret",
    JAROKU_AUTH_ORIGIN: "https://auth.jaroku.dev/",
  };
  const config = googleConfigFrom(full);
  check(config !== null, "a fully configured environment yields a config");
  check(config?.authOrigin === "https://auth.jaroku.dev", "...with the trailing slash removed, so URLs concatenate cleanly");
  check(config?.redirectUri === "https://auth.jaroku.dev/oauth/google/callback", "...and the callback Google is registered against");

  // ABSENT RATHER THAN BROKEN. A deployment with no Google client still signs people in by email,
  // and what must not exist is a button that produces a 500.
  check(googleConfigFrom({ ...full, JAROKU_GOOGLE_CLIENT_ID: "" }) === null, "no client id, no Google routes");
  check(googleConfigFrom({ ...full, JAROKU_GOOGLE_CLIENT_SECRET: "" }) === null, "no secret, no Google routes");
  check(googleConfigFrom({ ...full, JAROKU_AUTH_ORIGIN: "" }) === null, "no callback origin, no Google routes");
  check(googleConfigFrom({}) === null, "and an empty environment configures nothing");

  // Google refuses a plain-http redirect for anything but localhost, so a misconfiguration here
  // would fail at Google's end with an error page nobody reading our logs can see.
  check(googleConfigFrom({ ...full, JAROKU_AUTH_ORIGIN: "http://auth.jaroku.dev" }) === null, "plain http is refused here rather than by Google");
  check(googleConfigFrom({ ...full, JAROKU_AUTH_ORIGIN: "http://localhost:4317" }) !== null, "...except localhost, which is Google's own exception");
}

console.log("\nverifying what Google sends back — the half nobody tests against a real Google");
{
  // A key pair and a JWKS served from memory, so the whole verification path runs with no network.
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "test-key-1";
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  const jwks = new JwksClient({
    url: "https://www.googleapis.com/oauth2/v3/certs",
    fetchImpl: (async () =>
      new Response(JSON.stringify({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  });

  const CLIENT = "1234.apps.googleusercontent.com";
  const NONCE = "the-nonce-we-sent";
  const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
  const sign = (claims: Record<string, unknown>, header: Record<string, unknown> = {}): string => {
    const head = b64({ alg: "RS256", typ: "JWT", kid, ...header });
    const body = b64(claims);
    const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey).toString("base64url");
    return `${head}.${body}.${sig}`;
  };
  const good = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    iss: "https://accounts.google.com",
    aud: CLIENT,
    sub: "108123456789",
    email: "ada@example.com",
    email_verified: true,
    name: "Ada Lovelace",
    exp: Math.floor(Date.now() / 1000) + 600,
    nonce: NONCE,
    ...over,
  });
  const deps = { jwks, clientId: CLIENT, now: () => Date.now() };
  const verify = (token: string, nonce = NONCE): Promise<unknown> => verifyGoogleIdToken(deps, token, nonce);
  const refused = async (token: string, why: string, nonce = NONCE): Promise<void> => {
    try {
      await verify(token, nonce);
      check(false, why);
    } catch (err) {
      check(err instanceof GoogleSignInError, why);
    }
  };

  const identity = await verify(sign(good()));
  check((identity as { subject: string }).subject === "108123456789", "a good token yields Google's stable subject");
  check((identity as { email: string }).email === "ada@example.com", "...and the address");
  check((identity as { displayName: string }).displayName === "Ada Lovelace", "...and the name §12 criterion 7 asks for");

  // The name, when Google sends the halves rather than the whole.
  const split = await verify(sign(good({ name: undefined, given_name: "Grace", family_name: "Hopper" })));
  check((split as { displayName: string }).displayName === "Grace Hopper", "given_name and family_name are joined when name is absent");
  const nameless = await verify(sign(good({ name: undefined })));
  check((nameless as { displayName: string | null }).displayName === null, "...and a profile with no name at all is null, not empty string");

  // THE REFUSALS. Each token below is wrong in exactly one way.
  await refused(sign(good({ iss: "https://accounts.evil.example" })), "a token from another issuer is refused");
  // Without the `aud` check, ANY Google application's ID token verifies here — and "sign in with
  // Google" becomes "sign in with any Google app the attacker also uses".
  await refused(sign(good({ aud: "9999.apps.googleusercontent.com" })), "a token for a DIFFERENT Google app is refused");
  await refused(sign(good({ exp: Math.floor(Date.now() / 1000) - 60 })), "an expired token is refused");
  // THE CHECK PEOPLE LEAVE OUT. Without it a token captured from an earlier flow verifies on every
  // other count.
  await refused(sign(good({ nonce: "somebody-elses-nonce" })), "a token whose nonce we did not send is refused");
  await refused(sign(good({ nonce: undefined })), "...and one carrying no nonce at all");
  // Google sets this false for a Workspace address that has not completed verification, and an
  // unverified address is one somebody else may still prove.
  await refused(sign(good({ email_verified: false })), "an unverified Google address is refused");
  await refused(sign(good({ email: undefined })), "a token with no address is refused");
  await refused(sign(good({ sub: undefined })), "...and one with no subject");

  // Trusting the token's own header to say how to verify it is the `alg: none` family of bugs.
  const unsigned = `${b64({ alg: "none", typ: "JWT", kid })}.${b64(good())}.`;
  await refused(unsigned, "an unsigned token is refused rather than read");
  await refused(sign(good(), { alg: "HS256" }), "a token claiming a symmetric algorithm is refused");
  await refused(sign(good(), { kid: undefined }), "a token naming no key is refused");
  await refused(sign(good(), { kid: "some-other-key" }), "a token naming a key Google does not publish is refused");

  // And the signature itself, which is the one everything else rests on.
  const tampered = (() => {
    const parts = sign(good()).split(".");
    return `${parts[0]}.${b64(good({ email: "attacker@example.com" }))}.${parts[2]}`;
  })();
  await refused(tampered, "a token whose payload was edited after signing is refused");
  await refused("not.a.token", "nonsense is refused rather than parsed halfway");
  await refused("", "and so is nothing at all");
}

console.log("\nwhere a finished sign-in sends the browser");
{
  const link = completeDeepLink("abc/def+ghi");
  check(link.startsWith("jaroku://auth/complete?ticket="), "the deep link is the one the client parses");
  // ENCODED, because a base64url ticket is safe and this function must not assume its input is.
  // The client percent-decodes once; a raw `/` or `+` would arrive as a different string.
  check(link.includes("abc%2Fdef%2Bghi"), "...with the ticket percent-encoded rather than pasted in raw");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
