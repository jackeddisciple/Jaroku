// The receipt a commit carries out of the product.
//
// §B.8.1's argument, and it is the whole reason this file exists: the guarantees Jaroku makes do
// not stop being true the moment the code leaves the app, but they do stop being VISIBLE. A person
// with no Jaroku access, reading `git log` in a repository somebody handed them, can see the diff
// and nothing else — not which version it was, not what validated it, not what it cost. A trailer
// block is what carries those out the door, in a format git itself already understands and every
// log viewer already renders.
//
// APPENDED TO THE BODY, NEVER THE SUBJECT. §2.3 and §3.4 both render a one-line summary drawn from
// the commit subject, and a subject with `Jaroku-Version: v14` glued onto it would put machine
// metadata in the sentence a human reads. The subject is untouched by everything in this file.
//
// NO NEW WRITE PATH. `githubPush.messageFor` already fills the body from `agent_versions`' stored
// instruction and summary; this appends to what that produced, at the same commit-construction
// step, and there is no second place a commit message is assembled. That is deliberate rather than
// convenient — a trailer that only some paths applied would make its own absence meaningless.
//
// EVERY LINE IS OMITTED RATHER THAN GUESSED, and `Jaroku-Cost` is the one the spec calls out by
// name: a version generated before cost accounting existed, or run on the free dry-run provider,
// has NO cost, and `Jaroku-Cost: $0.0000` would be a claim that it was free. That is the same
// null-not-zero rule v0.1.9 enforces in the cost column, the eval dashboard's `costUnknown` flag
// and §A.5's absent-count-versus-zero distinction. The rule is applied here to every field, not
// only to money: an unknown model omits its line too.
//
// THE VERSION TRAILER'S SPELLING IS LOAD-BEARING AND IS NOT THIS FILE'S TO CHANGE.
// `githubService.remoteOnlyCommits` decides which commits on a branch Jaroku wrote by testing for
// `/^Jaroku-Versions?:/m`, and §3.8's hollow dots are computed from that answer. So the version
// line keeps its exact existing form and leads the block; everything below it is additive, and a
// reader of an older commit that carries only the version line still resolves correctly.

import type { AgentVersion } from "./db/repositories/agents.ts";

/**
 * A gate a version cleared on its way to being published.
 *
 * The names are the validator's own stages, in the order `validateProject` runs them, so
 * `Jaroku-Validated: parse,import,contract` reads as a claim somebody can go and check against
 * `validator.ts` rather than as a badge this file invented.
 *
 * `secret-scan` is here from the start even though §B.6's scanner lands later, because the alternative
 * is a value set that changes shape when it does — and a trailer format that changed under an
 * unchanged name would make every commit written before the change ambiguous.
 */
export type ValidationGate = "parse" | "import" | "contract" | "secret-scan";

/** The order gates render in. Never the order they were passed — see `gatesFor`. */
const GATE_ORDER: ValidationGate[] = ["parse", "import", "contract", "secret-scan"];

/**
 * What the commit-construction step knows about a version beyond the version row itself.
 *
 * EVERY FIELD IS OPTIONAL AND EVERY ABSENCE IS AN OMITTED LINE. There is no field here whose
 * absence is worth defaulting: a missing model is not "unknown model", it is a line that does not
 * appear, and a reader who sees no `Jaroku-Model` learns exactly as much as is true.
 */
export interface VersionProvenance {
  /** The agent's slug, as the panel and the branch name both spell it. */
  agentSlug?: string | null;
  /** The model that authored this version, when anything recorded one. */
  model?: string | null;
  /**
   * USD, or null/undefined for "nothing priced this".
   *
   * NULL AND ZERO ARE DIFFERENT ANSWERS, and both are renderable: a version that genuinely ran on
   * the free dry-run provider is not priced at all (this is null, and the line is omitted), while
   * a version whose calls were all cache reads could legitimately be `$0.0000`. Collapsing the
   * first into the second is the exact laundering the cost accounting refuses everywhere else.
   */
  costUsd?: number | null;
  /** Which gates this version cleared. Empty means the line is omitted, not that none ran. */
  gates?: readonly ValidationGate[];
  /**
   * Version ids a validated pull produced — see `gatesFor`.
   *
   * ON THE PROVENANCE RECORD RATHER THAN PASSED SEPARATELY, because it is per-push context in
   * exactly the way the agent slug and the model are: resolved once by the pusher, consulted per
   * version by the builder.
   */
  validatedByPull?: ReadonlySet<string>;
  /**
   * Gates cleared by THIS PUSH rather than by the version, unioned with whatever `gates` resolves
   * to — §B.6's `secret-scan`.
   *
   * SEPARATE FROM `gates` RATHER THAN FOLDED INTO IT, because the two answer different questions
   * and are known at different times. `gates` is per version and derived from its source; a push
   * clears one more gate for every version in it at once, and passing a single combined list would
   * flatten the per-version derivation — putting `parse,import,contract` on an imported version
   * that never met the validator, because a generation elsewhere in the same push did.
   */
  extraGates?: readonly ValidationGate[];
}

/**
 * Which gates a version cleared, from what the version row already says.
 *
 * DERIVED RATHER THAN STORED, because there is nothing new to store: `validateProject` runs the
 * same three checks on every path that produces a `generation` or an `edit` version, and refuses
 * the publish if any of them fails — so a version of either source EXISTING is the evidence that
 * all three passed. That is a stronger guarantee than a column, which could be written by anything.
 *
 * A PULLED VERSION NEEDS TO BE TOLD, AND THAT IS WHAT `validatedByPull` IS FOR. §3.6 holds a pull to
 * the identical bar as generated code — the remote tree is staged as a candidate and put through
 * the same validator — but `githubPullRunner` publishes it with `source: "import"`, because that is
 * the vocabulary the source column has. So the source alone cannot tell a validated pull from a
 * disk import, and this used to under-claim: every pulled version's trailer said nothing about
 * validation even though it had cleared everything.
 *
 * THE ANSWER CAME FROM A TABLE THAT ALREADY HELD IT, rather than from widening `agent_versions.source`.
 * The pull runner writes a `github_events` row carrying the version id, and the KIND on that row
 * draws a distinction the source column could not have: `pull` with `outcome: "ok"` is a candidate
 * that cleared the validator, and `force_override` is precisely the pull that FAILED it and was
 * published anyway. Only the first may claim the gates. Widening the enum would have needed a CHECK
 * change — a table rebuild on SQLite, on the table that holds every version's manifest — to arrive
 * at a coarser answer.
 *
 * A `deploy` VERSION GETS NOTHING for the ordinary reason: the artifact synthesis writes its own
 * files and never went through the generation validator at all.
 */
export function gatesFor(
  version: Pick<AgentVersion, "source" | "id">,
  /**
   * Version ids a validated pull produced.
   *
   * ONLY CONSULTED FOR AN `import` VERSION, so a caller that cannot resolve it loses nothing it had:
   * a generation and an edit answer from their own source, and the absence of this set puts a pull
   * back where it was — under-claiming, which is the safe direction for a receipt.
   */
  validatedByPull?: ReadonlySet<string>,
): ValidationGate[] {
  switch (version.source) {
    case "generation":
    case "edit":
      return ["parse", "import", "contract"];
    case "import":
      // See the comment above: a pull cleared the same three gates a generation does, and the only
      // record of which imports were pulls is the event log.
      return validatedByPull?.has(version.id) ? ["parse", "import", "contract"] : [];
    default:
      return [];
  }
}

/**
 * Money, as a trailer renders it.
 *
 * FOUR DECIMAL PLACES, matching the panel's own `$0.0031`. An agent version costs cents, so two
 * places would round most of them to `$0.00` — a number that reads as free and is not — and the
 * full float would put `$0.0031000000000000004` in somebody's git log.
 */
function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

/**
 * The trailer block for one version, as lines, without the blank separator.
 *
 * Returns the version line at minimum, because that one is never optional: it is what
 * `remoteOnlyCommits` matches on, and a Jaroku commit without it comes back on the next fetch as
 * §3.8's hollow dot — a commit the panel reports as somebody else's work, and then counts among
 * what a force push is about to destroy.
 */
export function trailerLines(
  version: Pick<AgentVersion, "id" | "version" | "source">,
  provenance: VersionProvenance = {},
): string[] {
  const lines = [`Jaroku-Version: v${version.version}`];
  const slug = provenance.agentSlug?.trim();
  if (slug) lines.push(`Jaroku-Agent: ${slug}`);
  const model = provenance.model?.trim();
  if (model) lines.push(`Jaroku-Model: ${model}`);

  // Passed gates beat derived ones, so a caller that actually watched a gate run — §B.6's scanner,
  // which runs at push time and cannot be inferred from the version row — reports what happened
  // rather than what the source implies. Ordered by GATE_ORDER rather than by arrival, so two
  // commits that cleared the same gates read identically regardless of who assembled the list.
  const gates = [
    ...(provenance.gates ?? gatesFor(version, provenance.validatedByPull)),
    ...(provenance.extraGates ?? []),
  ];
  const ordered = GATE_ORDER.filter((g) => gates.includes(g));
  if (ordered.length) lines.push(`Jaroku-Validated: ${ordered.join(",")}`);

  // NOT `?? null` AND NOT A TRUTHINESS TEST. `costUsd: 0` is a real answer and must render;
  // `undefined` and `null` are the absence and must not. A `if (provenance.costUsd)` here would
  // silently omit the line for exactly the version that cost nothing, which is the one case where
  // "no line" and "zero" mean genuinely different things.
  const cost = provenance.costUsd;
  if (typeof cost === "number" && Number.isFinite(cost)) lines.push(`Jaroku-Cost: ${formatCost(cost)}`);

  return lines;
}

/**
 * A squashed run's trailer block.
 *
 * THE RANGE FORM IS KEPT, for the same reason the single form is: `squashMessageFor` has written
 * `Jaroku-Versions: 11-14` since §2.3, and `remoteOnlyCommits` matches the optional plural. A
 * squash that switched to listing four `Jaroku-Version` lines would be four claims about one
 * commit, and git's own trailer conventions say nothing about which one wins.
 *
 * COSTS ARE SUMMED AND AN UNKNOWN POISONS THE SUM. Four versions of which three are priced do not
 * have a cost — they have three quarters of one — and adding the known three would understate the
 * commit while looking exact. Null is the honest total, and null omits the line.
 */
export function squashTrailerLines(
  versions: Pick<AgentVersion, "id" | "version" | "source">[],
  provenance: VersionProvenance & { costs?: readonly (number | null | undefined)[] } = {},
): string[] {
  const oldest = versions[0];
  const newest = versions[versions.length - 1];
  if (!oldest || !newest) return [];
  const lines =
    oldest.version === newest.version
      ? [`Jaroku-Version: v${newest.version}`]
      : [`Jaroku-Versions: ${oldest.version}-${newest.version}`];

  const slug = provenance.agentSlug?.trim();
  if (slug) lines.push(`Jaroku-Agent: ${slug}`);
  const model = provenance.model?.trim();
  if (model) lines.push(`Jaroku-Model: ${model}`);

  // The INTERSECTION, not the union. A squash asserts one thing about one commit, and a gate that
  // only three of four versions cleared is not a gate this commit cleared — claiming it would make
  // the receipt say the strongest thing true of any part rather than the strongest thing true of
  // the whole, which is the direction that cannot be walked back by a reader.
  const each = versions.map(
    (v) => new Set([
      ...(provenance.gates ?? gatesFor(v, provenance.validatedByPull)),
      ...(provenance.extraGates ?? []),
    ]),
  );
  const common = GATE_ORDER.filter((g) => each.length > 0 && each.every((s) => s.has(g)));
  if (common.length) lines.push(`Jaroku-Validated: ${common.join(",")}`);

  const costs = provenance.costs;
  if (costs && costs.length === versions.length && costs.every((c) => typeof c === "number" && Number.isFinite(c))) {
    lines.push(`Jaroku-Cost: ${formatCost((costs as number[]).reduce((a, b) => a + b, 0))}`);
  } else if (!costs && typeof provenance.costUsd === "number" && Number.isFinite(provenance.costUsd)) {
    lines.push(`Jaroku-Cost: ${formatCost(provenance.costUsd)}`);
  }

  return lines;
}

/**
 * Attach a trailer block to a message that may already carry one.
 *
 * IDEMPOTENT BY REMOVAL RATHER THAN BY DETECTION. A message can arrive here having been through
 * `messageFor` (which writes the version line), or typed by a person who pasted text out of
 * `git log`, or re-committed after an amend — and in every one of those the right answer is the
 * block this call was given, not the one that happened to be there. So every existing `Jaroku-*`
 * line is stripped and the new block is written whole. Detecting-and-skipping would let a stale
 * `Jaroku-Cost` from a copied message survive onto a commit it is not true of.
 *
 * ONLY LINES THAT ARE ENTIRELY A TRAILER ARE STRIPPED. A body sentence that happens to mention
 * `Jaroku-Version` mid-line is prose, and prose in a commit body is the user's.
 */
export function withTrailerBlock(message: string, lines: readonly string[]): string {
  const body = message.replace(/\r\n/g, "\n").trimEnd();
  if (lines.length === 0) return body;
  const kept = body
    .split("\n")
    .filter((line) => !/^Jaroku-[A-Za-z-]+:/.test(line.trim()))
    .join("\n")
    // Whatever blank lines the strip left at the end are not the separator — that is added below,
    // exactly once, whether or not there was one before.
    .replace(/\n+$/, "");
  return kept ? [kept, "", ...lines].join("\n") : lines.join("\n");
}
