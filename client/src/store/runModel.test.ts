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

import { defaultModelFor, providerForModel, runProviders } from "./providerStore.ts";
import type { ProviderModel } from "../types.ts";

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
  { id: "gemini-3-pro", provider: "google", label: "Gemini" },
] as ProviderModel[];

console.log("\nevery model in the catalogue resolves to the provider that offers it");
{
  check("an Anthropic model", providerForModel(sheet, "claude-opus-5") === "anthropic",
    String(providerForModel(sheet, "claude-opus-5")));
  check("...and its sibling", providerForModel(sheet, "claude-sonnet-5") === "anthropic");
  check("an OpenAI model", providerForModel(sheet, "gpt-5") === "openai");
  check("a Google model", providerForModel(sheet, "gemini-3-pro") === "google");
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

console.log("\nthe pre-snapshot catalogue answers for the default pair");
{
  // uiStore boots on `fake`/`fake-dry-run` before any providers frame lands. If that pair did not
  // resolve, the first `setModel` of a session would refuse the app's own default.
  check("an empty catalogue still owns fake-dry-run", providerForModel([], "fake-dry-run") === "fake");
  check("...and offers nothing else", providerForModel([], "claude-opus-5") === null);
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

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
