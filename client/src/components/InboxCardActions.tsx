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

import { useEffect, useState } from "react";
import {
  ACTION_LABEL,
  FORM_ACTIONS,
  useAllowedActions,
  runAction,
  submitCeiling,
  submitCredential,
} from "./InboxActions.tsx";
import { actionIconFor } from "./inboxActionIcons.tsx";
import { sendDismissInboxItem, sendResolveInboxItem, sendSnoozeInboxItem } from "../lib/socket.ts";
import { useInboxStore } from "../store/inboxStore.ts";
import { useSecretsStore } from "../store/secretsStore.ts";
import { fetchElevation } from "../lib/secrets.ts";
import { useUiStore } from "../store/uiStore.ts";
import { ICON } from "../lib/tokens.ts";
import type { InboxActionName, InboxItemView, SnoozeDuration } from "../types.ts";
import { Icon } from "../lib/icons/registry.ts";
import { IconButton } from "./IconButton.tsx";

/** §3's three durations, in the order the menu lists them. LABELS, because a duration is a word. */
const SNOOZE_CHOICES: { id: SnoozeDuration; label: string }[] = [
  { id: "hour", label: "1 hour" },
  { id: "tomorrow", label: "Tomorrow" },
  { id: "week", label: "Next week" },
];


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
  // WHETHER THIS CAN SUCCEED, ASKED BEFORE THE SECRET IS SENT RATHER THAN AFTER.
  //
  // Save was enabled the moment the field was non-empty, so typing a credential and pressing it
  // POSTed the value, got a 403, and only then rendered "this needs an unlocked Secrets session"
  // beside the button. The error was reported clearly and in the right place — the defect was
  // entirely that the precondition was discovered by transmitting the thing it guards. This is the
  // one place in the app where a precondition was found by failing rather than by being told; every
  // other disabled control here carries its reason ("Select an agent to deploy", "This plan no
  // longer matches the selected connectors").
  const elevated = useSecretsStore((s) => s.elevated);
  const gateLoaded = useSecretsStore((s) => s.gateLoaded);

  const credential = typeof item.payload["credential"] === "string" ? (item.payload["credential"] as string) : "";
  const isCeiling = action === "raise_ceiling";
  const label = isCeiling ? "New ceiling in dollars" : credential || "Credential value";

  // ASKED ONCE, HERE, rather than assumed to be known. The gate state is polled by `SecretsPanel`,
  // which is mounted only while the Secrets tab is the one showing — and this form is on the Inbox,
  // where it usually is not. One request, and only for a credential card.
  useEffect(() => {
    if (isCeiling || gateLoaded) return;
    void (async () => {
      try {
        useSecretsStore.getState().setElevation(await fetchElevation());
      } catch {
        // A gate state that could not be read leaves the button enabled and the server as the
        // authority, which is the behaviour this replaces — never a control disabled by a failed
        // request, which would be a form nobody can submit for a reason nobody can see.
      }
    })();
  }, [isCeiling, gateLoaded]);

  // Only once the answer is IN. An unknown gate must not disable anything: `gateLoaded` false means
  // the question has not been answered yet, not that the vault is locked.
  const locked = !isCeiling && gateLoaded && !elevated;
  const lockedReason = "this needs an unlocked Secrets session";

  const submit = async (): Promise<void> => {
    if (!value.trim() || busy || locked) return;
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
    return <div className="ml-6 mt-2 text-tiny text-muted">Sent. This card leaves when it takes effect.</div>;
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
          className="min-w-0 flex-1 bg-transparent text-caption text-ink placeholder:text-faint outline-none focus-visible:shadow-focusring"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !value.trim() || locked}
          // `disabled:pointer-events-none` means a disabled button shows no tooltip, so the reason
          // goes on the wrapper. The sentence under the field says it in full — a title alone is
          // unreachable by keyboard, which is exactly how somebody arrives at a control they cannot
          // use.
          title={locked ? lockedReason : undefined}
          className="shrink-0 rounded-control px-2 py-0.5 text-tiny text-muted transition-colors hover:bg-active active:bg-chrome hover:text-ink disabled:pointer-events-none disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {locked && (
        // THE PRECONDITION AND THE WAY OUT OF IT, in the same line. A disabled control cannot also
        // be its own fix, which is the argument the model selector's "Add key" already makes — so
        // the unlock lives beside it and carries somebody to the tab that owns the passcode.
        <div className="mt-1 text-tiny text-faint">
          {lockedReason} —{" "}
          <button
            type="button"
            onClick={() => {
              useUiStore.getState().setRightTab("secrets");
              useUiStore.getState().closeNav();
            }}
            className="text-muted underline-offset-2 transition-colors hover:text-ink hover:underline"
          >
            unlock Secrets
          </button>
        </div>
      )}
      {error && <div className="mt-1 text-tiny text-err">{error}</div>}
      {!isCeiling && (
        // WHAT THIS DOES WITH THE VALUE, said before it is typed rather than after. It is the same
        // guarded route the Secrets tab posts to, which is the whole of §6.4's reuse rule at the one
        // place it touches a credential.
        <div className="mt-1 text-tiny text-faint">
          Stored in this workspace&rsquo;s vault, the same way the Secrets tab stores one.
        </div>
      )}
    </div>
  );
}

/**
 * The snooze durations.
 *
 * §7 IS EXPLICIT THAT THESE KEEP THEIR WORDS — "labels stay where a label genuinely carries
 * meaning", and "1 hour" is not a glyph. Only the control that OPENS this became a mark; what it
 * opens is five spans of time, and there is no icon for tomorrow.
 */
function SnoozeMenu({ item, onClose }: { item: InboxItemView; onClose: () => void }) {
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="absolute right-0 top-6 z-30 mt-1 w-[184px] animate-slide-in overflow-hidden rounded-card border border-edge bg-elevated p-1 shadow-floating motion-reduce:animate-none"
    >
      {SNOOZE_CHOICES.map((choice) => (
        <button
          key={choice.id}
          onClick={() => {
            sendSnoozeInboxItem(item.id, choice.id);
            onClose();
          }}
          className="block w-full px-3 py-1.5 text-left text-caption text-muted transition-colors hover:bg-active active:bg-chrome hover:text-ink"
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}

/** The overflow (§4.4): every action that is not the primary one. */
function Overflow({ item, onClose }: { item: InboxItemView; onClose: () => void }) {
  // The same filter the row above applies, for the same reason: an overflow offering a fix that
  // 403s is worse than one that is a line shorter.
  const secondary = useAllowedActions(item.actions).slice(1).filter((a) => a !== "dismiss");

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      // CLASSES, LIKE THE OTHER TEN MENUS. This one was built with inline styles, and its
      // `boxShadow` was a byte-identical copy of `ELEVATION.floating` written out by hand — a
      // token that would silently stop matching the moment the token changed, on the one surface
      // where "does this look like the other menus" is the whole question.
      className="absolute right-0 top-6 z-30 mt-1 w-[184px] animate-slide-in overflow-hidden rounded-card border border-edge bg-elevated p-1 shadow-floating motion-reduce:animate-none"
    >
      {(
        <>
          {secondary.map((action) => (
            <button
              key={action}
              onClick={() => {
                // THE ANSWER IS READ NOW. It used to be discarded, so a menu that closed was the
                // only feedback either way — and on a board whose sweep resolves cards on its own
                // schedule, "nothing visible happened" is indistinguishable from "it worked and the
                // list will catch up". `runAction` returns false when a payload was missing what
                // the command needed, which is a card that cannot be fixed from here rather than a
                // command that failed, so the honest answer is to leave the menu open and say so
                // rather than to close it as though something had been done.
                if (runAction(action, item)) onClose();
                else useInboxStore.getState().setError(`${ACTION_LABEL[action]} — this card is missing what that needs`);
              }}
              className="block w-full px-3 py-1.5 text-left text-caption text-muted transition-colors hover:bg-active active:bg-chrome hover:text-ink"
            >
              {ACTION_LABEL[action]}
            </button>
          ))}
        </>
      )}
    </div>
  );
}

export function InboxCardActions({ item, expanded }: { item: InboxItemView; expanded: boolean }) {
  const [menu, setMenu] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  /**
   * §8 ON THE INBOX. Every card offers a fix and the fixes come from five subsystems, so an
   * action's capability is a property of the action rather than of the card — see `ACTION_COMMAND`.
   *
   * FILTERED BEFORE `primary` IS CHOSEN, which is the part that matters: the registry orders each
   * card's actions by usefulness and the first is the one that gets the button. Filtering
   * afterwards would leave a member looking at a card whose primary control is missing and whose
   * second-best fix is buried in a kebab — the card would still be actionable and would not look
   * it. Taking the first action they CAN take is what keeps the board clearable at every role.
   */
  const offered = useAllowedActions(item.actions);
  const primary = offered[0];
  const canDismiss = offered.includes("dismiss");
  // §4.3: a blocking card shows its inline form WITHOUT expanding. That is what "large" buys.
  const showForm =
    primary !== undefined && FORM_ACTIONS.has(primary) && (expanded || item.severity === "blocking");

  return (
    <>
      {showForm && primary && <InlineForm item={item} action={primary} />}

      <div className="relative mt-1.5 flex items-center justify-end gap-0.5">
        {primary && !FORM_ACTIONS.has(primary) && (
          <IconButton
            icon={actionIconFor(primary)}
            label={ACTION_LABEL[primary]}
            size={ICON.xs}
            stopPropagation
            onClick={() => {
              // Same rule as the overflow's: a card's most prominent control saying nothing is the
              // failure this whole pass is about, and a refusal here means the payload lacked what
              // the command needed rather than that the command failed.
              if (!runAction(primary, item)) {
                useInboxStore.getState().setError(`${ACTION_LABEL[primary]} — this card is missing what that needs`);
              }
            }}
          />
        )}
        {offered.length > 1 && (
          <IconButton
            icon={Icon.agents.more}
            label="More actions"
            size={ICON.xs}
            stopPropagation
            onClick={() => setMenu((m) => !m)}
          />
        )}

        {/* §6'S THREE CARD ACTIONS, TOGETHER AND ICON-ONLY. Archive and snooze were rows in the
            overflow; they are here because the specification groups them with dismiss as one trio,
            and because a card's three universal verbs should not need a menu opened to reach two of
            them. They are NOT duplicated — the overflow lost both rows in the same change, so each
            still happens in exactly one place. */}
        <IconButton
          icon={Icon.inboxCard.archive}
          label="Mark as done"
          size={ICON.xs}
          stopPropagation
          onClick={() => { sendResolveInboxItem(item.id); }}
        />
        <IconButton
          icon={Icon.inboxCard.snooze}
          label="Snooze"
          size={ICON.xs}
          stopPropagation
          onClick={() => setSnoozing((v) => !v)}
        />
        {/* D2: AN X CLOSES A SURFACE. The specification printed `cancel-01` on the Inbox LANE
            and `x` here, six inches apart, for one verb. Both are the x now. */}
        {canDismiss && (
          <IconButton
            icon={Icon.inboxCard.dismiss}
            label="Dismiss — for you only"
            danger
            size={ICON.xs}
            stopPropagation
            onClick={() => sendDismissInboxItem(item.id)}
          />
        )}
        {snoozing && <SnoozeMenu item={item} onClose={() => setSnoozing(false)} />}
        {menu && <Overflow item={item} onClose={() => setMenu(false)} />}
      </div>
    </>
  );
}
