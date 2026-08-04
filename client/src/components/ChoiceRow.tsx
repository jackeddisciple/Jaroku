// The two or three things worth doing right now, offered instead of guessed at.
//
// Jaroku already asks the user to decide, four times: a plan is waiting to be generated, a plan
// has gone stale, a proposal is waiting to be applied, a step has failed and is selected. Each of
// those was answered in a different place and in a different way. Generate and Apply were buttons
// on a card that may be scrolled a page up the thread; re-planning meant retyping the brief;
// explaining, fixing or re-running a failed step meant knowing that typing "fix this" is a thing
// the composer understands. That last one is the real gap — the routing is discoverable only by
// reading the one-line hint AFTER you have already typed something it recognises.
//
// So the fork comes to the composer. Two or three option-cards inline above the input, saying
// what the reasonable answers are, with the free-text box still there underneath for anything
// that is not one of them.
//
// Nothing here is a new mechanism. Every option dispatches a `send*` call the app already had, or
// the same intent the composer would route a typed phrase to — the cards are a way of naming the
// options, not a second way of performing them. Skip dismisses the row for that fork and leaves
// the composer exactly as it was, because "none of these" has to stay one click away.

import { ICON, TYPE } from "../lib/tokens.ts";

export type Choice = {
  id: string;
  /** The verb. Two words at most — a card that needs a sentence is not an option, it is a form. */
  label: string;
  /** What picking it does, in the words the user would use. */
  hint?: string;
  icon: (p: { size?: number }) => React.ReactElement;
  /** The accent for the icon. Category colours only, never a status. */
  accent?: string;
  /** The one option the fork is really asking about. Gets the ink treatment. */
  primary?: boolean;
  onPick: () => void;
  disabled?: boolean;
  title?: string;
};

export function ChoiceRow({
  question,
  choices,
  onSkip,
}: {
  /** What is being decided, in one line. */
  question: string;
  choices: Choice[];
  onSkip: () => void;
}) {
  return (
    <div className="mb-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <span className={TYPE.sectionLabel}>{question}</span>
        {/* Not a dismiss X in a corner. Declining the offered options is an answer, and it should
            read as one of the things you can do rather than as closing a notification. */}
        <button
          type="button"
          onClick={onSkip}
          className="ml-auto text-[11px] text-faint transition-colors duration-fast hover:text-ink"
          title="Hide these and just type"
        >
          Skip
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {choices.map((c) => {
          const Icon = c.icon;
          return (
            <button
              key={c.id}
              type="button"
              onClick={c.onPick}
              disabled={c.disabled}
              title={c.title}
              className={`group flex min-w-[128px] flex-1 items-start gap-2 rounded-control border px-2.5 py-2 text-left transition-colors duration-fast disabled:cursor-not-allowed disabled:opacity-40 ${
                c.primary
                  ? "border-edge bg-panel hover:bg-active"
                  : "border-hair hover:border-edge hover:bg-active/40"
              }`}
            >
              <span
                className="mt-[1px] shrink-0"
                style={c.accent ? { color: c.accent } : undefined}
                aria-hidden
              >
                <Icon size={ICON.sm} />
              </span>
              <span className="min-w-0">
                <span className={`block text-[12px] ${c.primary ? "font-medium text-ink" : "text-ink"}`}>
                  {c.label}
                </span>
                {c.hint && <span className="mt-0.5 block text-[11px] text-muted">{c.hint}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
