// Whose money a pull request may spend — every combination, because the table is small and the
// wrong cell is expensive.
//
// THE CELL THIS SUITE EXISTS FOR is `always_paid` + a stranger's pull request. That is the one a
// reasonable implementation gets wrong: the agent is configured to always use real providers, so
// using them looks like doing what was asked. It is not — `always_paid` is a thing somebody sets
// once, for their own repository, without thinking about who might fork it next year, and treating
// it as a standing authorisation turns a preference into a blank cheque against their balance.
//
// AND THE ONE ON THE OTHER SIDE: an approval is per COMMIT, not per pull request. Approving code
// somebody read and having that carry forward to whatever gets pushed next is exactly the hole
// GitHub's own first-time-contributor gate exists to close.
//
//   npm run test:check-policy

import { modeReason, offersApproval, providerModeFor, targetsFor } from "./checkPolicy.ts";
import type { ProviderPolicy } from "./db/repositories/checks.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const mode = (policy: ProviderPolicy, collaborator: boolean, approved: boolean): string =>
  providerModeFor({ policy, authorIsCollaborator: collaborator, approvedForThisSha: approved });

console.log("\nthe whole table, both authors, both approval states");
{
  // dry_run_only — the explicit opt-out. Nothing overrides it, including an approval: somebody
  // clicking a button must not be able to undo a setting the agent's owner chose.
  check(mode("dry_run_only", false, false) === "dry_run", "dry_run_only, stranger, unapproved");
  check(mode("dry_run_only", true, false) === "dry_run", "dry_run_only, collaborator — still dry");
  check(mode("dry_run_only", false, true) === "dry_run", "dry_run_only, approved — an approval does not override a setting");
  check(mode("dry_run_only", true, true) === "dry_run", "dry_run_only, both — still dry");

  // collaborators_paid — the default, and §B.1.3's rule in its ordinary form.
  check(mode("collaborators_paid", true, false) === "paid", "collaborators_paid, collaborator — paid");
  check(mode("collaborators_paid", false, false) === "dry_run", "collaborators_paid, stranger — dry");
  check(mode("collaborators_paid", false, true) === "paid", "collaborators_paid, stranger, approved — paid");

  // THE CELL THAT MATTERS. Configured to always use real providers, and a stranger's pull request
  // still does not.
  check(mode("always_paid", false, false) === "dry_run",
    "always_paid, STRANGER — dry, because the dataset's list says which providers to compare, not who may trigger one");
  check(mode("always_paid", true, false) === "paid", "always_paid, collaborator — paid");
  check(mode("always_paid", false, true) === "paid", "always_paid, stranger, approved — paid");
}

console.log("\na collaborator is not gated, because gating them would be friction with no boundary");
{
  // Somebody with write access can already spend this money by pushing to a branch. Making them
  // click an approval on their own pull request would teach everybody to click approvals.
  check(mode("collaborators_paid", true, false) === "paid", "no approval needed on one's own repository");
}

console.log("\nwhen the approval control is offered");
{
  const offers = (policy: ProviderPolicy, collaborator: boolean, approved: boolean): boolean =>
    offersApproval({ policy, authorIsCollaborator: collaborator, approvedForThisSha: approved });

  check(offers("collaborators_paid", false, false), "a stranger's unapproved pull request offers it");
  check(offers("always_paid", false, false), "and so does one under always_paid, which is where it does the most work");

  // A button that does nothing teaches people the control is decorative — which is the fastest way
  // to make the one that matters get clicked without being read.
  check(!offers("collaborators_paid", true, false), "a collaborator's own pull request does not — it is already paid");
  check(!offers("collaborators_paid", false, true), "nor does one already approved");
  // Offering it under dry_run_only would be a button that contradicts a setting somebody chose.
  check(!offers("dry_run_only", false, false), "and dry_run_only never offers it, because it would not work");
}

console.log("\nthe sentence on the check says which of the four reasons applied");
{
  const reason = (policy: ProviderPolicy, collaborator: boolean, approved: boolean): string =>
    modeReason({ policy, authorIsCollaborator: collaborator, approvedForThisSha: approved });

  check(reason("dry_run_only", true, true).includes("configured"), "a setting names the setting");
  check(reason("collaborators_paid", true, false).includes("write access"), "a collaborator's own PR says so");
  check(reason("collaborators_paid", false, true).includes("approved"), "an approval says who let it through");
  const stranger = reason("collaborators_paid", false, false);
  check(stranger.includes("from outside"), "and a stranger's PR explains the boundary", stranger);
  // The person reading a pass rate on a pull request is usually not the person who configured the
  // agent, and a number from the fake provider means something quite different.
  check(stranger.includes("dry-run provider") && stranger.includes("can approve"),
    "…and says what would change it, rather than only that it happened");
}

console.log("\nwhich legs actually run");
{
  const configured = [
    { provider: "anthropic", model: "claude-haiku-4-5" },
    { provider: "openai", model: "gpt-4o-mini" },
  ];

  const paid = targetsFor("paid", configured);
  check(paid.length === 2 && paid[0]!.provider === "anthropic",
    "a paid check compares everything the dataset configured — filtered, not replaced", JSON.stringify(paid));

  const dry = targetsFor("dry_run", configured);
  // Comparing the fake provider against itself twice is twice the work for one answer.
  check(dry.length === 1 && dry[0]!.provider === "fake",
    "a dry check collapses to one leg on the fake provider", JSON.stringify(dry));

  // A dataset with no targets is a configuration mistake. A check that silently ran nothing would
  // report a neutral conclusion indistinguishable from "there was nothing to compare against".
  check(targetsFor("paid", []).length === 1, "an empty configured list still produces one leg");
  check(targetsFor("paid", [])[0]!.provider === "fake", "…on the free provider, since there is no paid one named");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
