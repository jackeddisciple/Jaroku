// The two ends of an invitation link: assembling one, and reading one back.
//
// WHAT THIS DEFENDS. The server hands out a token and no link — it has no mailer and no idea what
// origin this app is served from — so the URL is built here, and every mistake available in that
// assembly is silent. A token that is not percent-encoded produces a link that works for most
// secrets and fails for the ones containing a `+` or a `/`, which is the worst possible failure
// distribution: it works in testing and fails for one invitee in eight, with "that invitation is
// not valid" as the only symptom.
//
//   npm run test:invite

import { INVITE_PARAM, inviteTokenFrom, inviteUrl } from "./invite.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

console.log("\nreading a token out of a query string");
{
  check(inviteTokenFrom("?invite=ws-1.secret") === "ws-1.secret", "the parameter is read");
  check(inviteTokenFrom("invite=ws-1.secret") === "ws-1.secret", "...with or without the leading ?");
  check(
    inviteTokenFrom("?utm=x&invite=ws-1.secret&other=2") === "ws-1.secret",
    "...from among other parameters, because a link may be forwarded through anything",
  );
  check(inviteTokenFrom("?invite=%20ws-1.secret%20") === "ws-1.secret", "surrounding whitespace is dropped");
  check(inviteTokenFrom("") === null, "an empty query string carries no invitation");
  check(inviteTokenFrom("?invite=") === null, "...and neither does an empty parameter");
  check(inviteTokenFrom("?other=1") === null, "...nor an unrelated one");

  // THE SHAPE CHECK, and it is about truncation rather than about forgery. The token is
  // `<workspace_id>.<secret>`; a paste that lost its tail has no separator, and sending it would
  // come back as "that invitation is not valid" — which reads as the invitation being wrong rather
  // than the link having been cut short.
  check(inviteTokenFrom("?invite=ws-1") === null, "a token with no separator is not sent as a redemption");
}

console.log("\nbuilding the link");
{
  check(
    inviteUrl("https://jaroku.example", "ws-1.secret") === `https://jaroku.example/?${INVITE_PARAM}=ws-1.secret`,
    "the link is the origin plus the one parameter",
  );
  check(
    inviteUrl("https://jaroku.example/", "ws-1.secret").startsWith("https://jaroku.example/?"),
    "a trailing slash on the origin does not become a double one",
  );

  // The round trip is the property that actually matters, and it is the one a naive
  // string-concatenation version fails: base64url secrets contain `+`, `/` and `=`, and `+` in a
  // query string decodes to a space.
  const awkward = "ws-1.a+b/c=d&e";
  const url = inviteUrl("http://localhost:5173", awkward);
  check(!url.includes("+") && !url.includes("&e"), "the token is percent-encoded, so it cannot break out");
  check(
    inviteTokenFrom(url.slice(url.indexOf("?"))) === awkward,
    "...and reading it back gives exactly the token that was issued",
  );
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
