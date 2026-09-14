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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { useUiStore } from "./uiStore.ts";
import { pickChatModel, useProviderStore } from "./providerStore.ts";
import { chatSubscriptionFor } from "../lib/chatSubscription.ts";
import type { ProviderModel, ProviderStatus, SubscriptionStatus } from "../types.ts";

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
  ui().setChatModel("claude-haiku-4-5");
  check("changing the chat model leaves the run model alone",
    ui().model === "claude-opus-5" && ui().provider === "anthropic", `${ui().provider}/${ui().model}`);
  check("...and moves the chat pair together", ui().chatModel === "claude-haiku-4-5" && ui().chatProvider === "anthropic",
    `${ui().chatProvider}/${ui().chatModel}`);

  // AN AGENT MAY RUN ON MUSE SPARK — Test mode, on a key from Secrets — which is exactly what Chat may
  // not do. The run pair moving there must leave the chat pair where it was.
  ui().setModel("muse-spark-1.3");
  check("and changing the run model leaves the chat model alone",
    ui().chatModel === "claude-haiku-4-5" && ui().chatProvider === "anthropic", `${ui().chatProvider}/${ui().chatModel}`);
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

/** One subscription row, connected or not. Muse Spark has no mechanism, so it is never either. */
const subRow = (provider: "anthropic" | "openai" | "meta", connected: boolean): SubscriptionStatus => ({
  provider, label: provider, planLabel: provider,
  available: provider !== "meta", supported: provider !== "meta", requiresApproval: false, runtimeApiSupported: true,
  reason: null, citation: "https://example.com", unblock: null, effortParam: null, effortLevels: [],
  binary: null, loginCommand: null, credentialPath: null,
  host: connected
    ? { installed: true, version: "1", signedIn: true, account: null, authMode: null, note: null, observedAt: "2026-09-14T00:00:00.000Z" }
    : null,
  connected,
});
const subs = (connected: { anthropic?: boolean; openai?: boolean }): SubscriptionStatus[] => [
  subRow("anthropic", connected.anthropic === true), subRow("openai", connected.openai === true), subRow("meta", false),
];
const subscribe = (connected: { anthropic?: boolean; openai?: boolean }): void =>
  useProviderStore.getState().setSubscriptions(subs(connected));

console.log("\nthe catalogue and the subscriptions move the chat selection only when they have to");
{
  // A CHOICE THAT IS STILL REACHABLE IS KEPT. Somebody who chose Opus for chat does not want it
  // moved back to Haiku because the price sheet refreshed.
  load(["anthropic", "openai", "meta"]);
  subscribe({ anthropic: true, openai: true });
  const ui = () => useUiStore.getState();
  ui().setChatModel("claude-opus-5");
  load(["anthropic", "openai", "meta"]);
  check("a reachable choice survives a catalogue refresh", ui().chatModel === "claude-opus-5", ui().chatModel);

  // AND ONE THAT IS NOT IS MOVED — by the SUBSCRIPTION going away, never by a key. Signing out of
  // Codex leaves the conversation pointed at a plan that can no longer answer.
  ui().setChatModel("gpt-5.6-luna");
  subscribe({ anthropic: true, openai: false });
  check("a choice whose subscription went away is moved", ui().chatModel !== "gpt-5.6-luna", ui().chatModel);
  check("...to a plan that is still connected", ui().chatProvider === "anthropic", `${ui().chatProvider}/${ui().chatModel}`);
  // AND THE RUN'S SELECTION FOLLOWS ITS OWN RULE, independently — two selections, two pickers.
  load(["anthropic"]);
  check("the run pair follows the keys", ui().provider === "anthropic", `${ui().provider}/${ui().model}`);
}

console.log("\na key is never what picks the chat model");
{
  // THE ONBOARDING CASE: Codex connected, no API key anywhere. The chat pair used to follow the keys,
  // land on the catalogue's first model — a Claude one — and send the turn to Anthropic's API.
  load([]);
  subscribe({ openai: true });
  const ui = () => useUiStore.getState();
  check("Codex connected and no key lands Chat on Codex", ui().chatProvider === "openai", `${ui().chatProvider}/${ui().chatModel}`);
  load(["anthropic"]);
  check("...and an Anthropic key arriving does not drag it back", ui().chatProvider === "openai", `${ui().chatProvider}/${ui().chatModel}`);

  check("the picker keeps a connected pick", pickChatModel(CATALOGUE, subs({ anthropic: true, openai: true }), "claude-opus-5") === "claude-opus-5");
  check("...moves an unconnected one to a connected plan", pickChatModel(CATALOGUE, subs({ openai: true }), "claude-opus-5") === "gpt-5.6-luna");
  check("...with nothing connected keeps a pick a subscription could answer", pickChatModel(CATALOGUE, subs({}), "gpt-5.6-luna") === "gpt-5.6-luna");
  check("...but not one no subscription can answer", pickChatModel(CATALOGUE, subs({}), "muse-spark-1.3") === "claude-haiku-4-5",
    pickChatModel(CATALOGUE, subs({}), "muse-spark-1.3"));
}

console.log("\nMuse Spark answers no Chat turn");
{
  // THE PRODUCT OWNER'S RULE (2026-09-14): Muse Spark is not a Jaroku Chat model. It runs agents in
  // Test mode, on a key somebody added in Secrets, and that is all it does.
  load(["anthropic", "openai", "meta"]);
  subscribe({ anthropic: true, openai: true });
  const ui = () => useUiStore.getState();
  ui().setChatModel("gpt-5.6-luna");
  ui().setChatModel("muse-spark-1.3");
  check("choosing Muse Spark for Chat is refused", ui().chatModel === "gpt-5.6-luna" && ui().chatProvider === "openai",
    `${ui().chatProvider}/${ui().chatModel}`);
  ui().setModel("muse-spark-1.3");
  check("...while an agent may still run on it", ui().model === "muse-spark-1.3" && ui().provider === "meta",
    `${ui().provider}/${ui().model}`);
  const museOnly = [model("muse-spark-1.3", "meta", "Meta")];
  check("the picker never lands on it, not even as the last model offered", pickChatModel(museOnly, subs({}), "") === "",
    pickChatModel(museOnly, subs({}), ""));
  check("...nor keeps it once the rows say it has no subscription path",
    pickChatModel(museOnly, subs({ anthropic: true }), "muse-spark-1.3") === "", pickChatModel(museOnly, subs({ anthropic: true }), "muse-spark-1.3"));
  // THE CATALOGUE AND THE ROWS ARE TWO MESSAGES. A catalogue landing first is not news about the plans.
  check("no rows yet keeps a pick rather than wiping it", pickChatModel(CATALOGUE, [], "gpt-5.6-luna") === "gpt-5.6-luna");
}

console.log("\nthe composer's gate asks about the chat provider, never about any provider");
{
  const pane = readFileSync(fileURLToPath(new URL("../components/BuildPane.tsx", import.meta.url)), "utf8");
  check("Chat is gated on the chosen provider's own row", /const noSubscription = [^;]*!chatProviderConnected/.test(pane));
  // "SOME plan is connected" is what let a Codex sign-in send a Claude turn to the server.
  check("...and never on whether some other plan is connected", !/useSubscriptionConnected\(\)/.test(pane));
  // THE FALLBACK THAT SPENT THE API KEY. A chat turn with no connected plan went to `sendChat`.
  const chatCases = pane.match(/case "chat":[\s\S]*?case "generate":/g) ?? [];
  check("the composer's chat case exists", chatCases.length > 0);
  // AND A TURN THAT DOES GO TO THE SERVER GOES AS A SUBSCRIPTION TURN, which the server hands back to
  // this app to answer rather than answering on a key.
  check("...and sends the server nothing but a subscription turn", chatCases.every((c) =>
    (c.match(/sendChat\(trimmed/g) ?? []).length
      === (c.match(/sendChat\(trimmed, activeAgentId, \{\s*(?:\/\/[^\n]*\n\s*)*subscription:/g) ?? []).length));
  check("...and one with no connected plan opens the account panel instead",
    chatCases.every((c) => /openWorkspacePanel\("account"\);\s*return;/.test(c)));
  check("the Chat menu lists only providers with a subscription path",
    /chatCatalogue = useMemo\(\s*\(\) => catalogue\.filter\(\(p\) => subscriptions\.some\(\(sub\) => sub\.provider === p\.id && sub\.supported\)\)/.test(pane));
}

console.log("\nevery way a chat turn is sent rides the plan the conversation runs on");
{
  // THE COMPOSER ASKED AND THE TURN'S OWN CONTROLS DID NOT: regenerate, retry, "I just wanted to ask"
  // and edit-and-fork left with no subscription, and the server answered them on an API key.
  (globalThis as Record<string, unknown>).__TAURI__ = {
    core: { invoke: async () => null },
    event: { listen: async () => () => {} },
  };
  load(["anthropic", "openai", "meta"]);
  subscribe({ openai: true });
  const ui = () => useUiStore.getState();
  ui().setChatModel("gpt-5.6-luna");
  const sub = chatSubscriptionFor();
  check("the chat model's own connected plan is what a turn rides",
    sub?.provider === "openai" && sub.model === "gpt-5.6-luna", JSON.stringify(sub));
  check("...at no level, for a model that takes none", sub?.effort === null, JSON.stringify(sub));
  check("regenerating on a model whose plan is not connected rides nothing", chatSubscriptionFor({ modelId: "claude-opus-5" }) === null);
  check("...and Muse Spark is never ridden", chatSubscriptionFor({ modelId: "muse-spark-1.3" }) === null);
  delete (globalThis as Record<string, unknown>).__TAURI__;
  check("a browser rides no plan at all", chatSubscriptionFor() === null);

  const pane = readFileSync(fileURLToPath(new URL("../components/BuildPane.tsx", import.meta.url)), "utf8");
  const sends = [...pane.matchAll(/sendChat\(/g)].map((m) => pane.slice(m.index ?? 0, (m.index ?? 0) + 1200));
  const bodies = sends.map((s) => s.slice(0, s.indexOf("});") + 3));
  check(`every chat send in the pane rides a plan (${sends.length})`,
    sends.length >= 4 && bodies.every((b) => /\bsubscription\b/.test(b)), bodies.filter((b) => !/\bsubscription\b/.test(b)).join(" || "));
  check("...and so does an edit-and-fork", /sendEditTurn\(threadId, turn\.itemId, next, subscription\)/.test(pane));
  check("regenerate-with offers only models on a connected plan",
    /models\.filter\(\(m\) => isProviderId\(m\.provider\) && chatUsable\.has\(m\.provider\)\)/.test(pane));
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
