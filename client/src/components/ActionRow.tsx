// One line of an agent's narrative: it did this, to that, and here is how it went.
//
// The app describes sequences of actions in four places and each one wrote its own row. The
// trace timeline: a seq number, a type badge, a name, and a run-on `1,204 tok · $0.0031 · 820 ms`
// string. The plan card: an icon, a name and a description sharing one flex line. The generation
// list: a type glyph, a path, a byte count. The graph steps: a numbered bullet and a sentence.
// Same four slots every time, arranged differently, aligned differently, and only one of them
// actually said what the agent *did* — the others left you to infer the verb from a type name.
//
// So: icon, verb, object, trailing. Every row, every panel, in that order.
//
// The verb is the part that was missing. "llm_call · answer" is a schema field and a node name;
// "Generated answer" is a sentence about something that happened. The vocabulary comes from
// lib/actionIcons.tsx so the words and the mark can never disagree.
//
// Two sizing rules are load-bearing, and the naive version of each is wrong.
//
// Verb, object and detail share ONE flowing container rather than competing for the row. Making
// the object shrink-0 protects it but then a 60-character tool name squeezes the description to
// zero width and it vanishes silently — the row loses information rather than running out of
// room. Here the detail wraps under a long object instead, and the object only breaks internally
// when it genuinely cannot fit a line by itself.
//
// The icon and trailing slots are fixed-width and OUTSIDE that flow, so the timing column stays
// aligned however tall a row grows. A column of rows whose right edge moves is a column you
// read one row at a time.

import { actionFor, type ActionDescriptor, type ActionKind } from "../lib/actionIcons.tsx";
import { ICON, STATUS } from "../lib/tokens.ts";

/**
 * How the action is going.
 *
 * `active` is the only one that changes the words — a live row says "Calling", a settled one
 * says "Called". The rest change the icon's colour and nothing else, because a row that
 * rewrites its own sentence when it finishes is a row you have to re-read.
 */
export type ActionState = "pending" | "active" | "done" | "error";

const STATE_COLOR: Partial<Record<ActionState, string>> = {
  pending: STATUS.neutral,
  error: STATUS.error,
};

export type ActionRowProps = {
  /** The action, by name. Ignored when `action` is given. */
  kind?: ActionKind;
  /** The action, already resolved — for callers that adjust the descriptor (a file's own icon). */
  action?: ActionDescriptor;
  state?: ActionState;
  /** Override the vocabulary's verb. For a row whose action has no entry worth adding. */
  verb?: string;
  /** Say nothing before the object. For a row whose object is already a sentence. */
  hideVerb?: boolean;
  /** What it acted on — a tool name, a file path, a node. Usually a mono chip. */
  object?: React.ReactNode;
  /** Marks that qualify the object: MCP provenance, high impact. Stay next to it. */
  badges?: React.ReactNode;
  /** Prose after the object. Wraps under it rather than being squeezed out of existence. */
  detail?: React.ReactNode;
  /**
   * A fixed-width gutter before the icon — the trace's seq number, a plan step's ordinal.
   * Fixed so the icon column does not move when a number gains a digit.
   */
  lead?: React.ReactNode;
  /** Timing, cost, a status mark. Right-aligned, and never allowed to wrap. */
  trailing?: React.ReactNode;
  /** Revealed under the row: a diff's hunks, a step's payload. Indented to the object column. */
  children?: React.ReactNode;
  onClick?: () => void;
  selected?: boolean;
  title?: string;
  className?: string;
};

export function ActionRow({
  kind,
  action,
  state = "done",
  verb,
  hideVerb = false,
  object,
  badges,
  detail,
  lead,
  trailing,
  children,
  onClick,
  selected = false,
  title,
  className = "",
}: ActionRowProps) {
  const descriptor = action ?? actionFor(kind ?? "update");
  const { Icon } = descriptor;
  const word = verb ?? (state === "active" ? descriptor.verbing : descriptor.verb);
  // The action's own accent, unless the state overrides it. A failed call is red before it is
  // green — what went wrong outranks what kind of thing it was.
  const iconColor = STATE_COLOR[state] ?? descriptor.accent;

  return (
    <div className={className}>
      <div
        className={`flex items-start gap-2 ${
          onClick ? "cursor-pointer select-none rounded-control transition-colors duration-fast" : ""
        } ${selected ? "bg-active" : onClick ? "hover:bg-active/40" : ""}`}
        onClick={onClick}
        title={title}
      >
        {lead !== undefined && (
          <span className="shrink-0 flex h-[19px] items-center tabular-nums text-faint">{lead}</span>
        )}
        {/* Fixed height rather than fixed alignment, so a one-line row and a wrapped one put
            their icon at the same distance from the top of the text. */}
        <span
          className="shrink-0 flex h-[19px] items-center"
          style={{ color: iconColor }}
          aria-hidden
        >
          <Icon size={ICON.sm} />
        </span>

        <span className="min-w-0 flex-1 text-[12px]">
          {!hideVerb && <span className="text-muted">{word} </span>}
          {object}
          {badges && <span className="ml-1.5 inline-flex items-center gap-1 align-middle">{badges}</span>}
          {detail && <span className="ml-1.5 text-muted">{detail}</span>}
        </span>

        {trailing !== undefined && (
          <span className="shrink-0 flex h-[19px] items-center gap-2 whitespace-nowrap pl-1 text-[11px] tabular-nums">
            {trailing}
          </span>
        )}
      </div>
      {/* Indented to the object column, not to the row — nested content belongs under the thing
          it describes, not under the mark that classifies it. */}
      {children && <div className="pl-[22px]">{children}</div>}
    </div>
  );
}
