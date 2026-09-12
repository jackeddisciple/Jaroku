// The metadata row's ordering, which is §12.24: "Metadata row order is stable; absent items
// collapse without reordering the rest."
//
// The failure is not a crash and not a wrong value — it is the duration sitting in a different
// place on a turn that produced code than on one that did not. §6.5 gives the reason it matters in
// one sentence: "people learn the position of the thing they check most." Somebody glancing at a
// duration forty times an hour is reading a position, not a label.
//
// Reordering on availability is also the natural thing to write, which is why this is checked
// rather than trusted: you have four optional items, you map over the ones that exist, and the row
// looks perfect on every turn you happen to be looking at.
//
//   npm run test:turn-metadata

import {
  DIFF_SUMMARY_MAX, METADATA_SLOTS, diffSummary, formatDuration, isClamped, presentSlots,
  variantLabel, type MetadataSlot, type TurnMeta,
} from "./turnMetadata.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

/** A turn with everything: a model, a real effort, a version it produced, a duration, two variants. */
const full = (over: Partial<TurnMeta> = {}): TurnMeta => ({
  modelId: "claude-sonnet-5",
  provider: "anthropic",
  effortRequested: "high",
  effortApplied: "high",
  effortSupported: true,
  versionLabel: "v14",
  versionStaged: false,
  diffPlus: 18,
  diffMinus: 4,
  durationMs: 12_400,
  ordinal: 2,
  total: 2,
  // §13's FOUR. A turn with everything has a route, the reason it was taken, a token count and a
  // cost — which is what the line renders for an ordinary chat turn.
  route: "chat",
  routeReason: "No build-request signal; nothing selected.",
  totalTokens: 1204,
  costUsd: 0.0003,
  ...over,
});

/** What the row would actually render, in order — the walk a component must do. */
const rendered = (meta: TurnMeta): MetadataSlot[] => {
  const present = presentSlots(meta);
  return METADATA_SLOTS.filter((s) => present.has(s));
};

console.log("\n§6.5 — the order is fixed, and it is the spec's");
{
  // EIGHT SINCE §13, AND THE FIVE §6.5 NAMED HAVE NOT MOVED. §13's route leads and its tokens and
  // cost follow the duration, so `model,effort,build,duration` occupy the same relative positions
  // they always did and `variants` is still last. That is §6.5's own rule rather than deference to
  // it: "people learn the position of the thing they check most", and a line that reordered itself
  // when a feature landed would have cost every reader that.
  check("eight slots", METADATA_SLOTS.length === 8, String(METADATA_SLOTS.length));
  check("route → model → effort → build → duration → tokens → cost → variants",
    METADATA_SLOTS.join(",") === "route,model,effort,build,duration,tokens,cost,variants",
    METADATA_SLOTS.join(","));
  // §6.5'S FIVE, IN THEIR ORIGINAL ORDER, asserted as a subsequence rather than as the whole list —
  // which is the property that actually matters and the one a future addition must not break.
  check("§6.5's five are still in their original order",
    METADATA_SLOTS.filter((sl) => ["model", "effort", "build", "duration", "variants"].includes(sl))
      .join(",") === "model,effort,build,duration,variants",
    METADATA_SLOTS.join(","));
  check("a turn with everything renders all eight in that order",
    rendered(full()).join(",") === "route,model,effort,build,duration,tokens,cost,variants",
    rendered(full()).join(","));
}

console.log("\n§13 — the provenance line's own four");
{
  // §13.3: "THE SAME LINE APPEARS ON PLAN TURNS, GENERATION TURNS AND EDIT TURNS — not only chat.
  // A provenance line that exists on one turn type and not others is worse than none, because its
  // absence reads as meaning something." So a turn with a route renders the chip whatever the route
  // says.
  for (const route of ["chat", "edit", "explain", "fix", "plan", "generate"]) {
    check(`a ${route} turn renders its route`, rendered(full({ route })).includes("route"), route);
  }
  // AND A TURN WITH NO RECORDED ROUTE OMITS THE CHIP rather than guessing one. A chip reading "chat"
  // under a turn nobody routed would be worse than no chip.
  check("no route means no chip", !rendered(full({ route: null })).includes("route"));

  // §13.1's COST IS THE ONE FIGURE WHERE `null` AND `0` ARE DIFFERENT CLAIMS, and both render: an
  // unpriced model is "unknown" and a free one is "$0.0000". The slot is present for both, because
  // this line IS where cost lives and silently omitting the unknown one would leave a reader to
  // assume it was free.
  check("an unknown cost still occupies the slot",
    rendered(full({ costUsd: null })).includes("cost"), "");
  check("a zero cost occupies it too", rendered(full({ costUsd: 0 })).includes("cost"));
  // A TURN THAT MEASURED NOTHING AT ALL has neither, and the two collapse together — which keeps
  // the line from ending in a bare separator.
  const unmeasured = rendered(full({ costUsd: null, totalTokens: null }));
  check("a turn that measured nothing shows neither",
    !unmeasured.includes("tokens") && !unmeasured.includes("cost"), unmeasured.join(","));
  // ...AND THE REST OF THE LINE IS UNMOVED BY THEIR ABSENCE, which is §6.5 applied to the new slots.
  check("...and the rest of the line holds position",
    unmeasured.join(",") === "route,model,effort,build,duration,variants", unmeasured.join(","));

  // §13.2's REASON IS OPTIONAL AND DOES NOT GATE THE CHIP. A route recorded without a reason is a
  // turn whose route is known and whose explanation was not kept — the chip still says which route,
  // and expanding it has nothing to add.
  check("a route with no reason still renders", rendered(full({ routeReason: null })).includes("route"));
}

console.log("\n§12.24 — absent items collapse without reordering the rest");
{
  // THE EXPECTED STRINGS GAINED §13's THREE SLOTS and lost none of their own order. That is the
  // whole criterion restated: adding to a fixed order is allowed, moving anything in it is not.
  // The case the spec names, and the one that happens constantly: most turns produce no code.
  const noBuild = full({ versionLabel: null });
  check("no build chip", !presentSlots(noBuild).has("build"));
  check("...and everything else keeps its order",
    rendered(noBuild).join(",") === "route,model,effort,duration,tokens,cost,variants", rendered(noBuild).join(","));

  // §6.2's omission. A model with no reasoning control shows no chip rather than a meaningless one.
  const noEffort = full({ effortSupported: false });
  check("no effort chip on a model without the control", !presentSlots(noEffort).has("effort"));
  check("...and the rest hold position",
    rendered(noEffort).join(",") === "route,model,build,duration,tokens,cost,variants", rendered(noEffort).join(","));
  // Even with an applied level recorded — that level is one nobody spent.
  check("...even when a level was recorded", !presentSlots(full({ effortSupported: false, effortApplied: "low" })).has("effort"));

  // One variant is not a choice, so there is nothing to switch between.
  const single = full({ total: 1, ordinal: 1 });
  check("no switcher on a turn with one response", !presentSlots(single).has("variants"));
  check("...and the rest are unmoved",
    rendered(single).join(",") === "route,model,effort,build,duration,tokens,cost", rendered(single).join(","));

  // THE ASSERTION THE CRITERION IS ACTUALLY ABOUT: whatever is missing, the ones that remain are in
  // the same relative order as they were when everything was there. Checked over every subset
  // rather than the three the spec happens to name — the natural bug shows up on the combinations
  // nobody wrote a case for.
  const optional: MetadataSlot[] = ["effort", "build", "duration", "variants"];
  const reference = METADATA_SLOTS;
  let stable = true;
  let broke = "";
  for (let mask = 0; mask < 1 << optional.length; mask++) {
    const meta = full({
      effortSupported: (mask & 1) === 0,
      versionLabel: (mask & 2) === 0 ? "v14" : null,
      durationMs: (mask & 4) === 0 ? 12_400 : null,
      total: (mask & 8) === 0 ? 2 : 1,
    });
    const got = rendered(meta);
    // Every rendered slot must appear in the reference order, ascending, with no swaps.
    const positions = got.map((s) => reference.indexOf(s));
    const ascending = positions.every((p, i) => i === 0 || p > positions[i - 1]!);
    if (!ascending) { stable = false; broke = got.join(","); break; }
  }
  check("no combination of absences reorders what remains", stable, broke);
}

console.log("\n§6.2 — a clamp is visible, and an honoured level is not marked");
{
  check("XHigh applied as High is a clamp", isClamped(full({ effortRequested: "xhigh", effortApplied: "high" })));
  check("...and High applied as High is not", !isClamped(full({ effortRequested: "high", effortApplied: "high" })));
  // A model with no control cannot clamp — it has nothing to clamp FROM. Marking one would report
  // a downgrade that never happened, on a chip that is not even rendered.
  check("an unsupported model never reads as clamped",
    !isClamped(full({ effortSupported: false, effortRequested: "xhigh", effortApplied: "high" })));
  check("a turn missing one of the two levels does not guess",
    !isClamped(full({ effortRequested: null })) && !isClamped(full({ effortApplied: null })));
}

console.log("\n§6.4 — 12.4s under a minute, 1m 04s above");
{
  check("the spec's own example", formatDuration(12_400) === "12.4s", String(formatDuration(12_400)));
  check("...and its other one", formatDuration(64_000) === "1m 04s", String(formatDuration(64_000)));
  check("a fast response", formatDuration(340) === "0.3s", String(formatDuration(340)));
  // The boundary, both sides. An off-by-one here renders "60.0s" where the spec says "1m 00s".
  check("just under a minute is seconds", formatDuration(59_900) === "59.9s", String(formatDuration(59_900)));
  check("exactly a minute is minutes", formatDuration(60_000) === "1m 00s", String(formatDuration(60_000)));
  // ZERO-PADDED ABOVE A MINUTE. "1m 4s" reads as a typo beside "1m 14s" in a column of them.
  check("seconds are padded above a minute", formatDuration(64_000)!.includes(" 04s"));
  check("a long one still reads", formatDuration(3_725_000) === "62m 05s", String(formatDuration(3_725_000)));

  // Unmeasured is null, not "0.0s". A zero would render as a measurement under a response that
  // took eleven seconds — doc §8's rule about wrong numbers, applied to the whole row.
  check("unmeasured is nothing at all", formatDuration(null) === null);
  check("...and so is nonsense", formatDuration(NaN) === null && formatDuration(-5) === null);
}

console.log("\nthe switcher says which of how many");
{
  check("two of two", variantLabel(full()) === "2/2", String(variantLabel(full())));
  check("one of three", variantLabel(full({ ordinal: 1, total: 3 })) === "1/3");
  check("a single response has no label", variantLabel(full({ ordinal: 1, total: 1 })) === null);
}

console.log("\n§6.3 — the DiffStat rides along only while it is still a summary");
{
  const small = diffSummary(full({ diffPlus: 18, diffMinus: 4 }));
  check("a small diff summarises", small?.plus === 18 && small?.minus === 4);
  // Past the threshold the figures stop being a summary and start being a statistic — and widen
  // the row enough to wrap it on a narrow composer.
  check("a rewrite does not", diffSummary(full({ diffPlus: 412, diffMinus: 390 })) === null);
  check("the boundary is inclusive", diffSummary(full({ diffPlus: DIFF_SUMMARY_MAX, diffMinus: 0 })) !== null);
  check("...and one past it is not", diffSummary(full({ diffPlus: DIFF_SUMMARY_MAX, diffMinus: 1 })) === null);
  // An unmeasured diff is absent rather than +0/−0, which would claim a version changed nothing.
  check("an unmeasured diff shows nothing", diffSummary(full({ diffPlus: null, diffMinus: null })) === null);
  check("...and so does a half-measured one", diffSummary(full({ diffMinus: null })) === null);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
