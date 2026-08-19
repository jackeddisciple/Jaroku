// §6's payload discipline, as claims — built the way `test:log-redaction` is built.
//
// ONE KNOWN SECRET, AND EVERY ROUTE INTO A PAYLOAD TRIED AGAINST IT. That pattern is what §6 asks
// for by name, and the reason it is the right shape is that a payload is a sink in exactly the sense
// a log is: stored, broadcast to every socket in the workspace, and outliving the thing it describes.
// This one carries something a log does not — a deploy's own error text, from a process that had the
// workspace's credentials in its environment.
//
// AND THE NARROWING FROM v0.2.4, WHICH IS THE HALF THAT IS EASY TO GET WRONG. The scrubber once
// treated `anthropic` and `claude-haiku-4-5` as secrets and produced unreadable output. On THIS tab
// that would not merely be ugly: Model Mix's whole job is to say which models ran, so a redacted
// model name deletes the answer. Both directions are asserted here — genuine secrets out, ordinary
// identifiers through — because a suite that only checked one would pass on a scrubber that redacted
// everything.
//
//   npm run test:activity-payload

import { protectSecret, resetProtection } from "../obs/log.ts";
import {
  MAX_ID,
  MAX_ROWS,
  MAX_TEXT,
  boundActor,
  boundIdentifier,
  boundList,
  boundNumber,
  boundText,
  boundUrl,
} from "./payload.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

/** The known secret. Registered the way the runtime registers a workspace's credentials. */
const SECRET = "sk-live-9f2b7c41e08a4d6fbe3c1a55d7904ee2";
const DB_URL = "postgres://jaroku:hunter2@db.internal:5432/prod";

resetProtection();
protectSecret(SECRET, "provider-key");

// --- the known secret cannot reach a payload by any route -------------------------------------------

console.log("\none known secret, every route tried against it");
{
  const routes: [string, string][] = [
    ["a deploy's own error text", `Build failed: env OPENAI_API_KEY=${SECRET} was rejected`],
    ["an MCP server's advertised name", `mock ${SECRET}`],
    ["a tool name a third-party server chose", `send_${SECRET}`],
    ["a tool description", `Posts a message. Configure with ${SECRET}.`],
    ["a deploy target somebody typed", `railway/${SECRET}`],
    ["an agent slug", `agent_${SECRET}`],
    ["a model id", `custom/${SECRET}`],
    ["a URL with the key in its query", `https://api.example/v1?key=${SECRET}`],
  ];
  for (const [what, value] of routes) {
    const asText = boundText(value);
    const asId = boundIdentifier(value);
    check(`${what}: not in the prose bound`, !asText.includes(SECRET), asText);
    check(`${what}: nor in the identifier bound`, !asId.includes(SECRET), asId);
    // §6: "No secret values, NOT EVEN PARTIAL ONES." A truncation that cut the key in half would
    // leave a recognisable prefix, which is why the redactor runs BEFORE the cut.
    check(`${what}: not even a prefix of it`, !asText.includes(SECRET.slice(0, 12)) && !asId.includes(SECRET.slice(0, 12)));
  }
}

console.log("\nand a connection string, which is what a driver's own error quotes back");
{
  const bounded = boundText(`OperationalError: could not connect to ${DB_URL}`);
  check("the password is gone", !bounded.includes("hunter2"), bounded);
  // The url-credentials pattern keeps the scheme and user, because that is the part that says WHICH
  // connection failed — the same trade the log redactor makes, in the same function.
  check("...while the message still says which connection it was", bounded.includes("postgres"));
}

// --- and an ordinary identifier is not mistaken for one --------------------------------------------------

console.log("\nv0.2.4's narrowing: a model name is not a secret");
{
  const models = [
    "claude-haiku-4-5",
    "claude-opus-4-8",
    "anthropic",
    "gpt-4o-mini",
    "accounts/fireworks/models/llama-v3p1-405b-instruct",
    "railway",
    "support_bot",
    "gmail_search",
  ];
  for (const id of models) {
    check(`"${id}" passes through intact`, boundIdentifier(id) === id, boundIdentifier(id));
  }
  // The one that would make the whole tab useless: Model Mix's job IS to name models.
  check("so Model Mix can still say what ran", boundIdentifier("claude-haiku-4-5").length > 0);
}

// --- newlines and control bytes ------------------------------------------------------------------------------

console.log("\na card's one line stays one line");
{
  const multi = boundText("first line\nsecond line\r\nthird");
  check("newlines become spaces", multi === "first line second line third", multi);
  check("...rather than being dropped, which would run the words together", !multi.includes("linesecond"));

  const ansi = boundText("\u001B[31mred\u001B[0m text");
  check("an ANSI escape is stripped", !ansi.includes("\u001B"), JSON.stringify(ansi));
  check("...leaving the words", ansi.includes("red") && ansi.includes("text"));

  // A NUL in an identifier is not a space — an id is one token, so the byte goes rather than
  // splitting the value into two.
  check("a control byte inside an id is removed", boundIdentifier("send\u0000_message") === "send_message");
  check("...and so is whitespace, because an id has none", boundIdentifier(" send message ") === "sendmessage");
}

// --- the bounds -------------------------------------------------------------------------------------------------

console.log("\nnothing on this wire is unbounded");
{
  const long = "x".repeat(1_000);
  check(`prose is cut at ${MAX_TEXT}`, boundText(long).length === MAX_TEXT);
  check("...with a mark saying it was", boundText(long).endsWith("…"));
  check(`an identifier is cut at ${MAX_ID}`, boundIdentifier(long).length === MAX_ID);
  // An id is not cut with an ellipsis: a truncated id is not a shorter id, it is a different one,
  // and a marker would make it look like a value somebody could paste.
  check("...without one, because a cut id is not a shorter id", !boundIdentifier(long).includes("…"));

  const rows = Array.from({ length: MAX_ROWS + 50 }, (_, i) => i);
  const bounded = boundList(rows);
  check(`a list is cut at ${MAX_ROWS}`, bounded.rows.length === MAX_ROWS);
  check("...and says it is partial", bounded.truncated);
  check("a short list is not marked partial", !boundList([1, 2, 3]).truncated);
}

// --- the values that are not values -------------------------------------------------------------------------------

console.log("\nwhat is not a figure does not become one");
{
  check("NaN is not a number", boundNumber(Number.NaN) === null);
  check("Infinity is not a number", boundNumber(Number.POSITIVE_INFINITY) === null);
  check("a string is not a number", boundNumber("12" as unknown) === null);
  check("a real zero is", boundNumber(0) === 0);

  check("an https URL survives", boundUrl("https://agent.example.app") === "https://agent.example.app");
  check("an http one does too", boundUrl("http://localhost:8080") === "http://localhost:8080");
  // The one that turns a read-only dashboard into something else. §1: nothing here changes state.
  check("a javascript: href does not", boundUrl("javascript:alert(1)") === null);
  check("nor does a data: one", boundUrl("data:text/html,<script>x</script>") === null);
  check("nor does prose that is not a URL", boundUrl("not a url") === null);

  check("an actor is a uuid or nothing", boundActor("3ba700f0-1a2f-4be0-9df9-793ca131bee2") !== null);
  // AN ID, NEVER AN EMAIL. The most person-identifying string in the product must not ride the one
  // payload built to be screenshotted.
  check("an email address is not an actor id", boundActor("ada@example.com") === null);
  check("nor is a display name", boundActor("Ada Lovelace") === null);
  check("nor is nothing", boundActor("") === null && boundActor(null) === null);
}

// --- and the empty cases ----------------------------------------------------------------------------------------------

console.log("\nabsent stays absent");
{
  check("no text is empty text", boundText(null) === "" && boundText(undefined) === "");
  check("no id is empty", boundIdentifier(null) === "");
  check("no url is null", boundUrl(null) === null);
  check("no number is null", boundNumber(null) === null);
}

resetProtection();
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
