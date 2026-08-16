// Whose money a pull request is allowed to spend.
//
// §B.1.3's problem, stated the way it actually bites: a pull request is BY CONSTRUCTION
// attacker-adjacent. Anyone who can open one can push commits that trigger this check, and unlike
// every other CI system the resource at stake here is not compute — it is the repository owner's
// Anthropic or OpenAI balance. GitHub Actions solved the equivalent problem by requiring approval
// to run workflows from first-time outside contributors; this is the same boundary, drawn around a
// different resource.
//
// THE RULE, AND IT IS ONE SENTENCE: a check triggered by a pull request from a non-collaborator
// runs on the free dry-run provider only, regardless of the dataset's configured provider list.
// Running it on a paid provider requires either the author being a collaborator, or an explicit
// approval from somebody who is.
//
// "REGARDLESS OF THE CONFIGURED LIST" IS THE HALF THAT MATTERS. The dataset says which providers
// this eval compares; the boundary says which of them a given trigger may reach. Making the dataset
// authoritative would mean an agent configured for `always_paid` spends on every stranger's pull
// request — and `always_paid` is a thing somebody sets once, for their own repository, without
// thinking about who might fork it next year.
//
// AND THE DRY RUN IS NOT A CONSOLATION PRIZE. §B.1.3 is explicit: it still proves every tool imports
// and executes, which is v0.0.3's original justification for the fake provider; it still catches a
// contract violation before a human reviewer has to; and it costs nothing to run on every single
// push regardless of who opened the pull request. A check that refused to run at all for outside
// contributors would give up all of that to avoid a cost it was never going to incur.
//
// NOTHING HERE ASKS GITHUB ANYTHING. Whether the author is a collaborator arrives as a boolean the
// caller resolved; whether somebody approved arrives as a boolean the caller read. That is what
// makes every branch below assertable, and it is why the interesting mistake — believing a claim
// that came in on the webhook payload rather than one we went and checked — is a mistake the
// caller can make and this file cannot.

import type { ProviderMode, ProviderPolicy } from "./db/repositories/checks.ts";

/** What the caller knows about the trigger, having already established each of these. */
export interface TriggerFacts {
  /** The agent's configured policy. §B.1.3's three positions. */
  policy: ProviderPolicy;
  /**
   * Whether the pull request's AUTHOR has write access to the repository.
   *
   * RESOLVED AGAINST GITHUB'S COLLABORATORS ENDPOINT, never read off the webhook delivery. The
   * payload carries `author_association`, which is GitHub's own opinion and would be perfectly
   * fine — except that the whole point of this boundary is that the payload describes a request
   * from somebody untrusted, and a field inside it is a field they are adjacent to. Asking costs
   * one round trip on a path that is about to spend real money.
   */
  authorIsCollaborator: boolean;
  /**
   * Whether a collaborator has clicked "Approve and run on real providers" for THIS head sha.
   *
   * PER COMMIT AND NOT PER PULL REQUEST, which is the difference between an approval and a
   * blank cheque. Approving a pull request's current state is a judgement about code somebody
   * read; carrying that approval forward to whatever gets pushed next is the exact hole GitHub's
   * own first-time-contributor gate exists to close.
   */
  approvedForThisSha: boolean;
}

/**
 * Which provider this check may reach.
 *
 * WRITTEN AS A LADDER OF REFUSALS RATHER THAN A TABLE OF PERMISSIONS, so that the default at the
 * bottom is the cheap one. Every branch that returns `"paid"` names the specific thing that
 * justified it; anything this function cannot justify falls through to `"dry_run"`, which is the
 * same fail-toward-the-safe-answer shape `mcpImpact.classify` ends with and for the same reason:
 * when the rule cannot decide, the expensive answer must not be the silent one.
 */
export function providerModeFor(facts: TriggerFacts): ProviderMode {
  // The explicit opt-out, and it is genuinely an opt-out rather than a default — see
  // `ChecksRepository.setConfig`, where the default is the middle position.
  if (facts.policy === "dry_run_only") return "dry_run";

  // A collaborator's own pull request. This is the ordinary case: somebody with write access to the
  // repository is already able to spend this money by pushing to a branch, so gating them here
  // would be friction with no boundary behind it.
  if (facts.authorIsCollaborator) return "paid";

  // Somebody with write access read the code and said yes, for this commit. §B.1.3's second door.
  if (facts.approvedForThisSha) return "paid";

  // `always_paid` DOES NOT REACH HERE FOR A STRANGER, and that is the rule's whole content: the
  // dataset's configured provider list is about which providers to COMPARE, not about who may
  // trigger a comparison. A policy set once for one's own repository must not become a standing
  // authorisation for whoever forks it.
  return "dry_run";
}

/**
 * Whether the check should offer an approval control — §B.1.3's "surfaced once, on the check
 * itself, exactly where a person is already looking".
 *
 * ONLY WHEN APPROVING WOULD CHANGE SOMETHING. Offered on a check that is already paid, it is a
 * button that does nothing; offered under `dry_run_only`, it is a button that contradicts a setting
 * somebody chose. Both teach people that the control is decorative, which is the fastest way to
 * make the one that matters get clicked without being read.
 */
export function offersApproval(facts: TriggerFacts): boolean {
  return providerModeFor(facts) === "dry_run" && facts.policy !== "dry_run_only";
}

/**
 * Why this check ran where it ran, in one sentence for the check's own summary.
 *
 * SAID ON THE CHECK RATHER THAN ONLY IN THE SETTINGS, because the person reading a pass rate on a
 * pull request is usually not the person who configured the agent — and a number from the fake
 * provider means something quite different from the same number from a real one.
 */
export function modeReason(facts: TriggerFacts): string {
  if (facts.policy === "dry_run_only") {
    return "this agent is configured to run checks on the dry-run provider only";
  }
  if (facts.authorIsCollaborator) return "the author has write access to this repository";
  if (facts.approvedForThisSha) return "a collaborator approved this commit for real providers";
  return "this pull request is from outside the repository, so it runs on the free dry-run provider — a collaborator can approve real providers for this commit";
}

/**
 * Which (provider, model) legs to actually run.
 *
 * THE DATASET'S LIST IS FILTERED, NOT REPLACED, WHEN PAID — so an agent configured to compare three
 * providers still compares three. On a dry run the whole list collapses to one leg on the fake
 * provider, because comparing the fake provider against itself three times is three times the work
 * for one answer.
 *
 * `fake` IS THE PROVIDER NAME v0.0.3 GAVE IT, and it is spelled here rather than derived, for the
 * same reason `GITHUB_ENV_KEY` is a constant: one string that several subsystems agree on is worth
 * being able to find.
 *
 * AN EMPTY CONFIGURED LIST STILL PRODUCES ONE LEG. A dataset with no targets is a configuration
 * mistake, and a check that silently ran nothing would report a neutral conclusion that looks
 * exactly like "there was nothing to compare against" — which is a different problem with a
 * different fix.
 */
export function targetsFor(
  mode: ProviderMode,
  configured: readonly { provider: string; model: string }[],
): { provider: string; model: string }[] {
  if (mode === "dry_run") return [{ provider: "fake", model: "fake" }];
  return configured.length > 0 ? [...configured] : [{ provider: "fake", model: "fake" }];
}
