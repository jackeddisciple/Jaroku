// Turn-taking across N keys, a cooldown that returns capacity on its own, and a refusal that is
// never a queue.
//
// THE ASSERTION THIS SUITE EXISTS FOR is the one about exhaustion. A pool that queued instead of
// refusing would pass every other check here — the keys would still rotate, the cooldowns would
// still expire — and would turn a capacity problem into a latency problem that no graph shows: the
// error rate stays flat, the runs get slower, and the first anybody hears is a complaint about
// speed weeks later. A 429 is a worse minute for one person and the only version in which the
// operator finds out.
//
// AND THE COOLDOWN, WHICH IS THE HALF THAT BREAKS QUIETLY. A key that returns 429 is busy rather
// than broken, so a pool that REMOVED it would drain to empty over one busy hour and stay empty
// until somebody restarted the process — with every symptom pointing at the provider.
//
// THE CLOCK IS INJECTED, so "sixty seconds later" is an assertion rather than a sleep. A suite that
// waited would be a minute long and would still be racing.
//
//   npm run test:key-pool

import {
  DEFAULT_COOLDOWN_MS, ProviderKeyPool, poolKeysFor, poolRefusal,
} from "./keyPool.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

/** A pool over a fixed environment and a clock the suite moves by hand. */
function pool(env: NodeJS.ProcessEnv): { pool: ProviderKeyPool; tick: (ms: number) => void } {
  let clock = 1_000_000;
  return {
    pool: new ProviderKeyPool(env, () => clock),
    tick: (ms) => { clock += ms; },
  };
}

// ---------------------------------------------------------------------------------------------
console.log("\nkeys are read from the name that already exists, and numbered from it");
// ---------------------------------------------------------------------------------------------
{
  // A DEPLOYMENT WITH ONE KEY ALREADY HAS A POOL OF ONE. If this had been a new `JAROKU_POOL_*`
  // convention, every existing deployment would have needed a migration to keep working.
  check(
    poolKeysFor("anthropic", { ANTHROPIC_API_KEY: "sk-one" }).length === 1,
    "one key configured is a pool of one, under the name it already had",
  );
  check(
    poolKeysFor("anthropic", {
      ANTHROPIC_API_KEY: "sk-one", ANTHROPIC_API_KEY_2: "sk-two", ANTHROPIC_API_KEY_3: "sk-three",
    }).length === 3,
    "...and _2, _3 are how capacity is added",
  );
  check(poolKeysFor("anthropic", {}).length === 0, "nothing configured is a pool of none");

  // STOPS AT THE FIRST GAP, so a missing `_3` fails loudly rather than silently skipping to `_4`
  // and giving the deployment capacity nobody meant to add.
  check(
    poolKeysFor("anthropic", { ANTHROPIC_API_KEY: "a", ANTHROPIC_API_KEY_2: "b", ANTHROPIC_API_KEY_4: "d" })
      .length === 2,
    "a gap stops the scan, so a typo is missing capacity rather than surprise capacity",
  );

  check(
    poolKeysFor("openai", { OPENAI_API_KEY: "sk-o" }).length === 1 &&
      poolKeysFor("google", { GOOGLE_API_KEY: "g" }).length === 1,
    "every provider reads its own name, including Google's, which is not the pretty one",
  );

  // Whitespace is not a key. A variable set to an empty string in a shell script is the ordinary
  // way a deployment ends up with a pool it thinks is bigger than it is.
  check(
    poolKeysFor("anthropic", { ANTHROPIC_API_KEY: "  " }).length === 0,
    "a blank value is not a key",
  );
}

// ---------------------------------------------------------------------------------------------
console.log("\nkeys are handed out in turn");
// ---------------------------------------------------------------------------------------------
{
  const { pool: p } = pool({
    ANTHROPIC_API_KEY: "one", ANTHROPIC_API_KEY_2: "two", ANTHROPIC_API_KEY_3: "three",
  });
  const taken = [1, 2, 3, 4, 5, 6].map(() => {
    const lease = p.lease("anthropic");
    return lease.ok ? lease.key.value : "REFUSED";
  });
  check(
    taken.join(",") === "one,two,three,one,two,three",
    `six leases walk the ring twice (${taken.join(",")})`,
  );
  check(p.size("anthropic") === 3, "and the pool knows how big it is");

  // The ring is per provider. A busy Anthropic pool must not advance the OpenAI cursor, or the
  // sharing across the second provider becomes whatever the first one's traffic happened to be.
  const { pool: q } = pool({ ANTHROPIC_API_KEY: "a1", ANTHROPIC_API_KEY_2: "a2", OPENAI_API_KEY: "o1" });
  q.lease("anthropic");
  const openai = q.lease("openai");
  check(openai.ok && openai.key.value === "o1", "each provider has its own cursor");
}

// ---------------------------------------------------------------------------------------------
console.log("\na rate-limited key is set aside, not removed");
// ---------------------------------------------------------------------------------------------
{
  const { pool: p, tick } = pool({ ANTHROPIC_API_KEY: "one", ANTHROPIC_API_KEY_2: "two" });

  const first = p.lease("anthropic");
  check(first.ok && first.key.value === "one", "the first key comes out first");
  if (first.ok) p.rateLimited(first.key);

  // SKIPPED, NOT BLOCKING. The cooling key must not hold up the ones behind it, or one busy key
  // takes the whole pool down.
  const next = [1, 2].map(() => {
    const lease = p.lease("anthropic");
    return lease.ok ? lease.key.value : "REFUSED";
  });
  check(next.join(",") === "two,two", `a cooling key is skipped rather than blocking (${next.join(",")})`);

  // AND IT COMES BACK ON ITS OWN. A pool that removed keys would drain to empty over a busy hour
  // and never refill without a restart — with every symptom pointing at the provider.
  tick(DEFAULT_COOLDOWN_MS + 1);
  const seen = new Set([1, 2].map(() => {
    const lease = p.lease("anthropic");
    return lease.ok ? lease.key.value : "REFUSED";
  }));
  check(seen.has("one"), "...and returns once its cooldown is over, without a restart");
}

// ---------------------------------------------------------------------------------------------
console.log("\nan exhausted pool refuses, and says when to come back");
// ---------------------------------------------------------------------------------------------
{
  const { pool: p, tick } = pool({ ANTHROPIC_API_KEY: "one", ANTHROPIC_API_KEY_2: "two" });
  for (const _ of [1, 2]) {
    const lease = p.lease("anthropic");
    if (lease.ok) p.rateLimited(lease.key);
  }

  const refused = p.lease("anthropic");
  check(!refused.ok && refused.reason === "exhausted", "every key cooling is a refusal");
  check(
    !refused.ok && refused.retryAfterS > 0 && refused.retryAfterS <= 60,
    `...carrying when capacity returns (${!refused.ok ? refused.retryAfterS : "-"}s)`,
  );
  check(!p.hasCapacity("anthropic"), "and the pool says it has none");

  // THE SOONEST, NOT THE LONGEST. The caller is being told when to try again, and the answer is
  // the moment capacity exists rather than the moment the last key returns.
  const { pool: q, tick: qtick } = pool({ ANTHROPIC_API_KEY: "one", ANTHROPIC_API_KEY_2: "two" });
  const a = q.lease("anthropic");
  if (a.ok) q.rateLimited(a.key, 10);
  const b = q.lease("anthropic");
  if (b.ok) q.rateLimited(b.key, 600);
  const soon = q.lease("anthropic");
  check(
    !soon.ok && soon.retryAfterS <= 10,
    `retry-after is the soonest key back, not the last (${!soon.ok ? soon.retryAfterS : "-"}s)`,
  );
  qtick(11_000);
  check(q.hasCapacity("anthropic"), "...and at that moment there genuinely is capacity");

  // A provider's own number is used, and clamped. A header is a value from outside this system,
  // and a bad afternoon at a provider must not set the pool aside for the rest of the day.
  const { pool: r } = pool({ ANTHROPIC_API_KEY: "solo" });
  const lease = r.lease("anthropic");
  if (lease.ok) r.rateLimited(lease.key, 86_400);
  const clamped = r.lease("anthropic");
  check(
    !clamped.ok && clamped.retryAfterS <= 15 * 60,
    `a provider's retry-after is clamped to fifteen minutes (${!clamped.ok ? clamped.retryAfterS : "-"}s)`,
  );
}

// ---------------------------------------------------------------------------------------------
console.log("\nno pool at all is a different answer from an exhausted one");
// ---------------------------------------------------------------------------------------------
{
  const { pool: p } = pool({});
  const lease = p.lease("anthropic");
  check(!lease.ok && lease.reason === "unconfigured", "an unconfigured provider says so");

  // THE TWO REFUSALS MUST NOT READ THE SAME. One is the workspace's to fix by connecting a key;
  // the other is ours, and nothing they do changes it except waiting.
  const unconfigured = poolRefusal({ ok: false, reason: "unconfigured", retryAfterS: 0 });
  const exhausted = poolRefusal({ ok: false, reason: "exhausted", retryAfterS: 30 });
  check(unconfigured.includes("Secrets"), "unconfigured tells somebody where to connect their own key");
  check(!unconfigured.includes("demand"), "...and does not blame demand for something they can fix");
  check(exhausted.includes("30s"), "exhausted names when to try again");
  check(!exhausted.includes("Secrets"), "...and does not send somebody to fix something that is ours");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
