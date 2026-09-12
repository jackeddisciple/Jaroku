// §4's conversation memory — the window, the budget, the summaries and the truncation notice.
//
// WHY THE ASSERTIONS ARE PURE. §4.5 asks for five things and every one of them is a property of the
// ASSEMBLY rather than of the database: a pronoun resolving depends on turn 1 being in the window,
// two threads staying independent depends on the window being built from one thread's items, and
// truncating oldest-first depends on the direction of a loop. `conversationWindow` takes the rows
// as data for exactly this reason — so the five can be checked without a server, a model or a key.
//
// AND THE TENANCY HALF IS SOMEWHERE ELSE ON PURPOSE. "A workspace switch empties chat context" is
// not a property of this function; it is a property of every read that feeds it taking a
// `TenantContext` first, which `test:db-boundary` makes structural and `test:convo-tenancy` drives
// against a real database. A mock here would assert that a mock was scoped.
//
//   npm run test:chat-memory

import { openTestSqlite, testContext } from "./db/testDb.ts";
import { newRequestId, systemContextFor, type TenantContext } from "./db/tenant.ts";
import { ThreadStore } from "./threadStore.ts";
import {
  conversationWindow, estimateTokens, summariseItem, CONTEXT_TOKEN_BUDGET, TRUNCATION_NOTICE,
  type ItemForWindow, type RunDigests,
} from "./chat.ts";

let fail = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok   ${name}`);
  else {
    fail++;
    console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

const NO_RUNS: RunDigests = new Map();

/** A user's turn, with the answer it got. */
const said = (id: string, body: string, answer?: string): ItemForWindow => ({
  kind: "message", role: "user", body, refId: id,
  answers: answer === undefined ? [] : [{ ordinal: 1, body: answer }],
});

/** A non-message item — a plan, a run, a proposal. */
const did = (id: string, kind: ItemForWindow["kind"], refId = id): ItemForWindow => ({
  kind, role: null, body: null, refId, answers: [],
});

// --- §4.5: a three-turn conversation where turn 3 refers to turn 1 by pronoun ----------------
//
// WHAT THIS CAN AND CANNOT ASSERT. Whether a model resolves the pronoun is a model's business; what
// this asserts is the only half that can be wrong in the code — that turn 1 and its answer are in
// the window turn 3 is sent with, in order, and attributed to the right speaker. A window that had
// them absent, reversed, or both filed as the user's would make resolution impossible whatever the
// model did.

console.log("\na three-turn conversation");
{
  const items = [
    said("t1", "which two models are cheapest for classification?",
      "GPT-5.6 Luna at $0.20/M input, then claude-haiku-4-5 at $1/M."),
    said("t2", "how much would a thousand calls cost on the first one?", "About four cents."),
    said("t3", "what about the second one?"),
  ];
  const w = conversationWindow(items, NO_RUNS, { exclude: "t3" });
  check("the current message is not in its own history", !w.messages.some((m) => m.content.includes("what about the second")), w.messages);
  check("turn 1 is in scope for turn 3", w.messages.some((m) => m.content.includes("cheapest for classification")), w.messages);
  check("...and so is the answer that named the two", w.messages.some((m) => m.content.includes("GPT-5.6 Luna")), w.messages);
  check("in order, oldest first", (w.messages[0]?.content ?? "").includes("cheapest"), w.messages[0]);
  // THE ATTRIBUTION IS THE HALF THAT SILENTLY BREAKS RESOLUTION. A model handed its own previous
  // words as the user's reads them as something the user asserted, and answers accordingly.
  check("questions are the user's and answers are the assistant's",
    w.messages.filter((m) => m.role === "user").length === 2
    && w.messages.filter((m) => m.role === "assistant").length === 2, w.messages.map((m) => m.role));
  check("nothing was truncated", w.truncated === false && w.dropped === 0, w);
}

// --- §4.4: two threads on one agent keep independent context ---------------------------------
//
// ASSERTED AS A PROPERTY OF THE INPUT, which is the honest place for it: the window is built from
// the items it is given, and `chatMemory` gives it one thread's. A function that could see two
// threads' items would need to be given them.

console.log("\ntwo threads on one agent");
{
  const a = conversationWindow([said("a1", "use postgres for the lookup", "Noted.")], NO_RUNS);
  const b = conversationWindow([said("b1", "use redis for the lookup", "Noted.")], NO_RUNS);
  check("thread A sees only its own turn", a.messages.some((m) => m.content.includes("postgres")) && !a.messages.some((m) => m.content.includes("redis")), a.messages);
  check("thread B sees only its own turn", b.messages.some((m) => m.content.includes("redis")) && !b.messages.some((m) => m.content.includes("postgres")), b.messages);
}

// --- §4.5: past the budget, truncate oldest-first and SAY SO ---------------------------------

console.log("\nthe token budget");
{
  // Each turn ~250 tokens, so a budget of 600 admits two and drops the rest.
  const long = (n: number) => said(`t${n}`, `turn ${n}: ${"x".repeat(500)}`, `answer ${n}: ${"y".repeat(500)}`);
  const items = [long(1), long(2), long(3), long(4), long(5)];
  const w = conversationWindow(items, NO_RUNS, { budget: 600 });

  check("the budget was respected", w.messages.length < 10, w.messages.length);
  check("it says it truncated", w.truncated === true, w);
  // OLDEST FIRST. The newest turns are the ones somebody is in the middle of, and a window that
  // kept the START of a long thread would drop exactly the part that matters.
  check("the newest turn survived", w.messages.some((m) => m.content.startsWith("turn 5")), w.messages.map((m) => m.content.slice(0, 8)));
  check("the oldest turn was dropped", !w.messages.some((m) => m.content.startsWith("turn 1")), w.messages.map((m) => m.content.slice(0, 8)));
  // NO HOLE IN THE MIDDLE. Skipping one expensive turn and keeping an older one would hand the model
  // a conversation with a gap it cannot see, which it will answer across.
  const kept = w.messages.filter((m) => m.role === "user").map((m) => Number(/^turn (\d+)/.exec(m.content)?.[1] ?? 0));
  check("what is kept is contiguous", kept.every((n, i) => i === 0 || n === (kept[i - 1] ?? 0) + 1), kept);

  // AT EXACTLY THE BOUNDARY AND ONE TURN PAST IT — §16's memory attack, run here because it is a
  // pure property. The turn immediately before the question must always be present: a window that
  // could reject every turn would hand the model an empty history and a truncation notice, which is
  // strictly worse than one turn over budget.
  const one = conversationWindow([long(1)], NO_RUNS, { budget: 1 });
  check("a single over-budget turn is kept rather than dropped", one.messages.length > 0, one);
  check("...and is not reported as truncated", one.truncated === false, one);
  const none = conversationWindow([], NO_RUNS, { budget: 1 });
  check("an empty thread produces an empty window and no notice", none.messages.length === 0 && !none.truncated, none);
}

console.log("\nthe truncation notice");
{
  check("it tells the model what it cannot see", /Earlier turns are not shown/i.test(TRUNCATION_NOTICE));
  check("...and what to do about it", /say so rather than assuming/i.test(TRUNCATION_NOTICE));
  // §4.2's NOTICE NAMES NO NUMBER. "12 earlier turns are not shown" invites a model to reason about
  // the arithmetic of its own context window, and to tell the user about it.
  check("it names no count", !/\d/.test(TRUNCATION_NOTICE), TRUNCATION_NOTICE);
}

// --- §4.5: a fixture thread with a plan, an applied edit and a failed run --------------------

console.log("\n§4.3's one-line summaries");
{
  const runs: RunDigests = new Map([
    ["r1", { status: "error", failedSeq: 7, failedError: "TimeoutError: get_weather timed out after 30s\n  at tools/weather.py:14" }],
    ["r2", { status: "completed", failedSeq: null, failedError: null }],
    ["r3", { status: "running", failedSeq: null, failedError: null }],
  ]);
  const items: ItemForWindow[] = [
    said("m1", "build me a weather agent"),
    did("p1", "plan"),
    did("g1", "generation"),
    said("m2", "add a retry to the tool"),
    did("pr1", "proposal"),
    did("i1", "run", "r1"),
    said("m3", "why did that fail?"),
  ];
  const w = conversationWindow(items, runs);
  const joined = w.messages.map((m) => m.content).join("\n");

  check("the plan is one line", joined.includes("[plan written]"), joined);
  check("the generation is one line", joined.includes("[agent generated]"), joined);
  check("the edit is one line", joined.includes("[edit proposed]"), joined);
  // §4.3'S OWN EXAMPLE, and the one summary with real data behind it. The step and the error come
  // from the trace store, which genuinely has them.
  check("the failed run names the step and the error",
    joined.includes("[run failed at step 7: TimeoutError: get_weather timed out after 30s]"), joined);
  // AND NO PAYLOAD. "Sending those verbatim would blow the context window within a few turns and
  // cost a fortune." A summary that grew with the thing it summarises is not a summary.
  check("no summary carries a payload", w.messages.every((m) => m.role === "user" || m.content.length < 200), w.messages);

  // A SUMMARY IS THE ASSISTANT'S TURN. What it describes is something Jaroku did, and filing it as
  // the user's would make the conversation read as though somebody had typed "[run failed]".
  const summaries = w.messages.filter((m) => m.content.startsWith("["));
  check("summaries are attributed to the assistant", summaries.length === 4 && summaries.every((m) => m.role === "assistant"), summaries);

  check("a completed run says so", summariseItem(did("x", "run", "r2"), runs) === "[run completed]");
  check("a run still in flight says so", summariseItem(did("x", "run", "r3"), runs) === "[run in flight]");
  // §16'S GROUNDING ATTACK: a run the trace store has nothing about. "[run started]" is the honest
  // line — something happened and nothing is known about how it ended — where an invented outcome
  // would be §8.3's failure in the one place a model would believe it completely.
  check("a run with no record says only that it started", summariseItem(did("x", "run", "gone"), runs) === "[run started]");
  check("a run item with no ref says the same", summariseItem(did("x", "run", ""), runs) === "[run started]");
  // THE ERROR IS TRIMMED TO ITS FIRST LINE, because that is where the exception is and the rest is
  // a stack the window cannot afford.
  check("a traceback contributes one line, not a stack",
    !summariseItem(did("x", "run", "r1"), runs).includes("weather.py"), summariseItem(did("x", "run", "r1"), runs));
}

// --- §6.2: only the SELECTED sibling participates --------------------------------------------

console.log("\nregenerated siblings");
{
  const withThree: ItemForWindow = {
    kind: "message", role: "user", body: "which model?", refId: "t1",
    answers: [
      { ordinal: 1, body: "The first answer." },
      { ordinal: 2, body: "The second answer." },
      { ordinal: 3, body: "The third answer." },
    ],
  };
  const w = conversationWindow([withThree], NO_RUNS);
  const answers = w.messages.filter((m) => m.role === "assistant");
  // "THE UNSELECTED SIBLINGS ARE RETAINED AND VIEWABLE BUT ARE NOT SILENTLY FED BACK TO THE MODEL."
  // Three answers in the window would be the model reading three contradictory replies of its own
  // and reconciling them, which is not a thing anybody asked for.
  check("exactly one answer enters the context", answers.length === 1, answers);
  check("...and it is the selected one", answers[0]?.content === "The third answer.", answers[0]);

  // A VARIANT WITH NO BODY IS NOT AN ANSWER. A plan, a generation and a proposal all open variants
  // and none of them has prose; so does a reply that failed before its first token.
  const empty: ItemForWindow = { ...withThree, answers: [{ ordinal: 1, body: null }, { ordinal: 2, body: "" }] };
  check("a bodyless variant contributes nothing",
    conversationWindow([empty], NO_RUNS).messages.every((m) => m.role === "user"), conversationWindow([empty], NO_RUNS).messages);

  // §6.2's SELECTED SIBLING, DURABLY (migration 074). Before the column, the window took the
  // NEWEST answer — so somebody who regenerated three times and switched back to the first read
  // answer one on screen while every following turn was answered against answer three.
  const switched: ItemForWindow = {
    ...withThree,
    answers: [
      { ordinal: 1, body: "The first answer.", selected: true },
      { ordinal: 2, body: "The second answer." },
      { ordinal: 3, body: "The third answer." },
    ],
  };
  const w2 = conversationWindow([switched], NO_RUNS);
  const picked = w2.messages.filter((m) => m.role === "assistant");
  check("the selected sibling is what the model reads", picked[0]?.content === "The first answer.", picked);
  check("...and still only one of them", picked.length === 1, picked);

  // A TIE GOES TO THE NEWEST, which is the same answer the column's absence gives — so a failed
  // half-transaction degrades to the previous behaviour rather than to an arbitrary one.
  const tied: ItemForWindow = {
    ...withThree,
    answers: [
      { ordinal: 1, body: "One.", selected: true },
      { ordinal: 2, body: "Two.", selected: true },
    ],
  };
  check("two selected rows resolve to the newest",
    conversationWindow([tied], NO_RUNS).messages.some((m) => m.content === "Two."),
    conversationWindow([tied], NO_RUNS).messages);

  // A SELECTED ROW WITH NO BODY IS NOT AN ANSWER, so selection cannot make the window empty: the
  // fallback still finds the newest one that said something.
  const emptySelected: ItemForWindow = {
    ...withThree,
    answers: [{ ordinal: 1, body: "Real." }, { ordinal: 2, body: "", selected: true }],
  };
  check("a selected empty body falls back to one that spoke",
    conversationWindow([emptySelected], NO_RUNS).messages.some((m) => m.content === "Real."),
    conversationWindow([emptySelected], NO_RUNS).messages);

  // §6.1: A STOPPED ANSWER STAYS IN MEMORY AS WHAT IT ACTUALLY WAS — a partial answer — rather than
  // being silently dropped from context.
  const stopped: ItemForWindow = { ...withThree, answers: [{ ordinal: 1, body: "The cheapest is GPT-5.6 Lu" }] };
  check("a partial answer is remembered as a partial answer",
    conversationWindow([stopped], NO_RUNS).messages.some((m) => m.content === "The cheapest is GPT-5.6 Lu"));
}

// --- the budget constant and the estimator ---------------------------------------------------

console.log("\nthe budget");
{
  // §4.2: "The boundary is a named constant in one place." Asserted as a number with a plausible
  // magnitude rather than an exact value, so tuning it is one edit and not two.
  check("the budget is a named constant with room to work", CONTEXT_TOKEN_BUDGET >= 2000 && CONTEXT_TOKEN_BUDGET <= 100_000, CONTEXT_TOKEN_BUDGET);
  check("the estimator is monotonic", estimateTokens("aaaa") <= estimateTokens("aaaaaaaa"));
  check("...and never zero for real text", estimateTokens("a") >= 1);
  check("...and zero for none", estimateTokens("") === 0);
}

// --- §4.4's two boundaries, against a real database -------------------------------------------
//
// THE ASSEMBLY IS PURE AND THE SCOPE IS NOT, so the scope is driven through the actual reads. Both
// of §4.4's rules are properties of a WHERE clause and neither can be checked by a mock: "two
// threads on the same agent do not share conversation context" and "there is no unscoped read path
// to a thread's turns."
//
// A WORKSPACE SWITCH IS THE SECOND OF THOSE, from the client's side. The client has nothing to
// empty any more — the window is assembled server-side from rows this workspace owns — so what
// makes the guarantee true is that the read cannot reach another workspace's thread at all. That is
// what is asserted here; the client's `reset.ts` entry, which clears whatever a tab was showing, is
// what `test:reset` holds.

console.log("\n§4.4's boundaries, live");
{
  const db = await openTestSqlite();
  const threads = new ThreadStore(db);
  const at = "2026-01-01T00:00:00.000Z";
  const A = testContext();
  const B = systemContextFor("44444444-4444-4444-8444-444444444444", newRequestId());

  for (const ctx of [A, B]) {
    await db.run(
      `INSERT OR IGNORE INTO workspaces (id, slug, name, kind, plan, created_at)
       VALUES (?, ?, 'Seeded', 'personal', 'free', ?)`,
      [ctx.workspaceId, `ws-${ctx.workspaceId.slice(0, 8)}`, at],
    );
  }

  // TWO THREADS, ONE AGENT — the premise of Threads being separate build sessions.
  const one = await threads.create(A, { title: "rate limiting" });
  const two = await threads.create(A, { title: "oauth flow" });
  await threads.addItem(A, one.id, { kind: "message", role: "user", body: "use postgres for the lookup" });
  await threads.addItem(A, two.id, { kind: "message", role: "user", body: "use redis for the lookup" });

  const itemsOf = async (ctx: TenantContext, id: string): Promise<ItemForWindow[]> =>
    (await threads.itemsFor(ctx, id)).map((i) => ({
      kind: i.kind, role: i.role, body: i.body, refId: i.kind === "run" ? i.ref_id : i.id, answers: [],
    }));

  const wOne = conversationWindow(await itemsOf(A, one.id), NO_RUNS);
  const wTwo = conversationWindow(await itemsOf(A, two.id), NO_RUNS);
  check("two threads on one agent keep independent context",
    wOne.messages.some((m) => m.content.includes("postgres")) && !wOne.messages.some((m) => m.content.includes("redis"))
    && wTwo.messages.some((m) => m.content.includes("redis")) && !wTwo.messages.some((m) => m.content.includes("postgres")),
    [wOne.messages, wTwo.messages]);

  // AND FROM ANOTHER WORKSPACE THERE IS NOTHING TO READ. Absent rather than forbidden, which is
  // this codebase's rule everywhere an id crosses a tenant boundary — a refusal would confirm the
  // id exists somewhere.
  const across = conversationWindow(await itemsOf(B, one.id), NO_RUNS);
  check("a thread in A is invisible from B", across.messages.length === 0, across.messages);
  check("...and it reads as empty rather than as a refusal", across.truncated === false);

  await db.close();
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
