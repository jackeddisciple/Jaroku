// §3.3's five statuses, in the product's one status vocabulary.
//
// IT DREW FIVE SHAPES OF ITS OWN — a filled diamond, a pulsing filled circle, a cross, a hollow
// circle and a circle with a line through it — and the argument for drawing rather than typing them
// was right and still is: "a font character sits on the text baseline at whatever weight the row
// happens to be, and never optically matches the icons two panels over". What that argument could
// not fix is that the diamond meant "needs you" here and nothing anywhere else, while the Cockpit
// two tabs over said the same fact with a pulsing pause. §2.1's ramp is the answer to the half
// §3.3 could not reach: one family, seven phases, the same shape in every tab.
//
// `needs_you` IS THE STATE `waiting` WAS DEFINED FOR — halted, needs a human — and it is why
// `waiting` is a phase of its own rather than a shade of `active`. The diamond is gone; the fact it
// carried has a shape that means the same thing on a work item, on an MCP server asking for a
// credential, and here.
//
// THE FIVE WORDS STAY LOCAL, which is the whole of what this file is now. "errored" is the Threads
// tab's word and "failed" is the phase's; a tooltip on a thread should say the first.
//
// FOUR COLOURS BECOME TWO AND A NEUTRAL. `idle` was already dim on §3.3's own reasoning — "a thread
// that finished cleanly is not a success to be congratulated, it is a session with nothing waiting
// in it, and colouring it would make the amber rows compete with something" — which is the shared
// vocabulary's argument for `done` and `ready`, made here first.

import { THREAD_PHASE } from "../lib/domainPhase.ts";
import type { ThreadStatus } from "../types.ts";
import { StatusGlyph } from "./StatusGlyph.tsx";

/** The Threads tab's own word for each status. Not the phase's — see the header. */
const LABEL: Record<ThreadStatus, string> = {
  needs_you: "needs you",
  running: "running",
  errored: "errored",
  idle: "idle",
  archived: "archived",
};

export function ThreadGlyph({ status }: { status: ThreadStatus }) {
  return <StatusGlyph phase={THREAD_PHASE[status]} title={LABEL[status]} />;
}
