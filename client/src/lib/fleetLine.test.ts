// §9's hardest line, and every case that would make it say nothing.
//
// "A status word alone is what the Railway dashboard already gives, and it is the reason the user is
// opening Railway instead of this." So the property this suite holds is not that the sentence is
// correct — it is that the sentence is SPECIFIC: no card may render a string that would be
// identical on twenty cards, and the failure mode of this component is a strip all reading
// "Deployed".
//
// IT IS PURE AND IT IS TESTED FOR THE REASON `inboxBoard` AND `activityMetrics` ARE: each of these
// rules looks obviously right in a screenshot and is wrong in the case nobody had that day — a
// workspace with nothing running, an agent whose model has no price, a card whose connection state
// means the numbers beside it cannot be trusted.
//
//   npm run test:fleet-line

import { CONNECTION_LABEL, fleetLine, healthLine, needsReconnect } from "./fleetLine.ts";
import type { FleetCardView } from "../types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const card = (patch: Partial<FleetCardView> = {}): FleetCardView => ({
  agent_id: "a", agent_name: "billing_bot", deployment_id: "d", url: "https://x.up.railway.app",
  version: 7, provider: "anthropic", model: "claude-haiku-4-5", connection: "connected",
  running: 0, waiting: 0, queued: 0,
  jobs_today: 0, spend_today: 0, spend_complete: true,
  health: null, health_stale_ms: null,
  ...patch,
});

const said = (c: FleetCardView): string => fleetLine(c).parts.map((p) => p.text).join(" · ");

// --- 1. the sentence is never a status word --------------------------------------------------------

console.log("\nwhat a card says about itself");
{
  check("running and waiting read as §9's own example",
    said(card({ running: 2, waiting: 1 })) === "2 running · 1 waiting on you", said(card({ running: 2, waiting: 1 })));
  check("and idle with a day behind it reads as the other one",
    said(card({ jobs_today: 11, spend_today: 0.42 })) === "idle · 11 jobs today · $0.4200",
    said(card({ jobs_today: 11, spend_today: 0.42 })));

  // `waiting` IS THE ONE FRAGMENT THAT IS EVER INK, because it is the only one that names something
  // a person has to do. Everything else on this strip is muted by construction.
  const parts = fleetLine(card({ running: 2, waiting: 1, queued: 3 })).parts;
  check("only the waiting fragment is emphasised",
    parts.filter((p) => p.emphasis === "ink").length === 1 &&
    parts.find((p) => p.emphasis === "ink")!.text.includes("waiting"));

  // THE ORDER IS LIVE-FIRST. Somebody opening this tab is asking what is going on, and a card that
  // led with "11 jobs today" while one of them was blocked would have buried the only line that
  // needed them.
  check("what is happening now comes before what happened today",
    said(card({ running: 1, jobs_today: 9, spend_today: 0.1 })).startsWith("1 running"));
}

// --- 2. an idle card still says something specific -------------------------------------------------

console.log("\nan idle agent");
{
  // "idle" ALONE WOULD BE THE STATUS WORD §9 RULES OUT, one synonym over — so a card with a day
  // behind it says what the day was.
  check("idle with nothing behind it is one word, honestly", said(card({})) === "idle");
  check("...and idle with a day behind it is not", said(card({ jobs_today: 3, spend_today: 0.01 })) !== "idle");
  check("`idle` never appears beside a running count", !said(card({ running: 2 })).includes("idle"));
  check("...nor beside a waiting one", !said(card({ waiting: 1 })).includes("idle"));
  check("one job today is singular", said(card({ jobs_today: 1, spend_today: 0.5 })).includes("1 job today"));
  check("...and two are not", said(card({ jobs_today: 2, spend_today: 0.5 })).includes("2 jobs today"));
}

// --- 3. unknown is not zero ------------------------------------------------------------------------

console.log("\nmoney");
{
  // §11.1, and the failure it prevents is quiet: a card with jobs and no money reads as free, and a
  // card that simply omitted the fragment reads the same way.
  check("an unpriced model renders an em dash rather than $0.00",
    said(card({ jobs_today: 4, spend_today: null })).includes("—"),
    said(card({ jobs_today: 4, spend_today: null })));
  check("...and does not render a zero", !said(card({ jobs_today: 4, spend_today: null })).includes("$0"));
  // PRICED AND FREE IS A REAL ANSWER, and it must not read as unknown either.
  check("a priced model that spent nothing renders a zero, not a dash",
    !said(card({ jobs_today: 4, spend_today: 0 })).includes("—"),
    said(card({ jobs_today: 4, spend_today: 0 })));
  // A FLOOR SAYS SO. Some call could not be priced, so the total is an undercount.
  check("an incomplete total is marked as a floor",
    said(card({ jobs_today: 4, spend_today: 0.2, spend_complete: false })).includes("+"));
  check("...and a complete one is not",
    !said(card({ jobs_today: 4, spend_today: 0.2 })).includes("+"));
  // NO JOBS TODAY MEANS NO MONEY LINE AT ALL. "$0.0000" on an agent nobody used is a figure about
  // nothing, and it would be the same figure on every idle card in the workspace.
  check("an agent nobody used today says nothing about money", !said(card({})).includes("$"));
}

// --- 4. a card that cannot be reached says so and stops --------------------------------------------

console.log("\nwhen the numbers cannot be trusted");
{
  // ITS COUNTS ARE STALE BY CONSTRUCTION — nothing has been able to dispatch to it — and a sentence
  // carrying them would be describing a yesterday the reader has no way to date.
  const broken = fleetLine(card({ connection: "unconnected", running: 2, jobs_today: 9, spend_today: 1 }));
  check("an unconnected card says only that", said(card({ connection: "unconnected", running: 2 })) === "not connected");
  check("...and is marked as blocked, so the card can render it alone", broken.blocked === true);
  check("a refused credential is a different sentence from never having had one",
    said(card({ connection: "unauthorised" })) !== said(card({ connection: "unconnected" })));
  check("both offer the same fix", needsReconnect("unconnected") && needsReconnect("unauthorised"));
  check("...and a working agent does not", !needsReconnect("connected") && !needsReconnect("public"));

  // `public` DOES NOT REPLACE THE SENTENCE, because a public agent is working. The warning goes
  // beside the real state rather than instead of it.
  check("a public endpoint still reports its work", said(card({ connection: "public", running: 2 })) === "2 running");
  check("...and is not treated as needing a reconnect", fleetLine(card({ connection: "public" })).blocked === false);
  // AND THE CONNECTION IS NOT NEWS ON A WORKING AGENT.
  check("`connected` says nothing, because on a working agent it is not news", CONNECTION_LABEL.connected === null);
  check("...while the other three do", (["unconnected", "unauthorised", "public"] as const).every((c) => CONNECTION_LABEL[c] !== null));
}

// --- 5. health is a third state, and its age is spoken ---------------------------------------------

console.log("\nthe health probe");
{
  // NULL IS "NOBODY HAS ASKED". A card that reported red because it had never been probed would be
  // the product accusing a working agent.
  check("no probe says nothing at all", healthLine(card({})) === null);
  check("a healthy answer says when it was given",
    (healthLine(card({ health: "healthy", health_stale_ms: 12_000 })) ?? "").includes("12s ago"));
  // THE STALENESS IS SPOKEN RATHER THAN IMPLIED — §10 asks for a stated staleness precisely so the
  // screen does not suggest it just checked.
  check("...and a fresh one says so rather than claiming zero seconds",
    (healthLine(card({ health: "healthy", health_stale_ms: 400 })) ?? "").includes("just now"));
  check("an unreachable agent is not described as answering",
    !(healthLine(card({ health: "unreachable", health_stale_ms: 5_000 })) ?? "").startsWith("answering,"));
  check("...and one answering the wrong thing is distinguished from one answering nothing",
    healthLine(card({ health: "unhealthy", health_stale_ms: 5_000 })) !==
      healthLine(card({ health: "unreachable", health_stale_ms: 5_000 })));
}

// --- 6. no two different cards say the same thing --------------------------------------------------

console.log("\nthe failure this file exists for");
{
  // A STRIP OF TWENTY CARDS ALL READING THE SAME WORD is what §9 rules out, and the way that
  // happens is a sentence built from facts that are true of every deployment rather than of this
  // one. Six genuinely different agents, six different sentences.
  const fleet = [
    card({ running: 2, waiting: 1 }),
    card({ jobs_today: 11, spend_today: 0.42 }),
    card({ connection: "unconnected" }),
    card({ connection: "unauthorised" }),
    card({ queued: 3 }),
    card({}),
  ];
  const sentences = fleet.map(said);
  check(`six different agents produce six different sentences (${new Set(sentences).size})`,
    new Set(sentences).size === 6, sentences.join(" | "));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
