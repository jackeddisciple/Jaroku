// §5's precedence, a fixture per branch — which is what §24 asks of this suite by name.
//
// THE PROPERTY IS SPECIFICITY, NOT CORRECTNESS. "A status word alone is what the Railway dashboard
// already gives, and it is the reason the user is opening Railway instead of this." Every version
// of this function that renders a status enum passes an assertion that says "the sentence is
// right"; the only test that fails on it is one that puts six genuinely different agents side by
// side and demands six different sentences.
//
// AND THE BRANCH §5 SPENDS ITS SHARPEST PARAGRAPH ON: not-connected REPLACES rather than appends.
// "A card that says 'not connected · 11 jobs today' invites the reader to wonder which half is
// current." That is the fixture worth writing twice — once for each of the two unreachable states,
// because they are two faults and one consequence, and a function that special-cased only the
// commoner one would look correct on every card anybody demoed.
//
//   npm run test:fleet-sentence

import { CLAUSE, CONNECTION_LABEL } from "./cockpitCopy.ts";
import { JOIN, factsOf, fleetSentence, healthLine, needsReconnect, type FleetFacts } from "./fleetSentence.ts";
import type { FleetCardView } from "../types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const facts = (patch: Partial<FleetFacts> = {}): FleetFacts => ({
  connection: "connected",
  running: 0, waiting: 0, queued: 0,
  jobsToday: 0, lastJobAt: null,
  ...patch,
});

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const MINUTE = 60_000;

const card = (patch: Partial<FleetCardView> = {}): FleetCardView => ({
  agent_id: "a", agent_slug: "billing_bot", agent_name: "billing_bot", deployment_id: "d", url: "https://x.up.railway.app",
  version: 7, provider: "anthropic", model: "claude-haiku-4-5", connection: "connected",
  running: 0, waiting: 0, queued: 0,
  jobs_today: 0, last_job_at: null, spend_today: 0, spend_complete: true, outcomes: [],
  health: null, health_stale_ms: null,
  ...patch,
});

// --- 1. clause one: what is happening now ----------------------------------------------------------

console.log("\nwhat is happening now");
{
  check("one running", fleetSentence(facts({ running: 1 })) === "1 running",
    fleetSentence(facts({ running: 1 })));
  check("§5's own example, both clauses",
    fleetSentence(facts({ running: 2, waiting: 1 })) === "2 running · 1 waiting on you",
    fleetSentence(facts({ running: 2, waiting: 1 })));
  check("queued is part of what is happening now",
    fleetSentence(facts({ queued: 3 })) === "3 queued", fleetSentence(facts({ queued: 3 })));

  // NUMERALS, EVEN BELOW TEN — §16. The one below ten is the one somebody spells out.
  check("a count below ten is a digit", /^1 running$/.test(fleetSentence(facts({ running: 1 }))));
}

// --- 2. clause two outranks, and is never trimmed --------------------------------------------------

console.log("\nthe only clause the reader can act on");
{
  // §5: "This clause outranks everything except an outright failure." With all three live clauses
  // present the sentence is at its three-clause cap, and `waiting` is in it.
  const busy = fleetSentence(facts({ running: 2, waiting: 1, queued: 4 }));
  check("all three live clauses fit the cap", busy.split(JOIN).length === 3, busy);
  check("...and waiting is one of them", busy.includes("1 waiting on you"), busy);

  // §5's cap, structurally rather than by a slice.
  for (const f of [
    facts({ running: 2, waiting: 1, queued: 4 }),
    facts({ running: 9, waiting: 9, queued: 9, jobsToday: 40, lastJobAt: ago(MINUTE) }),
  ]) {
    check(`never more than three clauses (${fleetSentence(f)})`,
      fleetSentence(f).split(JOIN).length <= 3, fleetSentence(f));
  }

  // Second person for the reader — §16 — and the reason this clause exists at all.
  check("it addresses the reader", fleetSentence(facts({ waiting: 2 })) === "2 waiting on you",
    fleetSentence(facts({ waiting: 2 })));
}

// --- 3. clause three: only when neither of the above applies ---------------------------------------

console.log("\nwhat last happened");
{
  check("§5's own example", fleetSentence(facts({ lastJobAt: ago(4 * MINUTE) })) === "last job 4m ago",
    fleetSentence(facts({ lastJobAt: ago(4 * MINUTE) })));
  check("...or the day's count", fleetSentence(facts({ jobsToday: 11 })) === "11 jobs today",
    fleetSentence(facts({ jobsToday: 11 })));
  check("...or both, which is still under the cap",
    fleetSentence(facts({ jobsToday: 11, lastJobAt: ago(4 * MINUTE) })) === "11 jobs today · last job 4m ago",
    fleetSentence(facts({ jobsToday: 11, lastJobAt: ago(4 * MINUTE) })));

  // "WHEN NEITHER OF THE ABOVE APPLIES" — the half that is easy to leave out, and the half that
  // matters most on a busy card. A card reading "2 running · 11 jobs today" is answering a question
  // nobody asked of an agent that is visibly working, and it costs a live clause its place.
  const live = fleetSentence(facts({ running: 2, jobsToday: 11, lastJobAt: ago(MINUTE) }));
  check("a live card does not also report its history", live === "2 running", live);
  check("...not even the day's count", !live.includes("today"), live);

  // Pluralisation at one, which is where a template that appends `s` shows itself.
  check("one job today is singular", fleetSentence(facts({ jobsToday: 1 })) === "1 job today",
    fleetSentence(facts({ jobsToday: 1 })));

  // §17's week ceiling, inherited rather than re-implemented: past a week `relTime` gives a date.
  const march = fleetSentence(facts({ lastJobAt: ago(40 * 24 * 60 * MINUTE) }));
  check("a long-idle agent reads as a date rather than as arithmetic",
    /^last job /.test(march) && !/\d+d ago/.test(march), march);
}

// --- 4. idle is a real answer ----------------------------------------------------------------------

console.log("\nwhen there is nothing to say");
{
  check("a live agent nobody has asked anything says Idle", fleetSentence(facts()) === CLAUSE.idle,
    fleetSentence(facts()));
  check("...which is a word and not an empty string", fleetSentence(facts()).length > 0);

  // AND IT DOES NOT APPEAR BESIDE ANYTHING. Part 2's version emitted "idle · 11 jobs today", which
  // §5 replaces: if there were jobs today there IS something to say, and saying both is the card
  // describing itself twice.
  check("idle never appears beside another clause",
    !fleetSentence(facts({ jobsToday: 11 })).includes(CLAUSE.idle),
    fleetSentence(facts({ jobsToday: 11 })));
  check("...nor beside a running count", !fleetSentence(facts({ running: 1 })).includes(CLAUSE.idle));
}

// --- 5. not connected replaces, and does not append ------------------------------------------------

console.log("\nthe sentence §5 spends its sharpest paragraph on");
{
  for (const state of ["unconnected", "unauthorised"] as const) {
    // BOTH STATES, because they are two faults and one consequence. A function that special-cased
    // only the commoner one would look correct on every card anybody demoed.
    const said = fleetSentence(facts({ connection: state, running: 2, waiting: 1, jobsToday: 11 }));
    check(`${state} replaces the whole sentence`, said === CONNECTION_LABEL[state], said);
    check(`...so ${state} carries no count beside it`, !/\d/.test(said), said);
    check(`...and it is what needsReconnect says`, needsReconnect(state));
  }

  // §9: `public` is a WARNING state, not an unreachable one. The agent is working, so the sentence
  // stays — the warning appears alongside, on the card, rather than replacing what is true.
  const open = fleetSentence(facts({ connection: "public", running: 2 }));
  check("a public URL does not replace the sentence", open === "2 running", open);
  check("...and is not a reconnect state", !needsReconnect("public"));
  check("...nor is a healthy one", !needsReconnect("connected"));
}

// --- 6. the failure this file exists for -----------------------------------------------------------

console.log("\nsix agents, six sentences");
{
  // A STRIP OF TWENTY CARDS ALL READING THE SAME WORD is what §5 rules out. Six genuinely different
  // agents, six genuinely different sentences — the assertion no status-enum implementation passes.
  const strip = [
    facts({ running: 2, waiting: 1 }),
    facts({ jobsToday: 11, lastJobAt: ago(4 * MINUTE) }),
    facts({ connection: "unconnected" }),
    facts({ connection: "unauthorised" }),
    facts({ queued: 3 }),
    facts(),
  ];
  const sentences = strip.map(fleetSentence);
  check(`six different agents produce six different sentences (${new Set(sentences).size})`,
    new Set(sentences).size === 6, sentences.join(" | "));

  // AND NONE OF THEM IS A STATUS WORD. "Deployed", "Live", "Active" — the vocabulary a status page
  // reaches for, every one of which would be true of all six cards at once.
  const STATUS_WORDS = /^(deployed|live|active|online|ok|healthy|ready)$/i;
  check("none of them is a status word", !sentences.some((s) => STATUS_WORDS.test(s)),
    sentences.filter((s) => STATUS_WORDS.test(s)).join(", "));
}

// --- 7. the facts object is narrower than the wire row ---------------------------------------------

console.log("\nwhat the rule is allowed to know");
{
  const f = factsOf(card({ running: 2, waiting: 1, jobs_today: 11, last_job_at: ago(MINUTE) }));
  check("the narrowing carries the six that matter",
    f.running === 2 && f.waiting === 1 && f.jobsToday === 11 && f.lastJobAt !== null);
  check("...and exactly six", Object.keys(f).length === 6, Object.keys(f).join(", "));

  // A rule that could reach a url, a model or a health probe is a rule whose next revision does.
  check("...none of which is a url, a model or a probe",
    !("url" in f) && !("model" in f) && !("health" in f));

  check("the sentence agrees whichever end it is called from",
    fleetSentence(f) === fleetSentence(factsOf(card({ running: 2, waiting: 1, jobs_today: 11 }))),
    fleetSentence(f));
}

// --- 8. the health line, which is not part of the sentence -----------------------------------------

console.log("\nthe probe, and its stated staleness");
{
  // NULL IS "NOBODY HAS ASKED", a third state and not "unhealthy" — a card reporting red because it
  // had never been probed would be the product accusing a working agent.
  check("an unprobed card says nothing about its health", healthLine(card()) === null);

  check("a healthy answer states how old it is",
    healthLine(card({ health: "healthy", health_stale_ms: 12_000 })) === "answering, as of 12s ago",
    String(healthLine(card({ health: "healthy", health_stale_ms: 12_000 }))));
  check("...and a fresh one says so in words rather than in 0s",
    healthLine(card({ health: "healthy", health_stale_ms: 400 })) === "answering, as of just now",
    String(healthLine(card({ health: "healthy", health_stale_ms: 400 }))));
  check("an unreachable probe is not the same sentence as an unhealthy one",
    healthLine(card({ health: "unreachable", health_stale_ms: 1 }))
      !== healthLine(card({ health: "unhealthy", health_stale_ms: 1 })));

  // IT IS NOT IN THE SENTENCE, which is what keeps a probe result from displacing a live clause.
  check("the probe never reaches the sentence",
    !fleetSentence(factsOf(card({ health: "unreachable", running: 1 }))).includes("answer"));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
