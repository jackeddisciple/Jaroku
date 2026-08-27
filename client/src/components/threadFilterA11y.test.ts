// THE ONE SURFACE OF FOUR THAT FAILED THE SWEEP.
//
// A runtime pass over all four destinations, looking for controls with no accessible name, inputs
// with no label, disabled controls with no reason and colour-only toggle groups, produced exactly
// two findings and both were here:
//
//   unlabelledInputs:   {"tag":"INPUT","type":"text","ph":"filter…"}
//   colourOnlyToggles:  {"group":"All38 | Needs you1 | Running0 | Recent37 | Archived0","active":"All38"}
//
// The rest of the client is in good shape, which is what makes this a local omission rather than a
// systemic gap — `aria-pressed` is used correctly in ten components, and `ActivityView`'s 24h/7d/30d
// chips are the same control two surfaces away with the attribute on them.
//
// AND THE CODEBASE STATES THE RULE ITSELF, in `ShieldControl`: "COLOUR IS NEVER THE ONLY SIGNAL
// (§10)." Between the active chip and the other four there was one difference, `bg-active text-ink`
// — so which of five filters was applied was a fact only a sighted user had.
//
// A PLACEHOLDER IS NOT A NAME, which is the half people argue about. It is not exposed as one, and
// it is the one piece of text that disappears the moment somebody starts typing — so the field was
// unnamed on arrival and unnamed again with a value in it.
//
//   npm run test:thread-filter-a11y

import { createElement } from "react";
import { markup } from "../lib/testRender.ts";
import { THREAD_FILTERS } from "../lib/threadFilter.ts";
import { ThreadFilterBar } from "./ThreadFilterBar.tsx";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const counts = { all: 38, needs_you: 1, running: 0, recent: 37, archived: 0 };
const bar = (filter: (typeof THREAD_FILTERS)[number], query = ""): string =>
  markup(createElement(ThreadFilterBar, {
    filter, query, counts,
    onFilter: () => {}, onQuery: () => {},
  }));

console.log("\nthe filter field has a name that does not vanish when you type in it");
{
  const empty = bar("all");
  check("it is labelled", /aria-label="Filter threads"/.test(empty));
  check("...and still carries its placeholder as a hint", /placeholder="filter…"/.test(empty));
  // The state the placeholder cannot serve: a field with a value in it.
  const typed = bar("all", "webhook");
  check("the name survives a value being typed", /aria-label="Filter threads"/.test(typed));
  check("...which is the state the placeholder is gone in", /value="webhook"/.test(typed));
}

console.log("\nthe five chips say which one is applied, in something other than colour");
{
  const html = bar("all");
  const pressed = [...html.matchAll(/aria-pressed="(true|false)"/g)].map((m) => m[1]);
  check("every chip carries the attribute", pressed.length === THREAD_FILTERS.length,
    `${pressed.length} of ${THREAD_FILTERS.length}`);
  check("exactly one is pressed", pressed.filter((p) => p === "true").length === 1,
    pressed.join(","));
  check("...and the other four are explicitly not", pressed.filter((p) => p === "false").length === 4);
}

console.log("\nand it moves with the filter rather than being pinned to the first chip");
{
  // A group where `aria-pressed` is hardcoded true on one chip passes the count above and tells a
  // screen-reader user the wrong thing on four filters out of five.
  for (const filter of THREAD_FILTERS) {
    const html = bar(filter);
    const pressedIndex = [...html.matchAll(/aria-pressed="(true|false)"/g)]
      .findIndex((m) => m[1] === "true");
    check(`"${filter}" presses chip ${THREAD_FILTERS.indexOf(filter)}`,
      pressedIndex === THREAD_FILTERS.indexOf(filter), String(pressedIndex));
  }
}

console.log("\nthe zero-count chips are still reachable");
{
  // Dimmed at zero, never disabled — the component's own rule, and it is an accessibility rule as
  // much as a layout one: "Archived 0" answers "have I archived anything", and a disabled chip
  // refuses a question it could perfectly well answer.
  const html = bar("all");
  check("nothing in the group is disabled", !/<button[^>]*disabled/.test(html));
  check("...and the zero counts are rendered rather than omitted", html.includes(">0<"));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
