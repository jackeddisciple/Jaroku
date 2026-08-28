// §17's figures, and the one rule that has to hold across three surfaces.
//
// "A figure that reads `$0.00` for four different real amounts is the same failure as showing zero
// for unknown." Both halves of that sentence are assertions here, and they are different mistakes:
// the first is a precision that rounds four distinct spends onto one string, and the second is a
// null rendered as a number. A product can commit either without the other, and this tab shows the
// same cost in the row, on the card and in the detail — so a disagreement between any two of them
// is visible in one glance without scrolling.
//
// THE LOAD-BEARING ASSERTION IS THAT THERE IS NO SECOND RULE. Every function in `cockpitFormat.ts`
// delegates to `format.ts`, so the suite checks the DELEGATION rather than re-deriving the numbers:
// a Cockpit that formatted money itself would agree with itself perfectly and disagree with the
// Usage panel about the same run, which is the shape of the bug §17 opens by describing.
//
// AND EVERY EM DASH CARRIES ITS REASON. §17 requires it and a bare dash is worse than a wrong
// number: a reader files a missing figure as a bug in the product rather than as an absence in the
// record, and then stops trusting the figures that ARE there.
//
//   npm run test:cockpit-format

import { cockpitAbsolute, cockpitCost, cockpitDuration, cockpitTime, cockpitTokens } from "./cockpitFormat.ts";
import { absTime, fmtCost, fmtDuration, fmtTokens, relTime } from "./format.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// --- 1. unknown is an em dash, and never a zero ----------------------------------------------------

console.log("\nnothing measured is not nothing spent");
{
  check("an unknown cost is an em dash", cockpitCost(null).text === "—", cockpitCost(null).text);
  check("...and undefined too", cockpitCost(undefined).text === "—");
  check("...and it is never the zero string", cockpitCost(null).text !== "$0.00");

  // THE OTHER DIRECTION, WHICH IS THE HALF THAT GETS COLLAPSED. A job that genuinely cost nothing
  // has a real total, and rendering it as an absence would throw away a fact somebody can rely on.
  check("a real zero is a number and not a dash", cockpitCost(0).text === "$0.00", cockpitCost(0).text);
  check("...so the two are distinguishable", cockpitCost(0).text !== cockpitCost(null).text);

  check("an unknown duration is an em dash", cockpitDuration(null).text === "—");
  check("an unknown token count is an em dash", cockpitTokens(null).text === "—");
  check("an absent instant is an em dash", cockpitTime(null).text === "—");
}

// --- 2. the em dash says why ----------------------------------------------------------------------

console.log("\nevery absence carries its reason");
{
  check("an unknown cost explains itself", (cockpitCost(null).title ?? "").length > 10, String(cockpitCost(null).title));
  check("an unknown duration explains itself", (cockpitDuration(null).title ?? "").length > 10);
  check("an unknown token count explains itself", (cockpitTokens(null).title ?? "").length > 10);

  // AND THE THREE REASONS ARE THREE DIFFERENT FACTS. A shared "not available" would be the em dash
  // again, one layer down — the tooltip exists to say which absence this is.
  const reasons = [cockpitCost(null).title, cockpitDuration(null).title, cockpitTokens(null).title];
  check("...and no two of them say the same thing", new Set(reasons).size === 3, reasons.join(" | "));

  // A FIGURE THAT SPEAKS FOR ITSELF CARRIES NO TOOLTIP. A title restating the digits is read twice
  // by a screen reader and adds nothing to a pointer, which is the noise this shape avoids.
  check("a known cost has no tooltip", cockpitCost(0.0031).title === null, String(cockpitCost(0.0031).title));
  check("a known duration has no tooltip", cockpitDuration(4_000).title === null);
}

// --- 3. one precision rule, and it is `format.ts`'s ------------------------------------------------

console.log("\none rule across the row, the card and the detail");
{
  // THE DELEGATION IS THE ASSERTION. If this ever stops being `fmtCost`, the Cockpit's row and the
  // Usage panel's disagree about the same run — and neither is wrong on its own, which is what
  // makes that class of bug survive review.
  for (const amount of [0, 0.0000004, 0.0031, 0.42, 1.5, 128.75]) {
    check(`$${amount} is spelled the way the rest of the app spells it`,
      cockpitCost(amount).text === fmtCost(amount), `${cockpitCost(amount).text} vs ${fmtCost(amount)}`);
  }

  // §17: "Sub-cent amounts need more places or an explicit 'under a cent'; pick one." The app
  // picked more places, before this tab existed, and `test:format` has pinned it since.
  check("a sub-cent amount keeps more places than a cent-and-over one",
    cockpitCost(0.0031).text === "$0.00310", cockpitCost(0.0031).text);
  check("...and does not round onto the zero string", cockpitCost(0.0031).text !== "$0.00");

  // FOUR DIFFERENT REAL AMOUNTS, FOUR DIFFERENT STRINGS. This is §17's own example of the failure,
  // and it is the one a two-decimal rule commits silently on a tab whose jobs cost fractions.
  const four = [0.0031, 0.0042, 0.0007, 0.0089].map((c) => cockpitCost(c).text);
  check("four different sub-cent spends read as four different figures",
    new Set(four).size === 4, four.join(", "));
}

// --- 4. the floor marker, spelled once ------------------------------------------------------------

console.log("\na floor says so");
{
  // ONE FACT, TWO RENDERINGS. The row draws a `+` and the detail writes a sentence, and before this
  // module they were two independent expressions — the arrangement where one gets fixed and the
  // other does not.
  check("a complete cost is not a floor", cockpitCost(0.42, true).floor === false);
  check("an incomplete one is", cockpitCost(0.42, false).floor === true);
  check("...and it says why", (cockpitCost(0.42, false).title ?? "").length > 10,
    String(cockpitCost(0.42, false).title));
  check("...while the figure itself is unchanged",
    cockpitCost(0.42, false).text === cockpitCost(0.42, true).text);

  // AN UNKNOWN COST IS NOT A FLOOR. It is not an undercount of anything; there is no total. The two
  // absences are different claims and a card that marked the dash with a `+` would be inventing one.
  check("an unknown cost is not marked as a floor", cockpitCost(null, false).floor === false);
}

// --- 5. time is `relTime` and nothing else ---------------------------------------------------------

console.log("\nno second clock");
{
  const recent = new Date(Date.now() - 4 * 60_000).toISOString();
  check("a relative time is `relTime`'s", cockpitTime(recent).text === relTime(recent),
    `${cockpitTime(recent).text} vs ${relTime(recent)}`);
  check("...which is minutes at four of them", cockpitTime(recent).text === "4m ago", cockpitTime(recent).text);

  // THE EXACT MOMENT IS THE TITLE AND NOT THE TEXT. §17 allows an ISO-shaped fact only where the
  // reader arrived on purpose, and a hover is that bargain in miniature.
  check("the absolute instant is on the hover", cockpitTime(recent).title === absTime(recent));
  check("...and never in the text", !/\d{4}-\d{2}-\d{2}T/.test(cockpitTime(recent).text));

  // §17's one exception, in the one place it is allowed.
  check("the metadata line may write it out", cockpitAbsolute(recent).text === absTime(recent));
  check("...and does not then repeat itself on hover", cockpitAbsolute(recent).title === null);

  // AN UNPARSEABLE INSTANT IS AN ABSENCE, NOT A BLANK. `relTime` answers "" for one, and an empty
  // cell in a column of times reads as a rendering fault rather than as a record that has none.
  check("a malformed instant is an em dash rather than an empty cell",
    cockpitTime("not a date").text === "—", `"${cockpitTime("not a date").text}"`);
  check("...in the metadata line too", cockpitAbsolute("not a date").text === "—");
}

// --- 6. durations and token counts, in the house forms ---------------------------------------------

console.log("\nthe other two figures");
{
  check("a duration is `fmtDuration`'s", cockpitDuration(269_000).text === fmtDuration(269_000));
  // §17: "4m 29s, not 269s and not 00:04:29."
  check("...which is minutes and seconds", cockpitDuration(269_000).text === "4m 29s", cockpitDuration(269_000).text);
  check("...and never a colon-separated clock", !/:/.test(cockpitDuration(269_000).text));

  // §17: token counts abbreviate above a thousand, in the app's existing abbreviation.
  check("a token count is `fmtTokens`'s short form",
    cockpitTokens(11_646).text === fmtTokens(11_646, "short"), cockpitTokens(11_646).text);
  check("...which abbreviates above a thousand", cockpitTokens(11_646).text === "11.6k tok",
    cockpitTokens(11_646).text);
  check("...and does not below it", cockpitTokens(842).text === "842 tok", cockpitTokens(842).text);
  check("a real zero is a count and not an absence", cockpitTokens(0).text === "0 tok", cockpitTokens(0).text);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
