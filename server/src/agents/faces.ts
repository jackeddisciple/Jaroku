// Which face and which name an agent is given — the server's copy of the eleven, and the assignment.
//
// WRITTEN TWICE ON PURPOSE, AND THE DRIFT IS WHAT GETS TESTED. The same arrangement `emojiPalette.ts`
// and `avatarRoster.ts` use beside it, for the same reason: the client cannot import from the server
// and the server cannot import from the client, so the list exists here for the assignment at agent
// creation and in `client/src/lib/agentFaces.ts` for every surface that draws one. `test:agent-faces`
// reads the other file's SOURCE and fails on any difference.
//
// BOTH HALVES ARE HERE, WHICH IS THE ONE THING THIS FILE DOES THAT `avatarRoster.ts` DID NOT. The
// server never drew a character, so it held ids alone and left the recipe on the client. A face now
// arrives with a NAME attached and the name is a column — `display_name` — so the pairing has to be
// on this side too. Splitting it would mean the server picking a picture and something else picking
// the name that goes under it, which is the one way this feature can be wrong and still run.
//
// ── WHY THE ASSIGNMENT IS A POSITION AND NOT A HASH ────────────────────────────────────────────
//
// THE THREE IDENTITY FEATURES THIS REPLACES ALL HASHED THE AGENT'S UUID — the gradient, the emoji,
// the 3D character — and the argument for it was stability: the same agent shows the same picture on every
// replica, for ever. That argument is satisfied here by a different mechanism. The choice is WRITTEN
// to `agents.picture` at creation and never recomputed, so nothing about it can drift, which frees
// the assignment to answer the question a hash over eleven buckets cannot.
//
// THE QUESTION IS "DO MY FIRST ELEVEN AGENTS LOOK DIFFERENT FROM EACH OTHER". A hash does not: by
// the birthday bound a workspace with six agents is already more likely than not to hold two wearing
// the same face, and the first duplicate usually lands on the fourth or fifth. With twenty-eight
// characters and a picker that warned, a duplicate was somebody's choice; with eleven handed out
// silently it is a product that looks broken on the second afternoon.
//
// So the index is the agent's POSITION in its workspace's creation order, modulo eleven — which is
// also the behaviour that was asked for in as many words: once eleven agents have been made from the
// eleven, the twelfth starts the list again.
//
// AND THE COUNT IS UNFILTERED, DELIBERATELY. Archived and swept rows are counted, because the
// sequence is a counter rather than a census: a workspace that archived its third agent should give
// its next one the fourth face, not repeat the third. It is the same arithmetic migration 079's
// backfill spells in SQL, for the reason that migration gives — a backfill that needed the
// application running is a backfill that runs twice.

/**
 * The eleven, in the order the assignment walks them.
 *
 * THE ORDER IS THE MAPPING, exactly as `EMOJI_PALETTE`'s and the old roster's were: an agent takes
 * the entry at its own position, so a list in a different order hands every agent in the workspace a
 * different face. The ids are zero-padded so that "source order" and "sorted order" are one
 * sequence on every platform — directory iteration order is not stable across them, and this project
 * has already been bitten once by a platform-dependent path.
 *
 * THE NAMES ARE PAIRED AND FIXED. `agent-06` is Stacey wherever it appears, which is what makes one
 * entry one identity rather than two independent draws that can disagree.
 */
export const AGENT_FACES: readonly { id: string; name: string }[] = [
  { id: "agent-01", name: "Iris" },
  { id: "agent-02", name: "Bruno" },
  { id: "agent-03", name: "Margot" },
  { id: "agent-04", name: "Kai" },
  { id: "agent-05", name: "Marisol" },
  { id: "agent-06", name: "Stacey" },
  { id: "agent-07", name: "Otis" },
  { id: "agent-08", name: "Amara" },
  { id: "agent-09", name: "Hugo" },
  { id: "agent-10", name: "Dante" },
  { id: "agent-11", name: "Theo" },
];

/** Just the ids, for the guard that checks a client-supplied value is one of them. */
export const AGENT_FACE_IDS: readonly string[] = AGENT_FACES.map((f) => f.id);

/**
 * The face and name for an agent at a given position in its workspace's creation order.
 *
 * WRAPS, WHICH IS THE WHOLE OF WHAT THE TWELFTH AGENT NEEDS. A negative or nonsense position still
 * answers a real face rather than throwing: there is no state of this product in which the right
 * response to a confused count is an agent with no picture, and the caller's count comes from a
 * `COUNT(*)` that cannot sensibly be either.
 */
export function faceAt(position: number): { id: string; name: string } {
  const n = Number.isFinite(position) ? Math.floor(position) : 0;
  return AGENT_FACES[((n % AGENT_FACES.length) + AGENT_FACES.length) % AGENT_FACES.length]!;
}
