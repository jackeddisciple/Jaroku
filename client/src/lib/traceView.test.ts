// The trace, shaped for reading: the tree, what a filter shows, the totals and the timing.
//
// The fixtures are the shapes a real run produces — a node step with the model call and the router
// that ran inside it, a tool call that failed inside a node that did not, `started_at` stamped when
// each step FINISHED — because every rule here exists for one of those shapes.
//
//   npm run test:trace-view

import { useTraceStore, visibleTraceRows } from "../store/traceStore.ts";
import { traceMarks } from "../components/traceMarks.ts";
import { outcomePhase, runOutcome } from "./runOutcome.ts";
import { answerPreview } from "../components/TraceResult.tsx";
import { STATUS, STEP_HUE } from "./tokens.ts";
import type { Step } from "../types.ts";
import {
  ancestorIds,
  buildTraceTree,
  descendantSteps,
  errorParts,
  filterCounts,
  isInherited,
  jsonReply,
  matchPlaces,
  matchesQuery,
  ownSteps,
  runElapsed,
  runWindow,
  stepCategory,
  stepProvider,
  stepOutputText,
  stepWindow,
  traceTotals,
  visibleRows,
} from "./traceView.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const mk = (over: Partial<Step> & Pick<Step, "id" | "seq">): Step => ({
  run_id: "r", type: "state_update", name: "node", input: null, output: null, state_before: null,
  state_after: null, tokens: null, cost: null, latency_ms: 0, error: null, parent_step_id: null,
  started_at: "2026-10-09T05:24:47.000Z", ...over,
});

// One agent turn and one tool turn, as run bf13d39c traced them.
const agent = mk({ id: "a", seq: 0, name: "agent", latency_ms: 2486, started_at: "2026-10-09T05:24:47.476Z" });
const llm = mk({
  id: "l", seq: 1, type: "llm_call", name: "ChatAnthropic", parent_step_id: "a", latency_ms: 2475,
  tokens: 1572, cost: 0.004344, started_at: "2026-10-09T05:24:47.466Z", input: [{ role: "user", content: "parse the queue" }],
});
const route = mk({ id: "r1", seq: 2, type: "router", name: "should_continue", parent_step_id: "a", latency_ms: 0.05 });
const tools = mk({ id: "t", seq: 3, name: "tools", latency_ms: 4.3, started_at: "2026-10-09T05:24:48.990Z" });
const parse = mk({
  id: "p", seq: 4, type: "tool_call", name: "parse_readings", parent_step_id: "t", latency_ms: 0.7,
  error: "RuntimeError: No parsable readings found", output: "readings: none",
});
const steps = [agent, llm, route, tools, parse];

console.log("the tree");
{
  const tree = buildTraceTree([parse, route, tools, llm, agent]);
  check("every step once", tree.length === steps.length, String(tree.length));
  check("parents before children, siblings by seq",
    tree.map((r) => r.step.id).join(",") === "a,l,r1,t,p", tree.map((r) => r.step.id).join(","));
  check("children sit one level down", tree.find((r) => r.step.id === "l")?.depth === 1);
  check("a node lists its children in order", tree[0]!.childIds.join(",") === "l,r1");
  check("the last child is marked", tree.find((r) => r.step.id === "r1")!.lastChild && !tree.find((r) => r.step.id === "l")!.lastChild);
  check("a root carries no path; a child carries its own place",
    tree[0]!.lastPath.length === 0 && tree.find((r) => r.step.id === "l")!.lastPath.join() === "false");
  const deep = buildTraceTree([
    mk({ id: "n", seq: 0 }), mk({ id: "c1", seq: 1, parent_step_id: "n" }), mk({ id: "g", seq: 2, parent_step_id: "c1" }),
    mk({ id: "c2", seq: 3, parent_step_id: "n" }),
  ]);
  check("a grandchild's path says its parent has a sibling below",
    deep.find((r) => r.step.id === "g")!.lastPath.join() === "false,true", deep.find((r) => r.step.id === "g")!.lastPath.join());
  check("descendants are everything under a row",
    descendantSteps(deep, "n").map((s) => s.id).join() === "c1,g,c2" && descendantSteps(deep, "c2").length === 0);

  // A live run: the model call has finished, the node it ran inside has not.
  const live = buildTraceTree([llm, route]);
  check("a child whose parent has not arrived is a root, not lost",
    live.length === 2 && live.every((r) => r.depth === 0 && r.parentId === null));

  const self = buildTraceTree([mk({ id: "x", seq: 0, parent_step_id: "x" })]);
  check("a step naming itself as parent is a root", self.length === 1 && self[0]!.depth === 0);

  const cycle = buildTraceTree([mk({ id: "c1", seq: 0, parent_step_id: "c2" }), mk({ id: "c2", seq: 1, parent_step_id: "c1" })]);
  check("a cycle strands nothing", cycle.length === 2, String(cycle.length));

  check("a model call's provider comes from its class", stepProvider(llm, "openai") === "anthropic");
  check("...then from the run", stepProvider(mk({ id: "m", seq: 0, type: "llm_call", name: "chat_model" }), "OpenAI") === "openai");
  check("...and a node has none", stepProvider(agent, "anthropic") === null);

  const legacy = mk({ id: "old", seq: 0, type: "tool" as Step["type"] });
  check("an unknown type is `other`, not a crash", stepCategory(legacy) === "other");
}

console.log("\nwhat is on screen");
{
  const tree = buildTraceTree(steps);
  check("unfiltered, everything", visibleRows(tree).length === 5);

  const folded = visibleRows(tree, { collapsed: { a: true } });
  check("a folded node hides its children and nothing else",
    folded.map((r) => r.step.id).join(",") === "a,t,p", folded.map((r) => r.step.id).join(","));
  check("...and says it is folded", folded[0]!.collapsed && !folded[1]!.collapsed);
  check("folding a childless step changes nothing", visibleRows(tree, { collapsed: { p: true } }).length === 5);

  const llmOnly = visibleRows(tree, { filter: "llm" });
  check("a filter keeps the match and its node", llmOnly.map((r) => r.step.id).join(",") === "a,l");
  check("...with the node marked as context", llmOnly[0]!.context && !llmOnly[1]!.context);

  const drawn = visibleRows(tree, { filter: "llm" });
  check("a step whose sibling is filtered out is drawn as the last one",
    drawn.find((r) => r.step.id === "l")!.lastChild === true);
  check("...and its node knows a step is drawn under it", drawn.find((r) => r.step.id === "a")!.shownChildren);
  const stateOnly = visibleRows(tree, { filter: "state" });
  check("a node whose steps are all hidden draws no line down", stateOnly.every((r) => !r.shownChildren));
  check("a folded node draws no line down", !visibleRows(tree, { collapsed: { a: true } })[0]!.shownChildren);
  check("...and an open one does", visibleRows(tree)[0]!.shownChildren);

  const errors = visibleRows(tree, { filter: "errors", collapsed: { t: true } });
  check("a filter sees past a fold", errors.map((r) => r.step.id).join(",") === "t,p", errors.map((r) => r.step.id).join(","));

  check("a search finds a step by name", visibleRows(tree, { query: "PARSE_read" }).some((r) => r.step.id === "p"));
  check("...by its error", matchesQuery(parse, "no parsable"));
  check("...by its payload", matchesQuery(llm, "the queue"));
  check("...by its seq", matchesQuery(route, "#2"));
  check("a search that matches nothing shows nothing", visibleRows(tree, { query: "zzz-nothing" }).length === 0);

  const counts = filterCounts(steps);
  check("counts per filter",
    counts.all === 5 && counts.llm === 1 && counts.tool === 1 && counts.state === 2 && counts.route === 1 && counts.errors === 1,
    JSON.stringify(counts));

  const bucket = Object.fromEntries(steps.map((s) => [s.id, s]));
  check("ancestors, nearest first", ancestorIds(bucket, "p").join(",") === "t" && ancestorIds(bucket, "l").join(",") === "a");
}

console.log("\ntotals");
{
  const t = traceTotals(steps);
  check("tokens come from the model calls alone", t.tokens === 1572, String(t.tokens));
  check("cost likewise", t.cost === 0.004344, String(t.cost));
  check("model calls counted", t.llmCalls === 1 && t.unpricedCalls === 0);

  const none = traceTotals([agent, tools]);
  check("nothing measured is null, never zero", none.tokens === null && none.cost === null && none.llmCalls === 0);

  const unpriced = traceTotals([mk({ id: "u", seq: 0, type: "llm_call", tokens: 300, cost: null })]);
  check("an unpriced call has tokens and no cost", unpriced.tokens === 300 && unpriced.cost === null && unpriced.unpricedCalls === 1);

  const zero = traceTotals([mk({ id: "z", seq: 0, type: "llm_call", tokens: 0, cost: 0 })]);
  check("a real zero stays a zero", zero.tokens === 0 && zero.cost === 0);
}

console.log("\ntime");
{
  const w = stepWindow(agent);
  check("started_at is the END; the start is that minus the duration",
    w !== null && w.end === Date.parse("2026-10-09T05:24:47.476Z") && w.end - w.start === 2486);
  const child = stepWindow(llm)!;
  check("so a node's window contains its model call's", child.start >= w!.start - 1 && child.end <= w!.end);
  check("an unreadable timestamp has no window", stepWindow(mk({ id: "b", seq: 0, started_at: "" })) === null);
  check("a negative duration has no window", stepWindow(mk({ id: "n", seq: 0, latency_ms: -5 })) === null);

  const run = { started_at: "2026-10-09T05:24:44.000Z", ended_at: "2026-10-09T05:24:49.000Z" };
  const rw = runWindow(run, steps, Date.now())!;
  check("a finished run spans its own start and end", rw.start === Date.parse(run.started_at) && rw.end === Date.parse(run.ended_at));
  const early = runWindow({ ...run, started_at: "2026-10-09T05:24:46.000Z" }, steps, 0)!;
  check("...widened when a step began before it", early.start === w!.start);
  const now = Date.parse("2026-10-09T05:25:00.000Z");
  check("a live run runs to now", runWindow({ ...run, ended_at: null }, steps, now)!.end === now);
  check("an unreadable run has no window", runWindow({ started_at: "nope", ended_at: null }, steps, now) === null);
}

console.log("\nerrors");
{
  const e = errorParts("RuntimeError: No parsable readings found");
  check("the class and the message", e.type === "RuntimeError" && e.message === "No parsable readings found" && e.detail === null);
  const s = errorParts('TimezoneNotFound: no IANA zone for "Atlantis"\n  at tools/city_time.py:41 in resolve_zone\n  at agent.py:88 in call_tool');
  check("a stack is the lines after the first", s.type === "TimezoneNotFound" && (s.detail ?? "").includes("city_time.py:41"));
  const nested = errorParts("BadRequestError: Error code: 400 - {'type': 'error'}");
  check("only the first colon splits", nested.type === "BadRequestError" && nested.message.startsWith("Error code: 400"));
  const plain = errorParts("interrupted by a server restart");
  check("a sentence has no class", plain.type === null && plain.message === "interrupted by a server restart");
  check("a lowercase lead is not a class", errorParts("cancelled by user: twice").type === null);
  check("nor is a capitalised word", errorParts("Cancelled: the run was stopped at a node boundary").type === null);
  check("a one-hump class with a class suffix is", errorParts("Exception: boom").type === "Exception");
}

console.log("\neach step's own mark and colour");
{
  const again = mk({ id: "a2", seq: 5, name: "agent" });
  const marks = traceMarks([...steps, again]);
  check("every distinct step has one", marks.has("agent") && marks.has("tools") && marks.has("parse_readings") && marks.has("should_continue"));
  check("...and model calls are left to their logos", !marks.has("ChatAnthropic"));
  const colours = [...marks.values()].map((m) => m.colour);
  check("no two distinct steps share a colour", new Set(colours).size === colours.length, colours.join());
  const icons = [...marks.values()].map((m) => m.Icon);
  check("...or a mark", new Set(icons).size === icons.length);
  check("a step that runs again keeps its look", traceMarks(steps).get("agent")!.colour === marks.get("agent")!.colour);
  check("no colour is a status colour",
    STEP_HUE.every((h) => ![STATUS.ok, STATUS.error, STATUS.pending].map((x) => x.toLowerCase()).includes(h.toLowerCase())));
}

console.log("\nthe store's rules for selection and folding");
{
  const run = "r";
  const bucket = Object.fromEntries(steps.map((s) => [s.id, s]));
  const reset = (): void => useTraceStore.setState({
    activeRunId: run, stepsByRun: { [run]: bucket }, selectedStepId: null, expandedStepId: null, collapsedStepIds: {},
    stepFilter: "all", stepQuery: "",
  });

  reset();
  useTraceStore.getState().setCollapsed("t", true);
  useTraceStore.getState().selectStep("p");
  check("selecting a step inside a fold unfolds it", !useTraceStore.getState().collapsedStepIds.t);

  reset();
  useTraceStore.getState().selectStep("l");
  useTraceStore.getState().setCollapsed("a", true);
  check("folding away the selected step selects its node", useTraceStore.getState().selectedStepId === "a");

  reset();
  useTraceStore.getState().selectStep("l");
  check("a plain selection opens nothing", useTraceStore.getState().expandedStepId === null);
  useTraceStore.getState().setExpandedStep("l");
  useTraceStore.getState().selectStep("r1");
  check("an open drawer follows the selection", useTraceStore.getState().expandedStepId === "r1");
  useTraceStore.getState().selectStep(null);
  check("...and clearing the selection leaves it alone", useTraceStore.getState().expandedStepId === "r1");

  reset();
  useTraceStore.getState().setCollapsed("a", true);
  check("the keyboard walks only what is drawn",
    visibleTraceRows({ ...useTraceStore.getState(), stepFilter: "all", stepQuery: "" }).map((r) => r.step.id).join() === "a,t,p");

  reset();
  useTraceStore.setState({ stepFilter: "llm", stepQuery: "" });
  check("...and only what the filter lets through",
    visibleTraceRows(useTraceStore.getState()).map((r) => r.step.id).join() === "a,l");
  useTraceStore.getState().selectStep("l");
  check("selecting a step the filter shows keeps the filter", useTraceStore.getState().stepFilter === "llm");
  useTraceStore.getState().selectStep("p");
  check("selecting one it hides sets the filter aside", useTraceStore.getState().stepFilter === "all");
  useTraceStore.setState({ stepFilter: "all", stepQuery: "no such words" });
  useTraceStore.getState().selectStep("t");
  check("...and the search too", useTraceStore.getState().stepQuery === "");

  reset();
  useTraceStore.setState({ stepFilter: "llm", stepQuery: "Chat" });
  useTraceStore.getState().selectRun(run);
  check("opening the run already on screen keeps its filter and search",
    useTraceStore.getState().stepFilter === "llm" && useTraceStore.getState().stepQuery === "Chat");
  useTraceStore.getState().setCollapsed("a", true);
  useTraceStore.getState().selectRun("another");
  check("opening another run sets the filter and search back",
    useTraceStore.getState().stepFilter === "all" && useTraceStore.getState().stepQuery === "");
  check("...and keeps the folds, which are this run's steps' own", useTraceStore.getState().collapsedStepIds.a === true);
  useTraceStore.setState({ stepFilter: "errors", stepQuery: "boom" });
  useTraceStore.getState().applyEvent({
    kind: "run_start", schema_version: 1,
    run: { id: "fresh", agent_id: "x", provider: "fake", model: "m", status: "running", started_at: new Date().toISOString(), ended_at: null, cost: 0, tokens: 0, error: null },
  });
  check("a run that starts and takes the screen starts unfiltered",
    useTraceStore.getState().stepFilter === "all" && useTraceStore.getState().stepQuery === "");
}

console.log("\na run starts once");
{
  const first = "2026-10-12T15:40:16.000Z";
  const resumedAt = "2026-10-12T15:40:55.000Z";
  const base = { id: "resumed", agent_id: "x", provider: "fake", model: "m", cost: 0, tokens: 0, error: null };
  useTraceStore.getState().applyEvent({ kind: "run_start", schema_version: 1, run: { ...base, status: "running", started_at: first, ended_at: null } });
  useTraceStore.getState().setRunStatus("resumed", "paused");
  useTraceStore.getState().setRunStatus("resumed", "running");
  // The resumed process's own Run, stamped when it started.
  useTraceStore.getState().applyEvent({ kind: "run_end", schema_version: 1, run: { ...base, status: "completed", started_at: resumedAt, ended_at: "2026-10-12T15:40:57.300Z" } });
  const after = useTraceStore.getState().runs["resumed"];
  check("a resumed run's end keeps its first start", after?.started_at === first, after?.started_at);
  check("...and takes the rest of the end", after?.status === "completed" && after.ended_at === "2026-10-12T15:40:57.300Z");
  useTraceStore.getState().applyEvent({ kind: "run_end", schema_version: 1, run: { ...base, id: "unseen", status: "completed", started_at: resumedAt, ended_at: resumedAt } });
  check("a run heard of only at its end takes the end's start", useTraceStore.getState().runs["unseen"]?.started_at === resumedAt);
}

console.log("\nhow long a run has taken");
{
  const start = "2026-10-09T05:24:45.000Z";
  const later = Date.parse("2026-10-10T06:24:45.000Z"); // a day on, reopened from history
  const paused = { status: "paused" as const, started_at: start, ended_at: null };
  check("a paused run stops its clock at its last finished step, however late it is reopened",
    runElapsed(paused, steps, later) === Date.parse(tools.started_at) - Date.parse(start), String(runElapsed(paused, steps, later)));
  check("...and a paused run with no steps yet has taken nothing", runElapsed(paused, [], later) === 0);
  check("a running one counts to now", runElapsed({ ...paused, status: "running" }, steps, Date.parse(start) + 5000) === 5000);
  check("an ended one is its end less its start",
    runElapsed({ status: "completed", started_at: start, ended_at: "2026-10-09T05:24:54.400Z" }, steps, later) === 9400);
  check("unreadable times say nothing", runElapsed({ ...paused, started_at: "nope" }, steps, later) === null);
}

console.log("\na live run's delay, measured from its events");
{
  const t = useTraceStore.getState();
  const base = { id: "lagged", agent_id: "x", provider: "fake", model: "m", cost: 0, tokens: 0, error: null, status: "running" as const, ended_at: null };
  // Its start arrived 3s late (it sat in the runner's batch), its first step 0.7s late.
  t.applyEvent({ kind: "run_start", schema_version: 1, run: { ...base, started_at: new Date(Date.now() - 3000).toISOString() } });
  t.applyEvent({ kind: "step", schema_version: 1, step: mk({ id: "lag1", seq: 0, run_id: "lagged", started_at: new Date(Date.now() - 700).toISOString() }) });
  const lag = useTraceStore.getState().lagByRun["lagged"] ?? NaN;
  check("the smallest delay is kept, not the latest", lag >= 690 && lag < 1500, String(lag));
  t.applyEvent({ kind: "step", schema_version: 1, step: mk({ id: "lag2", seq: 1, run_id: "lagged", started_at: new Date(Date.now() - 5000).toISOString() }) });
  check("...so a step that waited in a batch does not raise it", (useTraceStore.getState().lagByRun["lagged"] ?? NaN) === lag);
  for (let i = 0; i < 80; i++) t.applyEvent({ kind: "run_start", schema_version: 1, run: { ...base, id: `many-${i}`, started_at: new Date().toISOString() } });
  check("it is bounded", Object.keys(useTraceStore.getState().lagByRun).length === 50);
}

console.log("\na branch's inherited steps");
{
  // Branched at #1's boundary: #0 and #1 were copied from the parent, 40s before the branch began.
  const branch = { parent_run_id: "bec57d6c", branch_from_seq: 1, started_at: "2026-10-12T14:11:02.000Z", ended_at: "2026-10-12T14:11:17.200Z" };
  const old0 = mk({ id: "i0", seq: 0, latency_ms: 2000, started_at: "2026-10-12T14:10:22.860Z" });
  const old1 = mk({ id: "i1", seq: 1, type: "llm_call", parent_step_id: "i0", latency_ms: 1900, tokens: 545, cost: 0.00144, started_at: "2026-10-12T14:10:22.800Z" });
  const own2 = mk({ id: "o2", seq: 2, latency_ms: 3000, started_at: "2026-10-12T14:11:06.000Z" });
  const all = [old0, old1, own2];
  check("its copied prefix is inherited", isInherited(old0, branch) && isInherited(old1, branch));
  check("...and what it ran is not", !isInherited(own2, branch));
  check("a run that is not a branch inherits nothing", !isInherited(old0, { parent_run_id: null, branch_from_seq: null }) && !isInherited(old0, undefined));
  check("its own steps leave the prefix out", ownSteps(branch, all).map((x) => x.id).join() === "o2");
  const span = runWindow(branch, ownSteps(branch, all), Date.now());
  check("its track starts when IT started, not at its parent's first step",
    span?.start === Date.parse(branch.started_at), String(span && new Date(span.start).toISOString()));
}

console.log("\na reply that is JSON");
{
  check("an object", JSON.stringify(jsonReply('{"must_haves": ["Python"]}')) === '{"must_haves":["Python"]}');
  check("an array", Array.isArray(jsonReply(" [1, 2] ")));
  check("in a json fence", JSON.stringify(jsonReply('```json\n{"a": 1}\n```')) === '{"a":1}');
  check("prose is not", jsonReply("Here is the shortlist: {see below}") === undefined);
  check("a bare string or number is not", jsonReply('"hi"') === undefined && jsonReply("42") === undefined);
  check("broken JSON is not", jsonReply('{"a": ') === undefined);
}

console.log("\na folded answer's one line");
{
  check("a heading's words", answerPreview("## Two queues are backing up:\n\n- **orders**: x") === "Two queues are backing up:");
  check("bold taken off", answerPreview("**Shortlist**: Ada") === "Shortlist: Ada");
  check("a link's words", answerPreview("- [Link](http://x) text") === "Link text");
  check("past a code fence's opening", answerPreview("```json\n{\"a\":1}\n```") === '{"a":1}');
  check("an identifier keeps its underscores", answerPreview("Use route_after_extract next") === "Use route_after_extract next");
  check("emphasis taken off", answerPreview("This is *really* _good_.") === "This is really good.");
}

console.log("\nwhere a search matched");
{
  check("in the name", matchPlaces(llm, "anthropic").join() === "name", matchPlaces(llm, "anthropic").join());
  check("in what went in", matchPlaces(llm, "queue").join() === "input", matchPlaces(llm, "queue").join());
  check("in the error and the output", matchPlaces(parse, "readings").join() === "name,error,output", matchPlaces(parse, "readings").join());
  check("by number", matchPlaces(tools, "#3").includes("id"));
  check("by kind", matchPlaces(route, "routing").includes("kind"));
  check("nowhere, for a step that does not match", matchPlaces(agent, "zebra").length === 0);
  check("nowhere, for no search", matchPlaces(agent, "  ").length === 0);
}

console.log("\nwhat Copy output copies");
{
  const reply = mk({ id: "c", seq: 9, type: "llm_call", output: [{ content: '{"requirement_results": {"5 years of Python": true}}' }] });
  check("a model call's reply, not the envelope it came in",
    stepOutputText(reply) === '{"requirement_results": {"5 years of Python": true}}', stepOutputText(reply));
  const blocks = mk({ id: "c2", seq: 10, type: "llm_call", output: [{ content: [{ type: "text", text: "Hello" }, { type: "thinking", thinking: "hm" }] }] });
  check("...its text blocks, without its thinking", stepOutputText(blocks) === "Hello", stepOutputText(blocks));
  const asked = mk({ id: "c3", seq: 11, type: "llm_call", output: [{ content: "", tool_calls: [{ name: "get_time", args: {} }] }] });
  check("...or the tool calls it asked for when it said nothing", stepOutputText(asked).includes('"get_time"') && !stepOutputText(asked).includes('"content"'));
  check("a node's output is the JSON it is", stepOutputText(mk({ id: "n", seq: 12, output: { a: 1 } })) === '{\n  "a": 1\n}');
  check("text is text", stepOutputText(parse) === "readings: none");
  check("nothing is nothing", stepOutputText(agent) === "");
}

console.log("\none word for how a run went, on every surface");
{
  const paused = { status: "paused" as const, error: null };
  const stopped = { status: "error" as const, error: "cancelled by user" };
  const failed = { status: "error" as const, error: "ValueError: no" };
  check("a paused run is paused, not stopped", runOutcome(paused) === "paused" && outcomePhase(paused) === "halted");
  check("a run somebody stopped is stopped, not failed", runOutcome(stopped) === "stopped" && outcomePhase(stopped) === "halted");
  check("a failed run is failed", runOutcome(failed) === "failed" && outcomePhase(failed) === "failed");
  check("a completed run is finished", runOutcome({ status: "completed", error: null }) === "finished");
  check("a running one is running", runOutcome({ status: "running", error: null }) === "running");
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
