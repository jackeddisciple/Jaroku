// Slack's half, and the three ways it is not an ordinary OAuth 2.0 provider.
//
// Every case below is a specific bug that a correct-by-the-RFC implementation would have. The
// 200-with-`ok:false` one is the dangerous one: without `errorInBody`, a failed installation
// produces a body with no token, and the failure surfaces later as a Slack call that 401s from
// inside a run — which is to say, as the agent's problem rather than as ours.
//
// The `token_type` case is the one that is easy to skip and worst to get wrong. A user-token
// installation returns a string in the same field, and storing it as `SLACK_BOT_TOKEN` gives an
// agent the installing human's own reach across every channel they can see, silently, while
// working perfectly for reads.
//
//   npm run test:oauth-slack

import { SLACK, SLACK_BOT_SCOPES } from "./slack.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const slack = SLACK.connectors.find((c) => c.connectorId === "slack");

console.log("\nscopes, and how they travel");
check(slack !== undefined, "Slack offers the slack connector");
check(
  SLACK_BOT_SCOPES.every((s) => slack?.scopes.includes(s)) && slack?.scopes.length === 3,
  "it asks for exactly channels:read, channels:history and chat:write",
  slack?.scopes.join(","),
);
check(
  !(slack?.scopes ?? []).some((s) => /^(admin|users:read|files|groups|im|mpim)/.test(s)),
  "and nothing that would reach private conversations, files or administration",
);
check(SLACK.scopeSeparator === ",", "scopes are comma-separated, because Slack is not RFC 6749 here");
check(
  (slack?.consent ?? []).some((line) => /cannot be undone/i.test(line)),
  "and the consent copy says posting is irreversible, in the same words the prompt uses",
);
check(slack?.refreshSecretName === undefined, "there is no refresh token name, because there is no refresh token");

console.log("\nan error arrives with a 200 status");
check(SLACK.errorInBody !== undefined, "the provider declares an in-body error reader at all");
check(SLACK.errorInBody?.({ ok: true, access_token: "xoxb-1" }) === null, "ok:true is not an error");
check(
  SLACK.errorInBody?.({ ok: false, error: "invalid_code" }) === "invalid_code",
  "ok:false is an error even though the status was 200",
);
check(
  SLACK.errorInBody?.({ ok: false }) === "unknown_error",
  "...and one with no name still refuses rather than passing",
);
check(SLACK.errorInBody?.("not an object") !== null, "a body that is not an object is refused too");
check(SLACK.errorInBody?.(null) !== null, "...and so is nothing at all");

console.log("\nreading the v2 response");
{
  const grant = SLACK.readTokenResponse({
    ok: true,
    access_token: "xoxb-2345-abcdef",
    token_type: "bot",
    scope: "channels:read,channels:history,chat:write",
    bot_user_id: "U123",
    team: { id: "T0001", name: "Acme" },
  });
  check(grant?.accessToken === "xoxb-2345-abcdef", "the bot token is read from the top level");
  check(grant?.scopes.length === 3, "...and the comma-separated scopes are split on commas");
  check(grant?.accountLabel === "Acme", "the team name gives the panel a Slack to name");
  check(grant?.accountId === "T0001", "...and the team id something stable to notice a change by");
  check(
    grant?.expiresInS === null,
    "expiry is null rather than zero — a bot token does not expire, and 0 would read as dead",
  );
  check(grant?.refreshToken === null, "and there is no refresh token to store");

  check(
    SLACK.readTokenResponse({ ok: true, access_token: "xoxp-user-token", token_type: "user" }) === null,
    "a USER token is refused rather than stored under a name that says bot",
  );
  check(
    SLACK.readTokenResponse({ ok: true, access_token: "xoxb-1" })?.accessToken === "xoxb-1",
    "...while a response that simply omits token_type is still read",
  );
  check(SLACK.readTokenResponse({ ok: true }) === null, "a body with no token is null, not a half-grant");
  check(
    SLACK.readTokenResponse({ ok: true, access_token: "xoxb-1", team: "not an object" })?.accountLabel === null,
    "a team that is not an object costs a display name, never the connection",
  );
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
