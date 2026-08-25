// A control that cannot be used, and the sentence saying why.
//
// Jaroku's refusal language is specific on purpose. The stdout guard names the file and the line.
// A plan refusal names the rule it broke. §3.6's validation refusal names the missing symbol and
// then says the agent is unchanged. Every one of them tells you the exact thing that is wrong
// rather than failing quietly — and a greyed-out button with no explanation breaks that pattern
// the moment it appears, because "why can't I click this" is precisely the silent failure the rest
// of the product goes out of its way to avoid.
//
// THE RULE: any control that can be disabled renders a one-line reason IN ITS PLACE, not just a
// lowered opacity. Under the control, in the muted caption weight EmptyState already uses for
// secondary text.
//
// AND THE DISTINCTION THAT MAKES IT WORTH A COMPONENT. There are two kinds of disabled, and they
// want different things from the reader:
//
//   MISSING INPUT — "Stage a file to enable commit." The fix is here, in front of them, and the
//   sentence is the whole of the help.
//
//   A BLOCKING CONDITION SOMEWHERE ELSE — "Commit blocked — a run is using this agent's files."
//   The fix is in another panel, and a sentence that names it without offering a way there is a
//   sentence that ends in the user hunting. So this kind takes an `onReveal`, becomes clickable,
//   and jumps to the thing causing it — the same way §3.6's refusal links to [View diff].
//
// A control with no reason is not disabled by this component. Passing `reason: null` renders it
// enabled, which is what makes the call site read as one expression rather than as a conditional
// wrapped around a button.

export interface DisabledState {
  /** The one-line reason, or null when the control is usable. */
  reason: string | null;
  /**
   * Where the blocking condition lives, when it lives somewhere else.
   *
   * Present makes the reason a link. Absent means the fix is here — see the header — and a link to
   * nowhere would be worse than prose.
   */
  onReveal?: () => void;
}

/** Usable. A named constant so a call site reads as a decision rather than as an empty object. */
export const ENABLED: DisabledState = { reason: null };

/**
 * The first reason that applies, or ENABLED.
 *
 * ORDER IS PRECEDENCE, and the caller decides it. A control can be blocked by two things at once —
 * nothing staged AND a run in flight — and showing both would be two sentences where the user can
 * only act on one. The first is the one they can do something about soonest, which is the caller's
 * judgement to make and not this function's.
 */
export function firstReason(...states: (DisabledState | false | null | undefined)[]): DisabledState {
  for (const state of states) {
    if (state && state.reason) return state;
  }
  return ENABLED;
}

export function DisabledReason({
  state,
  children,
  /** Keeps the reason's column aligned with the control above it in a row of two. */
  className = "",
}: {
  state: DisabledState;
  /** The control. Rendered as given; this component never styles it. */
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`inline-flex flex-col items-start gap-1 ${className}`}>
      {children}
      {state.reason && (
        state.onReveal ? (
          // Clickable, because the cause is elsewhere and naming it without a way there ends in a
          // hunt. Underlined on hover rather than always, so a column of reasons does not read as
          // a list of links.
          <button
            type="button"
            onClick={state.onReveal}
            className="max-w-[22ch] text-left text-tiny leading-[1.4] text-muted underline-offset-2 transition-colors duration-fast hover:text-ink hover:underline"
          >
            {state.reason}
          </button>
        ) : (
          <span className="max-w-[22ch] text-tiny leading-[1.4] text-faint">{state.reason}</span>
        )
      )}
    </div>
  );
}
