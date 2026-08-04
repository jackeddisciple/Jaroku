// The MCP marker, in one place.
//
// It appears in the plan card, the graph view, the trace timeline and the step detail panel,
// and it has to be the SAME mark in all four — a badge whose job is "this came from code
// nobody reviewed" fails the moment a user has to learn two versions of it. One component,
// two sizes, one colour.
//
// The colour is ACCENT.mcp, chosen for distance from every other accent and every status
// colour: this is the one badge that must never be mistaken for "reviewed" teal or "pending"
// amber. It is deliberately not red, because MCP is not an error and crying wolf on every
// external tool teaches people to stop looking.

import { ACCENT, ICON, STATUS } from "../lib/tokens.ts";
import { Chip } from "./Chip.tsx";
import { PlugIcon, ShieldAlertIcon } from "./panelIcons.tsx";

/**
 * `full` carries the word, for places with room to explain — a plan card row, a step detail
 * header. `compact` is the icon alone, for a dense trace row or a graph card where a word
 * would push out the thing it describes.
 */
export function McpBadge({
  variant = "full",
  title,
}: {
  variant?: "full" | "compact";
  title?: string;
}) {
  const label = title ?? "From an MCP server — third-party code Jaroku has not reviewed";
  if (variant === "compact") {
    return (
      <span
        className="inline-flex shrink-0 items-center"
        style={{ color: ACCENT.mcp }}
        title={label}
        aria-label="MCP tool"
      >
        <PlugIcon size={ICON.xs} />
      </span>
    );
  }
  return (
    // Chip geometry, so this badge and the "high impact" one beside it and the "approved" one in
    // the card above are all one size. Only the colour and the word are this component's own.
    <Chip
      caps
      size="sm"
      variant="outline"
      color={ACCENT.mcp}
      title={label}
      className="shrink-0"
      icon={<PlugIcon size={ICON.xs} />}
    >
      MCP
    </Chip>
  );
}

/**
 * The high-impact mark, which answers a different question: not where a tool came from, but
 * whether running it will stop and ask. Separate from McpBadge because a tool can be
 * external and read-only, and conflating the two would make every MCP tool look alarming.
 */
export function HighImpactBadge({ reason }: { reason?: string }) {
  return (
    <Chip
      caps
      size="sm"
      variant="outline"
      color={STATUS.pending}
      className="shrink-0"
      icon={<ShieldAlertIcon size={ICON.xs} />}
      title={
        reason
          ? `Asks for your confirmation before its first call — ${reason}`
          : "Asks for your confirmation before its first call"
      }
    >
      confirms
    </Chip>
  );
}
