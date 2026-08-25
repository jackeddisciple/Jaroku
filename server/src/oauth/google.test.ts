// Google's half: the scopes it asks for, the parameters that make a refresh token exist, and the
// two ways its token response differs from the shape everything downstream expects.
//
// THE SCOPE ASSERTIONS ARE THE PRODUCT PROMISE UNDER TEST. `gmail.py` creates drafts and never
// sends; the connector has said so in prose since it was written, and hosted it becomes something
// Google enforces — but only if the scope list is right. So this suite asserts what is asked for
// AND what is not: no `gmail.send`, no `https://mail.google.com/`, no `gmail.modify`. A widening
// that arrives by accident, or by somebody copying a wider example from a tutorial, fails here
// rather than in a consent screen a user reads too quickly.
//
// THE OTHER HALF IS THE REFRESH-TOKEN TRAP. Google issues one on the first consent for a
// (user, client) pair and never again, so `access_type=offline` and `prompt=consent` are load-
// bearing rather than cosmetic — without them the integration works for exactly one user, exactly
// once, for exactly one hour. Both are asserted on the authorize URL, and the absence of a
// `refresh_token` on a later response is asserted to read as "keep what you have" rather than as
// "there is none".
//
//   npm run test:oauth-google

import { CALENDAR_SCOPES, GMAIL_SCOPES, GOOGLE, IDENTITY_SCOPES } from "./google.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const gmail = GOOGLE.connectors.find((c) => c.connectorId === "gmail");

console.log("\nthe scopes are the narrowest that make the connector work");
check(gmail !== undefined, "Google offers the gmail connector");
check(gmail?.scopes.includes(GMAIL_SCOPES[0] ?? "") === true, "it asks to read mail");
check(gmail?.scopes.includes(GMAIL_SCOPES[1] ?? "") === true, "...and to compose drafts");
check(
  IDENTITY_SCOPES.every((s) => gmail?.scopes.includes(s)),
  "...plus openid and email, which is what puts a mailbox name on the card",
);
check(gmail?.scopes.length === 4, "and nothing else at all", gmail?.scopes.join(" "));

// The refusals, named individually rather than as one regex, so a failure says WHICH scope
// somebody added.
for (const forbidden of [
  "https://www.googleapis.com/auth/gmail.send",
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.settings.basic",
]) {
  check(
    !(gmail?.scopes ?? []).includes(forbidden),
    `it does not ask for ${forbidden.replace("https://www.googleapis.com/auth/", "")}`,
  );
}
check(
  (gmail?.consent ?? []).some((line) => /cannot send/i.test(line)),
  "and the consent copy says out loud that it cannot send",
);

const calendar = GOOGLE.connectors.find((c) => c.connectorId === "google_calendar");

console.log("\nand Calendar's are the narrowest that make ITS connector work");
check(calendar !== undefined, "Google offers the google_calendar connector");
check(calendar?.scopes.includes(CALENDAR_SCOPES[0] ?? "") === true, "it asks to read and write events");
check(calendar?.scopes.includes(CALENDAR_SCOPES[1] ?? "") === true, "...and to read them when only that is granted");
check(calendar?.scopes.length === 4, "and nothing else at all", calendar?.scopes.join(" "));

// The wide scope is the one a tutorial hands you, and it grants deleting a calendar — which no
// tool in the template does and which is not what the consent screen would then say.
for (const forbidden of [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.settings.readonly",
  "https://www.googleapis.com/auth/calendar.acls",
]) {
  check(
    !(calendar?.scopes ?? []).includes(forbidden),
    `it does not ask for ${forbidden.replace("https://www.googleapis.com/auth/", "")}`,
  );
}
check(
  (calendar?.consent ?? []).some((line) => /cannot delete an event/i.test(line)),
  "and the consent copy says out loud that it cannot delete an event",
);

// THE SEPARATION, WHICH IS THE DECISION THIS RELEASE MADE RATHER THAN A DETAIL OF IT. One OAuth
// app, two connections, and the property that makes the split worth its extra click is that
// neither can reach the other's credential: disconnecting Gmail must not take the scheduling
// assistant with it, and it cannot, because the two connections store under different names.
console.log("\nand a Calendar connection shares no credential with a Gmail one");
check(
  calendar?.accessSecretName !== gmail?.accessSecretName,
  "the access tokens land under different names",
  `${gmail?.accessSecretName} vs ${calendar?.accessSecretName}`,
);
check(
  calendar?.refreshSecretName !== gmail?.refreshSecretName,
  "...and so do the refresh tokens, so revoking one leaves the other's grant intact",
);
check(
  !(calendar?.scopes ?? []).some((s) => s.includes("gmail")) &&
    !(gmail?.scopes ?? []).some((s) => s.includes("calendar")),
  "...and neither connection's scope set reaches into the other's API",
);
check(
  new Set(GOOGLE.connectors.map((c) => c.connectorId)).size === GOOGLE.connectors.length,
  "every connector under this provider has its own id",
);

console.log("\nthe authorize parameters are what make a refresh token exist");
check(GOOGLE.authorizeParams?.["access_type"] === "offline", "access_type=offline, or there is no refresh token");
check(
  GOOGLE.authorizeParams?.["prompt"] === "consent",
  "prompt=consent, or a reconnecting user gets an access token and no refresh token",
);
check(
  GOOGLE.authorizeParams?.["include_granted_scopes"] === "true",
  "include_granted_scopes=true, or a narrower second flow silently drops the wider grant",
);
check(GOOGLE.scopeSeparator === undefined, "scopes are space-separated, which is RFC 6749's own rule");
check(GOOGLE.revokeUrl !== undefined, "and there is somewhere to hand the grant back");

console.log("\nreading a token response");
{
  // A real-shaped id_token: three dot-separated parts, the middle one base64url JSON. Built here
  // rather than pasted, so nothing in this file is a credential-shaped string somebody has to
  // check is fake.
  const payload = Buffer.from(
    JSON.stringify({ sub: "108431", email: "ada@example.com", aud: "us" }),
    "utf8",
  ).toString("base64url");
  const idToken = `header.${payload}.signature`;

  const first = GOOGLE.readTokenResponse({
    access_token: "ya29.first",
    refresh_token: "1//refresh",
    expires_in: 3599,
    scope: GMAIL_SCOPES.join(" "),
    id_token: idToken,
  });
  check(first?.accessToken === "ya29.first", "the access token is read");
  check(first?.refreshToken === "1//refresh", "...and the refresh token when there is one");
  check(first?.expiresInS === 3599, "...and how long it lasts");
  check(first?.scopes.length === 2, "...and what was granted, space-separated");
  check(first?.accountLabel === "ada@example.com", "the id_token gives the panel a mailbox to name");
  check(first?.accountId === "108431", "...and a stable id to notice a changed account by");

  const refreshed = GOOGLE.readTokenResponse({ access_token: "ya29.second", expires_in: 3599 });
  check(refreshed?.accessToken === "ya29.second", "a refresh response reads fine");
  check(
    refreshed?.refreshToken === null,
    "...and its ABSENT refresh token is null, which the refresher reads as `keep the one you have`",
  );

  check(GOOGLE.readTokenResponse({}) === null, "a body with no access token is null rather than a half-grant");
  check(GOOGLE.readTokenResponse(null) === null, "...and so is nothing at all");
  check(
    GOOGLE.readTokenResponse({ access_token: "x", id_token: "not-a-jwt" })?.accountLabel === null,
    "an unreadable id_token costs a display name, never the connection",
  );
  check(
    GOOGLE.readTokenResponse({ access_token: "x", id_token: `header.${Buffer.from("{oops").toString("base64url")}.sig` })
      ?.accountId === null,
    "...and neither does one whose payload is not JSON",
  );
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
