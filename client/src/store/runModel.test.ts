// THE PROVIDER/MODEL PAIR, WHICH IS THE ONE PIECE OF UI STATE THAT REACHES THE DATABASE.
//
// A `run` frame carries both fields, the server writes both onto the `runs` row, and the Usage
// panel's *By agent* and *Most expensive runs* sections, the trace header and Activity's MODEL MIX
// card all read that column back. So a pair the UI can hold and no catalogue offers is not a
// cosmetic fault: it is a model name persisted for a run that was executed by something else, under
// a product whose stated invariant is "the trace never lies".
//
// AND IT COULD BE HELD. `setProvider` re-derived the model, so that direction was safe; `setModel`
// wrote the model and left the provider alone, so pinning `claude-opus-5` while the tab sat on the
// free dry-run provider produced `provider: fake, model: claude-opus-5` — with the composer still
// reading "Dry run (free)", because the label is derived from the provider and the provider had not
// moved. Nothing on screen changed. Every run afterwards was recorded under a model that never ran,
// and a reload silently repaired it, which is what kept it out of sight.
//
// THIS SUITE IS ABOUT THE RESOLVER, and the store's setter is three lines over it. What it holds is
// the property the setter needs to be able to keep: for every model any provider offers, exactly
// one provider owns it, and a model nobody offers resolves to nothing rather than to a guess.
//
//   npm run test:run-model

import { defaultModelFor, modelName, pickRunModel, providerForModel, runProviders } from "./providerStore.ts";
import type { ProviderModel, ProviderStatus } from "../types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

/** A price sheet shaped like the real one: newest first, several providers, one label each. */
const sheet: ProviderModel[] = [
  { id: "claude-opus-5", provider: "anthropic", label: "Claude" },
  { id: "claude-sonnet-5", provider: "anthropic", label: "Claude" },
  { id: "gpt-5", provider: "openai", label: "OpenAI" },
  { id: "muse-spark-1.3", provider: "meta", label: "Meta" },
] as ProviderModel[];

console.log("\nevery model in the catalogue resolves to the provider that offers it");
{
  check("an Anthropic model", providerForModel(sheet, "claude-opus-5") === "anthropic",
    String(providerForModel(sheet, "claude-opus-5")));
  check("...and its sibling", providerForModel(sheet, "claude-sonnet-5") === "anthropic");
  check("an OpenAI model", providerForModel(sheet, "gpt-5") === "openai");
  check("a Meta model", providerForModel(sheet, "muse-spark-1.3") === "meta");
}

console.log("\nthe pair the audit found, which is now unreachable");
{
  // The exact combination: the free dry-run provider holding a paid Anthropic model. `setModel`
  // resolves the owner, so choosing this model moves the provider with it rather than leaving one
  // behind — and the composer's label, derived from the provider, changes with it.
  const owner = providerForModel(sheet, "claude-opus-5");
  check("claude-opus-5 is never owned by `fake`", owner !== "fake", String(owner));
  check("...it is owned by anthropic", owner === "anthropic");
}

console.log("\na model nothing offers resolves to nothing, never to a guess");
{
  check("an unknown id", providerForModel(sheet, "claude-opus-9") === null);
  check("an empty id", providerForModel(sheet, "") === null);
  // The setter refuses on null, so the last coherent pair survives — which is the pair the label
  // beside the run button is already describing.
  check("a provider id is not a model id", providerForModel(sheet, "anthropic") === null);
}

console.log("\nbefore the catalogue lands there is nothing to run on — not even a dry run");
{
  // uiStore boots on an empty pair. The dry run is the test suites' stand-in and no selector offers
  // it, so an empty catalogue owns nothing at all rather than quietly owning that.
  check("an empty catalogue owns no dry run", providerForModel([], "fake-dry-run") === null);
  check("...and nothing else", providerForModel([], "claude-opus-5") === null);
  check("...and groups into no providers", runProviders([]).length === 0);
}

console.log("\nthe run model follows the catalogue and the keys");
{
  const status = (...ids: string[]): ProviderStatus[] =>
    (["anthropic", "openai", "meta"] as const).map((id) => ({
      id, env_key: "", configured: ids.includes(id), runnable: ids.includes(id), powers_jaroku: id === "anthropic",
    }));
  check("a pick that can run is kept", pickRunModel(sheet, status("anthropic"), "claude-sonnet-5") === "claude-sonnet-5");
  check("a stored dry-run pick moves to the first model that can run",
    pickRunModel(sheet, status("openai"), "fake-dry-run") === "gpt-5");
  check("a pick whose provider cannot run moves to one that can",
    pickRunModel(sheet, status("meta"), "claude-opus-5") === "muse-spark-1.3");
  check("with nothing runnable an offered pick stays, so a send can name the key it needs",
    pickRunModel(sheet, status(), "gpt-5") === "gpt-5");
  check("...and one nothing offers becomes the catalogue's first", pickRunModel(sheet, status(), "fake-dry-run") === "claude-opus-5");
  check("an empty catalogue picks nothing", pickRunModel([], status("anthropic"), "claude-opus-5") === "");
}

console.log("\nthe two directions agree — the invariant is round-trippable");
{
  // What makes this a pair rather than two fields: resolving a provider's default model and then
  // resolving that model's owner has to land back on the provider you started from.
  for (const p of runProviders(sheet)) {
    const back = providerForModel(sheet, defaultModelFor(sheet, p.id));
    check(`${p.id} → its default model → ${p.id}`, back === p.id, String(back));
  }
  // And every model in the sheet, not only the defaults.
  const orphans = sheet.filter((m) => providerForModel(sheet, m.id) !== m.provider).map((m) => m.id);
  check("no model in the catalogue is orphaned", orphans.length === 0, orphans.join(","));
}

console.log("\na model reads as its name, and an unnamed one as its id");
{
  // Every selector shows this. The id is what a run is started with and recorded under; the name is
  // what somebody picked it by.
  const named = [{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai", label: "OpenAI" }] as ProviderModel[];
  check("the name the price sheet gives it", modelName(named, "gpt-5.6-luna") === "GPT-5.6 Luna");
  check("...and the id for a model nobody named", modelName(named, "gpt-9") === "gpt-9");
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
