// When a conversation happened, said where it happened — above the first message of each day.
//
// "TODAY 11:52", THEN A DATE ONCE IT IS NOT TODAY — the product owner's call on 2026-09-15, after how
// Codex marks a chat. The stamp sits above the first message of a conversation and again wherever the
// conversation picks up on a later day, so a chat continued this morning reads "Today 09:10" at that
// point while the part above it reads the date it was written. Nothing is stored: the label is worked
// out from each message's time against the clock, so yesterday's "Today" becomes a date on its own.
//
//   npm run test:turn-dates

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number): string => String(n).padStart(2, "0");

/** Whether two moments fall on the same calendar day where this app is running. */
export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * The stamp for a message sent at `iso`: "Today 11:52", "14 Sep 11:52", or "14 Sep 2025, 11:52" for
 * another year. Null for a time that does not parse, so a bad value draws nothing rather than "NaN".
 */
export function turnStamp(iso: string, now: Date = new Date()): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (sameDay(at, now)) return `Today ${time}`;
  const date = `${at.getDate()} ${MONTHS[at.getMonth()]}`;
  return at.getFullYear() === now.getFullYear() ? `${date} ${time}` : `${date} ${at.getFullYear()}, ${time}`;
}

/**
 * The turns a stamp goes above: the first message that carries a time, and every later one sent on a
 * different day from the message before it. Turns without a time — a reply, a note — never start a day.
 */
export function dayStarts(turns: readonly { id: string; at?: string }[]): Set<string> {
  const starts = new Set<string>();
  let last: Date | null = null;
  for (const turn of turns) {
    if (!turn.at) continue;
    const at = new Date(turn.at);
    if (Number.isNaN(at.getTime())) continue;
    if (!last || !sameDay(at, last)) starts.add(turn.id);
    last = at;
  }
  return starts;
}
