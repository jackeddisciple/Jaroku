// A half-understood refusal is worse than the plain error it replaced.
//
// THE GUARD IS THE POINT OF THIS SUITE. `isRefusal` decides whether a value that arrived on a
// socket becomes an upsell card, and the client's types are a description of what the server sends
// rather than a guarantee about it — the same posture `parseDeepLink` takes toward a URL that any
// program on the machine can open. A cast instead of a check renders "undefined of undefined used"
// over an Upgrade button, which is strictly worse than the sentence the panel would have shown on
// its own, because it looks like a number somebody could act on.
//
// AND THE TWO SHAPES ARE NOT INTERCHANGEABLE. A quota refusal carries `current` and `limit`; a
// feature refusal carries neither, deliberately, because "GitHub is not on Free" is not zero of
// zero and a meter sitting at 0/0 reads as something that refills next month. So the guard has to
// admit the second WITHOUT its numbers and refuse the first WITHOUT them, which is the one
// asymmetry a single field check would collapse.
//
//   npm run test:entitlement-store

import { isRefusal, useEntitlementStore } from "./entitlementStore.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const QUOTA = {
  error: "quota_exceeded",
  kind: "agents",
  current: 3,
  limit: 3,
  tier: "free",
  upgradeUrl: "/billing/upgrade?to=pro&reason=agents",
};

const FEATURE = {
  error: "feature_unavailable",
  kind: "githubPhase1",
  tier: "free",
  upgradeUrl: "/billing/upgrade?to=pro&reason=githubPhase1",
};

console.log("\nwhat counts as a refusal");
{
  check(isRefusal(QUOTA), "a complete quota refusal is one");
  check(isRefusal(FEATURE), "a feature refusal is one, with no numbers at all");

  check(!isRefusal(null) && !isRefusal(undefined), "null and undefined are not");
  check(!isRefusal("quota_exceeded"), "nor is the string on its own");
  check(!isRefusal({}), "nor an empty object");
  check(!isRefusal({ ...QUOTA, error: "something_else" }), "nor an error nobody here knows");

  // THE ASYMMETRY. A quota refusal without its figures would render a meter with nothing in it;
  // a feature refusal without them is correct and complete.
  const { current, ...quotaMissingCurrent } = QUOTA;
  void current;
  check(!isRefusal(quotaMissingCurrent), "a quota refusal missing `current` is refused");
  const { limit, ...quotaMissingLimit } = QUOTA;
  void limit;
  check(!isRefusal(quotaMissingLimit), "...and one missing `limit` is too");
  check(isRefusal({ ...FEATURE }), "...while a feature refusal missing both is fine, by construction");

  check(!isRefusal({ ...QUOTA, current: "3" }), "a figure that arrived as a string is not a figure");
  check(!isRefusal({ ...QUOTA, tier: 7 }), "nor is a tier that is not a name");
  check(!isRefusal({ ...FEATURE, upgradeUrl: undefined }), "and a refusal with nowhere to go is not one");

  // WHICH PLAN WOULD LIFT IT, which is the field the card's sentence and its button both read and
  // which the client used to work out for itself — wrongly, for three of the kinds a Free
  // workspace can hit. It is a string OR null, and null is a real answer: a capability no plan
  // grants. Both are accepted; neither may arrive as anything else.
  check(isRefusal({ ...QUOTA, unlocks: "team", unlocksLabel: "Team" }), "a refusal naming the plan that unlocks it is one");
  check(isRefusal({ ...QUOTA, unlocks: null, unlocksLabel: null }), "...and so is one saying no plan does");
  check(!isRefusal({ ...QUOTA, unlocksLabel: 3 }), "a plan name that is not a name is refused");

  // NORMALISED RATHER THAN REFUSED WHEN ABSENT. A refusal from a server that predates the fields
  // is still true about the figure and the limit, and the meter is still the answer — so it is
  // admitted with the fields set to null, which the card renders as "no plan currently includes
  // this". Refusing the payload would replace a card that is right about the numbers with no card
  // at all; rendering `undefined` in a sentence about somebody's money would be worse than both.
  const legacy: Record<string, unknown> = { ...QUOTA };
  check(isRefusal(legacy), "a refusal from before these fields existed is still a refusal");
  check(legacy["unlocks"] === null && legacy["unlocksLabel"] === null, "...with them normalised to null rather than left undefined");
}

console.log("\none refusal at a time, about one channel");
{
  const store = useEntitlementStore;
  store.getState().clear();
  check(store.getState().refusal === null, "nothing is refused to begin with");

  store.getState().refuse("gen", QUOTA as never);
  check(store.getState().refusal?.kind === "agents", "a refusal lands");
  check(store.getState().channel === "gen", "...on the channel the command belonged to");

  // SUPERSEDED, NOT STACKED. A refusal is about the thing somebody just tried, and answered by
  // upgrading or by waiting for the month to turn. A pile of these is an advertisement.
  store.getState().refuse("members", FEATURE as never);
  check(store.getState().refusal?.kind === "githubPhase1", "a second replaces the first");
  check(store.getState().channel === "members", "...and moves the card with it");

  store.getState().clear();
  check(
    store.getState().refusal === null && store.getState().channel === null,
    "dismissing clears both, so no card is left addressed to a channel with nothing in it",
  );
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
// Through the global rather than as a bare `process`, because this package has no `@types/node` —
// deliberately, so a component cannot reach for one and still compile. See node-shims.d.ts.
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
