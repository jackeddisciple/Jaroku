// Which face an agent wears, and what it is called — the eleven, and the one function that picks one.
//
// THE PAIR IS THE UNIT. An agent gets a portrait, the banner drawn in that portrait's own hue, and a
// name, and it gets all three at once from one entry in this list. That is not a tidiness argument:
// the banner and the portrait are two crops of one palette, so a card that drew Iris over Bruno's
// green would be two pictures of different agents stacked on each other — and the name is here for
// the same reason, because "Bruno" over a portrait of Iris is the same mistake made in text.
//
// SO THERE IS ONE INDEX AND IT CHOOSES EVERYTHING. Nothing in the product picks a portrait, a banner
// or a name separately, and there is deliberately no function here that would let it.
//
// ── WHY THE INDEX IS A POSITION AND NOT A HASH ─────────────────────────────────────────────────
//
// THE THREE IDENTITY FEATURES THIS REPLACES ALL HASHED THE AGENT'S UUID, and the argument for that
// was stability: the same agent shows the same picture on every replica, for every member of the
// workspace, for ever. That argument is fully satisfied here by a DIFFERENT mechanism — the choice
// is written to `agents.picture` at creation and then never recomputed — which frees the assignment
// to answer the question a hash cannot.
//
// THE QUESTION IS "DO MY FIRST ELEVEN AGENTS LOOK DIFFERENT FROM EACH OTHER". A hash over eleven
// buckets does not: by the birthday bound, a workspace with six agents is already more likely than
// not to have two wearing the same face, and the first duplicate usually lands on agent four or
// five. With twenty-eight characters and a warning in a picker that was somebody's choice; with
// eleven handed out silently it is just a product that looks broken on the second afternoon.
//
// So the position in the workspace's creation order is the index, modulo eleven. The first eleven
// agents anybody makes are eleven different people with eleven different names, the twelfth starts
// the list again, and that is the behaviour asked for in as many words: "once user have created 11
// agents using those 11, we will repeat from starting".
//
//   npm run test:agent-faces

import { AGENT_FACE_FILES } from "./agentFaceFiles.ts";

/** Where the generator writes the pair, and therefore where the browser asks for them. */
const FACE_BASE = "/agent-faces/";

export interface AgentFace {
  /** The value `agents.picture` stores. */
  readonly id: string;
  /**
   * The name an agent created on this face is given.
   *
   * ELEVEN NAMES FOR ELEVEN PICTURES, PAIRED AND FIXED — the product owner's call. They are written
   * here beside the file they belong to rather than in a list of their own, because the pairing is
   * the whole point and two parallel arrays are two things to keep in the same order.
   *
   * THEY ARE PEOPLE'S NAMES, NOT ROLE NAMES. The placeholder this product has shown since its first
   * screen is "Stacey, John, Claire" — an agent is somebody you hand work to, and `invoice_chaser`
   * is what the slug is for. One of the eleven is Stacey for that reason.
   *
   * CHOSEN AGAINST THE PICTURES, one at a time, looking at them. A name is not interchangeable with
   * the face above it, and a generated list would have produced eleven names that fit nothing in
   * particular.
   */
  readonly name: string;
  /** The square portrait, full bleed. */
  readonly portrait: string;
  /** The banner, in the same hue as the portrait. */
  readonly banner: string;
}

/** The names, by the id they belong to. See `AgentFace.name` for how they were chosen. */
const NAMES: Readonly<Record<string, string>> = {
  "agent-01": "Iris",
  "agent-02": "Bruno",
  "agent-03": "Margot",
  "agent-04": "Kai",
  "agent-05": "Marisol",
  "agent-06": "Stacey",
  "agent-07": "Otis",
  "agent-08": "Amara",
  "agent-09": "Hugo",
  "agent-10": "Dante",
  "agent-11": "Theo",
};

/**
 * The eleven, in the order the assignment walks them.
 *
 * BUILT FROM THE GENERATED LIST rather than written out again, so a pair added to
 * `public/agent-faces/` cannot be a pair this module has never heard of. What is written by hand is
 * only the half a generator cannot know: the name.
 */
export const AGENT_FACES: readonly AgentFace[] = AGENT_FACE_FILES.map((f) => ({
  id: f.id,
  // A MISSING NAME IS THE ID, which is a visible placeholder rather than a crash — and
  // `test:agent-faces` fails on it, so it is not a state that reaches anybody.
  name: NAMES[f.id] ?? f.id,
  portrait: FACE_BASE + f.portrait,
  banner: FACE_BASE + f.banner,
}));

/** How many there are. Exported for the cycle the assignment does and for the suite. */
export const AGENT_FACE_COUNT = AGENT_FACES.length;

/** By id, for the one lookup every render site does. Built once rather than per card. */
const BY_ID: ReadonlyMap<string, AgentFace> = new Map(AGENT_FACES.map((f) => [f.id, f]));

/**
 * The face a stored id names, or null.
 *
 * NULL IS A REAL ANSWER AND EVERY CALLER HANDLES IT. `agents.picture` is nullable — migration 079
 * backfills every row and every insert path writes one, but a row written by a version that predates
 * either is a real possibility during a rolling deploy, and so is a row carrying the id of a pair
 * somebody removed from the set. Neither is worth a fabricated face: a card with no picture is a
 * card with no picture, and `AgentFace` draws the agent's initial instead.
 */
export function faceFor(pictureId: string | null | undefined): AgentFace | null {
  return pictureId ? BY_ID.get(pictureId) ?? null : null;
}

/**
 * The face for an agent at a given position in its workspace's creation order.
 *
 * WRAPS, WHICH IS THE WHOLE OF WHAT THE TWELFTH AGENT NEEDS. A negative or fractional position is a
 * caller bug and still answers a real face rather than throwing, for the reason the header gives
 * about nulls: there is no state of this product in which the right response to a confused index is
 * an agent with no picture.
 */
export function faceAt(position: number): AgentFace {
  const n = Number.isFinite(position) ? Math.floor(position) : 0;
  return AGENT_FACES[((n % AGENT_FACE_COUNT) + AGENT_FACE_COUNT) % AGENT_FACE_COUNT]!;
}
