// Iconography for the Graph View (n8n-style restyle). Two families:
//   • Flow icons — monochrome line/solid marks for the main-path node kinds (trigger, agent,
//     tool, action, terminal). They inherit `currentColor`, so the node sets the accent.
//   • Brand icons — full-colour connector/provider logos shown inside the circular resource
//     nodes (Postgres, Gmail, Slack, Anthropic, …). These are self-coloured, recognizable
//     reconstructions (no external assets — the canvas CSP forbids remote images).
//
// The app's single-stroke-weight rule governs the FIRST family and deliberately not the second.
// A logo is a reproduction of somebody else's mark, and redrawing Slack's pinwheel or the Claude
// sunburst at our stroke weight would make them wrong rather than consistent. What the rule does
// cover is everything generic — the globe, the sparkle, the hex nut, the plug — because those are
// icons that happen to sit in a resource circle, and they are the ones that looked imported.
//
// Everything here is presentation-only; mappers turn a tool file path or a provider id into the
// right brand mark + a human label.

import type { ReactElement } from "react";
import { ACCENT, TEXT } from "../lib/tokens.ts";
import { PlugIcon, svg } from "./panelIcons.tsx";

type IconProps = { size?: number };

/* ─────────────────────────── Flow (main-path) icons ─────────────────────────── */
//
// Drawn through panelIcons' shared svg() factory, at the one stroke weight, like every other
// icon in the app. They used to be a mix: two solid fills and two strokes at 1.7, in a canvas
// that also renders the plug and wrench from the trace panel's set — so a graph read as though
// its icons had been collected from three places over three years, which is exactly what had
// happened. The shapes are unchanged; only the treatment is.

export function TriggerIcon({ size = 20 }: IconProps) {
  // lucide:zap — "this starts the run"
  return svg(
    { size },
    <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />,
  );
}

export function AgentIcon({ size = 22 }: IconProps) {
  // lucide:bot — a friendly robot head
  return svg(
    { size },
    <>
      <rect x="4" y="8" width="16" height="11" rx="3" />
      <path d="M12 4.5 v3" />
      <circle cx="12" cy="4" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="9" cy="13" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="13" r="1.2" fill="currentColor" stroke="none" />
      <path d="M9.5 16.3 h5" />
      <path d="M4 12 H2.6 M20 12 h1.4" />
    </>,
  );
}

export function ToolIcon({ size = 20 }: IconProps) {
  // lucide:wrench — the same wrench the plan card's tool sections use.
  return svg(
    { size },
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />,
  );
}

export function ActionIcon({ size = 20 }: IconProps) {
  // generic "do something" — a play-into-tray glyph
  return svg(
    { size },
    <>
      <path d="M5 12h9" />
      <path d="M11 8l4 4-4 4" />
      <path d="M17 5v14" />
    </>,
  );
}

export function TerminalIcon({ size = 18 }: IconProps) {
  // lucide:square — the run stops here
  return svg({ size }, <rect x="5" y="5" width="14" height="14" rx="3" />);
}

/* ─────────────────────────── Brand (resource) icons ─────────────────────────── */

export function PostgresIcon({ size = 30 }: IconProps) {
  // Postgres "Slonik" — a blue elephant head, simplified but recognizable.
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <g fill="#8FB7DA">
        <path d="M6.5 12.5c-3-1-3.4 5.2 1 6 1.6.3 1.9-4.8-1-6z" />
        <path d="M25.5 12.5c3-1 3.4 5.2-1 6-1.6.3-1.9-4.8 1-6z" />
        <path d="M16 5.5c-6 0-9 3.8-9 9 0 6 4 10 9 10 2.8 0 3.8-1.9 3.8-3.9v4.6c0 1.2 1 2 2 1.3 1.1-.8.8-2.7.6-4.2 2.3-1.4 3.6-4.2 3.6-7.6 0-5.2-3-9-9.6-9z" />
      </g>
      <circle cx="12.6" cy="12.4" r="1.5" fill="#0b0b0f" />
      <path d="M18 23.5c1.2-.4 2.2-1.2 2.8-2.2" stroke="#0b0b0f" strokeOpacity="0.4" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

export function SlackIcon({ size = 26 }: IconProps) {
  // 4-colour pinwheel — Slack's signature mark.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect x="8.2" y="3.4" width="7.6" height="4.4" rx="2.2" fill="#2EB67D" />
      <rect x="16.2" y="8.2" width="4.4" height="7.6" rx="2.2" fill="#ECB22E" />
      <rect x="8.2" y="16.2" width="7.6" height="4.4" rx="2.2" fill="#E01E5A" />
      <rect x="3.4" y="8.2" width="4.4" height="7.6" rx="2.2" fill="#36C5F0" />
      <rect x="3.4" y="3.4" width="4.4" height="4.4" rx="2.2" fill="#36C5F0" />
      <rect x="16.2" y="3.4" width="4.4" height="4.4" rx="2.2" fill="#2EB67D" />
      <rect x="16.2" y="16.2" width="4.4" height="4.4" rx="2.2" fill="#ECB22E" />
      <rect x="3.4" y="16.2" width="4.4" height="4.4" rx="2.2" fill="#E01E5A" />
    </svg>
  );
}

export function GmailIcon({ size = 26 }: IconProps) {
  // white envelope with the red "M" — recognizable Gmail.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect x="2.5" y="5" width="19" height="14" rx="2.4" fill="#ffffff" />
      <path d="M3.6 6.2 L12 12.6 L20.4 6.2" fill="none" stroke="#EA4335" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
      <path d="M3 6.5 v11 h2.4 V10.2" fill="none" stroke="#4285F4" strokeWidth="0" />
      <path d="M5.4 18 V10 L4 9 H3.2 A0.7.7 0 0 0 2.5 9.7 V17.3 A0.7.7 0 0 0 3.2 18 Z" fill="#C5221F" />
      <path d="M18.6 18 V10 L20 9 h.8 A0.7.7 0 0 1 21.5 9.7 V17.3 A0.7.7 0 0 1 20.8 18 Z" fill="#C5221F" />
    </svg>
  );
}

export function GoogleCalendarIcon({ size = 26 }: IconProps) {
  // The white card with the four-colour edge and a date on it. Deliberately NOT the Gmail
  // envelope tinted differently: the two connectors are separate connections under one OAuth app,
  // and a workspace that has both needs to tell at a glance which row it is about to disconnect.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect x="3" y="4.5" width="18" height="15" rx="2.4" fill="#ffffff" />
      <path d="M3 7.5 A2.4 2.4 0 0 1 5.4 4.5 H9 v3 z" fill="#4285F4" />
      <path d="M9 4.5 h6 v3 H9 z" fill="#EA4335" />
      <path d="M15 4.5 h3.6 A2.4 2.4 0 0 1 21 7.5 H15 z" fill="#FBBC04" />
      <path d="M3 16.5 h6 v3 H5.4 A2.4 2.4 0 0 1 3 17.1 z" fill="#34A853" />
      <text
        x="12"
        y="15.4"
        textAnchor="middle"
        fontSize="7.5"
        fontWeight="600"
        fill="#3C4043"
        fontFamily="Helvetica, Arial, sans-serif"
      >
        31
      </text>
    </svg>
  );
}

export function StripeIcon({ size = 26 }: IconProps) {
  // The wordmark's S on Stripe's own #635BFF. A glyph rather than the full wordmark because at
  // 20px in the connector deck a five-letter word is a smudge, and the tile has to be legible at
  // the size it is actually drawn.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="#635BFF" />
      <path
        d="M11.4 9.6c0-.62.52-.86 1.34-.86 1.02 0 2.32.32 3.34.88V6.5a8.6 8.6 0 0 0-3.34-.62c-2.73 0-4.55 1.44-4.55 3.85 0 3.75 5.1 3.14 5.1 4.76 0 .73-.63.97-1.5.97-1.12 0-2.58-.47-3.72-1.09v3.16c1.22.53 2.46.76 3.72.76 2.8 0 4.72-1.39 4.72-3.84 0-4.05-5.11-3.32-5.11-4.85z"
        fill="#ffffff"
      />
    </svg>
  );
}

// A globe is not a logo, so it follows the icon rules rather than the brand ones: the shared
// factory, one stroke weight, colour set by the wrapper rather than baked into the path.
export function HttpIcon({ size = 26 }: IconProps) {
  return (
    <span className="inline-flex" style={{ color: TEXT.muted }}>
      {svg(
        { size },
        <>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M3.5 12h17M12 3.5c2.5 2.4 2.5 14.6 0 17M12 3.5c-2.5 2.4-2.5 14.6 0 17" />
        </>,
      )}
    </span>
  );
}

export function AnthropicIcon({ size = 26 }: IconProps) {
  // Claude / Anthropic sunburst — coral asterisk.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" stroke="#D97757" strokeWidth="2.6" strokeLinecap="round" aria-hidden>
      <line x1="12" y1="4" x2="12" y2="20" />
      <line x1="5.1" y1="7.5" x2="18.9" y2="16.5" />
      <line x1="18.9" y1="7.5" x2="5.1" y2="16.5" />
    </svg>
  );
}

export function OpenAIIcon({ size = 26 }: IconProps) {
  // OpenAI knot — a monochrome hexafoil approximation.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={TEXT.ink} strokeWidth="1.6" aria-hidden>
      <path d="M12 4.2 a4 4 0 0 1 3.5 2 4 4 0 0 1 1.9 5.3 4 4 0 0 1-1.9 5.3 4 4 0 0 1-7 0 4 4 0 0 1-1.9-5.3 4 4 0 0 1 1.9-5.3 4 4 0 0 1 3.5-2z" />
      <path d="M12 8v8M8.5 10l7 4M15.5 10l-7 4" />
    </svg>
  );
}

// The two generic fallbacks. Neither identifies a service, so neither is a brand mark, and both
// are drawn to the icon rules — same sparkle the plan card uses for a model-written tool, same
// hex nut for a tool with no logo to show.
export function ModelChipIcon({ size = 24 }: IconProps) {
  return (
    <span className="inline-flex" style={{ color: ACCENT.state }}>
      {svg(
        { size },
        <>
          <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
          <path d="M20 3v4" />
          <path d="M22 5h-4" />
        </>,
      )}
    </span>
  );
}

export function GenericToolIcon({ size = 24 }: IconProps) {
  return (
    <span className="inline-flex" style={{ color: TEXT.muted }}>
      {svg(
        { size },
        <>
          <path d="M12 2.6l7.8 4.5v9L12 20.6l-7.8-4.5v-9z" />
          <circle cx="12" cy="12" r="3.2" />
        </>,
      )}
    </span>
  );
}

/* ─────────────────────────── mappers ─────────────────────────── */

type Brand = { label: string; Icon: (p: IconProps) => ReactElement };

const pretty = (stem: string) =>
  stem.replace(/[_-]+/g, " ").replace(/\.py$/, "").replace(/\b\w/g, (c) => c.toUpperCase()).trim();

/** A tool file path (tools/postgres.py) → a brand mark + label for its resource circle. */
/** The MCP bridge's mark: the badge's own plug, in the badge's own rose, at the app's weight. */
function McpBridgeIcon({ size = 18 }: { size?: number }) {
  return (
    <span className="inline-flex" style={{ color: ACCENT.mcp }}>
      <PlugIcon size={size} />
    </span>
  );
}

export function toolResource(path: string): Brand {
  const stem = (path.split("/").pop() || path).replace(/\.py$/, "");
  const s = stem.toLowerCase();
  // Checked first: "mcp_bridge" contains none of the patterns below, but a future server
  // named "mcp_mail" would otherwise be marked as Gmail. Provenance outranks resemblance.
  if (/^mcp_bridge$/.test(s)) return { label: "MCP", Icon: McpBridgeIcon };
  // BEFORE THE MAIL RULE, and the case is a real one rather than a tidiness. This mapper runs on
  // EVERY tool path, including the bespoke ones a model writes — and an agent that has both Google
  // connectors gets tools named `gmail_calendar_sync.py` and `mail_to_calendar.py` without anyone
  // choosing those names. Below the mail rule, both draw the Gmail envelope. It is the same
  // principle the MCP line above states: the more specific claim wins, and provenance outranks
  // resemblance.
  if (/calendar|gcal/.test(s)) return { label: "Google Calendar", Icon: GoogleCalendarIcon };
  if (/postgre|(^|_)pg($|_)|psql/.test(s)) return { label: "Postgres", Icon: PostgresIcon };
  if (/gmail|email|mail/.test(s)) return { label: "Gmail", Icon: GmailIcon };
  if (/slack/.test(s)) return { label: "Slack", Icon: SlackIcon };
  if (/stripe/.test(s)) return { label: "Stripe", Icon: StripeIcon };
  if (/http|webhook|rest|api/.test(s)) return { label: "HTTP", Icon: HttpIcon };
  return { label: pretty(stem), Icon: GenericToolIcon };
}

/** A provider/model → the model resource circle's mark + label. */
export function modelResource(provider?: string, model?: string): Brand {
  const p = (provider || "").toLowerCase();
  const m = (model || "").toLowerCase();
  if (p.includes("anthropic") || m.includes("claude")) return { label: model || "Anthropic", Icon: AnthropicIcon };
  if (p.includes("openai") || m.includes("gpt")) return { label: model || "OpenAI", Icon: OpenAIIcon };
  return { label: model || "Dry-run", Icon: ModelChipIcon };
}
