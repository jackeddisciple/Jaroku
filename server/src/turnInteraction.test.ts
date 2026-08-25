// Notes, pins and feedback — §12.18, §12.19, §12.20 and §12.23.
//
//   18. "A note is visible to another workspace member and not to another workspace."
//   19. "Notes survive regeneration and remain attached to the turn."
//   20. "Pins are per user: user A's pin is invisible to user B in the same conversation."
//   23. "Thumbs are exclusive and toggleable."
//
// TWO OF THESE ARE THE SAME QUESTION WITH OPPOSITE ANSWERS, which is the whole reason both features
// exist and the reason a suite is worth writing: a note that turned out to be private would be a
// warning a teammate never sees, and a pin that turned out to be shared would be a rail full of
// somebody else's bookmarks. Neither failure produces an error, and both look completely correct
// to whoever is testing alone.
//
//   npm run test:turn-interaction

import { randomUUID } from "node:crypto";

import { MAX_PINS, TurnInteractionStore, isFeedbackReason, FEEDBACK_REASONS } from "./turnInteraction.ts";
import { TurnVariantStore } from "./turnVariants.ts";
import { openTestSqlite, testContext } from "./db/testDb.ts";
import { newRequestId, systemContextFor } from "./db/tenant.ts";

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

  const seedUser = async (label: string): Promise<string> => {
    const id = randomUUID();
    await db.run(
      `INSERT INTO users (id, external_id, email, display_name, created_at) VALUES (?, ?, ?, ?, ?)`,
      [id, `ext-${id.slice(0, 8)}`, `${label}-${id.slice(0, 8)}@example.test`, label, new Date().toISOString()],
    );
    return id;
  };

  const seedTurn = async (workspaceId: string): Promise<{ threadId: string; turnId: string }> => {
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
       VALUES (?, ?, ?, 'generation', ?)`,
      [turnId, workspaceId, threadId, now],
    );
    return { threadId, turnId };
  };

  return {
    db,
    store: new TurnInteractionStore(db),
    variants: new TurnVariantStore(db),
    seedUser, seedTurn,
    close: () => db.close(),
  };
}

console.log("\n§12.18 — a note is the workspace's, not the author's");
{
  const h = await harness();
  const ada = await h.seedUser("Ada");
  const grace = await h.seedUser("Grace");
  const { turnId } = await h.seedTurn(ctx.workspaceId);

  await h.store.addNote(ctx, turnId, ada, "This plan drops the retry on 429. Check before we publish.");

  // THE POINT OF THE FEATURE. A note that turned out to be private would be a warning the teammate
  // it was written for never sees — and it would look completely correct to whoever wrote it.
  const asGrace = await h.store.notesFor(ctx, turnId);
  check("a teammate sees it", asGrace.length === 1, String(asGrace.length));
  check("...with the author on it", asGrace[0]?.author_id === ada);
  check("...and the words intact", Boolean(asGrace[0]?.body.includes("retry on 429")));
  check("grace is not the author, and still reads it", grace !== ada);

  // ...and the other half: not another WORKSPACE. On SQLite the repository's WHERE is the whole of
  // the enforcement, so this is the assertion that it is actually there.
  check("another workspace sees nothing", (await h.store.notesFor(otherCtx, turnId)).length === 0);
  await h.close();
}

console.log("\n...and only the author may change it");
{
  const h = await harness();
  const ada = await h.seedUser("Ada");
  const grace = await h.seedUser("Grace");
  const { turnId } = await h.seedTurn(ctx.workspaceId);
  const note = await h.store.addNote(ctx, turnId, ada, "original");

  // §5.2 gives Edit/Delete to "the author only", and the check is in the WHERE rather than in an
  // `if` — so there is no path that reaches the write with the check skipped.
  check("a teammate cannot edit it", !(await h.store.editNote(ctx, note.id, grace, "rewritten")));
  check("...and the words are untouched", (await h.store.notesFor(ctx, turnId))[0]?.body === "original");
  check("a teammate cannot delete it", !(await h.store.deleteNote(ctx, note.id, grace)));
  check("...and it is still there", (await h.store.notesFor(ctx, turnId)).length === 1);

  check("the author can edit it", await h.store.editNote(ctx, note.id, ada, "rewritten"));
  check("...and the change lands", (await h.store.notesFor(ctx, turnId))[0]?.body === "rewritten");
  check("the author can delete it", await h.store.deleteNote(ctx, note.id, ada));
  check("...and it stops being listed", (await h.store.notesFor(ctx, turnId)).length === 0);

  // Soft delete: the row stays, so "was there ever a warning on this turn?" is still answerable.
  const raw = await h.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM turn_notes WHERE id = ?`, [note.id]);
  check("...but the row is still there, deleted rather than gone", Number(raw?.n) === 1);
  check("deleting twice is not a second delete", !(await h.store.deleteNote(ctx, note.id, ada)));
  await h.close();
}

console.log("\n§12.19 — notes survive regeneration");
{
  const h = await harness();
  const ada = await h.seedUser("Ada");
  const { turnId } = await h.seedTurn(ctx.workspaceId);

  await h.variants.begin(ctx, turnId, { modelId: "claude-sonnet-5" });
  await h.store.addNote(ctx, turnId, ada, "we tried this prompt shape");

  // The regeneration. §5.2: "a note is attached to the turn, not to a specific response variant."
  // The mechanism is that there is no column here that COULD point at a variant — so this is
  // really asserting the schema rather than a code path, which is the strongest form available.
  await h.variants.begin(ctx, turnId, { modelId: "claude-opus-5" });
  await h.variants.begin(ctx, turnId, { modelId: "gpt-4o" });

  const after = await h.store.notesFor(ctx, turnId);
  check("the note is still there after two regenerations", after.length === 1, String(after.length));
  check("...unchanged", after[0]?.body === "we tried this prompt shape");
  check("...and there really were three variants", (await h.variants.forTurn(ctx, turnId)).length === 3);
  await h.close();
}

console.log("\n§12.20 — pins are per user, and invisible to anybody else");
{
  const h = await harness();
  const ada = await h.seedUser("Ada");
  const grace = await h.seedUser("Grace");
  const { threadId, turnId } = await h.seedTurn(ctx.workspaceId);

  await h.store.pin(ctx, threadId, turnId, ada);

  check("Ada sees her pin", (await h.store.pinsFor(ctx, threadId, ada)).length === 1);
  // THE ASSERTION, and the failure it guards is a rail full of somebody else's bookmarks — which
  // looks completely correct to whoever is testing alone.
  check("Grace sees nothing", (await h.store.pinsFor(ctx, threadId, grace)).length === 0);

  // ...and the same turn pinned by both is two independent pins, not a shared one.
  await h.store.pin(ctx, threadId, turnId, grace);
  check("both can pin the same turn", (await h.store.pinsFor(ctx, threadId, grace)).length === 1);
  await h.store.unpin(ctx, turnId, grace);
  check("...and one unpinning does not touch the other", (await h.store.pinsFor(ctx, threadId, ada)).length === 1);
  check("...while their own is gone", (await h.store.pinsFor(ctx, threadId, grace)).length === 0);

  // There is deliberately no method that lists a conversation's pins without a user — the one
  // somebody would reach for while building a "team pins" view, silently making the rail shared.
  const methods = Object.getOwnPropertyNames(TurnInteractionStore.prototype);
  check("no method lists pins without a user", !methods.includes("allPinsFor") && !methods.includes("pinsForConversation"),
    methods.join(","));
  await h.close();
}

console.log("\n§5.3 — the sixth pin is refused rather than silently dropped");
{
  const h = await harness();
  const ada = await h.seedUser("Ada");
  const { threadId } = await h.seedTurn(ctx.workspaceId);

  // Six turns in ONE conversation, because the limit is per conversation. Six turns spread over
  // six threads would pass a broken implementation that counted globally, and six in one would
  // pass one that counted per thread — only the first is the rule §5.3 states.
  const turns: string[] = [];
  for (let i = 0; i < MAX_PINS + 1; i++) {
    const turnId = randomUUID();
    await h.db.run(
      `INSERT INTO thread_items (id, workspace_id, thread_id, kind, created_at)
       VALUES (?, ?, ?, 'generation', ?)`,
      [turnId, ctx.workspaceId, threadId, new Date().toISOString()],
    );
    turns.push(turnId);
  }

  for (let i = 0; i < MAX_PINS; i++) {
    const res = await h.store.pin(ctx, threadId, turns[i]!, ada);
    check(`pin ${i + 1} of ${MAX_PINS} is taken`, res.pinned && !res.atLimit);
  }
  const sixth = await h.store.pin(ctx, threadId, turns[MAX_PINS]!, ada);
  // §5.3: "pinning a 6th prompts to unpin one" — so the answer is a refusal the client can turn
  // into a prompt, not an error and not a silent drop.
  check("the sixth is refused", !sixth.pinned);
  check("...and says why, so the client can prompt", sixth.atLimit);
  check("...and the five are intact", (await h.store.pinsFor(ctx, threadId, ada)).length === MAX_PINS);

  // Pinning something already pinned is not a sixth pin.
  const again = await h.store.pin(ctx, threadId, turns[0]!, ada);
  check("re-pinning an existing pin is a no-op, not a limit error", again.pinned && !again.atLimit);
  check("...and the count is unchanged", (await h.store.pinsFor(ctx, threadId, ada)).length === MAX_PINS);
  await h.close();
}

console.log("\n§12.23 — thumbs are exclusive and toggleable");
{
  const h = await harness();
  const ada = await h.seedUser("Ada");
  const grace = await h.seedUser("Grace");
  const { turnId } = await h.seedTurn(ctx.workspaceId);

  let s = await h.store.setFeedback(ctx, turnId, ada, 1);
  check("a thumbs up counts", s.up === 1 && s.down === 0, JSON.stringify(s));
  check("...and is reported back as mine", s.mine === 1);

  // EXCLUSIVE: switching does not accumulate. One record per (turn, user) is the primary key, and
  // this is that key doing its job.
  s = await h.store.setFeedback(ctx, turnId, ada, -1, ["wrong_code", "too_slow"], "it dropped the retry");
  check("switching to a thumbs down replaces it", s.up === 0 && s.down === 1, JSON.stringify(s));

  // TOGGLEABLE: clicking the active one clears it, and clearing is the absence of a row rather
  // than a third value — so "no opinion" and "never asked" are the same state, which they are.
  s = await h.store.setFeedback(ctx, turnId, ada, null);
  check("clearing removes it entirely", s.up === 0 && s.down === 0 && s.mine === null, JSON.stringify(s));
  const rows = await h.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM turn_feedback WHERE turn_id = ?`, [turnId]);
  check("...leaving no row at all", Number(rows?.n) === 0);

  // Two people are two records, and each sees only their own rating in `mine`.
  await h.store.setFeedback(ctx, turnId, ada, 1);
  const asGrace = await h.store.setFeedback(ctx, turnId, grace, -1);
  check("two people are two opinions", asGrace.up === 1 && asGrace.down === 1, JSON.stringify(asGrace));
  check("...and Grace's own is the one she is told about", asGrace.mine === -1);
  check("...while Ada is told about hers", (await h.store.feedbackFor(ctx, turnId, ada)).mine === 1);
  await h.close();
}

console.log("\nthe reason text is a separate read from the counts");
{
  // §5.5: "Feedback is workspace-visible in aggregate (counts on the turn) but the reason text is
  // visible to workspace admins and the author only." The split is structural: `feedbackFor`
  // cannot return a comment, so a route that forgot the capability check has nothing to leak.
  const h = await harness();
  const ada = await h.seedUser("Ada");
  const { turnId } = await h.seedTurn(ctx.workspaceId);
  await h.store.setFeedback(ctx, turnId, ada, -1, ["broke_something"], "it deleted the staging table");

  const summary = await h.store.feedbackFor(ctx, turnId, ada);
  check("the summary carries no comment", !("comment" in summary));
  check("...and no reasons", !("reasons" in summary));
  check("...only counts and my own rating", summary.down === 1 && summary.mine === -1);

  const detail = await h.store.feedbackDetail(ctx, turnId);
  check("the detail read has them", detail[0]?.comment === "it deleted the staging table");
  // The reasons survive the JSON-text round trip this driver needs — the one place the dialect is
  // visible in this store, and the one most likely to come back as a string nobody parsed.
  check("...and the reasons come back as a list", Array.isArray(detail[0]?.reasons) && detail[0]!.reasons.length === 1,
    JSON.stringify(detail[0]?.reasons));
  check("...with the right value", detail[0]?.reasons[0] === "broke_something");
  await h.close();
}

console.log("\nthe reason set is closed, because an aggregate over free text is not one");
{
  check("five reasons", FEEDBACK_REASONS.length === 5);
  check("...and they are §5.5's",
    FEEDBACK_REASONS.join(",") === "wrong_code,ignored_instruction,too_slow,broke_something,other");
  check("something invented is not one", !isFeedbackReason("hallucinated") && !isFeedbackReason(""));

  // An invented reason is DROPPED rather than stored, so the aggregate stays countable.
  const h = await harness();
  const ada = await h.seedUser("Ada");
  const { turnId } = await h.seedTurn(ctx.workspaceId);
  await h.store.setFeedback(ctx, turnId, ada, -1, ["wrong_code", "made_up" as never]);
  const detail = await h.store.feedbackDetail(ctx, turnId);
  check("an unknown reason does not survive the round trip", detail[0]?.reasons.join(",") === "wrong_code",
    detail[0]?.reasons.join(","));
  await h.close();
}

console.log("\nnote counts come back for a whole thread in one read");
{
  const h = await harness();
  const ada = await h.seedUser("Ada");
  const a = await h.seedTurn(ctx.workspaceId);
  const b = await h.seedTurn(ctx.workspaceId);
  await h.store.addNote(ctx, a.turnId, ada, "one");
  await h.store.addNote(ctx, a.turnId, ada, "two");
  await h.store.addNote(ctx, b.turnId, ada, "three");

  const counts = await h.store.noteCounts(ctx, [a.turnId, b.turnId]);
  check("two turns counted", counts.size === 2, String(counts.size));
  // A NUMBER, not a string. COUNT is a bigint on Postgres and arrives as text, which renders as a
  // badge that concatenates instead of adding.
  check("...as numbers", typeof counts.get(a.turnId) === "number");
  check("...with the right totals", counts.get(a.turnId) === 2 && counts.get(b.turnId) === 1);

  // A deleted note stops being counted, or the badge outlives the thing it was counting.
  const notes = await h.store.notesFor(ctx, a.turnId);
  await h.store.deleteNote(ctx, notes[0]!.id, ada);
  check("a deleted note is not counted", (await h.store.noteCounts(ctx, [a.turnId])).get(a.turnId) === 1);
  check("an empty request reads nothing", (await h.store.noteCounts(ctx, [])).size === 0);
  await h.close();
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;
