// The trace, shaped for reading: the tree, what a filter shows, the totals and the timing.
//
// The fixtures are the shapes a real run produces — a node step with the model call and the router
// that ran inside it, a tool call that failed inside a node that did not, `started_at` stamped when
// each step FINISHED — because every rule here exists for one of those shapes.
//
//   npm run test:trace-view

import { failedStepIds, jumpToError, treeSteps, useTraceStore, visibleTraceRows } from "../store/traceStore.ts";
import { graphLook, kindWord, traceMarks } from "../components/traceMarks.ts";
import { nodeKind } from "../components/graphNodeIcons.ts";
import { outcomePhase, runOutcome } from "./runOutcome.ts";
import { agentTrend, branchFigures, compareRuns, finalState, runArtifacts } from "./traceCompare.ts";
import { isVerdict, readVerdict, verdictTone } from "./runVerdict.ts";
import { answerPreview } from "../components/TraceResult.tsx";
import { STATUS, STEP_HUE } from "./tokens.ts";
import type { RunSummary, Step } from "../types.ts";
import {
  ancestorIds,
  awaitingNode,
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
  rerunBlocked,
  hotSteps,
  stepHeat,
  stepOutputText,
  stepsTime,
  stepWindow,
  traceSections,
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
  useTraceStore.getState().selectStep("p");
  useTraceStore.getState().setAllCollapsed(true);
  check("collapse all folds every node", useTraceStore.getState().collapsedStepIds.a === true && useTraceStore.getState().collapsedStepIds.t === true);
  check("...and moves a hidden selection up to its node", useTraceStore.getState().selectedStepId === "t");
  useTraceStore.getState().setAllCollapsed(false);
  check("expand all unfolds them", Object.keys(useTraceStore.getState().collapsedStepIds).length === 0);

  reset();
  check("the failures, in the order they are drawn", failedStepIds(useTraceStore.getState()).join() === "p");
  useTraceStore.getState().setCollapsed("t", true);
  useTraceStore.getState().selectStep("a");
  check("E goes to the next failure", jumpToError(1) && useTraceStore.getState().selectedStepId === "p");
  check("...unfolding the node it is in", !useTraceStore.getState().collapsedStepIds.t);
  check("...and wraps round to it again", jumpToError(1) && useTraceStore.getState().selectedStepId === "p");
  check("Shift+E goes back the same way", jumpToError(-1) && useTraceStore.getState().selectedStepId === "p");
  useTraceStore.setState({ stepsByRun: { [run]: Object.fromEntries(steps.filter((x) => !x.error).map((x) => [x.id, x])) } });
  check("with nothing failed it does nothing", !jumpToError(1));

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

console.log("\nhow long the steps themselves took");
{
  // agent (2486ms, its model call inside it) and tools (4.3ms, its tool call inside it).
  check("the top-level steps, their insides not counted again", Math.abs(stepsTime(steps) - (2486 + 4.3)) < 1e-9, String(stepsTime(steps)));
  check("no steps, no time", stepsTime([]) === 0);
}

console.log("\nhow hot a step runs");
{
  const scale = { cost: 0.01, time: 2000 };
  check("the costliest is fully hot", stepHeat({ cost: 0.01, latency_ms: 10 }, scale) === 1);
  check("the slowest too", stepHeat({ cost: null, latency_ms: 2000 }, scale) === 1);
  check("half of either is half", stepHeat({ cost: 0.005, latency_ms: 100 }, scale) === 0.5);
  check("asked for cost alone, time does not count", stepHeat({ cost: null, latency_ms: 2000 }, scale, "cost") === 0);
  check("an empty run is cold", stepHeat({ cost: 1, latency_ms: 1 }, { cost: 0, time: 0 }) === 0);
  const even = [1, 2, 3, 4, 5, 6].map((i) => mk({ id: `e${i}`, seq: i, latency_ms: 1000 + i }));
  const hotOnes = hotSteps(even, { cost: 0, time: 1006 });
  check("a run of even steps warms only its slowest three", hotOnes.size === 3 && hotOnes.has("e6") && !hotOnes.has("e1"), [...hotOnes.keys()].join());
  const byTime = hotSteps(even, { cost: 0, time: 1006 }, 3, "time");
  check("pressed by one metric, every step with any of it is warm", byTime.size === 6 && (byTime.get("e1") ?? 0) > 0.99, [...byTime.keys()].join());
  check("...and a metric no step has warms none", hotSteps(even, { cost: 0, time: 1006 }, 3, "cost").size === 0);
}

console.log("\na long run in sections");
{
  // extract_jd, extract_resume, score_candidate, decline_note — each a node with a model call inside.
  const names = ["extract_jd", "extract_resume", "score_candidate", "decline_note"];
  const many: Step[] = [];
  names.forEach((n, i) => {
    many.push(mk({ id: `n${i}`, seq: i * 2, name: n }));
    many.push(mk({ id: `c${i}`, seq: i * 2 + 1, type: "llm_call", name: "ChatAnthropic", parent_step_id: `n${i}` }));
  });
  const rows = visibleRows(buildTraceTree(many));
  check("a short run has none", traceSections(rows, many.length, nodeKind) === null);
  const secs = traceSections(rows, 40, nodeKind) ?? [];
  check("runs of one kind make one section, in order", secs.map((x) => x.label).join() === "Extraction,Scoring,Writing", secs.map((x) => x.label).join());
  check("...holding their nodes and what ran inside them", secs[0]?.steps === 4 && secs[0]?.rows.length === 4);
  check("...keyed by their first node", secs[0]?.key === "n0" && secs[2]?.key === "n3");
  // A loop does not regroup: agent, tools, agent is three sections, not two.
  const loop = visibleRows(buildTraceTree([mk({ id: "x1", seq: 0, name: "agent" }), mk({ id: "x2", seq: 1, name: "tools" }), mk({ id: "x3", seq: 2, name: "agent" })]));
  check("a loop keeps the order it ran in", (traceSections(loop, 40, nodeKind) ?? []).length === 3);
}

console.log("\na branch against its parent, and what a run made");
{
  const p0 = mk({ id: "p0", seq: 0, name: "extract_jd", output: { a: 1 }, latency_ms: 1000 });
  const p1 = mk({ id: "p1", seq: 1, type: "llm_call", name: "ChatAnthropic", parent_step_id: "p0", cost: 0.002, output: [{ content: '{"must_haves": ["Python"]}' }] });
  const p2 = mk({ id: "p2", seq: 2, name: "score", output: { score: 70 }, state_after: { score: 70, jd: { must: ["Python"] } } });
  const b0 = { ...p0, id: "b0", run_id: "b" };
  const b1 = { ...p1, id: "b1", run_id: "b", parent_step_id: "b0" };
  const b2 = mk({ id: "b2", seq: 2, name: "score", output: { score: 92 }, latency_ms: 400, state_after: { score: 92, jd: { must: ["Python"] } } });
  const pairs = compareRuns([p0, p1, p2], [b0, b1, b2]);
  check("steps pair by kind, name and position", pairs.length === 3 && pairs[2]?.parent?.id === "p2" && pairs[2]?.own?.id === "b2");
  check("an inherited step is the same", !pairs[0]?.inputChanged && !pairs[0]?.outputChanged);
  check("a re-run step says its output changed", pairs[2]?.outputChanged === true);
  check("...and how its time moved (this run less the parent)", pairs[2]?.latencyDelta === 400);
  const extra = compareRuns([p0], [b0, mk({ id: "x", seq: 1, name: "extra" })]);
  check("a step only one run has is listed on its side", extra.some((x) => x.own?.id === "x" && !x.parent));
  check("the final state is the last node's update on what it started from", JSON.stringify(finalState([b0, b1, b2])) === JSON.stringify(b2.state_after));
  const appended = finalState([mk({ id: "z", seq: 0, state_before: { messages: [1], readings: [1] }, state_after: { messages: [2], readings: [9] } })]);
  check("...its messages appended, its other fields replaced", JSON.stringify(appended) === '{"messages":[1,2],"readings":[9]}', JSON.stringify(appended));
  // Like for like: the parent from the fork on against the branch's own.
  const runOf = (over: Partial<RunSummary> & Pick<RunSummary, "id">): RunSummary => ({
    agent_id: "ag", provider: "anthropic", model: "m", status: "completed", started_at: "2026-10-09T05:00:00.000Z",
    ended_at: "2026-10-09T05:00:10.000Z", cost: 0, tokens: 0, error: null, ...over,
  });
  const fp0 = mk({ id: "f0", seq: 0, cost: 0.01, tokens: 100, latency_ms: 2000, started_at: "2026-10-09T05:00:02.000Z" });
  const fp1 = mk({ id: "f1", seq: 1, cost: 0.004, tokens: 40, latency_ms: 8000, started_at: "2026-10-09T05:00:10.000Z" });
  const parentRun = runOf({ id: "P" });
  const branchRun = runOf({ id: "B", parent_run_id: "P", branch_from_seq: 0, started_at: "2026-10-09T06:00:00.000Z", ended_at: "2026-10-09T06:00:05.000Z" });
  const fb0 = { ...fp0, id: "g0", run_id: "B" };
  const fb1 = mk({ id: "g1", seq: 1, run_id: "B", cost: 0.003, tokens: 30, latency_ms: 4000, started_at: "2026-10-09T06:00:05.000Z" });
  const vs = branchFigures(branchRun, [fb0, fb1], parentRun, [fp0, fp1]);
  check("a branch's cost is set against the parent's from the fork on, not its whole run", vs?.theirs.cost === 0.004 && vs?.mine.cost === 0.003, JSON.stringify(vs));
  check("...and so are its tokens", vs?.theirs.tokens === 40 && vs?.mine.tokens === 30);
  check("...and its time: the parent's from the fork's end to its own", vs?.theirs.time === 8000 && vs?.mine.time === 5000, JSON.stringify(vs));
  check("a run that is not a branch has no parent to answer to", branchFigures(parentRun, [fp0], parentRun, [fp0]) === null);
  const history: Record<string, RunSummary> = {
    a: runOf({ id: "a", started_at: "2026-10-09T01:00:00.000Z", ended_at: "2026-10-09T01:00:04.000Z", cost: 1 }),
    b: runOf({ id: "b", started_at: "2026-10-09T02:00:00.000Z", ended_at: "2026-10-09T02:00:02.000Z", cost: 2 }),
    c: runOf({ id: "c", started_at: "2026-10-09T03:00:00.000Z", ended_at: "2026-10-09T03:00:01.000Z", cost: 3 }),
    later: runOf({ id: "later", started_at: "2026-10-09T04:00:00.000Z", cost: 9 }),
    other: runOf({ id: "other", agent_id: "zz", started_at: "2026-10-09T02:30:00.000Z", cost: 7 }),
  };
  const trend = agentTrend(history, history.c!, "cost");
  check("the trend is the agent's finished runs up to this one, oldest first", trend.map((t) => t.runId).join() === "a,b,c", trend.map((t) => t.runId).join());
  check("...by the figure asked for", agentTrend(history, history.c!, "time").map((t) => t.value).join() === "4000,2000,1000");
  check("...and at most n of them", agentTrend(history, history.c!, "cost", 2).map((t) => t.runId).join() === "b,c");
  const arts = runArtifacts([p0, p1, p2]);
  check("a JSON reply is an artifact, named for its node", arts[0]?.title === "extract_jd" && JSON.stringify(arts[0]?.value) === '{"must_haves":["Python"]}');
  check("...and so is a structured state field", arts.some((a) => a.title === "jd"));
  check("...but not a scalar one", !arts.some((a) => a.title === "score"));
}

console.log("\nwhat a run decided");
{
  const screened = readVerdict(
    { decision: "advance", score: 92, requirements: [{ name: "5+ yrs Python", met: true }, { name: "PostgreSQL", met: true }, { name: "AWS", met: false }], reasoning: "Strong backend history across three roles, with Postgres at scale." },
    "",
  );
  check("a decision and a score in the state are a verdict", isVerdict(screened) && screened.decision === "advance" && screened.score === "92");
  check("...its requirements read as met and not", screened?.requirements.map((r) => `${r.met ? "+" : "-"}${r.label}`).join() === "+5+ yrs Python,+PostgreSQL,-AWS", screened?.requirements.map((r) => r.label).join());
  check("...and its reasoning field is the reasoning", screened?.reasoning?.startsWith("Strong backend") === true);
  const nested = readVerdict({ evaluation: { verdict: "Reject", fit_score: 0.41, must_haves: { python: true, aws: "missing" } } }, "");
  check("a verdict a level down, its fraction a percentage", nested?.decision === "Reject" && nested.score === "41" && nested.tone === "reject");
  check("...requirements as a map, named by their field", nested?.noun === "must-haves" && nested.requirements.length === 2 && !nested.requirements[1]!.met);
  const prose = readVerdict(null, "**Decision:** Advance (strong fit)\nScore: 88/100\n\n- ✓ Python\n- ✗ Kubernetes\n\nThe candidate has deep Python experience.");
  check("prose: Decision: and Score: lines", prose?.decision === "Advance" && prose.score === "88/100", JSON.stringify(prose));
  check("...and its ✓ / ✗ lines", prose?.requirements.map((r) => `${r.met ? "+" : "-"}${r.label}`).join() === "+Python,-Kubernetes");
  const matchedMissing = readVerdict({ recommendation: "interview", matched: ["Go", "gRPC"], missing: ["Rust"] }, "");
  check("matched / missing lists are requirements met and not", matchedMissing?.requirements.length === 3 && matchedMissing.requirements[2]?.met === false);
  check("an ordinary answer is no verdict", !isVerdict(readVerdict({ messages: [], readings: [1, 2] }, "Two queues are backing up.")));
  check("a status field is not a decision", !isVerdict(readVerdict({ status: "done" }, "")));
  check("advance words read as advance", verdictTone("Advance to onsite") === "advance" && verdictTone("Strong yes") === "advance");
  check("reject words as reject, a negated advance too", verdictTone("decline") === "reject" && verdictTone("Do not advance") === "reject" && verdictTone("No hire") === "reject");
  check("anything else is neither", verdictTone("hold for review") === "other");
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

console.log("\na node looks the same in the trace as on the graph");
{
  const graph = {
    agent_id: "x",
    nodes: [
      { id: "__start__", type: "start" }, { id: "agent", type: "step", calls_model: true },
      { id: "tools", type: "tool" }, { id: "__end__", type: "end" },
    ],
    edges: [
      { source: "__start__", target: "agent", conditional: false, label: null },
      { source: "agent", target: "tools", conditional: false, label: null },
      { source: "tools", target: "__end__", conditional: false, label: null },
    ],
  };
  const look = graphLook(graph);
  const marks = traceMarks(steps, [], look);
  const node = look?.marks.get("agent");
  check("a node step takes the graph's own mark", node !== undefined && marks.get("agent")?.Icon === node.Icon);
  check("...and its colour", node?.kind === "glyph" && marks.get("agent")?.colour === node.hue);
  check("...and its word", kindWord(agent, marks.get("agent")) === "Model call" && kindWord(tools, marks.get("tools")) === "Tool node");
  check("a step the graph has no node for keeps the trace's own", kindWord(parse, marks.get("parse_readings")) === "Tool call" && marks.has("parse_readings"));
  check("...and so does every step with no graph at hand", kindWord(agent, traceMarks(steps).get("agent")) === "State update");
  check("no graph, no look", graphLook(undefined) === null && graphLook({ agent_id: "x", error: "boom" }) === null);
}

console.log("\na live step whose node has not landed");
{
  // The model call and router of the node running now (#0, not here yet), and a tool call under that call.
  const early = mk({ id: "e1", seq: 1, type: "llm_call", parent_step_id: "running-node" });
  const underEarly = mk({ id: "e2", seq: 2, type: "tool_call", parent_step_id: "e1" });
  const landed = [tools, parse];
  const waiting = awaitingNode([...landed, early, underEarly]);
  check("it waits, and so does a step inside it", waiting.has("e1") && waiting.has("e2"));
  check("...and nothing whose node is here", !waiting.has("t") && !waiting.has("p"));
  check("while the run runs, the tree leaves it to the live tail",
    treeSteps([...landed, early, underEarly], { status: "running" }).map((x) => x.id).join() === "t,p");
  check("once it is over, a missing parent is missing, and the step is a root",
    treeSteps([...landed, early, underEarly], { status: "completed" }).length === 4);
  check("a step naming itself does not wait", awaitingNode([mk({ id: "self", seq: 0, parent_step_id: "self" })]).size === 0);
}

console.log("\nwhether a step can be re-run from");
{
  const idle = [{ status: "completed" as const }, { status: "paused" as const }];
  check("a stamped step can", rerunBlocked({ seq: 3, checkpoint_id: "c1" }, idle) === null);
  check("one that streamed in live is left to the server", rerunBlocked({ seq: 3 }, idle) === null);
  check("one loaded with no checkpoint cannot, and says why", (rerunBlocked({ seq: 7, checkpoint_id: null }, idle) ?? "").includes("No checkpoint"));
  check("...unless a boundary at or after it has been seen since", rerunBlocked({ seq: 7, checkpoint_id: null }, idle, 7) === null);
  check("nothing can while a run is going", (rerunBlocked({ seq: 3, checkpoint_id: "c1" }, [...idle, { status: "running" as const }]) ?? "").includes("A run is going"));
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
