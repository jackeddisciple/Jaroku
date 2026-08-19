// §1's range control: the four values, their labels, and where the choice is remembered.
//
// "RANGE SELECTION PERSISTS PER WORKSPACE ACROSS RELOADS", which is one line of the specification and
// two decisions.
//
// PER WORKSPACE, because a range is a statement about how much data there is to look at. A personal
// workspace two weeks old and a team workspace two years old want different defaults, and somebody
// switching between them should not have to re-pick every time. The key carries the workspace id for
// the same reason `uiStore`'s pinned agents do.
//
// IN `localStorage`, NOT IN A TABLE AND NOT ON THE SOCKET. It is a per-person, per-device view
// preference about a screen — the same class of thing as which agents somebody pinned — and putting
// it in the database would mean a range somebody picked on their phone changing what their laptop
// shows. It is also why `activityStore` does not reset it on a workspace switch: the store is
// emptied because it holds another tenant's figures, and this is not one of them.
//
// A PURE MODULE WITH A SUITE, because the two failure modes are both silent: a key that does not
// carry the workspace makes two tenants share a range, and a value read back without validation puts
// whatever is in storage onto the wire. `localStorage` is untrusted input — it is edited by hand, it
// survives a version that meant something different by the same string, and it is shared with every
// other tab.

/** §1's control. Four values, matching the server's `ActivityRange` exactly. */
export const ACTIVITY_RANGES = ["24h", "7d", "30d", "custom"] as const;
export type ActivityRange = (typeof ACTIVITY_RANGES)[number];

export function isActivityRange(v: unknown): v is ActivityRange {
  return typeof v === "string" && (ACTIVITY_RANGES as readonly string[]).includes(v);
}

/**
 * What the control's buttons say.
 *
 * THE SHORT FORM, because §4 lists the range control among the places where "a label carries
 * irreplaceable meaning" and text survives — and the whole reason it survives is that `24h` is
 * shorter and clearer than any glyph for it. A calendar icon marks the control; the values are words.
 */
export const RANGE_LABEL: Record<ActivityRange, string> = {
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
  custom: "Custom",
};

/**
 * The default, for a workspace nobody has picked a range for.
 *
 * SEVEN DAYS RATHER THAN TWENTY-FOUR HOURS, which is the opposite of what "show the freshest data"
 * would suggest and is deliberate. A day is the range you choose while watching something happen; a
 * week is the range that answers "what is this workspace doing", which is the question the tab is
 * for. It is also the range where a new workspace has enough in it to draw a chart at all.
 */
export const DEFAULT_RANGE: ActivityRange = "7d";

/** The remembered choice, per workspace. `null` means nobody has chosen for this one. */
function key(workspaceId: string): string {
  return `jaroku:activity-range:${workspaceId}`;
}

interface StoredRange {
  range: ActivityRange;
  custom: { from: string; to: string } | null;
}

/**
 * Read the remembered range, or the default.
 *
 * EVERY FIELD IS VALIDATED ON THE WAY OUT, because `localStorage` is untrusted input: it is editable
 * by hand, it outlives the version that wrote it, and a value that meant something a release ago can
 * mean nothing now. An unrecognised range falls back rather than travelling to the server, where it
 * would be refused or — worse — silently coerced into a window nobody picked.
 *
 * A `custom` RANGE WITH NO ENDS IS NOT CUSTOM. Storage that holds `{"range":"custom"}` and nothing
 * else would put the control in a state whose own value is missing, so it reads as the default.
 */
export function readRange(workspaceId: string | null): StoredRange {
  const fallback: StoredRange = { range: DEFAULT_RANGE, custom: null };
  if (!workspaceId) return fallback;
  try {
    const raw = localStorage.getItem(key(workspaceId));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<StoredRange>;
    if (!isActivityRange(parsed?.range)) return fallback;
    if (parsed.range !== "custom") return { range: parsed.range, custom: null };
    const from = parsed.custom?.from;
    const to = parsed.custom?.to;
    if (typeof from !== "string" || typeof to !== "string") return fallback;
    if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to))) return fallback;
    return { range: "custom", custom: { from, to } };
  } catch {
    // A quota error, a disabled storage, a value somebody pasted in. None of them is worth a broken
    // dashboard, and the default is a correct answer rather than a repair.
    return fallback;
  }
}

/** Remember a choice. Silently a no-op where storage is unavailable — see `readRange`. */
export function writeRange(
  workspaceId: string | null,
  range: ActivityRange,
  custom: { from: string; to: string } | null,
): void {
  if (!workspaceId) return;
  try {
    localStorage.setItem(key(workspaceId), JSON.stringify({ range, custom: range === "custom" ? custom : null }));
  } catch {
    /* storage full or disabled — the range still applies for this session */
  }
}

/**
 * The prose a card's context line uses for its window. §1: "each card states its window in its
 * context line so a screenshot is never ambiguous."
 */
export const RANGE_PROSE: Record<ActivityRange, string> = {
  "24h": "the last 24 hours",
  "7d": "the last 7 days",
  "30d": "the last 30 days",
  custom: "the selected range",
};
