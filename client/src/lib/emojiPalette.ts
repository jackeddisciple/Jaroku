// The 59 marks an agent can wear, in the one order that is the mapping.
//
// THE SORT IS THE MAPPING. `agentEmoji` hashes an agent's uuid into an index in this array, so the
// ORDER of these entries is load-bearing in exactly the way `agentArtFiles.ts`'s is: reorder them
// and every agent in every workspace changes its mark on the next deploy. It is sorted by CODE POINT
// and asserted to be — a sort somebody can re-derive rather than an order somebody typed — because
// directory and object iteration order are not stable across platforms and this codebase has been
// bitten by a platform-dependent path once already.
//
// ── WHY THESE AND NOT OTHERS ────────────────────────────────────────────────────────────────────
//
// D7 IS RESOLVED BY RESTRICTING THE PALETTE RATHER THAN BUNDLING A FONT. This is a Tauri desktop
// app: macOS and Windows ship colour emoji, and a Linux box without Noto Color Emoji renders tofu
// boxes, which is worse than no feature. Bundling Noto Color Emoji would free the palette and cost
// ten megabytes in the installer, a new asset in `src-tauri`, and a font-loading path nothing tests.
// Restricting the palette costs nothing, is enforceable, and is what `test:agent-emoji` checks.
//
// So: SINGLE CODE POINT, no variation selector, no zero-width joiner, no skin tone, and nothing
// added to Unicode after 12. Every entry here is in the base font packages a 2019 distribution
// shipped. The three mechanical rules are asserted; the age rule is why the list leans on Unicode
// 6.0's original set.
//
// FIVE FAMILIES ARE EXCLUDED OUTRIGHT, and each exclusion is a rule rather than a taste:
//
//   STATUS-SHAPED — a tick, a cross, a warning triangle, a coloured circle, a pause, a play. They
//   compete directly with the Pattern 1 glyph. A red circle beside a phase ring is two status
//   systems arguing on one row.
//
//   AMBER-DOMINANT — anything whose silhouette reads orange at 16px. Amber means running in this
//   product, everywhere, and a permanently orange agent reads as permanently running. This is why
//   there is no lemon, no carrot, no bread, no cheese, no crown and no maple leaf in a list that
//   otherwise reaches for exactly those.
//
//   FACES AND PEOPLE — reads as a human collaborator rather than as an agent, and collides with the
//   member avatars two rows away.
//
//   FLAGS — political, and a workspace does not need that argument.
//
//   MULTI-CODEPOINT SEQUENCES — storage, comparison and font coverage all get harder for no gain.
//
// WHAT IS LEFT IS CONCRETE OBJECTS, TOOLS, PLANTS AND ANIMALS, which is what §8.3 asks for and what
// actually works at 16px: a thing with a distinct silhouette. The sidebar is the reason the feature
// exists — twenty agents each carrying the same robot mark is a list nobody can scan — and a
// silhouette is what the eye finds before it reads a truncated name.

/**
 * FNV-1a, 32-bit — the same hash and the same spelling `agentArt.ts` uses for the gradient.
 *
 * THE SAME ALGORITHM ON PURPOSE. Two hashes in one product is two answers to "which of these lists
 * does this agent map into", and the day somebody improves one of them is the day half the identity
 * marks in every workspace move. `>>> 0` after the multiply keeps it unsigned 32-bit; without it
 * JavaScript's `*` produces a double past 2^53 and the low bits stop being the low bits.
 */
export function hash32(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** The palette, sorted by code point. The order is the mapping — see the header. */
export const EMOJI_PALETTE: readonly string[] = [
  "⚓", // U+2693
  "🌰", // U+1F330
  "🌲", // U+1F332
  "🌴", // U+1F334
  "🌵", // U+1F335
  "🌻", // U+1F33B
  "🌾", // U+1F33E
  "🌿", // U+1F33F
  "🍄", // U+1F344
  "🍆", // U+1F346
  "🍇", // U+1F347
  "🍉", // U+1F349
  "🍐", // U+1F350
  "🎁", // U+1F381
  "🎈", // U+1F388
  "🎩", // U+1F3A9
  "🎺", // U+1F3BA
  "🎻", // U+1F3BB
  "🐊", // U+1F40A
  "🐌", // U+1F40C
  "🐘", // U+1F418
  "🐙", // U+1F419
  "🐛", // U+1F41B
  "🐝", // U+1F41D
  "🐞", // U+1F41E
  "🐢", // U+1F422
  "🐧", // U+1F427
  "🐫", // U+1F42B
  "🐬", // U+1F42C
  "🐳", // U+1F433
  "📌", // U+1F4CC
  "📎", // U+1F4CE
  "🔧", // U+1F527
  "🔨", // U+1F528
  "🔩", // U+1F529
  "🔬", // U+1F52C
  "🔭", // U+1F52D
  "🚀", // U+1F680
  "🚁", // U+1F681
  "🚂", // U+1F682
  "🚜", // U+1F69C
  "🚤", // U+1F6A4
  "🚲", // U+1F6B2
  "🛶", // U+1F6F6
  "🥁", // U+1F941
  "🥑", // U+1F951
  "🥥", // U+1F965
  "🥦", // U+1F966
  "🥬", // U+1F96C
  "🦀", // U+1F980
  "🦇", // U+1F987
  "🦉", // U+1F989
  "🦋", // U+1F98B
  "🦎", // U+1F98E
  "🦑", // U+1F991
  "🧪", // U+1F9EA
  "🧬", // U+1F9EC
  "🧭", // U+1F9ED
  "🧿", // U+1F9FF
] as const;

/**
 * An emoji for an agent, avoiding what the workspace already holds.
 *
 * NOT RANDOM — DERIVED, THEN STORED. A random pick changes on reload, differs between replicas and
 * cannot be tested. So the uuid hashes to a STARTING INDEX and the answer is deterministic for a
 * fixed workspace, which is the property `test:agent-emoji` asserts.
 *
 * AND THEN IT PROBES. With 59 entries and twenty agents the birthday paradox puts a duplicate at
 * better than ninety-five percent, and two agents both showing the tractor defeats the only purpose
 * the feature has. So the hash gives a start and the assignment walks forward to the first mark this
 * workspace is not already using.
 *
 * WHICH IS WHY IT IS WRITTEN AT CREATION AND NOT DERIVED AT READ. The result depends on what the
 * workspace already holds, so it is not a pure function of the id — deriving it on every read would
 * make an agent's mark change when an unrelated agent was created.
 *
 * A FULL PALETTE FALLS BACK TO THE HASH rather than failing. Sixty agents is a workspace where
 * two of them share a mark, which is a smaller problem than a workspace that cannot create the
 * sixty-fifth agent.
 */
export function assignEmoji(agentId: string, taken: readonly string[]): string {
  const used = new Set(taken);
  const start = hash32(agentId) % EMOJI_PALETTE.length;
  for (let i = 0; i < EMOJI_PALETTE.length; i++) {
    const candidate = EMOJI_PALETTE[(start + i) % EMOJI_PALETTE.length]!;
    if (!used.has(candidate)) return candidate;
  }
  return EMOJI_PALETTE[start]!;
}

/**
 * The next mark after this one that the workspace is not already using — §8.5's shuffle.
 *
 * A DIFFERENT FUNCTION FROM `assignEmoji`, AND THE DIFFERENCE IS THE WHOLE POINT. `assignEmoji`
 * hashes the AGENT'S UUID, which is exactly right at creation: the same agent must get the same
 * mark on every replica, for ever, and that is a property of the id. It is exactly wrong for a
 * button. An agent wears its hashed mark from the moment it is created, so re-running the
 * assignment answers with the mark it already has — which makes the shuffle a control that looks
 * pressable and does nothing, on every agent, for ever. Found by pressing it.
 *
 * SO THE SHUFFLE WALKS FROM WHERE IT IS rather than from where the hash says. It starts at the
 * entry after the current one and takes the first the workspace has free, which keeps every
 * property the button needs: it always MOVES, it never lands on a mark another agent wears, it is
 * deterministic given the workspace's state, and pressing it repeatedly walks the palette rather
 * than oscillating between two.
 *
 * A FULL PALETTE STILL ANSWERS. Sixty-five agents means the next mark is somebody else's, and
 * §8.5 permits that — taking a mark another agent has is allowed and warned. What is not permitted
 * is answering with the mark that is already on this agent, because that is the dead control again.
 */
export function shuffleEmoji(current: string | null | undefined, taken: readonly string[]): string {
  const used = new Set(taken);
  const from = current ? EMOJI_PALETTE.indexOf(current) : -1;
  for (let i = 1; i <= EMOJI_PALETTE.length; i++) {
    const candidate = EMOJI_PALETTE[(from + i + EMOJI_PALETTE.length) % EMOJI_PALETTE.length]!;
    if (!used.has(candidate) && candidate !== current) return candidate;
  }
  // Every mark is spoken for. Move anyway — the next one along, whoever else wears it.
  return EMOJI_PALETTE[(from + 1 + EMOJI_PALETTE.length) % EMOJI_PALETTE.length]!;
}
