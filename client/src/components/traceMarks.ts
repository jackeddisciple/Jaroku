// What each step of a run is drawn as in the trace: a Hugeicons mark and a colour of its own.
//
// THE PRODUCT OWNER'S CALL, 2026-10-12: one mark per KIND ("every state is having same icon and bg")
// left a run of four node steps as four identical database tiles. Now every distinct step is drawn
// apart from the others:
//
//   THE MARK IS THE GRAPH'S, from `marksFor` — read off the step's name (`extract_jd` a document
//   search, `score_candidate` a chart, `shortlist_note` a pen), unique within the run, and a
//   connector's own logo where the agent has that connector. So a step and its node on the Graph
//   tab wear the same mark.
//
//   THE COLOUR IS THE NEXT OF `STEP_HUE` — green, yellow, pink, blue, brown, turquoise… — in the
//   order the steps first ran, drawn as a pastel tile with the mark in the colour itself.
//
// A STEP THAT RUNS AGAIN KEEPS ITS LOOK: the key is the step's name, so the third `agent` turn is the
// same tile as the first. Model calls are not in here — they wear their provider's logo (StepTile).

import type { ReactElement } from "react";

import { STEP_HUE } from "../lib/tokens.ts";
import type { Step } from "../types.ts";
import { marksFor } from "./graphNodeIcons.ts";

export interface StepMark {
  Icon: (p: { size?: number }) => ReactElement;
  /** The step's colour: its tile is a pastel of it, and a glyph is drawn in it. */
  colour: string;
  /** A connector's logo, which brings its own colours. */
  brand: boolean;
}

/** Every distinct step name of a run, mapped to its mark and colour. Stable for a given run. */
export function traceMarks(steps: readonly Step[], connectors: readonly string[] = []): Map<string, StepMark> {
  const ordered = [...steps].sort((a, b) => a.seq - b.seq).filter((s) => s.type !== "llm_call");
  const names: { id: string; role: "step" | "tool" }[] = [];
  const seen = new Set<string>();
  for (const s of ordered) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    names.push({ id: s.name, role: s.type === "tool_call" ? "tool" : "step" });
  }
  const marks = marksFor(names, { connectors });
  const out = new Map<string, StepMark>();
  names.forEach((n, i) => {
    const m = marks.get(n.id);
    if (!m) return;
    out.set(n.id, { Icon: m.Icon, colour: STEP_HUE[i % STEP_HUE.length]!, brand: m.kind === "brand" });
  });
  return out;
}
