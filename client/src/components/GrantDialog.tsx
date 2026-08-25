// §11 — giving somebody access to one agent, and being honest about what that is.
//
// FOUR THINGS THIS DIALOG DOES THAT A CHECKBOX LIST WOULD NOT.
//
// It shows the capabilities a person's WORKSPACE ROLE cannot hold, disabled, with the reason
// written out — never hidden. §11.1 is explicit and the reasoning is worth restating: hiding them
// produces an admin who concludes the capability does not exist, goes looking for it in the product
// rather than in the person's role, and eventually asks somebody why Jaroku cannot do a thing it
// can. A disabled checkbox saying "secrets exceeds Sam's workspace role — change their role to
// grant it" is a dead end that names its own exit.
//
// It applies the implication rules FROM THE MATRIX rather than from handlers here. Ticking `edit`
// lights `run`; unticking `view` clears everything. Both are consequences of `closeAgentCapabilities`
// and `AGENT_IMPLIES`, which the server applies again when it stores the row — so the set on screen
// and the set that gets written cannot disagree. A pair of onChange handlers implementing the same
// two rules would be a second copy, and the two would drift the first time a capability was added.
//
// It makes expiry a first-class control rather than an advanced option behind a disclosure. A
// time-boxed grant is the correct shape for most of the reasons anybody grants anything —
// a contractor, an incident, a week of cover — and a product where "forever" is the default that
// takes one click and "until Friday" takes four teaches everybody to grant forever.
//
// And it requires a NOTE for deploy, secrets and admin. Six months later "why does this contractor
// have deploy" needs an answer that is not archaeology, and the only moment anybody can write it is
// the moment they know.

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckboxField } from "./Checkbox.tsx";
import { Chip } from "./Chip.tsx";
import { Select } from "./Select.tsx";
import { primaryBtn, quietBtn } from "./buttons.ts";
import { AGENT_CAPABILITIES, agentCeiling, closeAgentCapabilities } from "../lib/capabilities.ts";
import type { AgentCapability } from "../lib/capabilities.ts";
import { STATUS, TYPE } from "../lib/tokens.ts";
import { sendGrantAccess, sendModifyGrant } from "../lib/socket.ts";
import type { AccessPerson } from "../store/accessStore.ts";

/**
 * §11.1's expiry presets, plus "never" and a date somebody picks.
 *
 * MILLISECONDS RATHER THAN LABELS PARSED BACK, because the label is prose and the offset is the
 * value — and the instant is computed HERE, at the moment of sending, rather than travelling as a
 * duration. A duration on the wire is measured from whenever the server happens to process it,
 * which is a different moment from the one the person was looking at.
 */
const PRESETS: { id: string; label: string; ms: number | null }[] = [
  { id: "never", label: "never", ms: null },
  { id: "1h", label: "in 1 hour", ms: 3600_000 },
  { id: "8h", label: "in 8 hours", ms: 8 * 3600_000 },
  { id: "24h", label: "in 24 hours", ms: 24 * 3600_000 },
  { id: "7d", label: "in 7 days", ms: 7 * 24 * 3600_000 },
  { id: "30d", label: "in 30 days", ms: 30 * 24 * 3600_000 },
  { id: "custom", label: "on a date…", ms: null },
];

/** §11.1 — the three that need a stated reason. Mirrors the server's `NOTE_REQUIRED`. */
const NOTE_REQUIRED: readonly AgentCapability[] = ["deploy", "secrets", "admin"];

export interface GrantTarget {
  user_id: string;
  display_name: string | null;
  email: string;
  role: string | null;
}

export function GrantDialog({
  agentId,
  agentSlug,
  /** Present when editing an existing grant — §11.2's "same dialog, pre-populated". */
  editing,
  /** Everybody who could be granted. Filtered to those without a grant when creating. */
  candidates,
  onClose,
}: {
  agentId: string;
  agentSlug: string;
  editing: AccessPerson | null;
  candidates: readonly GrantTarget[];
  onClose: () => void;
}) {
  const [userId, setUserId] = useState(editing?.user_id ?? candidates[0]?.user_id ?? "");
  const [chosen, setChosen] = useState<Set<AgentCapability>>(
    () => closeAgentCapabilities(editing?.granted ?? ["view"]),
  );
  const [preset, setPreset] = useState(editing?.expires_at ? "custom" : "never");
  const [customDate, setCustomDate] = useState(editing?.expires_at?.slice(0, 10) ?? "");
  const [note, setNote] = useState(editing?.note ?? "");

  const target = useMemo(
    () => candidates.find((c) => c.user_id === userId) ?? null,
    [candidates, userId],
  );
  // THE CEILING IS THE TARGET'S, NOT THE VIEWER'S. An admin granting to a member is bounded by the
  // MEMBER's role — invariant B — so the dialog has to resolve it for whoever is selected and
  // re-resolve it when the selection changes.
  const ceiling = useMemo(() => agentCeiling(target?.role ?? null), [target]);

  /**
   * §17's FOCUS TRAP, and Escape.
   *
   * A REAL TRAP RATHER THAN `autoFocus` ALONE. Tabbing out of a modal into the page behind it is
   * the failure that makes a dialog unusable with a keyboard: focus lands on controls the overlay
   * is covering, and nothing on screen moves when they are activated. Escape closes, which is safe
   * here in a way it is not for `McpConfirmModal` — nothing is blocked waiting on this answer.
   */
  const surface = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = surface.current;
    if (!node) return;
    const focusable = (): HTMLElement[] =>
      [...node.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )].filter((el) => !el.hasAttribute("disabled"));
    focusable()[0]?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !node.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    node.addEventListener("keydown", onKey);
    return () => node.removeEventListener("keydown", onKey);
  }, [onClose]);

  /**
   * Ticking and unticking, with the matrix deciding the consequences.
   *
   * TICKING CLOSES UPWARD — `edit` brings `run` and `run` brings `view`, because a set that did not
   * would be one the server closes on arrival, leaving the dialog having shown something narrower
   * than what it wrote.
   *
   * UNTICKING `view` CLEARS EVERYTHING, which §11.1 asks for and which falls straight out of the
   * same table: every other capability implies `view`, so no capability can survive its removal. It
   * is computed rather than special-cased, so the day a capability stops implying `view` this stops
   * clearing it without anybody remembering this handler exists.
   */
  const toggle = (capability: AgentCapability): void => {
    setChosen((current) => {
      if (current.has(capability)) {
        const without = [...current].filter((c) => c !== capability);
        return closeAgentCapabilities(without.filter((c) => !closeAgentCapabilities([c]).has(capability)));
      }
      return closeAgentCapabilities([...current, capability]);
    });
  };

  const asked = [...chosen].filter((c) => ceiling.has(c));
  const needsNote = asked.some((c) => NOTE_REQUIRED.includes(c));
  const noteMissing = needsNote && note.trim() === "";
  const dateMissing = preset === "custom" && !customDate;
  const canSubmit = Boolean(userId) && !noteMissing && !dateMissing;

  const expiresAt = (): string | null => {
    if (preset === "never") return null;
    if (preset === "custom") return customDate ? new Date(`${customDate}T23:59:59.000Z`).toISOString() : null;
    const ms = PRESETS.find((p) => p.id === preset)?.ms ?? null;
    return ms === null ? null : new Date(Date.now() + ms).toISOString();
  };

  const submit = (): void => {
    const payload = {
      agentId,
      userId,
      capabilities: asked,
      expiresAt: expiresAt(),
      note: note.trim() || null,
    };
    // TWO COMMANDS FOR ONE ROW, and the difference is the audit entry rather than the write. See
    // `GrantAccessCommand` — `access.granted` and `access.modified` answer different questions six
    // months later, and deriving which to write from whether a row existed would be the server
    // guessing at intent.
    if (editing) sendModifyGrant(payload);
    else sendGrantAccess(payload);
    onClose();
  };

  const who = target ? target.display_name || target.email : "them";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={editing ? `Edit access to ${agentSlug}` : `Grant access to ${agentSlug}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/35 px-4"
    >
      <div ref={surface} className="w-full max-w-lg rounded-modal border border-edge bg-elevated p-4 shadow-overlay">
        <div className={TYPE.sectionLabel}>
          {editing ? "Edit access" : "Grant access"} · {agentSlug}
        </div>

        {/* §11.1's person selector. Absent when editing: the row is fixed, and a dropdown that
            could change WHO a grant is about would turn an edit into a silent re-grant of somebody
            else. */}
        {editing ? (
          <p className="mt-2 text-caption text-ink">
            {who}
            {target?.role && <span className="ml-2 text-tiny text-faint">{target.role}</span>}
          </p>
        ) : (
          <label className="mt-2 block">
            <span className="text-tiny text-muted">Person</span>
            <Select
              value={userId}
              onChange={setUserId}
              ariaLabel="Person to grant access to"
              options={candidates.map((c) => ({
                value: c.user_id,
                // THE ROLE IS BESIDE THE NAME because it decides the ceiling, and an admin picking
                // a person without seeing it is about to be surprised by which boxes are disabled.
                label: `${c.display_name || c.email}${c.role ? ` · ${c.role}` : ""}`,
              }))}
            />
          </label>
        )}

        <fieldset className="mt-3">
          <legend className="text-tiny text-muted">Capabilities</legend>
          <div className="mt-1 space-y-1">
            {AGENT_CAPABILITIES.map((capability) => {
              const overCeiling = !ceiling.has(capability);
              const reasonId = `ceiling-${capability}`;
              return (
                <div key={capability}>
                  <CheckboxField
                    checked={chosen.has(capability) && !overCeiling}
                    // DISABLED WITH A STATED REASON, NEVER HIDDEN — §11.1. See this file's header.
                    disabled={overCeiling}
                    onChange={() => toggle(capability)}
                    describedBy={overCeiling ? reasonId : undefined}
                  >
                    {capability}
                  </CheckboxField>
                  {overCeiling && (
                    // §17 — the reason is a real element the checkbox points at with
                    // `aria-describedby`, not a `title`. A tooltip is unreachable by keyboard, which
                    // is precisely how somebody arrives at a control they cannot use.
                    <p id={reasonId} className="ml-6 text-tiny" style={{ color: STATUS.error }}>
                      {capability} exceeds {who}
                      {target?.role ? `'s ${target.role} role` : "'s workspace role"} — change their
                      role to grant it
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>

        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="text-tiny text-muted">Expires</span>
            <Select
              value={preset}
              onChange={setPreset}
              ariaLabel="When this grant expires"
              options={PRESETS.map((p) => ({ value: p.id, label: p.label }))}
            />
          </label>
          {preset === "custom" && (
            <input
              type="date"
              value={customDate}
              onChange={(e) => setCustomDate(e.target.value)}
              aria-label="Expiry date"
              className="rounded-control border border-hair bg-void px-2 py-1.5 text-caption text-ink outline-none focus-visible:shadow-focusring"
            />
          )}
        </div>

        <label className="mt-3 block">
          <span className="text-tiny text-muted">
            Note{needsNote && <span style={{ color: STATUS.error }}> · required for {asked.filter((c) => NOTE_REQUIRED.includes(c)).join(", ")}</span>}
          </span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="why they need this"
            aria-label="Why this grant exists"
            className="mt-1 w-full rounded-control border border-hair bg-void px-2.5 py-1.5 text-caption text-ink placeholder:text-faint outline-none focus-visible:shadow-focusring focus:border-edge"
          />
        </label>

        {/* WHAT IS ACTUALLY ABOUT TO BE WRITTEN, as chips, because the closure means the set is not
            simply the boxes somebody ticked. Somebody who ticked `edit` and is about to grant three
            capabilities should see three. */}
        <div className="mt-3 flex flex-wrap items-center gap-1">
          <span className="text-tiny text-faint">Grants:</span>
          {asked.length === 0 ? (
            <span className="text-tiny text-faint">nothing — they will not be able to see this agent</span>
          ) : (
            asked.map((c) => (
              <Chip key={c} size="sm" tone="ink">
                {c}
              </Chip>
            ))
          )}
        </div>

        <div className="mt-4 flex items-center gap-2">
          <button onClick={submit} disabled={!canSubmit} className={primaryBtn}>
            {editing ? "Save" : "Grant"}
          </button>
          <button onClick={onClose} className={quietBtn}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
