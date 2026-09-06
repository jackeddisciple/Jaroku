// I1: amber means running. Still. Everywhere.
//
// EXACTLY ONE PHASE IN THE WHOLE VOCABULARY IS AMBER, and this suite is what makes that a claim
// rather than a comment. It enumerates every mark, every border colour and every chip variant this
// work produces and fails on a second one — because the way this rule dies is never a decision. It
// is one `PHASE_COLOUR.waiting: STATUS.pending` in a table of seven, added by somebody who reasoned
// correctly that a job waiting on a human is "in flight", and after which the amber down a column
// no longer answers the one question it was spent on.
//
// IT EXTENDS A LAW THIS REPOSITORY ALREADY HOLDS rather than inventing one. `test:agent-tags`
// asserts that only Running, Generating and Deploying wear amber on an agent card, and records why:
// v0.2.2 redrew the wordmark because an amber outline read as a warning sign in an app where amber
// already means running. This is the same sentence one layer down, over the vocabulary those tags
// sit beside.
//
// THE CLIENT HAD SPENT AMBER ELSEWHERE and this work is what takes it back. `WorkGlyph` gave
// `waiting` the same amber as `running` on an argument §9 made explicitly — "both are genuinely in
// flight, one on the machine and one on a person" — which is a good argument for a tab and a bad
// one for a product, because the Cockpit is not the only place a person is being waited on. Under
// this vocabulary `waiting` is neutral and the amber is the machine's alone.
//
//   npm run test:status-amber

import { createElement } from "react";
import { readFileSync } from "node:fs";

import { markup } from "../lib/testRender.ts";
import { AMBER_PHASE, PHASES, PHASE_COLOUR, type Phase } from "../lib/statusPhase.ts";
import { STATUS } from "../lib/tokens.ts";
import { StatusGlyph } from "./StatusGlyph.tsx";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const AMBER = STATUS.pending.toLowerCase();

// --- 1. the table ------------------------------------------------------------------------------

console.log("\nexactly one phase is amber");
{
  const amber = PHASES.filter((p) => PHASE_COLOUR[p].toLowerCase() === AMBER);
  check("one and only one", amber.length === 1, amber.join(", "));
  check("...and it is active", amber[0] === "active", String(amber[0]));
  // THE EXCEPTION IS WRITTEN DOWN IN THE VOCABULARY, not only here. A rule whose only statement is
  // in its own test is a rule the next reader of `statusPhase.ts` never sees.
  check("the vocabulary names its own exception", AMBER_PHASE === "active", AMBER_PHASE);

  // AND ROSE IS AS NARROW. §2.1 gives the ramp two colours and a neutral; a second rose would be
  // the same failure one column over — "finished badly" spread across two phases that mean
  // different things.
  const rose = PHASES.filter((p) => PHASE_COLOUR[p].toLowerCase() === STATUS.error.toLowerCase());
  check("exactly one phase is rose", rose.length === 1, rose.join(", "));
  check("...and it is failed", rose[0] === "failed", String(rose[0]));

  // THE OTHER FIVE ARE THE SAME NEUTRAL, which is what makes them recede together. Five slightly
  // different greys would be five phases each quietly claiming a little attention.
  const quiet = PHASES.filter((p) => p !== "active" && p !== "failed");
  check("the other five share one neutral",
    quiet.every((p) => PHASE_COLOUR[p] === STATUS.neutral), quiet.map((p) => `${p}=${PHASE_COLOUR[p]}`).join(", "));

  // AND NOTHING REACHES FOR A COLOUR THE APP HAS NOT NAMED. A seventh colour arrives as a hex
  // somebody used to separate two phases that shared a hue.
  const KNOWN = [STATUS.ok, STATUS.pending, STATUS.error, STATUS.warn, STATUS.neutral].map((c) => c.toLowerCase());
  const stray = PHASES.filter((p) => !KNOWN.includes(PHASE_COLOUR[p].toLowerCase()));
  check("no phase invents a colour", stray.length === 0, stray.join(", "));
  // GREEN IS SPENT NOWHERE. `done` is not an achievement — it is a row with nothing outstanding in
  // it — and a column of green ticks is a column where the rows that need somebody are hardest to
  // find. This is the assertion that fails if `done` is "fixed" back to the ok green.
  check("no phase is the ok green",
    !PHASES.some((p) => PHASE_COLOUR[p].toLowerCase() === STATUS.ok.toLowerCase()));
}

// --- 2. the marks themselves -------------------------------------------------------------------

console.log("\n...and exactly one mark renders amber");
{
  // THE TABLE IS NOT THE RENDER. A glyph that hard-coded an amber inside its geometry would pass
  // every assertion above, which is why this reads the markup rather than the map.
  const drawn = new Map<Phase, string>(
    PHASES.map((p) => [p, markup(createElement(StatusGlyph, { phase: p })).toLowerCase()]),
  );
  const ambered = PHASES.filter((p) => drawn.get(p)!.includes(AMBER));
  check("one mark carries the amber", ambered.length === 1, ambered.join(", "));
  check("...and it is the active arc", ambered[0] === "active", String(ambered[0]));
}

// --- 3. the source, because a colour can arrive without a table ---------------------------------

console.log("\nthe vocabulary spends amber in one place");
{
  // READ AS TEXT, which is the half a render cannot see: a second `STATUS.pending` in this
  // vocabulary's own modules is a second amber whether or not any current phase reaches it.
  const MODULES = ["src/lib/statusPhase.ts", "src/components/StatusGlyph.tsx"];
  const uses = MODULES.flatMap((path) => {
    const body = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    return [...body.matchAll(/STATUS\.pending/g)].map(() => path);
  });
  check("STATUS.pending is reached exactly once", uses.length === 1, uses.join(", "));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
