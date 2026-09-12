// Response variants — §12.21 and §12.22.
//
//   21. "Regenerate creates variant 2; variant 1's response and metadata remain retrievable and
//       unmodified."
//   22. "Switching variants does not move the published version pointer."
//
// The first is the one with a comfortable failure: a store that updated a turn in place would look
// completely correct while a single response was on screen, and would only be wrong when somebody
// compared two — at which point the metadata row, whose entire job is answering "which model wrote
// this?", would answer with whichever model ran last.
//
// The second is not a bug that shows up as a wrong pixel. If switching a view moved the published
// pointer, reading a response would be deploying one.
//
//   npm run test:turn-variants

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { randomUUID } from "node:crypto";

import { TurnVariantStore } from "./turnVariants.ts";
import { openTestSqlite, testContext } from "./db/testDb.ts";
import { newRequestId, systemContextFor } from "./db/tenant.ts";
import type { SqliteDb } from "./db/sqlite.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const ctx = testContext();
const OTHER = randomUUID();
const otherCtx = systemContextFor(OTHER, newRequestId());

async function harness() {
  const db = await openTestSqlite();
  await db.run(
    `INSERT INTO workspaces (id, slug, name, kind, plan, created_at) VALUES (?, ?, ?, 'team', 'free', ?)`,
    [OTHER, `ws-${OTHER.slice(0, 8)}`, "Other", new Date().toISOString()],
  );
  const store = new TurnVariantStore(db);

  const seedTurn = async (workspaceId: string, kind = "generation"): Promise<string> => {
    const threadId = randomUUID();
    const turnId = randomUUID();
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO threads (id, workspace_id, title, title_is_custom, created_at, last_activity_at, status)
       VALUES (?, ?, 'A thread', 0, ?, ?, 'idle')`,
      [threadId, workspaceId, now, now],
    );
    await db.run(
      `INSERT INTO thread_items (id, workspace_id, thread_id, kind, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [turnId, workspaceId, threadId, kind, now],
    );
    return turnId;
  };

  return { db, store, seedTurn, close: () => db.close() };
}

console.log("\n§12.21 — regenerate creates variant 2, and variant 1 is untouched");
{
  const h = await harness();
  const turn = await h.seedTurn(ctx.workspaceId);

  const first = await h.store.begin(ctx, turn, {
    modelId: "claude-sonnet-5", provider: "anthropic",
    effortRequested: "medium", effortApplied: "medium",
  });
  await h.store.settle(ctx, first.id, { durationMs: 12_400, tokensIn: 900, tokensOut: 300, costUsd: 0.0123 });

  // A DIFFERENT MODEL AND A DIFFERENT EFFORT, which is the whole point of §5.4's "Regenerate with
  // different model" — and the case where an in-place update is most obviously wrong.
  const second = await h.store.begin(ctx, turn, {
    modelId: "claude-opus-5", provider: "anthropic",
    effortRequested: "xhigh", effortApplied: "xhigh",
  });
  await h.store.settle(ctx, second.id, { durationMs: 41_000, tokensIn: 900, tokensOut: 1_800, costUsd: 0.0641 });

  const all = await h.store.forTurn(ctx, turn);
  check("there are two variants", all.length === 2, String(all.length));
  check("...numbered 1 and 2", all.map((v) => v.ordinal).join(",") === "1,2", all.map((v) => v.ordinal).join(","));

  const v1 = all[0]!;
  const v2 = all[1]!;
  // THE ASSERTION THE SPEC WRITES AS A SENTENCE: "Never overwrite variant 1's metadata with
  // variant 2's."
  check("variant 1 still names its own model", v1.model_id === "claude-sonnet-5", String(v1.model_id));
  check("...its own effort", v1.effort_applied === "medium", String(v1.effort_applied));
  check("...its own duration", v1.duration_ms === 12_400, String(v1.duration_ms));
  check("...and its own cost", v1.cost_usd === 0.0123, String(v1.cost_usd));
  check("while variant 2 has its own", v2.model_id === "claude-opus-5" && v2.duration_ms === 41_000);
  check("...and its own effort", v2.effort_applied === "xhigh");
}

console.log("\n...and the clamp stays derivable after the fact");
{
  // §6.2 renders `High ⌄` with "XHigh requested; this model caps at High" by COMPARING the two
  // columns. A single `effort` column would make that underivable the moment the request is over,
  // which is the silent-degradation failure the whole effort adapter exists to prevent.
  const h = await harness();
  const turn = await h.seedTurn(ctx.workspaceId);
  const v = await h.store.begin(ctx, turn, {
    modelId: "o-series", effortRequested: "xhigh", effortApplied: "high",
  });
  const back = (await h.store.forTurn(ctx, turn))[0]!;
  check("both levels survive the round trip", back.effort_requested === "xhigh" && back.effort_applied === "high",
    `${back.effort_requested} / ${back.effort_applied}`);
  check("...so the clamp is still visible", back.effort_requested !== back.effort_applied);
  check("...and an unclamped one is not", v.id === back.id);
  await h.close();
}

console.log("\n§12.22 — a variant records what it PRODUCED, never what is published");
{
  const h = await harness();
  const turn = await h.seedTurn(ctx.workspaceId);
  const v1 = await h.store.begin(ctx, turn, { modelId: "m1" });
  await h.store.settle(ctx, v1.id, { agentVersionId: "version-14" });
  const v2 = await h.store.begin(ctx, turn, { modelId: "m2" });
  await h.store.settle(ctx, v2.id, { agentVersionId: "version-15" });

  const all = await h.store.forTurn(ctx, turn);
  check("each variant names its own version", all[0]!.agent_version_id === "version-14" && all[1]!.agent_version_id === "version-15");

  // AND THERE IS NO METHOD HERE THAT PUBLISHES ONE. The absence is the assertion: a "switch" that
  // could move the pointer would turn reading a response into deploying it. Promotion is an
  // explicit Apply on the variant, on the publish path, which this store cannot reach.
  const methods = Object.getOwnPropertyNames(TurnVariantStore.prototype);
  const publishing = methods.filter((m) => /publish|promote|apply|current/i.test(m));
  check("the store has no publish path at all", publishing.length === 0, publishing.join(","));
  await h.close();
}

console.log("\ntwo people pressing Regenerate at once cannot both be variant 2");
{
  // The constraint is what enforces this, and the retry is what turns a lost race into the right
  // answer rather than an error. Without either, the switcher renders `‹ 2/3 ›` with two variants
  // claiming the same number and no way to tell them apart.
  const h = await harness();
  const turn = await h.seedTurn(ctx.workspaceId);
  await h.store.begin(ctx, turn, { modelId: "m0" });

  const racers = await Promise.all([
    h.store.begin(ctx, turn, { modelId: "a" }),
    h.store.begin(ctx, turn, { modelId: "b" }),
    h.store.begin(ctx, turn, { modelId: "c" }),
  ]);
  const ordinals = racers.map((v) => v.ordinal).sort((a, b) => a - b);
  check("every racer got a distinct number", new Set(ordinals).size === 3, ordinals.join(","));
  check("...and they are contiguous from 2", ordinals.join(",") === "2,3,4", ordinals.join(","));

  const all = await h.store.forTurn(ctx, turn);
  check("the switcher sees four in order", all.map((v) => v.ordinal).join(",") === "1,2,3,4");
  await h.close();
}

console.log("\nsettling one variant never reaches another");
{
  // A method that took a TURN and wrote "the latest" would land a slow variant 1's duration on
  // variant 2's row — which is the overwrite §5.4 forbids, arrived at from the other direction.
  const h = await harness();
  const turn = await h.seedTurn(ctx.workspaceId);
  const v1 = await h.store.begin(ctx, turn, { modelId: "m1" });
  const v2 = await h.store.begin(ctx, turn, { modelId: "m2" });

  await h.store.settle(ctx, v2.id, { durationMs: 100 });
  await h.store.settle(ctx, v1.id, { durationMs: 9_000 });

  const all = await h.store.forTurn(ctx, turn);
  check("the slow one's duration is its own", all[0]!.duration_ms === 9_000, String(all[0]!.duration_ms));
  check("...and the fast one keeps its own", all[1]!.duration_ms === 100, String(all[1]!.duration_ms));

  // A partial settle leaves the other columns alone rather than nulling them — §7's "null the rest
  // rather than guessing" applies to writes, not just to the backfill.
  await h.store.settle(ctx, v1.id, { costUsd: 0.5 });
  const after = (await h.store.forTurn(ctx, turn))[0]!;
  check("a partial settle does not null what it was not given", after.duration_ms === 9_000 && after.cost_usd === 0.5);
  await h.close();
}

console.log("\nwhat was never measured stays null rather than becoming a zero");
{
  // Doc §8's rule about cost, applied to every figure in the metadata row: a wrong number is worse
  // than an absent one, because an absent one is visibly absent. A duration of 0 would render as
  // "0.0s" — a measurement — under a response that took eleven seconds.
  const h = await harness();
  const turn = await h.seedTurn(ctx.workspaceId);
  await h.store.begin(ctx, turn, { modelId: "m" });
  const v = (await h.store.forTurn(ctx, turn))[0]!;
  check("duration is null, not zero", v.duration_ms === null);
  check("cost is null, not zero", v.cost_usd === null);
  check("tokens are null, not zero", v.tokens_in === null && v.tokens_out === null);
  check("...and so is the version it did not produce", v.agent_version_id === null);
  await h.close();
}

console.log("\nthe whole thread's variants come back in one read");
{
  const h = await harness();
  const a = await h.seedTurn(ctx.workspaceId);
  const b = await h.seedTurn(ctx.workspaceId);
  await h.store.begin(ctx, a, { modelId: "a1" });
  await h.store.begin(ctx, a, { modelId: "a2" });
  await h.store.begin(ctx, b, { modelId: "b1" });

  const map = await h.store.forTurns(ctx, [a, b]);
  check("both turns are there", map.size === 2, String(map.size));
  check("...with their own variants", map.get(a)?.length === 2 && map.get(b)?.length === 1);
  check("...in ordinal order", map.get(a)?.map((v) => v.ordinal).join(",") === "1,2");
  check("an empty request reads nothing", (await h.store.forTurns(ctx, [])).size === 0);
  await h.close();
}

console.log("\ntenancy: another workspace's turn has no variants of ours");
{
  const h = await harness();
  const mine = await h.seedTurn(ctx.workspaceId);
  const theirs = await h.seedTurn(OTHER);
  await h.store.begin(ctx, mine, { modelId: "mine" });
  await h.store.begin(otherCtx, theirs, { modelId: "theirs" });

  // On SQLite the repository's WHERE is the whole of the enforcement — migration 009 grants this
  // driver no RLS at all — so this is the assertion that the WHERE is actually there.
  check("reading their turn from our context sees nothing", (await h.store.forTurn(ctx, theirs)).length === 0);
  check("...and the batch read is scoped too", (await h.store.forTurns(ctx, [mine, theirs])).size === 1);
  check("each workspace still sees its own",
    (await h.store.forTurn(ctx, mine))[0]?.model_id === "mine"
    && (await h.store.forTurn(otherCtx, theirs))[0]?.model_id === "theirs");

  // A write scoped to the wrong workspace is refused by the composite key — the pair
  // (our workspace, their turn) does not exist in `thread_items`. §7's rule earning its place.
  let refused = false;
  try { await h.store.begin(ctx, theirs, { modelId: "smuggled" }); } catch { refused = true; }
  check("a cross-workspace write is refused by the composite key", refused);
  check("...and their turn is untouched", (await h.store.forTurn(otherCtx, theirs)).length === 1);
  await h.close();
}

// ---------------------------------------------------------------------------------------------
// AND THAT ANY OF IT IS EVER REACHED, which is what this whole feature was missing.
//
// Every assertion above was true of the shipped code and none of it ran on a real turn. Migration
// 057, this store, this suite, registration in export and retention, `TurnMeta.ordinal`/`.total`,
// `presentSlots` giving `variants` a fixed position, a rendered `‹ n/m ›` switcher and an
// `onSwitchVariant` prop — and no writer anywhere. `turn_variants` held only the backfill's rows,
// every one at ordinal 1 with every metadata column null, so `total` was always 1, the metadata
// row's slot could never be present, and both arrows carried `disabled={… || !onSwitchVariant}`
// over a prop nothing passed. Regenerate PREFILLED the composer, so what arrived was an ordinary
// second turn rather than a variant of the first.
//
// A source audit rather than an arithmetic one, and it is here because this is the suite about
// variants: it reads the dispatch, the wire and the client for the four links the audit named.
// ---------------------------------------------------------------------------------------------
console.log("\nthe store is instantiated, written and read — outside a test");
{
  const HERE = dirname(fileURLToPath(import.meta.url));
  const index = readFileSync(join(HERE, "index.ts"), "utf8");
  const relay = readFileSync(join(HERE, "wsRelay.ts"), "utf8");
  const client = (f: string): string => readFileSync(join(HERE, "..", "..", "client", "src", f), "utf8");

  check("the store is constructed in production", /new TurnVariantStore\(store\.database\(\)\)/.test(index));
  check("...and a variant is opened around a response", /await turnVariants\.begin\(ctx, turnId, \{/.test(index));
  check("...settled by VARIANT id rather than by turn", /turnVariants\n?\s*.*\.settle\(ctx, variant\.id/.test(index.replace(/\s+/g, " ")));
  check(
    "...carrying the model and BOTH effort levels, which is what the clamp marker is derived from",
    /effortRequested: effort\?\.supported \? effort\.requested : null/.test(index)
      && /effortApplied: effort\?\.supported \? effort\.applied : null/.test(index),
  );

  // THE COUNTS, WHICH THE SWITCHER CANNOT RENDER WITHOUT. Absent below two, so the metadata row's
  // slot collapses rather than showing `‹ 1/1 ›` on every turn in the product.
  const counts = /async function variantCounts\([\s\S]*?\n\}/.exec(index)?.[0] ?? "";
  check("the wire carries the two counts", /variant_ordinal: rows\.length, variant_total: rows\.length/.test(counts));
  check("...and omits them when there is one variant", /if \(rows\.length < 2\) return \{\};/.test(counts));

  // REGENERATE RE-RUNS, and attaches to the turn it is re-running rather than writing a second
  // message. Without this the switcher has nothing to switch between however well it is wired.
  // FIVE SINCE §6.2, and the fifth is the one that matters most: `chat` is the composer's default
  // route, so it is the command a regeneration actually goes out on now. A count here rather than a
  // per-command check because what fails is an OMISSION — a command that grew a regenerate path and
  // did not carry the turn it is a second answer to writes a second QUESTION, silently.
  // ANCHORED TO ITS OWN LINE, WHICH IS WHAT MAKES THIS COUNT COMMANDS. The `started` REPLY EVENT
  // also carries `regenerateOf` — it has to, so every tab replaces the same turn — and it declares
  // the field inline inside a one-line union member. An unanchored match counted that too and read
  // as a sixth command, which is the shape of false alarm a count is most likely to produce.
  check(
    "the five composer commands carry the turn a re-run is OF",
    (relay.match(/^ {2}regenerateOf\?: string;$/gm) ?? []).length === 5,
    String((relay.match(/^ {2}regenerateOf\?: string;$/gm) ?? []).length),
  );
  check("...verified server-side rather than taken on the client's word", /async function turnForRegenerate\(/.test(index));
  check("...and used instead of writing a second user message", /cmd\.regenerateOf\s*\n?\s*\? await turnForRegenerate/.test(index));

  const pane = client("components/BuildPane.tsx");
  // WHAT THIS ROW IS FOR IS UNCHANGED: regenerate must DISPATCH, not put the sentence back in the
  // composer and stop. What it dispatches changed with §6.2 — `sendChat` rather than `sendExplain`,
  // because a reply turn is what the chat route produces and re-running it through explain sent it
  // somewhere "grounded strictly in the selection" with no selection to ground it in. The
  // regenerated answer now gets the grounded context block and the conversation window the first
  // one had, rather than less.
  check("Regenerate DISPATCHES rather than prefilling", /sendChat\(prompt, turn\.agentId \|\| null, \{/.test(pane));
  // AND IT CARRIES THE MODEL, which is §6.2's "regenerating on a different model is a legitimate and
  // useful thing to do". The menu used to call `setModel` — the model an agent's RUN goes to — and
  // then dispatch a call that ignored the model entirely, so it repointed the next test run and
  // answered on the same model as before.
  // WHAT THIS ROW IS FOR IS UNCHANGED and its pattern moved with §11.1. A plain ⟳ now answers again
  // on the model the CONVERSATION is set to — which is the chat pair, a separate selection from the
  // run's — and "Regenerate with <model>" overrides it for one answer. The property being asserted
  // is the one that was broken: the chosen model rides the COMMAND, and nothing calls `setModel`,
  // which repoints the model an agent's test run goes to.
  check("...and the chosen model rides the command rather than repointing the run",
    /opts\?\.modelId\s*\n?\s*\? \{ model: opts\.modelId \}/.test(pane)
    && !/setModel\(opts\.modelId\)/.test(pane),
    /\{[^}]*model:[^}]*\}/.exec(pane.slice(pane.indexOf("function rerunTurn")))?.[0] ?? "no match");
  // AND THE FALLBACK IS THE CONVERSATION'S OWN MODEL, not the run's — §11.1's separation reaching
  // the one control most likely to confuse the two.
  check("...falling back to the conversation's model rather than the run's",
    /useUiStore\.getState\(\)\.chatModel/.test(pane) && !/model: useUiStore\.getState\(\)\.model\b/.test(pane));
  check("...and the switcher finally has a caller", /onSwitchVariant=\{/.test(pane));
  check(
    "...offered only where there are bodies to switch between",
    /turn\.priorVariants\?\.length \?\? 0\) > 0/.test(pane),
  );

  // AND THE COMMENT THAT ASSERTED BEHAVIOUR THAT DID NOT EXIST. It said the server writes a new
  // `turn_variants` row beside the old one, on a code path that prefilled a textarea.
  check(
    "the comment above it no longer describes a write nothing performed",
    /IT DISPATCHES NOW RATHER THAN PREFILLING/.test(pane),
  );
}

// --- §6.2: which of a turn's answers the conversation MEANS (migration 074) ------------------
//
// THE LOCAL SWITCHER WAS ONLY HALF OF §6.2. It moved the answer on screen; it could not move which
// answer the MODEL reads — "only the selected sibling participates in conversation memory and in
// the context sent for subsequent turns" — so somebody who regenerated three times and switched
// back to the first read answer one while every following reply was answered against answer three.

console.log("\n§6.2 — selection is durable, exactly one, and scoped");
{
  const h = await harness();
  const turn = await h.seedTurn(ctx.workspaceId);
  const a = await h.store.begin(ctx, turn, { modelId: "claude-haiku-4-5", provider: "anthropic" });
  const b = await h.store.begin(ctx, turn, { modelId: "gpt-5.6-luna", provider: "openai" });
  const c = await h.store.begin(ctx, turn, { modelId: "gpt-5.6-terra", provider: "openai" });

  // NOTHING IS SELECTED UNTIL SOMEBODY SWITCHES, which reads as "the newest one" — the same answer
  // every turn gave before the column existed. That is what makes 074 need no backfill.
  const fresh = await h.store.forTurn(ctx, turn);
  check("a fresh turn has no selection", fresh.every((v) => v.selected === false), JSON.stringify(fresh.map((v) => v.selected)));

  check("selecting an ordinal that exists succeeds", (await h.store.select(ctx, turn, 1)) === true);
  const afterFirst = await h.store.forTurn(ctx, turn);
  check("...and exactly one row is selected", afterFirst.filter((v) => v.selected).length === 1,
    JSON.stringify(afterFirst.map((v) => [v.ordinal, v.selected])));
  check("...the one asked for", afterFirst.find((v) => v.selected)?.id === a.id);

  // MOVING IT CLEARS THE OTHER, which is what makes "exactly one" true without a partial unique
  // index — migration 074 explains why that index is deliberately absent.
  await h.store.select(ctx, turn, 3);
  const afterThird = await h.store.forTurn(ctx, turn);
  check("moving the selection clears the previous one", afterThird.filter((v) => v.selected).length === 1,
    JSON.stringify(afterThird.map((v) => [v.ordinal, v.selected])));
  check("...and lands on the new one", afterThird.find((v) => v.selected)?.id === c.id);

  // AN ORDINAL NOTHING PRODUCED MOVES NOTHING. A client asking for variant 9 of a three-variant
  // turn has raced a regeneration or is simply wrong, and the selection staying put is better than
  // a refusal it cannot act on.
  check("an ordinal nothing produced is refused", (await h.store.select(ctx, turn, 9)) === false);
  check("...and the selection has not moved",
    (await h.store.forTurn(ctx, turn)).find((v) => v.selected)?.id === c.id);
  check("a zero ordinal is refused", (await h.store.select(ctx, turn, 0)) === false);
  check("a fractional ordinal is refused", (await h.store.select(ctx, turn, 1.5)) === false);

  // AND IT IS SCOPED. §13's rule for every id that crosses a tenant boundary: a turn this pass does
  // not own reads as ABSENT rather than as forbidden, because a refusal that told them apart would
  // confirm the id exists somewhere.
  check("another workspace cannot select on this turn", (await h.store.select(otherCtx, turn, 1)) === false);
  check("...and this turn's selection is untouched",
    (await h.store.forTurn(ctx, turn)).find((v) => v.selected)?.id === c.id);

  // SELECTION IS A VIEW CHANGE AND NOTHING ELSE — `turnVariants.ts`'s own standing rule. Nothing
  // about what a variant PRODUCED may move because somebody looked at a different answer.
  const bodies = await h.store.forTurn(ctx, turn);
  check("no body was touched", bodies.every((v) => v.body === null), JSON.stringify(bodies.map((v) => v.body)));
  check("no version pointer was touched", bodies.every((v) => v.agent_version_id === null));
  check("every model is still its own",
    bodies.find((v) => v.id === b.id)?.model_id === "gpt-5.6-luna"
    && bodies.find((v) => v.id === a.id)?.model_id === "claude-haiku-4-5");

  // §6.2's BODIES, SETTLED AND READ BACK — what makes both answers retrievable after a reload.
  await h.store.settle(ctx, a.id, { body: "Haiku." });
  await h.store.settle(ctx, c.id, { body: "Terra." });
  const read = await h.store.forTurn(ctx, turn);
  check("each answer's own body comes back", read.find((v) => v.id === a.id)?.body === "Haiku."
    && read.find((v) => v.id === c.id)?.body === "Terra.");
  check("...and a variant that said nothing stays null", read.find((v) => v.id === b.id)?.body === null);
  // SETTLING ONE MUST NOT TOUCH ANOTHER — this module's founding rule, now with one more column to
  // get wrong: "never overwrite variant 1's metadata with variant 2's."
  await h.store.settle(ctx, b.id, { body: "Luna." });
  const reread = await h.store.forTurn(ctx, turn);
  check("settling a third body leaves the other two alone",
    reread.find((v) => v.id === a.id)?.body === "Haiku." && reread.find((v) => v.id === c.id)?.body === "Terra.");
  check("...and does not move the selection", reread.find((v) => v.selected)?.id === c.id);

  await h.close();
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;
