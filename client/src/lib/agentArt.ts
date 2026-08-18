// Which gradient an agent wears, forever (§5.1).
//
// THE REQUIREMENT IS NOT "PICK A NICE IMAGE", it is that the SAME agent shows the SAME gradient on
// every replica, in every browser, for every member of the workspace, for the life of the agent. That
// rules out everything convenient: an index into the render order changes when somebody archives an
// agent above it, a random pick changes on reload, and a value stored on the row would be a column
// holding a fact that is already implied by the id.
//
// So it is a pure function of `agents.id`, which is a uuid the database minted once and nothing ever
// changes. Hash the id, take it modulo the asset count, index a list that is sorted explicitly.
//
// THE LIST IS BUILT AT BUILD TIME (`agentArtFiles.ts`, generated) rather than read from a directory,
// because a browser cannot list one and because §5.1 asks for the list to be fixed rather than
// discovered. It is SORTED EXPLICITLY in the generator: directory iteration order is not stable
// across platforms, and this project has already been bitten once by a platform-dependent path —
// `tools/mcp_bridge.py` silently left a block list on Windows because a separator was assembled with
// `join`. A gradient that differs between two people's screens is a much smaller failure than that
// one and it is the same mistake, so it gets the same treatment.
//
// FEWER ASSETS THAN AGENTS IS FINE and wrapping is the answer §5.1 gives. What is NOT allowed is a
// fallback to a flat colour, and there is deliberately no code path here that could produce one: the
// modulo always lands on a real file, and the only way to have none is to ship no assets at all,
// which `test:agent-art` refuses.

import { AGENT_ART_FILES } from "./agentArtFiles.ts";

/** Where the generator writes the thumbnails, and therefore where the browser asks for them. */
const ART_BASE = "/agent-art/";

/**
 * FNV-1a, 32-bit.
 *
 * A NAMED, FIXED ALGORITHM RATHER THAN "SOME HASH", because §5.1's stability requirement is a
 * requirement about this function specifically: change it and every agent in every workspace gets a
 * different picture on the next deploy. FNV-1a is four lines, has no dependencies, is defined by a
 * published constant rather than by an implementation, and distributes uuid text well enough that the
 * spread test passes comfortably — which is the whole of what is being asked of it.
 *
 * `>>> 0` after the multiply keeps it in unsigned 32-bit. Without it JavaScript's `*` produces a
 * double past 2^53 and the low bits — the only bits this uses — stop being the low bits of the real
 * product. That is the classic way a hash written in this language quietly becomes a worse one.
 */
export function hash32(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    // The FNV prime, 16777619, as the shift-and-add form. `Math.imul` would do, and this is the
    // spelling the reference implementation uses.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** How many gradients there are. Exported for the distribution test, which needs the denominator. */
export const AGENT_ART_COUNT = AGENT_ART_FILES.length;

/**
 * The gradient for an agent, as a URL the browser can ask for.
 *
 * TAKES THE UUID, NOT THE SLUG, and that is the difference between stable and merely usually-stable.
 * A slug can be taken by a different agent after the first is swept and recreated, and slugs are
 * unique per workspace rather than globally — two tenants both with a `support_bot` would be handed
 * the same picture, which is harmless and is also not what "the same agent shows the same gradient"
 * means. The uuid is minted once and never reused.
 *
 * An empty id — which should not happen and would be a caller bug — still returns a real asset rather
 * than nothing, because §5.1 is explicit that there must always be a gradient.
 */
export function artFor(agentUuid: string): string {
  return ART_BASE + artFileFor(agentUuid);
}

/** The filename alone, for the test and for anything that needs to preload one. */
export function artFileFor(agentUuid: string): string {
  const index = hash32(agentUuid) % AGENT_ART_COUNT;
  return AGENT_ART_FILES[index]!;
}
