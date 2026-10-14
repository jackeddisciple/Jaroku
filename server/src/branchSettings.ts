// What "Re-run from here" may change about the branch it starts (the trace panel's feature list,
// 2026-10-14): the model — any the catalogue offers, and so its provider — and a temperature or a
// seed, only where that model takes one. Which models take which is a fact in runtime/pricing.json
// (`sampling`), the same list models.py reads, so the server never offers a setting the run would
// not send, and the run never sends one the model would answer with a 400.
//
//   npm run test:pricing

import { allPrices, capabilityFor } from "./pricing.ts";
import { isRealProvider } from "./providers.ts";

/**
 * What a branch is asked to run on, checked against the catalogue: a model the price sheet offers
 * (and so its provider), and a temperature or seed only where that model takes one (`sampling`).
 * The refusal is a sentence for the trace; nothing has been copied when it is given.
 */
export function branchSettings(
  parent: { provider: string; model: string },
  asked: { model?: unknown; temperature?: unknown; seed?: unknown },
): { provider: string; model: string; temperature: number | null; seed: number | null } | { refusal: string } {
  let provider = parent.provider;
  let model = parent.model;
  if (asked.model !== undefined && asked.model !== parent.model) {
    const price = typeof asked.model === "string" ? allPrices().find((p) => p.id === asked.model) : undefined;
    if (!price || !isRealProvider(price.provider)) return { refusal: "that model is not one this app can run" };
    provider = price.provider;
    model = price.id;
  }
  const takes = capabilityFor(model)?.sampling ?? [];
  const name = allPrices().find((p) => p.id === model)?.name ?? model;
  let temperature: number | null = null;
  if (asked.temperature !== undefined && asked.temperature !== null) {
    if (typeof asked.temperature !== "number" || !Number.isFinite(asked.temperature) || asked.temperature < 0 || asked.temperature > 1) {
      return { refusal: "a temperature is a number from 0 to 1" };
    }
    if (!takes.includes("temperature")) return { refusal: `${name} doesn't take a temperature` };
    temperature = asked.temperature;
  }
  let seed: number | null = null;
  if (asked.seed !== undefined && asked.seed !== null) {
    if (typeof asked.seed !== "number" || !Number.isInteger(asked.seed) || asked.seed < 0 || asked.seed > 2 ** 31 - 1) {
      return { refusal: "a seed is a whole number from 0 to 2147483647" };
    }
    if (!takes.includes("seed")) return { refusal: `${name} doesn't take a seed` };
    seed = asked.seed;
  }
  return { provider, model, temperature, seed };
}
