// The action vocabulary, and the Activity tab's join onto it.
//
// §4'S RULE IS THE ONE THIS SUITE HOLDS: "Extend lib/actionIcons.tsx rather than defining a second
// icon for an action that already has one." A second registry is not a thing anybody adds on
// purpose — it is what happens when a new surface needs a verb the old table did not have, and the
// easiest fix is a new table beside it. Nine kinds mapping onto the existing eleven is the claim,
// and it is checked rather than described.
//
// AND THE TENSE. This tab is entirely historical, so every row is past tense — a feed that said
// "Deploying" about last Tuesday would be the same category error as amber on a dashboard, which
// §3.7 rules out for the same reason.
//
//   npm run test:action-icons

import {
  FEED_KINDS,
  actionForFeedKind,
  actionForStep,
  actionForToolOrigin,
  actionKindForStep,
  type FeedKind,
} from "./actionIcons.tsx";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("\nevery feed kind narrates itself");
{
  check("nine kinds, matching the server's union", FEED_KINDS.length === 9);
  for (const kind of FEED_KINDS) {
    const a = actionForFeedKind(kind);
    check(
      `${kind} has an icon, a verb and an accent`,
      typeof a.verb === "string" && a.verb.length > 0 && typeof a.accent === "string" && !!a.Icon,
      JSON.stringify({ verb: a.verb, accent: a.accent }),
    );
  }
}

console.log("\nthe tense is the past, because nothing on this tab is happening");
{
  // A live verb is the same category error as amber on a historical dashboard — see §3.7.
  const present = FEED_KINDS.filter((k) => actionForFeedKind(k).verb.endsWith("ing"));
  check("no verb is a participle", present.length === 0, present.join(", "));
}

console.log("\nthe feed borrows the trace's vocabulary rather than inventing one");
{
  // THE ASSERTION §4 ASKS FOR, spelled out: a confirmation row and the trace row that produced it
  // are the same tool call, so they must read identically. "Called get_time" in both places.
  const confirm = actionForFeedKind("mcp_confirm");
  const traceCall = actionForStep({ type: "tool_call" });
  check("a confirmation row reads exactly like the trace's tool call", confirm.verb === traceCall.verb);
  check("...with the same icon", confirm.Icon === traceCall.Icon);
  check("...and the same accent", confirm.accent === traceCall.accent);

  // A run is the model doing work, which is what `generate` has meant since v0.2.2.
  check("a run borrows the model-call accent", actionForFeedKind("run").accent === actionForStep({ type: "llm_call" }).accent);
  // A branch is a fork in the graph, which is the router's mark.
  check("a branch borrows the router's", actionForFeedKind("branch").accent === actionForStep({ type: "router" }).accent);
  check("...and the router's icon", actionForFeedKind("branch").Icon === actionForStep({ type: "router" }).Icon);
}

console.log("\nthe two verbs the vocabulary did not have are overrides, not new kinds");
{
  // "Published" and "Undid" describe things done to a VERSION; the eleven kinds are about what an
  // agent did while running. The override is `ActionRow`'s own `verb` mechanism.
  check("a publish says so", actionForFeedKind("version").verb === "Published");
  check("an undo says so", actionForFeedKind("edit_undone").verb === "Undid");
  // ...while still wearing the mark of the kind they belong to, so the column stays legible.
  check("a publish keeps the write mark", actionForFeedKind("version").accent === actionForFeedKind("edit").accent);
}

console.log("\nnothing about the existing vocabulary moved");
{
  // The join must not have changed what the trace, the plan card or the graph already say.
  check("a model call is still Generated", actionForStep({ type: "llm_call" }).verb === "Generated");
  check("a tool call is still Called", actionForStep({ type: "tool_call" }).verb === "Called");
  check("a state update is still Updated", actionForStep({ type: "state_update" }).verb === "Updated");
  check("a router is still Routed", actionForStep({ type: "router" }).verb === "Routed");
  check("a step still resolves to a kind", actionKindForStep({ type: "tool_call" }) === "call");
  // And the plan card's three origins, which are the other consumer of this table.
  check("a reviewed tool still says Calls", actionForToolOrigin("connector").verb === "Calls");
  check("...and an MCP tool wears the MCP accent", actionForToolOrigin("mcp").accent !== actionForToolOrigin("connector").accent);
}

console.log("\nan unknown kind does not render a blank row");
{
  // A server running ahead of a client is the rolling-deploy window, and the honest failure mode is
  // a row with a generic mark rather than one with no icon at all.
  const unknown = actionForFeedKind("something_new" as FeedKind);
  check("it still has an icon and a verb", !!unknown.Icon && unknown.verb.length > 0);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
// The same exit the other client suites use: this runs under tsx with no node types in scope.
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
