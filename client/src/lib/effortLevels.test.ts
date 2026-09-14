// The effort slider's stops and names — the product owner's list, checked word for word.
//
// Claude: Low, Medium, High effort, XHigh, Max effort. OpenAI: Light, Medium, High, Extra High,
// Ultra. Meta: no control. Each is a fixture shaped the way the server's catalogue sends a model, so
// what this suite asserts is what the composer does with a snapshot, not with a table of its own.
//
//   npm run test:effort-levels

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { EFFORT_ORDER, effortLabel, effortName, effortStops, stopFor, subscriptionEffort } from "./effortLevels.ts";
import type { ProviderModel } from "../types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const FIVE = ["low", "medium", "high", "xhigh", "max"];
const model = (over: Partial<ProviderModel>): ProviderModel => ({
  id: "m", name: "M", provider: "anthropic", label: "Claude", reasoning: "effort", context_window: null,
  effort_levels: FIVE, effort_labels: null, ...over,
});
const opus = model({
  id: "claude-opus-5", name: "Opus 5",
  effort_labels: { low: "Low", medium: "Medium", high: "High effort", xhigh: "XHigh", max: "Max effort" },
});
const astra = model({
  id: "gpt-6-astra", name: "GPT-6 Astra", provider: "openai", label: "OpenAI",
  effort_labels: { low: "Light", medium: "Medium", high: "High", xhigh: "Extra High", max: "Ultra" },
});
const muse = model({ id: "muse-spark-1.3", provider: "meta", label: "Meta", reasoning: null, effort_levels: [] });

console.log("\nfive levels, in order");
check("low, medium, high, xhigh, max", EFFORT_ORDER.join(",") === FIVE.join(","), EFFORT_ORDER.join(","));

console.log("\nthe stops come from the catalogue");
{
  check("a five-level Claude model has five stops", effortStops(opus).join(",") === FIVE.join(","));
  check("...and so does a five-level OpenAI one", effortStops(astra).join(",") === FIVE.join(","));
  check("Muse Spark has none, so it has no control", effortStops(muse).length === 0);
  check("nothing selected has none", effortStops(undefined).length === 0);
  // Ordered by the five, whatever order the list arrived in, and a word nobody defined is ignored.
  check("the order is the levels' own, not the list's",
    effortStops(model({ effort_levels: ["high", "low", "medium", "turbo"] })).join(",") === "low,medium,high");
  // A model the server says has no reasoning control has no stops, even if a list came with it.
  check("no reasoning control is no stops", effortStops(model({ reasoning: null })).length === 0);
}

console.log("\na remembered level lands on the highest stop at or below it");
{
  const three = ["low", "medium", "high"] as const;
  check("Max on a three-stop model sits at High", stopFor([...three], "max") === "high");
  check("XHigh too", stopFor([...three], "xhigh") === "high");
  check("a level that is a stop is itself", stopFor([...three], "medium") === "medium");
  check("Max on five stops is Max", stopFor(FIVE as never, "max") === "max");
  check("below every stop, the first", stopFor(["high", "max"], "low") === "high");
  check("no stops, no position", stopFor([], "high") === null);
}

console.log("\nand each provider's own words");
{
  check("Claude's",
    FIVE.map((l) => effortName(opus, l as never)).join(" / ") === "Low / Medium / High effort / XHigh / Max effort",
    FIVE.map((l) => effortName(opus, l as never)).join(" / "));
  check("OpenAI's",
    FIVE.map((l) => effortName(astra, l as never)).join(" / ") === "Light / Medium / High / Extra High / Ultra",
    FIVE.map((l) => effortName(astra, l as never)).join(" / "));
  check("a model with no names of its own falls back to the level's",
    effortName(model({}), "xhigh") === "XHigh" && effortName(model({}), "max") === "Max");
  check("XHigh keeps its capital H", effortLabel("xhigh") === "XHigh");
}

console.log("\nwhat a subscription turn is sent at");
{
  const codex = ["low", "medium", "high", "xhigh"];
  const haiku = model({ id: "claude-haiku-4-5", name: "Haiku 4.5", reasoning: null, effort_levels: [] });
  // THE DEFECT: the level came from the PROVIDER's list alone, so a model with no effort setting was
  // sent one anyway — its slider hidden, and the request still carrying `medium`.
  check("Haiku 4.5 is sent nothing, though Anthropic accepts five levels", subscriptionEffort(haiku, FIVE, "medium") === null);
  check("...and Muse Spark nothing", subscriptionEffort(muse, [], "high") === null);
  check("a level both accept is sent as itself", subscriptionEffort(opus, FIVE, "high") === "high");
  check("Max on Codex clamps down to xhigh", subscriptionEffort(astra, codex, "max") === "xhigh");
  check("...and never up: below every stop sends nothing",
    subscriptionEffort(model({ effort_levels: ["high", "max"] }), FIVE, "low") === null);
  check("a provider that accepts nothing is sent nothing", subscriptionEffort(opus, [], "high") === null);
  check("no model selected is sent nothing", subscriptionEffort(undefined, FIVE, "high") === null);

  // AND THE COMPOSER SENDS WHAT THIS SAYS, rather than deciding again inline.
  const pane = readFileSync(fileURLToPath(new URL("../components/BuildPane.tsx", import.meta.url)), "utf8");
  check("the composer's chat effort comes from subscriptionEffort",
    /const chatEffortValue = useMemo\(\s*\(\) => subscriptionEffort\(/.test(pane));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
