// Where a conversation's date and time are shown, and what they say.
//
//   npm run test:turn-dates

import { dayStarts, sameDay, turnStamp } from "./turnDates.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// Local times, built the way the app reads them, so the suite means the same thing in any timezone.
const local = (y: number, mo: number, d: number, h: number, mi: number): Date => new Date(y, mo - 1, d, h, mi);
const now = local(2026, 9, 15, 14, 30);

console.log("\ntoday says Today, and any other day says its date");
{
  check("a message from this morning", turnStamp(local(2026, 9, 15, 11, 52).toISOString(), now) === "Today 11:52",
    String(turnStamp(local(2026, 9, 15, 11, 52).toISOString(), now)));
  check("the minutes are always two digits", turnStamp(local(2026, 9, 15, 9, 5).toISOString(), now) === "Today 09:05");
  check("yesterday is a date, not Today", turnStamp(local(2026, 9, 14, 18, 40).toISOString(), now) === "14 Sep 18:40",
    String(turnStamp(local(2026, 9, 14, 18, 40).toISOString(), now)));
  check("another year says which", turnStamp(local(2025, 12, 31, 23, 59).toISOString(), now) === "31 Dec 2025, 23:59",
    String(turnStamp(local(2025, 12, 31, 23, 59).toISOString(), now)));
  check("a time that does not parse draws nothing", turnStamp("not a time", now) === null);
  check("midnight is still the same day as noon", sameDay(local(2026, 9, 15, 0, 0), local(2026, 9, 15, 12, 0)));
}

console.log("\na stamp goes above the first message of each day, and nowhere else");
{
  const turns = [
    { id: "u1", at: local(2026, 9, 14, 10, 0).toISOString() },
    { id: "r1" },
    { id: "u2", at: local(2026, 9, 14, 10, 5).toISOString() },
    { id: "r2" },
    { id: "u3", at: local(2026, 9, 15, 11, 52).toISOString() },
    { id: "r3" },
    { id: "u4", at: local(2026, 9, 15, 12, 0).toISOString() },
  ];
  const starts = dayStarts(turns);
  check("the first message of the chat", starts.has("u1"));
  check("...not a second message the same day", !starts.has("u2"));
  check("the first message of a later day", starts.has("u3"));
  check("...and not the one after it", !starts.has("u4"));
  check("never a reply", !starts.has("r1") && !starts.has("r2") && !starts.has("r3"));
  check("exactly two days, exactly two stamps", starts.size === 2, [...starts].join(","));
  check("a chat with no times has no stamps", dayStarts([{ id: "a" }, { id: "b" }]).size === 0);
}

console.log(fail === 0 ? "\nall turn-dates checks passed" : `\n${fail} turn-dates check(s) FAILED`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
