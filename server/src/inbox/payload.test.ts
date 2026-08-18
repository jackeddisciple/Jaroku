// A known secret value, and one more sink it must not reach.
//
// §6.5 ASKS FOR THIS SUITE BY NAME: "Add a test asserting a known secret value cannot reach an inbox
// payload, using the pattern that already asserts it cannot reach a log sink." So this is built the
// same way `test:log-redaction` is — one real-looking key, registered the way the process registers
// what it loads from `runtime/.env`, and then every route into a payload tried against it.
//
// A PAYLOAD IS A SINK IN EXACTLY THE SENSE A LOG IS. It is stored, it is broadcast to every socket in
// the workspace, and it outlives the problem it describes. What makes it worth its own suite rather
// than a line in the log one is that a payload carries something a log does not: a build's own error
// text, which is free-form output from a process that had the credentials in its environment.
//
// THE FIXTURE IS ASSEMBLED RATHER THAN WRITTEN OUT, for the reason the log suite gives: a file whose
// job is to prove credentials cannot leak must not itself contain a string a secret scanner
// recognises, or GitHub's push protection correctly refuses the commit and the suite becomes
// unpushable.
//
//   npm run test:inbox-payload

import { protectSecret } from "../obs/log.ts";
import { openTestSqlite, testContext } from "../db/testDb.ts";
import { MAX_KEYS, MAX_LIST, MAX_STRING, boundPayload, boundString } from "./payload.ts";
import { InboxStore } from "./inboxStore.ts";
import { noteDeployFailed } from "./generators.ts";
import { dedupeKey } from "./registry.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const ctx = testContext();

const SECRET = ["sk", "ant", "api03", "INBOXLEAKCANARY0123456789abcdefGHIJ"].join("-");
const DB_URL = `postgres://analytics:${"hunter2"}@db.internal.example:5432/warehouse`;
protectSecret(SECRET, "ANTHROPIC_API_KEY");

// --- 1. the value cannot reach a payload, by any route -------------------------------------

console.log("\na registered secret cannot reach a payload");
{
  const asValue = boundPayload({ error: `build failed: ANTHROPIC_API_KEY=${SECRET}` });
  check("not through an error string", !JSON.stringify(asValue).includes(SECRET));
  check("...and what is left names the credential rather than showing it",
    String(asValue["error"]).includes("[redacted:ANTHROPIC_API_KEY]"), String(asValue["error"]));

  check(
    "not through a list, which is where run ids and tool refs travel",
    !JSON.stringify(boundPayload({ tools: [`linear/${SECRET}`] })).includes(SECRET),
  );
  check(
    "not through a key somebody built out of user text",
    !JSON.stringify(boundPayload({ [SECRET]: "x" })).includes(SECRET),
  );
  check(
    "not through a connection string in a stack trace",
    !JSON.stringify(boundPayload({ error: `could not connect to ${DB_URL}` })).includes("hunter2"),
  );

  // NOT EVEN PARTIALLY, which §6.5 says in as many words. The order in `boundString` is what makes
  // this true: redacting AFTER cutting would leave a key truncated mid-value, unmatched by the
  // redactor and therefore half visible.
  const long = boundPayload({ error: `${"x".repeat(MAX_STRING - 10)}${SECRET}` });
  const rendered = String(long["error"]);
  check("...and not a fragment of it either, however long the string it was buried in",
    !rendered.includes(SECRET.slice(0, 24)), rendered.slice(-60));
}

console.log("\nand not through the generator that actually carries build output");
{
  const db = await openTestSqlite();
  const store = new InboxStore(db);

  // `deploy_failed` is the one item type whose payload holds text a third-party build produced —
  // the path §6.5 is actually about.
  await noteDeployFailed({ inbox: store }, ctx, {
    deploymentId: "dep-1",
    agentUuid: "agent-1",
    agentName: "api_gateway",
    error: `Error: request failed\n  Authorization: Bearer ${SECRET}\n  at build.js:12`,
  });

  const item = await store.byKey(ctx, dedupeKey("deploy_failed", "dep-1"));
  const stored = JSON.stringify(item?.payload);
  check("the row does not hold it", !stored.includes(SECRET));
  check("...and the row is what a snapshot is built from, so nothing downstream can hold it either",
    !JSON.stringify(await store.listOpen(ctx)).includes(SECRET));

  await db.close();
}

// --- 2. bounded, and flattened ---------------------------------------------------------------

console.log("\nserver-provided text is bounded and stripped of raw newlines");
{
  const long = boundString("a".repeat(1000));
  check(`a long string is cut to ${MAX_STRING}`, long.length === MAX_STRING, `${long.length}`);
  check("...with a mark saying it continues, rather than a hard stop", long.endsWith("…"));

  const multi = boundString("line one\nline two\r\nline three");
  check("newlines become spaces so a card's one line stays one line", !multi.includes("\n"));
  check("...and the words do not run together, which dropping them would do", multi.includes("one line two"));

  const ansi = boundString(`before${String.fromCharCode(27)}[31mred${String.fromCharCode(27)}[0m after`);
  check(
    "an ANSI escape is removed, because an invisible terminal instruction on a card is not text",
    !ansi.includes(String.fromCharCode(27)),
  );
  check("...and a NUL cannot reach a column Postgres refuses to store one in",
    !boundString(`a${String.fromCharCode(0)}b`).includes(String.fromCharCode(0)));

  const list = boundPayload({ run_ids: Array.from({ length: 100 }, (_, i) => `run-${i}`) });
  check(`a list is capped at ${MAX_LIST}`, (list["run_ids"] as string[]).length === MAX_LIST);

  const wide: Record<string, string> = {};
  for (let i = 0; i < 60; i++) wide[`k${i}`] = "v";
  check(
    `a payload cannot be made large by making it wide (capped at ${MAX_KEYS})`,
    Object.keys(boundPayload(wide)).length === MAX_KEYS,
  );
}

// --- 3. what a payload may hold at all ---------------------------------------------------------

console.log("\nfive shapes are allowed and everything else is dropped rather than coerced");
{
  const mixed = boundPayload({
    name: "api_gateway",
    count: 40,
    ok: true,
    nothing: null,
    ids: ["a", "b"],
    // A nested object is where a future generator could put an entire response body without
    // noticing. Dropped rather than stringified, because a key rendering as "[object Object]" is
    // worse than an absent one.
    nested: { deep: "value" },
    when: new Date(),
    fn: () => "x",
    broken: Number.NaN,
  } as never);

  check("a name survives", mixed["name"] === "api_gateway");
  check("a count survives", mixed["count"] === 40);
  check("a boolean survives", mixed["ok"] === true);
  check("an explicit null survives, because absent and null mean different things", mixed["nothing"] === null);
  check("a list of names survives", JSON.stringify(mixed["ids"]) === JSON.stringify(["a", "b"]));
  check("a nested object is dropped", !("nested" in mixed));
  check("a Date is dropped rather than serialised into something the client has to guess at", !("when" in mixed));
  check("a function is dropped", !("fn" in mixed));
  check("NaN is dropped rather than arriving as a null the client reads as a real answer", !("broken" in mixed));
  check("a payload that is not an object at all is an empty one", Object.keys(boundPayload(undefined)).length === 0);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
if (fail > 0) process.exit(1);
