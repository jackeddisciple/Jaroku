// The two attachment numbers the composer has to know before it asks the server.
//
// MIRRORED FROM server/src/attachments.ts, AND THE MIRROR IS THE POINT OF THE FILE. Both numbers
// exist on the server, where they are enforced; these copies exist so the composer can render a
// warning as somebody attaches rather than after a round trip per chip. Keeping them in one small
// file — rather than as two literals in the middle of BuildPane — is what makes the duplication
// findable when the server's change.
//
// THE CLIENT'S COPY NEVER DECIDES ANYTHING. §4.4's refusal happens at the route, which re-measures
// every ref it is handed: a browser that under-counted cannot talk its way past the limit, and a
// browser that over-counted only warns early. That asymmetry is why a mirror is safe here and
// would not be for, say, the permission shield — where the whole feature is that the client is not
// the thing deciding.

/** §4.4: "Cap at 10 attachments per turn, with a clear message on the 11th." */
export const MAX_ATTACHMENTS = 10;

/** §4.4 / §9: an inline warning at 70% of the model's context window, a hard block at 100%. */
export const WARN_AT = 0.7;

export type BudgetLevel = "ok" | "warn" | "over";

/**
 * Where this many tokens sits against a window.
 *
 * AN UNKNOWN WINDOW IS "ok", NOT "over". A model with no recorded context window is one nobody has
 * measured, and blocking every send on it would break a model that probably works — while claiming
 * it was over would be asserting a limit we cannot name. The server takes the same position, in
 * the same direction, for the same reason.
 */
export function budgetLevel(tokens: number, window: number | null): BudgetLevel {
  if (!window || window <= 0) return "ok";
  const fraction = tokens / window;
  if (fraction >= 1) return "over";
  if (fraction >= WARN_AT) return "warn";
  return "ok";
}

/** The percentage to show, or null when there is no window to measure against. */
export function budgetPercent(tokens: number, window: number | null): number | null {
  if (!window || window <= 0) return null;
  return Math.round((tokens / window) * 100);
}
