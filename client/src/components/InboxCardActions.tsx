// A card's controls, and the region that opens under it.
//
// §7: "Use icons, not text buttons. Every card action, filter, sort and overflow entry is an icon."
// And the half of that instruction that is easy to skip: "every icon-only control gets an accessible
// label and a tooltip. An icon nobody can name is worse than a text button." So every control here
// carries a `title` and an `aria-label` from one table, and there is no path that renders a glyph
// without one.
//
// §4.4'S ANATOMY: the PRIMARY action sits on the row, the secondary ones live in the overflow, and
// `×` dismisses. Which is primary is the registry's decision — the server sends the action list in
// order, first is primary — so a card cannot pick a different one from the one its type declares.
//
// §4.5'S EXPANSION: clicking a card opens it IN PLACE. It does not navigate. What opens is the
// evidence and, where the fix is possible without leaving, the form itself — because "a user should
// be able to clear an entire Inbox without leaving the Inbox" is the design goal of the surface and
// a card that navigated to fix things would be a menu.

import { useState } from "react";
import {
  ACTION_LABEL,
  FORM_ACTIONS,
  runAction,
  submitCeiling,
  submitCredential,
} from "./InboxActions.tsx";
import { actionIconFor } from "./inboxActionIcons.tsx";
import { sendDismissInboxItem, sendResolveInboxItem, sendSnoozeInboxItem } from "../lib/socket.ts";
import { ICON } from "../lib/tokens.ts";
import { KebabIcon, XIcon } from "./panelIcons.tsx";
import type { InboxActionName, InboxItemView, SnoozeDuration } from "../types.ts";

/** §3's three durations, in the order the menu lists them. LABELS, because a duration is a word. */
const SNOOZE_CHOICES: { id: SnoozeDuration; label: string }[] = [
  { id: "hour", label: "1 hour" },
  { id: "tomorrow", label: "Tomorrow" },
  { id: "week", label: "Next week" },
];

/**
 * One icon-only control.
 *
 * THE LABEL IS NOT OPTIONAL, which is why it is a required prop rather than something a caller may
 * pass. §7's rule is that an icon nobody can name is worse than a text button, and the cheapest way
 * to keep that true across a dozen call sites is for the component to be impossible to use without
 * one.
 */
function IconButton({
  label,
  onClick,
  children,
  danger = false,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        // The card itself is clickable — it expands — so every control on it has to stop the click
        // from reaching the card. Without this, dismissing something also opened it.
        e.stopPropagation();
        onClick();
      }}
      className={`rounded-control p-1 transition-colors hover:bg-active ${
        danger ? "text-faint hover:text-err" : "text-faint hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * §4.5's inline form, for the three actions that need somewhere to type.
 *
 * THE VALUE NEVER LEAVES THIS COMPONENT except into the request. It is local state, handed to
 * `submitCredential`, and never put in a store — the same discipline the reveal dialog keeps, and
 * the reason there is no `useState` for a credential anywhere near the item that named it.
 *
 * `type="password"` AND `autoComplete="off"`, because a browser offering to save a workspace
 * credential into a personal password manager is a copy of it nobody decided to make.
 */
function InlineForm({ item, action }: { item: InboxItemView; action: InboxActionName }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const credential = typeof item.payload["credential"] === "string" ? (item.payload["credential"] as string) : "";
  const isCeiling = action === "raise_ceiling";
  const label = isCeiling ? "New ceiling in dollars" : credential || "Credential value";

  const submit = async (): Promise<void> => {
    if (!value.trim() || busy) return;
    setBusy(true);
    setError(null);
    if (isCeiling) {
      const usd = Number(value);
      if (!Number.isFinite(usd) || usd <= 0) setError("that is not an amount");
      else if (!submitCeiling(item, usd)) setError("that is not higher than the ceiling this crossed");
      else setDone(true);
      setBusy(false);
      return;
    }
    const failure = await submitCredential(credential, value);
    setBusy(false);
    if (failure) setError(failure);
    else {
      // THE FIELD IS CLEARED IMMEDIATELY. Whatever else happens, the value stops being on screen the
      // moment it has been sent.
      setValue("");
      setDone(true);
    }
  };

  if (done) {
    // NOT "RESOLVED". The fix has gone out and the sweep is what decides whether the problem is
    // actually gone — a card that congratulated itself and then stayed would be worse than one that
    // said nothing. This says what happened and lets the board answer.
    return <div className="ml-6 mt-2 text-[11px] text-muted">Sent. This card leaves when it takes effect.</div>;
  }

  return (
    <div className="ml-6 mt-2" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2 rounded-control border border-edge bg-bg px-2 py-1">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // The board's own J/K and E/S/X must not fire from inside a field somebody is typing a
            // credential into.
            e.stopPropagation();
            if (e.key === "Enter") void submit();
          }}
          type={isCeiling ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          inputMode={isCeiling ? "decimal" : undefined}
          placeholder={label}
          aria-label={label}
          className="min-w-0 flex-1 bg-transparent text-[12px] text-ink placeholder:text-faint outline-none focus-visible:shadow-focusring"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !value.trim()}
          className="shrink-0 rounded-control px-2 py-0.5 text-[11px] text-muted transition-colors hover:bg-active hover:text-ink disabled:pointer-events-none disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {error && <div className="mt-1 text-[11px] text-err">{error}</div>}
      {!isCeiling && (
        // WHAT THIS DOES WITH THE VALUE, said before it is typed rather than after. It is the same
        // guarded route the Secrets tab posts to, which is the whole of §6.4's reuse rule at the one
        // place it touches a credential.
        <div className="mt-1 text-[10px] text-faint">
          Stored in this workspace&rsquo;s vault, the same way the Secrets tab stores one.
        </div>
      )}
    </div>
  );
}

/** The overflow (§4.4): every action that is not the primary one, and the snooze durations. */
function Overflow({ item, onClose }: { item: InboxItemView; onClose: () => void }) {
  const [snoozing, setSnoozing] = useState(false);
  const secondary = item.actions.slice(1).filter((a) => a !== "dismiss");

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      // CLASSES, LIKE THE OTHER TEN MENUS. This one was built with inline styles, and its
      // `boxShadow` was a byte-identical copy of `ELEVATION.floating` written out by hand — a
      // token that would silently stop matching the moment the token changed, on the one surface
      // where "does this look like the other menus" is the whole question.
      className="absolute right-0 top-6 z-30 w-[184px] overflow-hidden rounded-card border border-edge bg-panel py-1 shadow-floating"
    >
      {snoozing ? (
        // §7: labels stay where a label genuinely carries meaning, and the snooze duration menu is
        // named as one of the places they do. "1 hour" is not a glyph.
        SNOOZE_CHOICES.map((choice) => (
          <button
            key={choice.id}
            onClick={() => {
              sendSnoozeInboxItem(item.id, choice.id);
              onClose();
            }}
            className="block w-full px-3 py-1.5 text-left text-[12px] text-muted transition-colors hover:bg-active hover:text-ink"
          >
            {choice.label}
          </button>
        ))
      ) : (
        <>
          {secondary.map((action) => (
            <button
              key={action}
              onClick={() => {
                runAction(action, item);
                onClose();
              }}
              className="block w-full px-3 py-1.5 text-left text-[12px] text-muted transition-colors hover:bg-active hover:text-ink"
            >
              {ACTION_LABEL[action]}
            </button>
          ))}
          <button
            onClick={() => setSnoozing(true)}
            className="block w-full px-3 py-1.5 text-left text-[12px] text-muted transition-colors hover:bg-active hover:text-ink"
          >
            Snooze…
          </button>
          {/* RESOLVE IS ALWAYS AVAILABLE, on every type, and it is not in the registry's action list
              because it is not a fix — it is somebody saying "this is dealt with". If they are wrong
              the next sweep does nothing, because the row is already resolved, and undo puts it back
              for the predicate to judge afresh. */}
          <button
            onClick={() => {
              sendResolveInboxItem(item.id);
              onClose();
            }}
            className="block w-full px-3 py-1.5 text-left text-[12px] text-muted transition-colors hover:bg-active hover:text-ink"
          >
            Mark as done
          </button>
        </>
      )}
    </div>
  );
}

export function InboxCardActions({ item, expanded }: { item: InboxItemView; expanded: boolean }) {
  const [menu, setMenu] = useState(false);
  const primary = item.actions[0];
  const canDismiss = item.actions.includes("dismiss");
  // §4.3: a blocking card shows its inline form WITHOUT expanding. That is what "large" buys.
  const showForm =
    primary !== undefined && FORM_ACTIONS.has(primary) && (expanded || item.severity === "blocking");

  return (
    <>
      {showForm && primary && <InlineForm item={item} action={primary} />}

      <div className="relative mt-1.5 flex items-center justify-end gap-0.5">
        {primary && !FORM_ACTIONS.has(primary) && (
          <IconButton label={ACTION_LABEL[primary]} onClick={() => runAction(primary, item)}>
            {actionIconFor(primary)({ size: ICON.xs })}
          </IconButton>
        )}
        {item.actions.length > 1 && (
          <IconButton label="More actions" onClick={() => setMenu((m) => !m)}>
            <KebabIcon size={ICON.xs} />
          </IconButton>
        )}
        {canDismiss && (
          <IconButton label="Dismiss — for you only" danger onClick={() => sendDismissInboxItem(item.id)}>
            <XIcon size={ICON.xs} />
          </IconButton>
        )}
        {menu && <Overflow item={item} onClose={() => setMenu(false)} />}
      </div>
    </>
  );
}
