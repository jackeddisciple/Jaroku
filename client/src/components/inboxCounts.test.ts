// The Inbox says what its numbers count.
//
// THE BUG. The Inbox header read 6 beside a sidebar badge of 2 and nothing explained the difference:
// the badge counts what needs you — blocked, or waiting on a decision — and the header counts every
// open card. Both were right; neither said what it was counting.
//
//   npm run test:inbox-counts

import { createElement } from "react";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const g = globalThis as unknown as Record<string, unknown>;
const store = new Map<string, string>();
g["localStorage"] = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
g["window"] = { location: { search: "", href: "http://localhost/", origin: "http://localhost" }, history: { replaceState() {} } };

const { markup, seed } = await import("../lib/testRender.ts");
const { useInboxStore } = await import("../store/inboxStore.ts");
const { InboxView } = await import("./InboxView.tsx");

console.log("\nthe header and the badge, told apart");
{
  seed(useInboxStore, { counts: { all: 6, blocking: 1, attention: 4, proposals: 1, team: 0, snoozed: 0, badge: 2 } } as never);
  const html = markup(createElement(InboxView));
  check(html.includes("6 open · 2 need you"), "the header says how many are open and how many need you", html.slice(0, 400));
  seed(useInboxStore, { counts: { all: 3, blocking: 3, attention: 0, proposals: 0, team: 0, snoozed: 0, badge: 3 } } as never);
  const same = markup(createElement(InboxView));
  check(same.includes("3 open") && !same.includes("need you"), "...and says it once when every open card needs you");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
