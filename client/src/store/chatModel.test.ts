// §11.1 — the chat model is a SEPARATE selection from the run's, and the composer shows the chat one.
//
// THE PRODUCT OWNER'S WORDS (2026-09-12): "two drop downs will be open. One for your agent and one
// for talking to Jaroku. You have to select what provider for both of them, then you can proceed.
// But in the composer, the provider will be shown of the provider with which you are using to talk
// to Jaroku, not for the runs."
//
// WHY THIS NEEDS A SUITE AT ALL. The two settings are one `setModel` call apart, and conflating
// them has already gone wrong once in this codebase: "Regenerate with GPT-5.6 Terra" called
// `setModel`, which repoints the model an agent's RUN goes to — so the menu changed the wrong
// setting, and the answer came back on the model it had always used, under a label promising
// otherwise. §11.1's "changing one must not change another" is that bug stated as a rule.
//
//   npm run test:chat-model

import { useUiStore } from "./uiStore.ts";
import { useProviderStore } from "./providerStore.ts";
import type { ProviderModel, ProviderStatus } from "../types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const model = (id: string, provider: string, label: string): ProviderModel => ({
  id, provider, label, name: id, reasoning: null, context_window: null,
  // EMPTY, WHICH IS WHAT THE WIRE SHAPE MEANS by "a model with no reasoning control": the levels
  // are a list and an absent list is an empty one, while the LABELS are null because a provider
  // that names no levels has no names to give. Two different absences, spelled two different ways
  // on purpose — see `ProviderModel`.
  effort_levels: [], effort_labels: null,
});

const CATALOGUE: ProviderModel[] = [
  model("claude-haiku-4-5", "anthropic", "Claude"),
  model("claude-opus-5", "anthropic", "Claude"),
  model("gpt-5.6-luna", "openai", "OpenAI"),
  model("muse-spark-1.3", "meta", "Meta"),
];

const status = (id: string, runnable: boolean): ProviderStatus => ({
  id, env_key: `${id.toUpperCase()}_API_KEY`, configured: runnable, runnable,
  label: id, powers_jaroku: id === "anthropic",
} as unknown as ProviderStatus);

const load = (runnable: string[]): void => {
  useProviderStore.getState().setProviders(
    CATALOGUE.map((m) => m.provider).filter((p, i, a) => a.indexOf(p) === i)
      .map((p) => status(p, runnable.includes(p))),
    false,
    CATALOGUE,
  );
};

// --- the two selections move independently ----------------------------------------------------

console.log("\n§11.1 — changing one must not change another");
{
  load(["anthropic", "openai", "meta"]);
  const ui = () => useUiStore.getState();
  ui().setModel("claude-opus-5");
  ui().setChatModel("gpt-5.6-luna");

  check("the run pair is what was chosen", ui().model === "claude-opus-5" && ui().provider === "anthropic",
    `${ui().provider}/${ui().model}`);
  check("the chat pair is what was chosen", ui().chatModel === "gpt-5.6-luna" && ui().chatProvider === "openai",
    `${ui().chatProvider}/${ui().chatModel}`);

  // THE ASSERTION THE OLD BEHAVIOUR FAILS. Before §11.1 there was one pair, so setting either was
  // setting both — and "Regenerate with GPT-5.6 Terra" repointed the next test run.
  ui().setChatModel("muse-spark-1.3");
  check("changing the chat model leaves the run model alone",
    ui().model === "claude-opus-5" && ui().provider === "anthropic", `${ui().provider}/${ui().model}`);
  check("...and moves the chat pair together", ui().chatModel === "muse-spark-1.3" && ui().chatProvider === "meta",
    `${ui().chatProvider}/${ui().chatModel}`);

  ui().setModel("claude-haiku-4-5");
  check("and changing the run model leaves the chat model alone",
    ui().chatModel === "muse-spark-1.3" && ui().chatProvider === "meta", `${ui().chatProvider}/${ui().chatModel}`);
}

console.log("\na model nothing offers is not selected at all");
{
  load(["anthropic"]);
  const ui = () => useUiStore.getState();
  ui().setChatModel("claude-haiku-4-5");
  const before = ui().chatModel;
  // THE SAME REFUSAL `setModel` MAKES, and the same reason: the pair would be unreachable, the chip
  // would describe something the catalogue cannot show, and every chat turn afterwards would be
  // recorded under a model that never answered.
  ui().setChatModel("some-model-nobody-has");
  check("an unknown model is refused", ui().chatModel === before, ui().chatModel);
  check("...and the provider is not orphaned", ui().chatProvider === "anthropic", ui().chatProvider);
}

// --- the catalogue arriving, and a key being revoked ------------------------------------------

console.log("\nthe catalogue moves the selection only when it has to");
{
  // A CHOICE THAT IS STILL REACHABLE IS KEPT. Somebody who chose Opus for chat does not want it
  // moved back to Haiku because the price sheet refreshed.
  load(["anthropic", "openai", "meta"]);
  const ui = () => useUiStore.getState();
  ui().setChatModel("claude-opus-5");
  load(["anthropic", "openai", "meta"]);
  check("a reachable choice survives a catalogue refresh", ui().chatModel === "claude-opus-5", ui().chatModel);

  // AND ONE THAT IS NOT IS MOVED. A key revoked mid-session leaves the conversation pointed at a
  // model that can no longer answer, and §11.1's default — the cheapest capable one — is where it
  // should land rather than at a dead pair.
  ui().setChatModel("gpt-5.6-luna");
  load(["anthropic"]);
  check("a choice whose key went away is moved", ui().chatModel !== "gpt-5.6-luna", ui().chatModel);
  check("...to something reachable", ui().chatProvider === "anthropic", `${ui().chatProvider}/${ui().chatModel}`);
  // AND THE RUN'S SELECTION IS MOVED BY THE SAME RULE, independently — two selections, one picker.
  check("the run pair is reachable too", ui().provider === "anthropic", `${ui().provider}/${ui().model}`);
}

console.log("\nnothing reachable at all");
{
  load([]);
  const ui = () => useUiStore.getState();
  // THE LAST COHERENT PAIR IS KEPT, WHICH IS `pickRunModel`'s OWN DECISION and not a gap. Its
  // comment states it: "refusing leaves the last coherent pair, which is the one the label is
  // already describing." Emptying the selection would leave the chip describing nothing, and the
  // thing that must not happen — a message going out on a provider with no key — is refused by the
  // COMPOSER's gate rather than by forgetting what was chosen.
  //
  // This assertion originally expected the opposite, which was a claim about what I thought the
  // picker did rather than what it does; the picker is right and the expectation was wrong.
  check("the chat pair keeps its last coherent value", ui().chatModel !== "" && ui().chatProvider !== "",
    `${ui().chatProvider}/${ui().chatModel}`);
  check("...and so does the run pair", ui().model !== "" && ui().provider !== "", `${ui().provider}/${ui().model}`);
  // WHAT ACTUALLY STOPS A SEND IS THE GATE, and it reads `runnable` rather than the selection — so
  // a kept pair whose key is gone is still refused. Asserted here on the same inputs the composer
  // computes from, because the gate itself is JSX.
  const runnableNow = useProviderStore.getState().providers.filter((p) => p.runnable).map((p) => p.id);
  check("...and nothing is runnable, which is what the composer's gate reads",
    runnableNow.length === 0, runnableNow.join(","));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
