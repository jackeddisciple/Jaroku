// §7: one date chip, one formatter, and no state that implies a deadline this product does not have.
//
// THE TEMPTATION THIS SUITE EXISTS FOR IS A RED ONE. Every board UI anybody has copied a date chip
// from has an overdue state, and it is the most natural thing in the world to add: a date that has
// passed, in red. Jaroku has no due dates — every one of the sites this renders at is a TIMESTAMP,
// something that already happened — so a red date chip would be a deadline that does not exist, and
// an amber one would be worse, because amber in this product means a run is in flight RIGHT NOW and
// a date is by definition a thing that is not.
//
// AND ONE FORMATTER, which is the other half. The client had three spellings of a timestamp before
// this: `relTime` in most places, a raw ISO string in the version list's tooltip, and
// `new Date(...).toLocaleString()` in the secrets rotation history — full precision, in the
// browser's locale, in the one view where somebody is comparing dates to each other.
//
//   npm run test:date-chip

import { createElement } from "react";

import { markup } from "../lib/testRender.ts";
import { check, done, read, sourceFiles } from "../lib/icons/harness.ts";
import { absTime, relTime } from "../lib/format.ts";
import { STATUS } from "../lib/tokens.ts";
import { DateChip } from "./Chip.tsx";

/** The six §7.2 sites this pattern lands at. Written out; see the last block for why. */
const SITE_FILES = [
  "components/ThreadRow.tsx",     // Threads — last activity
  "components/AgentCard.tsx",     // Agents — last active
  "components/AgentVersions.tsx", // Agent detail — version published
  "components/InboxCard.tsx",     // Inbox — first seen
  "components/SecretsList.tsx",   // Secrets — last rotated
  "components/WorkspacePanel.tsx",// Workspace — member joined, invite sent
];

const AT = "2026-03-04T09:12:44.000Z";
const chip = markup(createElement(DateChip, { at: AT }));

// --- 1. what it draws ---------------------------------------------------------------------------

console.log("\na calendar mark, then the formatted date, in one hairline pill");
{
  check("it draws a mark", chip.includes("<svg"), chip.slice(0, 120));
  // FROM THE REGISTRY, never a direct import — I4 from the icon system, which this chip is bound by
  // like every other mark in the product.
  check("the mark comes from the registry",
    read("src/components/Chip.tsx").includes("Icon.activity.dateRange"));
  check("it draws the formatted date", chip.includes(relTime(AT)), chip);
  // A HAIRLINE PILL, WHICH IS THE CHIP'S OWN OUTLINE and not a second geometry. `Chip`'s outline
  // variant is an inset shadow rather than a border, so an outlined chip occupies exactly the same
  // box as a filled one and the two sit level in a row.
  check("it is the chip's outline", /inset 0 0 0 1px/.test(chip), chip.slice(0, 200));
  check("it is the chip's radius", chip.includes("rounded-chip"), chip.slice(0, 200));
  // NOTHING AT ALL FOR A MISSING TIMESTAMP. An empty calendar pill claims there is a date to know.
  check("null renders nothing", markup(createElement(DateChip, { at: null })) === "");
  check("...and so does undefined", markup(createElement(DateChip, { at: undefined })) === "");
}

// --- 2. there is no overdue state ----------------------------------------------------------------

console.log("\nno red variant, and emphatically no amber");
{
  const body = read("src/components/Chip.tsx");
  const dateSection = body.slice(body.indexOf("export function DateChip"));
  check("the chip carries no status colour at all",
    !dateSection.includes("STATUS.") && !/text-(err|run|warn|ok)\b/.test(dateSection), dateSection.slice(0, 200));
  check("...and none reaches the markup",
    !chip.toLowerCase().includes(STATUS.error.toLowerCase()) && !chip.toLowerCase().includes(STATUS.pending.toLowerCase()),
    chip);
  // THE PROP THAT WOULD MAKE ONE POSSIBLE DOES NOT EXIST. A `variant`, a `tone` or an `overdue` on
  // this signature is the door; there is no door.
  check("there is no overdue prop", !/overdue|due\b|deadline/i.test(dateSection), dateSection.slice(0, 200));
  // A DATE IS THE SAME COLOUR WHATEVER IT SAYS. Two chips a decade apart render identically but for
  // their text, which is the property an overdue state would break.
  const old = markup(createElement(DateChip, { at: "2016-01-01T00:00:00.000Z" }));
  // COMPARED ON TREATMENT RATHER THAN ON CONTENT: the classes and the inline style are what an
  // overdue variant would change, and the date itself is supposed to differ.
  const treatment = (m: string): string =>
    [...m.matchAll(/(class|style)="([^"]*)"/g)].map((x) => `${x[1]}=${x[2]}`).join("|");
  check("an old date looks exactly like a new one", treatment(old) === treatment(chip),
    `${treatment(old)}\n${treatment(chip)}`);
}

// --- 3. one formatter -----------------------------------------------------------------------------

console.log("\none date formatter, which is the one the rest of the app uses");
{
  check("the face is relTime", chip.includes(relTime(AT)));
  check("the tooltip is absTime", chip.includes(absTime(AT)), chip);
  // AND A CALLER WITH A BETTER SENTENCE CAN SAY IT, without reaching for a formatter of its own —
  // "Last active 4 March, 09:12" is a title, not a second format.
  const titled = markup(createElement(DateChip, { at: AT, title: "Last active" }));
  check("a caller's own sentence wins", titled.includes('title="Last active"'), titled);

  // NO SECOND FORMATTER AT THE SITES THIS PATTERN OWNS. Scoped deliberately: `toLocaleString` on a
  // NUMBER is a thousands separator and has nothing to do with dates, and a sweep that could not
  // tell the two apart would be a rule nobody could satisfy. What §7.1 forbids is a date formatted
  // by hand beside a date chip, which is exactly what the secrets rotation history had —
  // `new Date(r.rotated_at).toLocaleString()`, full precision, in the browser's locale, in the one
  // view where somebody is comparing dates to each other.
  const rogue: string[] = [];
  for (const file of SITE_FILES) {
    read(`src/${file}`).split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (/new Date\([^)]*\)\s*\.toLocale/.test(line) || /toLocaleDateString\(|toLocaleTimeString\(/.test(line)) {
        rogue.push(`${file}:${i + 1}`);
      }
    });
  }
  check("no date-chip site formats a date for itself", rogue.length === 0, rogue.join(", "));
  // AND THE CHIP ITSELF REACHES FOR NOTHING BUT `format.ts`.
  const chipSource = read("src/components/Chip.tsx");
  check("the chip has no formatter of its own",
    !/toLocale|Intl\.DateTimeFormat|new Date\(/.test(chipSource.slice(chipSource.indexOf("export function DateChip"))));
}

// --- 4. long values fade rather than cut ----------------------------------------------------------

console.log("\nlong values route through Truncate");
{
  // §7.1: "Long values fade through `Truncate`, never cut." Several of the twelve sites are in a
  // fixed-width column, and an absolute date in a narrow one is the case that overflows.
  check("the value is truncated, not clipped", /overflow-hidden/.test(chip) && /text-ellipsis/.test(chip), chip);
  check("...through the shared component",
    read("src/components/Chip.tsx").includes('import { Truncate }'));
}

// --- 5. where it goes ------------------------------------------------------------------------------

console.log("\n...and it is the same chip at every site");
{
  // THE SITES, WRITTEN OUT. A date chip that existed and was used nowhere would pass every check
  // above, and a site that quietly went back to a bare `relTime` leaves no trace but a screenshot.
  for (const path of SITE_FILES) {
    check(`${path} draws the date chip`, read(`src/${path}`).includes("<DateChip"), path);
  }
  // AND IT IS A VARIANT RATHER THAN A COMPONENT. §7.1: "Not a new component." No second file, no
  // second radius, no twelfth chip geometry for this codebase to reconcile.
  const files = sourceFiles().map((f) => f.replace(/^src\//, ""));
  check("there is no DateChip.tsx", !files.includes("components/DateChip.tsx"), files.filter((f) => /DateChip/.test(f)).join(", "));
}

done();
