// What an agent did, as a fixed vocabulary.
//
// The app narrates the same handful of actions in four places — the trace timeline, the plan
// card, the generation progress list, the graph — and each one picked its own words and its own
// glyph for them. A model call was `✦` in the step-detail header, a blue `llm_call` badge in the
// timeline, a sparkle in the plan card and a robot in the graph. Four marks, one idea.
//
// So: one table. A kind of action has ONE icon, ONE verb and ONE accent, everywhere it appears.
// A reader learns the vocabulary once and it keeps working when they move panels.
//
// Two verbs per kind, because the same action reads differently depending on whether it is
// happening or has happened, and the difference is the most useful thing a live view can say.
// "Writing agent.py" and "Wrote agent.py" are the whole of a progress indicator.
//
// Colours are borrowed, never invented. The four step kinds keep exactly the STEP_TYPE accents
// the trace timeline already used, so nothing about a familiar trace changes colour; the rest
// reach for existing category accents and status colours.

import type { Step } from "../types.ts";
import { ACCENT, STATUS, STEP_TYPE, TEXT } from "./tokens.ts";
import { iconForPath } from "../components/fileIcons.tsx";
import {
  AlertTriangleIcon,
  CheckIcon,
  ClockIcon,
  DatabaseIcon,
  EyeIcon,
  GitBranchIcon,
  PlugIcon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
  WrenchIcon,
} from "../components/panelIcons.tsx";

export type ActionKind =
  /** Looked at something without changing it — a file, a record, a page. */
  | "read"
  /** Looked for something. Distinct from `read`: a search may find nothing. */
  | "search"
  /** Invoked a tool. */
  | "call"
  /** Chose a path. A conditional edge, a router, a branch. */
  | "decide"
  /** A model produced text. */
  | "generate"
  /** Put something on disk. */
  | "write"
  /** Changed the agent's own state. */
  | "update"
  /** Reached a third-party server. */
  | "connect"
  /** Not started, or waiting on somebody. */
  | "wait"
  /** Finished, successfully. */
  | "done"
  /** Did not finish. */
  | "fail";

export type ActionDescriptor = {
  /** The icon, drawn from the app's one set at the app's one stroke weight. */
  Icon: (p: { size?: number }) => React.ReactElement;
  /** Past tense — what it did. */
  verb: string;
  /** Present participle — what it is doing, for a row that is still live. */
  verbing: string;
  /** The accent the icon takes. Never the row's text colour, which stays on the ink ladder. */
  accent: string;
};

const ACTION: Record<ActionKind, ActionDescriptor> = {
  read: { Icon: EyeIcon, verb: "Read", verbing: "Reading", accent: TEXT.muted },
  search: { Icon: SearchIcon, verb: "Searched", verbing: "Searching", accent: TEXT.muted },
  call: { Icon: WrenchIcon, verb: "Called", verbing: "Calling", accent: STEP_TYPE.tool_call.fg },
  decide: { Icon: GitBranchIcon, verb: "Routed", verbing: "Routing", accent: STEP_TYPE.router.fg },
  generate: {
    Icon: SparklesIcon,
    verb: "Generated",
    verbing: "Generating",
    accent: STEP_TYPE.llm_call.fg,
  },
  write: { Icon: SparklesIcon, verb: "Wrote", verbing: "Writing", accent: ACCENT.bespoke },
  update: {
    Icon: DatabaseIcon,
    verb: "Updated",
    verbing: "Updating",
    accent: STEP_TYPE.state_update.fg,
  },
  connect: { Icon: PlugIcon, verb: "Reached", verbing: "Reaching", accent: ACCENT.mcp },
  wait: { Icon: ClockIcon, verb: "Waited", verbing: "Waiting", accent: STATUS.pending },
  done: { Icon: CheckIcon, verb: "Finished", verbing: "Finishing", accent: STATUS.ok },
  fail: { Icon: AlertTriangleIcon, verb: "Failed", verbing: "Failing", accent: STATUS.error },
};

/** The one lookup. Everything else in this file is a way of arriving at a kind. */
export function actionFor(kind: ActionKind): ActionDescriptor {
  return ACTION[kind];
}

/** Trace step type → action kind. The frozen schema has four; so does this. */
const KIND_FOR_STEP: Record<Step["type"], ActionKind> = {
  llm_call: "generate",
  tool_call: "call",
  router: "decide",
  state_update: "update",
};

/**
 * How a trace step should narrate itself.
 *
 * A failed step keeps its own verb rather than becoming "Failed". What it was *trying* to do is
 * the useful half of a failure — "Called pg_query" that went red says more than "Failed" does —
 * and the row's state carries the outcome separately.
 */
export function actionForStep(step: Pick<Step, "type">): ActionDescriptor {
  return ACTION[KIND_FOR_STEP[step.type] ?? "update"];
}

/** Trace step type → action kind, for callers that need the kind rather than the descriptor. */
export function actionKindForStep(step: Pick<Step, "type">): ActionKind {
  return KIND_FOR_STEP[step.type] ?? "update";
}

/**
 * How a tool a plan proposes should narrate itself.
 *
 * The three origins planProtocol defines are genuinely different — an audited template copied in
 * verbatim, code a model is about to invent, and a call into a server nobody here has read — and
 * the plan card has always drawn that difference with these three marks and these three accents.
 * What is new is that the verb matches the trace's: a plan says "Calls get_time" and the trace
 * two minutes later says "Called get_time", which is the same sentence in two tenses rather than
 * two panels describing one tool in two vocabularies.
 *
 * Present tense here because a plan is about a build that has not happened. The descriptor is
 * data; `verb` means "the settled form", which for a proposal is what it will do.
 */
export function actionForToolOrigin(origin: "connector" | "bespoke" | "mcp"): ActionDescriptor {
  const base = { verb: "Calls", verbing: "Calling" };
  if (origin === "connector") return { ...base, Icon: ShieldCheckIcon, accent: ACCENT.reviewed };
  if (origin === "mcp") return { ...base, Icon: PlugIcon, accent: ACCENT.mcp };
  return { ...base, Icon: SparklesIcon, accent: ACCENT.bespoke };
}

/**
 * How a file being written should narrate itself.
 *
 * The icon is the file's own type rather than the generic write mark — in a list of seven files
 * the thing you scan for is which one is `agent.py`, and the fact that all seven are being
 * written is already said by the heading above them. fileIcons.tsx has drawn these since the
 * generation panel's pass; this is the join that makes the trace and the graph able to use them
 * too.
 */
export function actionForFile(path: string): ActionDescriptor {
  return { ...ACTION.write, Icon: iconForPath(path) };
}
