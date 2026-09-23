// What the panel may claim about the validator and the live version — once, so two places cannot
// make two different claims.
//
// THE CLAIM IS ONLY TRUE OF TWO SOURCES. The validator is the gate on a generation and an edit: one
// it refuses is discarded and never becomes a version. Nothing else passes through it. An `import`
// was published as-is because it already existed, and a `deploy` is the directory as the host wrote
// its artifacts into it, recorded by `recordArtifacts` with no validator call anywhere on that path.
// The Health tab used to give `deploy` the green sentence, and it is the one line in the panel a
// person would quote in a review.
//
//   npm run test:validator-verdict

import type { AgentCardView } from "../types.ts";

export type VersionSource = AgentCardView["version_source"];

export interface Verdict {
  /** The Health tab's sentence about the live version. */
  sentence: string;
  /** The header's shorter tooltip on the same fact. */
  short: string;
  /** Green only when the validator actually passed it. */
  passed: boolean;
}

/**
 * The verdict on the live version.
 *
 * `restoredFrom` IS A RESTORE, which carries the source of the version it copied (migration 081):
 * the bytes are that version's, so its verdict is theirs — and the sentence says it is a restore
 * rather than letting the copy pass for the original.
 */
export function validatorVerdict(
  source: VersionSource,
  version: number,
  restoredFrom: number | null = null,
): Verdict {
  if (source !== null && restoredFrom !== null) {
    const of = `v${version} restores v${restoredFrom}`;
    if (source === "import") {
      return {
        sentence: `${of}, which was published as-is and never went through the validator.`,
        short: `Restores v${restoredFrom}, which the validator never saw`,
        passed: false,
      };
    }
    if (source === "deploy") {
      return {
        sentence: `${of}'s deploy artifacts, which were recorded rather than validated.`,
        short: `Restores v${restoredFrom}'s deploy artifacts, recorded rather than validated`,
        passed: false,
      };
    }
    return {
      sentence: `${of}, which passed the validator when it was published.`,
      short: `Restores v${restoredFrom}, which passed the validator`,
      passed: true,
    };
  }
  if (source === null) {
    return {
      sentence: "Nothing has been published, so nothing has been validated.",
      short: "Nothing has been published yet",
      passed: false,
    };
  }
  if (source === "import") {
    return {
      sentence: `v${version} was published as-is and never went through the validator.`,
      short: "Published as-is, so the validator never saw it",
      passed: false,
    };
  }
  if (source === "deploy") {
    return {
      sentence: `v${version} is the host-written deploy artifacts, recorded as they were built rather than validated.`,
      short: "Deploy artifacts, recorded rather than validated",
      passed: false,
    };
  }
  return {
    sentence: `v${version} passed the validator when it was published.`,
    short: "Published through the validator",
    passed: true,
  };
}
