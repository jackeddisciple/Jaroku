// One known secret, and every route into `output` and `error` tried against it.
//
// BUILT THE WAY `test:log-redaction` IS, which is the pattern this codebase reaches for whenever a
// column is a SINK: register a value the redactor is supposed to protect, then try to get it out
// the other side by every path that writes. The assertion is never "the redactor works" — that is
// `test:log-redaction`'s — it is that nothing can reach the column without going through it.
//
// THESE TWO COLUMNS ARE THE SHARPEST SINKS THIS PRODUCT HAS. `output` is what a model produced
// inside somebody's container; `error` is a traceback from a process that had every credential the
// deploy handed it in its environment. An agent that prints its own settings, a library that logs a
// connection string, a stack frame that repr()s a config object — every one of those ends up here,
// and from here in a row that outlives the job and in a snapshot broadcast to every socket in the
// workspace.
//
// THE ORDER IS THE OTHER HALF, and it is the assertion most likely to be broken by somebody
// tidying up: redact BEFORE truncating. A key cut in half is a key the patterns no longer match,
// so truncating first leaves the first sixteen characters of a live credential visible — which is
// the "not even partial ones" case, and which looks completely correct in review.
//
//   npm run test:work-redaction

import { randomUUID } from "node:crypto";

import { openTestSqlite, testContext } from "../db/testDb.ts";
import { AgentRepository } from "../db/repositories/agents.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { DeployStore } from "../deployStore.ts";
import { newRequestId, systemContext, type TenantContext } from "../db/tenant.ts";
import { protectSecret, resetProtection } from "../obs/log.ts";
import {
  boundError, boundOutput, MAX_ERROR_BYTES, MAX_OUTPUT_BYTES, PREVIEW_CHARS, preview,
} from "./payload.ts";
import { WorkStore } from "./workStore.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

/** Long enough to be a plausible credential, and distinctive enough to grep an output for. */
const SECRET = "sk-live-51H7qWorkRedactionCanary9zXbQ0pLmNvC";

resetProtection();
protectSecret(SECRET, "work-canary");

const db = await openTestSqlite();
const identity = new IdentityRepository(db);
const agents = new AgentRepository(db);
const deploys = new DeployStore(db);
const work = new WorkStore(db);

const person = await identity.provisionUser(systemContext(newRequestId()), {
  externalId: `redaction-${randomUUID().slice(0, 8)}`,
  email: `redaction-${randomUUID().slice(0, 8)}@example.com`,
});
const ctx: TenantContext = { ...testContext(), actorUserId: person.user.id };
const agent = await agents.upsertFromDisk(ctx, { slug: "redaction_agent" });
const deployment = await deploys.create(ctx, {
  agentId: agent.id, provider: "anthropic", model: "claude-haiku-4-5", envKeys: [],
});

async function finished(o: { output?: string; error?: string }): Promise<{ output: string | null; error: string | null }> {
  const item = await work.create(ctx, {
    agentId: agent.id, deploymentId: deployment.id, runId: randomUUID(), input: "x",
  });
  await work.finish(ctx, item.id, {
    status: o.error ? "failed" : "succeeded",
    output: o.output ?? null,
    error: o.error ?? null,
    failureKind: o.error ? "agent_error" : null,
  });
  const row = (await work.get(ctx, item.id))!;
  return { output: row.output, error: row.error };
}

// --- 1. the secret cannot reach either column ----------------------------------------------------

console.log("\nevery route into the two columns");
{
  // The four shapes a credential actually arrives in, rather than four copies of one shape. Each
  // is a real thing that has happened to a log sink in this product's history.
  const routes: { name: string; text: string }[] = [
    { name: "an agent that printed its own settings", text: `config: {"api_key": "${SECRET}"}` },
    { name: "a traceback whose frame repr()s a client", text: `Traceback:\n  Client(api_key='${SECRET}')\nAuthError` },
    { name: "a connection string in a library's log line", text: `connecting with token=${SECRET} to api.example.com` },
    { name: "the bare value on its own", text: SECRET },
  ];

  for (const route of routes) {
    const asOutput = await finished({ output: route.text });
    check(`output: ${route.name}`, !(asOutput.output ?? "").includes(SECRET), asOutput.output ?? "(null)");
    const asError = await finished({ error: route.text });
    check(`error: ${route.name}`, !(asError.error ?? "").includes(SECRET), asError.error ?? "(null)");
  }

  // AND THE STORE IS THE ONLY WRITER, so the property holds for every caller rather than for the
  // ones somebody remembered. `boundOutput` and `boundError` are what `finish` calls, and a path
  // that wrote the column without them is what this pair of assertions is a proxy for.
  check("the bounding functions are what refuse it", !(boundOutput(SECRET) ?? "").includes(SECRET));
  check("...both of them", !(boundError(SECRET) ?? "").includes(SECRET));
}

// --- 2. redact BEFORE truncate, never after ------------------------------------------------------

console.log("\nthe order, which is the half that looks correct when it is wrong");
{
  // THE SECRET SITS ACROSS THE CUT. Everything before it fills the cap, so a truncate-then-redact
  // implementation cuts the value in half — leaving a prefix the patterns no longer match and the
  // first characters of a live credential visible in a column broadcast to every socket.
  const filler = "a".repeat(MAX_ERROR_BYTES - 20);
  const stored = (await finished({ error: `${filler}${SECRET} and then some more text` })).error ?? "";
  check("a secret straddling the truncation point is gone entirely", !stored.includes(SECRET));
  // The sharper half: no PREFIX of it survives either. A sixteen-character head of an API key is
  // a partial credential, which §6.5 of the Inbox specification rules out in as many words.
  check(
    "...and so is every prefix of it longer than a few characters",
    !stored.includes(SECRET.slice(0, 16)) && !stored.includes(SECRET.slice(0, 24)),
    stored.slice(-120),
  );
}

// --- 3. the cap is announced rather than silent --------------------------------------------------

console.log("\nthe cap says so");
{
  const long = "y".repeat(MAX_OUTPUT_BYTES * 2);
  const stored = (await finished({ output: long })).output ?? "";
  check("an over-long answer is cut", Buffer.byteLength(stored, "utf8") <= MAX_OUTPUT_BYTES, String(Buffer.byteLength(stored, "utf8")));
  // A SILENTLY TRUNCATED ANSWER IS WORSE THAN A SHORT ONE, because the operator reads it as the
  // whole answer and acts on it. The tail is what makes "the agent stopped mid-sentence" and "we
  // stopped storing it" two different things on screen.
  check("...and says so, with both figures", /truncated/.test(stored) && /32,768/.test(stored) && /16,384/.test(stored),
    stored.slice(-140));
  check("a value at exactly the cap is untouched", boundOutput("z".repeat(MAX_OUTPUT_BYTES)) === "z".repeat(MAX_OUTPUT_BYTES));

  // THE ANNOUNCEMENT IS INSIDE THE CAP, not appended past it. A bound whose own explanation pushed
  // the value back over the limit would be a bound that does not bound.
  check("the announcement does not push it back over", Buffer.byteLength(stored, "utf8") < MAX_OUTPUT_BYTES);
}
{
  // A MULTI-BYTE CHARACTER AT THE CUT. Slicing the Buffer instead of the string would land
  // mid-sequence and leave a replacement character as the last glyph of an answer somebody is
  // reading — from a truncation that was supposed to be honest about itself.
  const emoji = "🙂".repeat(MAX_OUTPUT_BYTES);
  const stored = boundOutput(emoji) ?? "";
  check("cutting through multi-byte text leaves no broken glyph", !stored.includes("�"), stored.slice(0, 40));
  check("...and is still inside the cap", Buffer.byteLength(stored, "utf8") <= MAX_OUTPUT_BYTES);
}

// --- 4. null and empty are different -------------------------------------------------------------

console.log("\nnothing and nothing said");
{
  // NULL IS "THERE WAS NONE" AND "" IS "THE AGENT SAID NOTHING", and §11's honesty rules would have
  // a card render those differently — an empty answer is a real and interesting outcome.
  check("null passes through as null", boundOutput(null) === null && boundError(undefined) === null);
  check("an empty string stays an empty string", boundOutput("") === "");
}

// --- 5. the one line a row renders ----------------------------------------------------------------

console.log("\nthe preview");
{
  check("a short answer is its own preview", preview("Refunded £41.20") === "Refunded £41.20");
  check("a long one is cut to a line", (preview("q".repeat(500)) ?? "").length === PREVIEW_CHARS);
  check("...with an ellipsis, so the cut is visible", (preview("q".repeat(500)) ?? "").endsWith("…"));
  // NEWLINES BECOME SPACES rather than being dropped: dropping runs words together, and the point
  // is that one line stays one line.
  check("newlines become spaces, not nothing", preview("line one\nline two") === "line one line two");
  // AN ESCAPE BYTE IS NOT WHITESPACE, which is why this filters by character code rather than with
  // `\s`. An agent that printed ANSI colour codes would otherwise put an invisible terminal
  // instruction on a row in a browser.
  const ESC = String.fromCharCode(0x1b);
  const DEL = String.fromCharCode(0x7f);
  check("an ANSI escape is stripped", preview(ESC + "[31mred" + ESC + "[0m") === "[31mred [0m");
  check("...and so is a DEL", preview("before" + DEL + "after") === "before after");
  check("null stays null and empty stays empty", preview(null) === null && preview("") === "");
}

// --- 6. the preview does not undo the bounding ----------------------------------------------------

console.log("\nthe row a list renders");
{
  const stored = (await finished({ output: `the key is ${SECRET}` })).output;
  const line = preview(stored);
  check("a row's one line carries no secret either", !(line ?? "").includes(SECRET), line ?? "(null)");
  check("...because what it is given has already been through the filter", !(stored ?? "").includes(SECRET));
}

resetProtection();
await db.close();
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;
