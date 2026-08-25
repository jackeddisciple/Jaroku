// §14.1's `test:join-flow` — what a person can paste into §4.1.2's box, and what they cannot.
//
// THE WHOLE FEATURE IS ONE FUNCTION AND ITS REFUSALS. §4.1.2 asks for a field that "accepts either
// the full URL (https://...?invite=abc123) or just the token (abc123)", and the interesting half
// is not that both work — it is which strings must NOT be accepted, because every one of those is
// a redemption attempt that comes back as "that invitation is not valid" and reads as the
// invitation being wrong rather than the paste being short.
//
// THE ORDER OF THE TWO ATTEMPTS IS THE LOAD-BEARING PROPERTY, and it is the one a reader is most
// likely to reverse while tidying: a pasted link CONTAINS a token, so trying the bare form first
// accepts the whole URL as a token, sends it, and reports a perfectly good link as invalid. The
// assertion for it is the one that fails on a reordering and on nothing else.
//
//   npm run test:join-flow

import { INVITE_PARAM, inviteTokenFrom, inviteTokenFromInput, inviteUrl } from "./invite.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

/** A workspace id and a 43-character base64url secret — the shape the server mints. */
const WS = "6f1c9a2e-0d3b-4e57-9a11-2b8c4d6e7f09";
const SECRET = "aB3-_dEfGhIjKlMnOpQrStUvWxYz0123456789abcdz";
const TOKEN = `${WS}.${SECRET}`;

console.log("\nthe two shapes §4.1.2 asks for");
{
  check(inviteTokenFromInput(TOKEN) === TOKEN, "a bare token comes back as itself");
  check(
    inviteTokenFromInput(inviteUrl("https://jaroku.app", TOKEN)) === TOKEN,
    "a whole link yields the token inside it",
  );
  check(
    inviteTokenFromInput(`  ${TOKEN}  `) === TOKEN,
    "...and surrounding whitespace is a paste artefact, not part of the secret",
  );
  // A LINK IS ALWAYS TRIED FIRST. Reverse the two branches and this is what breaks: the bare-token
  // check would match the whole URL — it contains a dot and a long tail — and send
  // `https://jaroku.app/?invite=…` as a redemption.
  const asUrl = inviteUrl("https://jaroku.app", TOKEN);
  check(asUrl.includes("."), "a URL contains a dot, which is why the bare-token check cannot go first");
  check(inviteTokenFromInput(asUrl) !== asUrl, "...and the URL is never returned as though it were the token");
}

console.log("\nthe link the inviter copies is the link the invitee pastes");
{
  // The two ends of one string, which is what `test:invite` guards for the deep link and what this
  // guards for the pasted one. A `+` or a `/` in a secret is the case that separates an encoded
  // link from a nearly-working one.
  const awkward = `${WS}.a+b/c=dEfGhIjKlMnOpQrStUvWxYz0123456789abcd`;
  const url = inviteUrl("https://jaroku.app", awkward);
  check(inviteTokenFrom(new URL(url).search) === awkward, "a secret with + and / survives the round trip");
  check(url.includes(`${INVITE_PARAM}=`), "...on the parameter both ends agree on");
}

console.log("\nwhat is refused before anything is sent");
{
  const refusals: [string, string][] = [
    ["", "an empty box"],
    ["   ", "whitespace"],
    ["hello", "a word"],
    [WS, "a workspace id with no secret after it"],
    [`${WS}.`, "a separator with nothing after it"],
    [`${WS}.abc`, "a secret too short to be one"],
    [`.${SECRET}`, "a secret with no workspace id in front of it"],
    [`${WS}.${SECRET.slice(0, 20)}`, "a truncated paste — the case this refusal exists for"],
    [`${WS}.${"!".repeat(48)}`, "characters base64url does not contain"],
    ["https://jaroku.app/", "a link with no invitation on it"],
    ["https://jaroku.app/?other=abc", "a link carrying some other parameter"],
    [`https://jaroku.app/?${INVITE_PARAM}=nodot`, "a link whose invitation has no workspace id"],
  ];
  for (const [input, what] of refusals) {
    check(inviteTokenFromInput(input) === null, `${what} is refused`);
  }
}

console.log("\nand the refusal is about the string, not about the invitation");
{
  // WHY THAT DISTINCTION IS WORTH AN ASSERTION. Everything above returns null WITHOUT a round trip,
  // which is what lets §4.1.2's third message — "Invalid invite code" — be about the thing the
  // person is looking at. Sent to the server, each one comes back as "that invitation has expired
  // or is no longer valid", which is true of a token that never existed and is the wrong sentence
  // to put in front of somebody who has pasted half a link.
  const half = `${WS}.${SECRET.slice(0, 20)}`;
  check(inviteTokenFromInput(half) === null, "half a link never reaches the server");
  check(inviteTokenFromInput(`${WS}.${SECRET}`) !== null, "...and the whole one does");
}

console.log("\na host that is not this one");
{
  // DELIBERATELY ACCEPTED. An invitation is minted by one deployment and redeemed against whichever
  // one this tab is talking to; a token from another host is refused by the SERVER, because its
  // digest matches nothing, which is the correct refusal and the one that does not require this
  // function to know what host it is running on.
  const elsewhere = inviteUrl("https://someone-elses-jaroku.example", TOKEN);
  check(inviteTokenFromInput(elsewhere) === TOKEN, "a link from another deployment yields its token");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
