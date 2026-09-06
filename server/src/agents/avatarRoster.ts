// Which avatar an agent wears — the server's copy of the roster's ids, and the assignment.
//
// WRITTEN TWICE ON PURPOSE, AND THE DRIFT IS WHAT GETS TESTED. Exactly the arrangement
// `emojiPalette.ts` uses one file over, for the same reason: the client cannot import from the
// server and the server cannot import from the client, so the list exists here for the assignment
// at agent creation and in `client/src/lib/gloss/roster.ts` for the picker and the renderer.
// `test:agent-avatar` reads the other file's SOURCE and fails on any difference.
//
// ONLY THE IDS ARE HERE, and that is the whole difference between this file and the emoji one. The
// server never draws anything: it decides which id a row carries and stores a string. The recipe —
// the seed and the five axes — lives on the client beside the renderer that needs it, and a copy of
// it here would be ninety lines of data nothing on this side can use.
//
// THE SORT IS THE MAPPING. `avatarIdFor` hashes an agent's uuid into an index in this array, so the
// ORDER is load-bearing exactly as `EMOJI_PALETTE`'s is: reorder it and every agent in every
// workspace changes its face on the next deploy. It is sorted by id and asserted to be — a sort
// somebody can re-derive rather than an order somebody typed.
//
// ── HOW THIS DIFFERS FROM THE EMOJI ASSIGNMENT, AND WHY ────────────────────────────────────────
//
// `assignEmoji` hashes and then PROBES FORWARD past every mark the workspace already holds, because
// two agents wearing the same emoji defeats the only purpose that feature has — the eye finds a
// shape in a sidebar faster than it reads a truncated name, and two identical shapes find nothing.
//
// This does not probe, and that is deliberate rather than an omission. §6: "Taking an avatar another
// agent already uses is ALLOWED but warned — the picker shows 'also used by X'. It is their
// workspace, and a hard block on a cosmetic choice is worse than a duplicate." A probe here would be
// the store quietly enforcing a rule the interface deliberately does not.
//
// THE ONE PAIR THAT MUST DIFFER IS A FORK AND ITS PARENT. §5.1: "fork and parent sit adjacent in the
// grid and are exactly the pair that must not look identical." So `avoid` exists for that one call
// site and for no other, and it walks rather than refuses.

/**
 * FNV-1a, 32-bit — the same hash and the same spelling `emojiPalette.ts` uses.
 *
 * THE SAME ALGORITHM ON PURPOSE, and it is now the THIRD copy: the gradient, the emoji and this.
 * Two hashes in one product is two answers to "which of these lists does this agent map into", and
 * the day somebody improves one of them is the day half the identities in every workspace move.
 * `>>> 0` after the multiply keeps it unsigned 32-bit; without it JavaScript's `*` produces a double
 * past 2^53 and the low bits stop being the low bits.
 */
export function hash32(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** The roster's ids, sorted. The order is the mapping — see the header. */
export const AVATAR_IDS: readonly string[] = [
  "alder",
  "ash",
  "basalt",
  "birch",
  "cedar",
  "clover",
  "cobalt",
  "coral",
  "dune",
  "fennel",
  "flint",
  "gorse",
  "hazel",
  "indigo",
  "juniper",
  "kelp",
  "larch",
  "linen",
  "maple",
  "marble",
  "nettle",
  "onyx",
  "opal",
  "pebble",
  "quartz",
  "rowan",
  "sage",
  "slate",
];

/**
 * Which avatar this agent gets, deterministically from its uuid.
 *
 * `avoid` IS FOR FORKS AND NOTHING ELSE. Passing it walks forward from the hashed index until the
 * answer is not in the set, which is the probe `assignEmoji` does for every agent and this one does
 * only where §5.1 demands it. Everywhere else a collision is a duplicate the product allows.
 */
export function avatarIdFor(agentUuid: string, avoid: readonly string[] = []): string {
  const taken = new Set(avoid);
  const start = hash32(agentUuid) % AVATAR_IDS.length;
  for (let i = 0; i < AVATAR_IDS.length; i++) {
    const candidate = AVATAR_IDS[(start + i) % AVATAR_IDS.length]!;
    if (!taken.has(candidate)) return candidate;
  }
  // Every avatar is spoken for, which needs a fork of a workspace holding all twenty-eight as
  // parents. Take the hashed one; a duplicate is what the product allows anyway.
  return AVATAR_IDS[start]!;
}

/**
 * The value a row gets when nobody has said which category an agent is in.
 *
 * §5.1: "For category, backfill a single neutral value such as Uncategorized: do not guess from the
 * agent's name, and do not leave it nullable to avoid the decision." Guessing is the tempting one —
 * an agent called `invoice_chaser` is obviously Billing — and it is wrong for the same reason every
 * inferred field is: it is right often enough to be trusted and wrong often enough to mislead, with
 * nothing on screen to say which.
 *
 * The SIDEBAR treats this value specially: §7 says a row whose category is `Uncategorized` shows the
 * name alone rather than the placeholder, because "· Uncategorized" after every name is a column of
 * noise saying nothing.
 */
export const UNCATEGORIZED = "Uncategorized";
