// Doing something to a card, doing it to forty at once, and taking it back.
//
// §3: "every destructive action shows a 5-second toast with undo. NO CONFIRMATION DIALOGS — undo is
// strictly better and does not interrupt a triage flow." That sentence decides the shape of this
// whole file. A confirmation is a gate somebody has to clear before the thing happens, and a board
// meant to be cleared in one pass cannot afford one per card. Undo is the same safety with the cost
// moved to the rare case: it is paid only by the person who got it wrong.
//
// WHICH MEANS "PUT BACK EXACTLY WHAT WAS THERE" HAS TO BE TRUE, and that is harder than it sounds.
// Undoing a dismissal is not "clear `dismissed_at`" — the item may have been dismissed last week and
// then dismissed again by a bulk action, and clearing the column would undo both. So what is taken
// back is the PRIOR VALUE, captured at the moment the action happened.
//
// THE LEDGER IS IN MEMORY AND THAT IS THE RIGHT LIFETIME. A toast lives five seconds. Persisting the
// inverse of every dismissal would be a table that grows forever to serve a window that has already
// closed, and a restart inside those five seconds takes the toast with it anyway — the undo and the
// thing offering it die together, which is the only way for the two not to disagree.
//
// AND THE ONE ACTION THAT KEEPS ITS DIALOG. §3 names the exception: deleting an agent still uses the
// creator-named confirmation. Nothing here touches that, and nothing here can — the actions on this
// surface are dismiss, snooze and resolve, and the destructive one in the product is somewhere else.

import { randomUUID } from "node:crypto";

import type { TenantContext } from "../db/tenant.ts";
import type { InboxStore } from "./inboxStore.ts";
import { inboxType, type InboxItemType } from "./registry.ts";
import { snoozeUntil, type SnoozeDuration } from "./snapshot.ts";

/** The three verbs, as something a client can name. */
export type InboxAction = "resolve" | "snooze" | "dismiss";

export const INBOX_ACTIONS: readonly InboxAction[] = ["resolve", "snooze", "dismiss"];

export function isInboxAction(v: unknown): v is InboxAction {
  return typeof v === "string" && (INBOX_ACTIONS as readonly string[]).includes(v);
}

/**
 * How long an undo token is good for.
 *
 * A MINUTE, AGAINST A TOAST THAT LIVES FIVE SECONDS, and the generosity is deliberate. The toast is
 * a rendering; the window is a promise. Somebody whose tab was busy, whose network hiccuped, or who
 * reached for the keyboard shortcut a beat late should get the undo they were offered rather than a
 * message about a token that expired — and a minute of memory for one bulk action costs nothing.
 */
export const UNDO_TTL_MS = 60_000;

/**
 * How many tokens one process keeps.
 *
 * BOUNDED, because this is a map a client can grow: every dismissal mints an entry, and a triage
 * session is a hundred of them. The oldest go first, which is also the ones whose toast is long gone.
 */
export const UNDO_MAX_ENTRIES = 500;

/** What one item looked like before an action touched it. The whole of what undo restores. */
interface PriorState {
  itemId: string;
  dismissed_at: string | null;
  snoozed_until: string | null;
  wasOpen: boolean;
}

interface UndoEntry {
  workspaceId: string;
  userId: string;
  action: InboxAction;
  at: number;
  prior: PriorState[];
}

/**
 * The five seconds after a destructive action, as one map.
 *
 * KEYED BY A TOKEN THE SERVER MINTS, and the token is the only thing a client sends back. A client
 * that could name the items and the values to restore would be a client that could write any
 * dismissal state it liked onto any row — undo would become a general-purpose write dressed as a
 * safety feature.
 *
 * SCOPED ON REDEMPTION, NOT ONLY ON CREATION. The entry records the workspace and the person, and
 * `take` refuses a token whose workspace or user does not match the caller. A uuid is unguessable,
 * but "unguessable" is not a tenancy boundary and nothing else in this codebase treats it as one.
 */
export class UndoLedger {
  private entries = new Map<string, UndoEntry>();

  constructor(private now: () => number = Date.now) {}

  /** Remember what these items looked like, and hand back the token that restores them. */
  put(ctx: TenantContext, userId: string, action: InboxAction, prior: PriorState[]): string {
    this.sweep();
    const token = randomUUID();
    this.entries.set(token, { workspaceId: ctx.workspaceId, userId, action, at: this.now(), prior });
    // Oldest first, which is also the ones whose toast is long gone.
    while (this.entries.size > UNDO_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return token;
  }

  /**
   * Claim a token, once.
   *
   * SINGLE USE, like a ws-ticket and an OAuth state, and for a smaller version of the same reason:
   * pressing undo twice must not be a way to reopen an item somebody has resolved since.
   */
  take(ctx: TenantContext, userId: string, token: string): UndoEntry | null {
    this.sweep();
    const entry = this.entries.get(token);
    if (!entry) return null;
    // The same answer for "expired", "not yours" and "never existed" — a caller learns nothing about
    // what exists elsewhere, which is §6.3's rule applied to a token instead of to a row.
    if (entry.workspaceId !== ctx.workspaceId || entry.userId !== userId) return null;
    this.entries.delete(token);
    return entry;
  }

  private sweep(): void {
    const cutoff = this.now() - UNDO_TTL_MS;
    for (const [token, entry] of this.entries) {
      if (entry.at < cutoff) this.entries.delete(token);
    }
  }

  /** For a suite, and for a gauge that wants to know this map is bounded. */
  size(): number {
    return this.entries.size;
  }
}

export interface ActionResult {
  /** How many items the action actually changed. */
  changed: number;
  /** The token the toast offers, or null when nothing changed and there is nothing to take back. */
  undoToken: string | null;
  /** Items the caller named that are not this workspace's, or not open. Reported, never silent. */
  skipped: string[];
}

/**
 * Apply one of the three verbs to one item or to forty.
 *
 * BULK IS THE SAME PATH AS SINGLE, which is what makes "shift-click a range, then resolve / snooze /
 * dismiss all" cost nothing extra to be correct: one item is a list of one. The alternative — a
 * separate bulk handler — is two implementations of the same three verbs, and the second one is the
 * one that forgets to capture the prior state.
 *
 * ONE TOKEN FOR THE WHOLE BATCH, because one action produced it. Undoing "dismiss all drift" has to
 * put back all of it; forty tokens would mean forty presses to take back one.
 *
 * `resolve` IS THE ONE VERB A PERSON MAY PERFORM THAT THE SWEEP ALSO PERFORMS, and that is fine
 * rather than a conflict: the sweep settles what is no longer true, and a person saying "this is
 * dealt with" settles what they have dealt with. If they were wrong, the next sweep does nothing —
 * the row is already resolved — and undo puts it back for the predicate to judge afresh.
 */
export async function applyInboxAction(
  store: InboxStore,
  undo: UndoLedger,
  ctx: TenantContext,
  userId: string,
  input: { action: InboxAction; itemIds: readonly string[]; duration?: SnoozeDuration },
  now: number = Date.now(),
): Promise<ActionResult> {
  const prior: PriorState[] = [];
  const skipped: string[] = [];
  const toResolve: string[] = [];
  const nowIso = new Date(now).toISOString();

  for (const itemId of input.itemIds) {
    // SCOPED, EVERY ITEM, EVERY TIME. An id from another workspace reads as absent here exactly as it
    // does everywhere else in this feature, and lands in `skipped` rather than in an error that would
    // tell the caller it exists somewhere.
    const item = await store.get(ctx, itemId);
    if (!item || item.state !== "open") {
      skipped.push(itemId);
      continue;
    }
    // A TYPE THAT DOES NOT OFFER THE VERB REFUSES IT. `mcp_auth_required` has no dismissal, because a
    // server that cannot authenticate does not stop needing a credential because somebody looked
    // away — and a client that sent one anyway must not get one.
    if (input.action === "dismiss" && !inboxType(item.type).actions.includes("dismiss")) {
      skipped.push(itemId);
      continue;
    }

    const state = await store.userState(ctx, itemId, userId);
    prior.push({
      itemId,
      dismissed_at: state.dismissed_at,
      snoozed_until: state.snoozed_until,
      wasOpen: true,
    });

    if (input.action === "dismiss") {
      await store.setUserState(ctx, itemId, userId, { dismissed_at: nowIso });
    } else if (input.action === "snooze") {
      await store.setUserState(ctx, itemId, userId, {
        snoozed_until: snoozeUntil(input.duration ?? "hour", now),
      });
    } else {
      toResolve.push(itemId);
    }
  }

  // Batched, so forty resolutions are one statement — the same reason the sweep batches.
  if (toResolve.length > 0) await store.resolve(ctx, toResolve, nowIso);

  if (prior.length === 0) return { changed: 0, undoToken: null, skipped };
  return {
    changed: prior.length,
    undoToken: undo.put(ctx, userId, input.action, prior),
    skipped,
  };
}

/**
 * Take one action back, exactly.
 *
 * RESTORES THE PRIOR VALUE RATHER THAN CLEARING THE COLUMN. An item dismissed last week and dismissed
 * again by a bulk action today has two dismissals in its history and one column; clearing it would
 * undo both, and the card would come back onto a board somebody had deliberately cleared it from.
 *
 * IT DOES NOT ASK WHETHER THE PROBLEM IS STILL THERE. The very next sweep does, and if the condition
 * really is fixed the item resolves again a moment later — which is the correct outcome. Undo
 * restores the row; the world decides whether it stays.
 */
export async function undoInboxAction(
  store: InboxStore,
  undo: UndoLedger,
  ctx: TenantContext,
  userId: string,
  token: string,
): Promise<{ restored: number; action: InboxAction | null }> {
  const entry = undo.take(ctx, userId, token);
  if (!entry) return { restored: 0, action: null };

  let restored = 0;
  if (entry.action === "resolve") {
    restored = await store.reopen(ctx, entry.prior.map((p) => p.itemId));
    return { restored, action: entry.action };
  }

  for (const p of entry.prior) {
    // ONLY THE COLUMN THE ACTION TOUCHED. Restoring both would resurrect a snooze somebody had
    // already replaced with a dismissal, which is a different item state from the one they were in.
    const patch =
      entry.action === "dismiss" ? { dismissed_at: p.dismissed_at } : { snoozed_until: p.snoozed_until };
    if (await store.setUserState(ctx, p.itemId, userId, patch)) restored++;
  }
  return { restored, action: entry.action };
}

/**
 * §2.5's two seeded items, written once per workspace and never again.
 *
 * A BRAND-NEW WORKSPACE WITH A GENUINELY EMPTY INBOX IS CONFUSING RATHER THAN DELIGHTFUL, which is
 * the specification's own reasoning and the reason these exist at all. They are REAL ITEMS with real
 * resolve conditions — a provider key being configured, an agent existing — not decoration, so they
 * leave the moment the thing is actually done, from wherever it was done.
 *
 * WRITTEN ONLY WHEN THE ROW HAS NEVER EXISTED, which is what "never return" costs. `record` re-opens
 * a resolved row on the same key, so a seed rule that ran unconditionally every minute would
 * resurrect "Add a provider key" the moment somebody removed one — turning a one-time welcome into a
 * permanent nag. `byKey` finds a row in either state, so a resolved seed blocks its own re-seeding.
 *
 * AND ONLY WHEN THE WORKSPACE STILL NEEDS IT, which is what keeps this free in the ordinary case: a
 * workspace with a key and an agent asks nothing at all, so the two reads below happen once in a
 * workspace's life rather than every minute for the rest of it.
 */
export async function seedOnboardingItems(
  store: InboxStore,
  ctx: TenantContext,
  facts: { hasProviderKey: boolean; agentCount: number },
): Promise<number> {
  const wanted: { type: InboxItemType; needed: boolean }[] = [
    { type: "setup_api_key", needed: !facts.hasProviderKey },
    { type: "setup_first_agent", needed: facts.agentCount === 0 },
  ];

  let seeded = 0;
  for (const { type, needed } of wanted) {
    if (!needed) continue;
    const key = `${type}:workspace`;
    if (await store.byKey(ctx, key)) continue;
    await store.record(ctx, { type, subjectId: null, dedupeKey: key });
    seeded++;
  }
  return seeded;
}
