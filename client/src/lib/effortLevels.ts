// Which effort stops a model's slider has, and what they are called — from the server's catalogue.
//
// THE CATALOGUE DECIDES, NOT THIS FILE. Each model arrives with `effort_levels` (the stops it can
// actually be run at) and `effort_labels` (its provider's own names for them: Claude's "Low, Medium,
// High effort, XHigh, Max effort", OpenAI's "Light, Medium, High, Extra High, Ultra"), both from
// runtime/pricing.json. This file only orders them and answers the two questions the control asks:
// where a level sits on a model's stops, and what to call it there.
//
// NO STOPS, NO CONTROL. Muse Spark has none by the product owner's call on 2026-09-11, and Haiku 4.5
// has none because Anthropic offers it no effort setting; the composer leaves the control out.
//
//   npm run test:effort-levels

import type { Effort } from "../store/composerSettingsStore.ts";
import type { ProviderModel } from "../types.ts";

/** Jaroku's five levels, in order — the order a slider's stops run, left to right. */
export const EFFORT_ORDER: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** A level's own name, for where no provider's is known. XHigh keeps its capital H. */
export function effortLabel(level: Effort): string {
  return level === "xhigh" ? "XHigh" : level[0]!.toUpperCase() + level.slice(1);
}

/** The stops this model's slider has, in order. None for a model with no reasoning control. */
export function effortStops(model: ProviderModel | undefined): Effort[] {
  if (!model?.reasoning) return [];
  const listed = new Set(model.effort_levels ?? []);
  return EFFORT_ORDER.filter((l) => listed.has(l));
}

/**
 * Where a level sits on those stops: the highest one at or below it — which is also the level the
 * server would run it at. A conversation remembered at Max opens a three-stop model at its top stop
 * rather than at a position that is not there.
 */
export function stopFor(stops: readonly Effort[], level: Effort): Effort | null {
  if (stops.length === 0) return null;
  for (let i = EFFORT_ORDER.indexOf(level); i >= 0; i--) {
    if (stops.includes(EFFORT_ORDER[i]!)) return EFFORT_ORDER[i]!;
  }
  return stops[0]!;
}

/** What this model's provider calls a level — "Ultra", "Max effort" — or the level's own name. */
export function effortName(model: ProviderModel | undefined, level: Effort): string {
  return model?.effort_labels?.[level] ?? effortLabel(level);
}
