// Iconography for the Graph View (n8n-style restyle). Two families:
//   • Flow icons — monochrome line/solid marks for the main-path node kinds (trigger, agent,
//     tool, action, terminal). They inherit `currentColor`, so the node sets the accent.
//   • Brand icons — full-colour connector/provider logos shown inside the circular resource
//     nodes (Postgres, Gmail, Slack, Anthropic, …). These are self-coloured, recognizable
//     reconstructions (no external assets — the canvas CSP forbids remote images).
//
// Everything here is presentation-only; mappers turn a tool file path or a provider id into the
// right brand mark + a human label.

import type { ReactElement } from "react";

type IconProps = { size?: number };

/* ─────────────────────────── Flow (main-path) icons ─────────────────────────── */

export function TriggerIcon({ size = 20 }: IconProps) {
  // lightning bolt — the "this starts the run" mark
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M13 2 L4 14 h6 l-1 8 9-12 h-6 z" />
    </svg>
  );
}

export function AgentIcon({ size = 22 }: IconProps) {
  // friendly robot head
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="8" width="16" height="11" rx="3" />
      <path d="M12 4.5 v3" />
      <circle cx="12" cy="4" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="9" cy="13" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="13" r="1.2" fill="currentColor" stroke="none" />
      <path d="M9.5 16.3 h5" />
      <path d="M4 12 H2.6 M20 12 h1.4" />
    </svg>
  );
}

export function ToolIcon({ size = 20 }: IconProps) {
  // bold solid wrench — unmistakably "tools", never a flower/sun
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M21 5.3a.9.9 0 0 0-1.5-.4l-2.6 2.6-2.1-.3-.3-2.1 2.6-2.6A.9.9 0 0 0 16.7 1a6 6 0 0 0-7.9 7.4L2.5 14.7a2.6 2.6 0 0 0 3.7 3.7l6.3-6.3A6 6 0 0 0 21 5.3z" />
    </svg>
  );
}

export function ActionIcon({ size = 20 }: IconProps) {
  // generic "do something" — a play-into-tray glyph
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h9" />
      <path d="M11 8l4 4-4 4" />
      <path d="M17 5v14" />
    </svg>
  );
}

export function TerminalIcon({ size = 18 }: IconProps) {
  // stop / finish square
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
    </svg>
  );
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

export function HttpIcon({ size = 26 }: IconProps) {
  // generic HTTP / webhook — a globe
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#7FA9D6" strokeWidth="1.6" aria-hidden>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.5 2.4 2.5 14.6 0 17M12 3.5c-2.5 2.4-2.5 14.6 0 17" />
    </svg>
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
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="1.6" aria-hidden>
      <path d="M12 4.2 a4 4 0 0 1 3.5 2 4 4 0 0 1 1.9 5.3 4 4 0 0 1-1.9 5.3 4 4 0 0 1-7 0 4 4 0 0 1-1.9-5.3 4 4 0 0 1 1.9-5.3 4 4 0 0 1 3.5-2z" />
      <path d="M12 8v8M8.5 10l7 4M15.5 10l-7 4" />
    </svg>
  );
}

export function ModelChipIcon({ size = 24 }: IconProps) {
  // generic / dry-run model — a bold AI sparkle
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#A6B0FF" aria-hidden>
      <path d="M12 1.8l2 5.9a3.2 3.2 0 0 0 2.3 2.3l5.9 2-5.9 2a3.2 3.2 0 0 0-2.3 2.3l-2 5.9-2-5.9a3.2 3.2 0 0 0-2.3-2.3l-5.9-2 5.9-2A3.2 3.2 0 0 0 10 7.7z" />
      <circle cx="19" cy="5" r="1.7" />
    </svg>
  );
}

export function GenericToolIcon({ size = 24 }: IconProps) {
  // custom tool with no known brand — a bold hex nut (reads as "hardware / tool")
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#c3c7d1" aria-hidden>
      <path d="M12 2.2l8.2 4.7v9.5L12 21.8l-8.2-4.7V7z" />
      <circle cx="12" cy="12" r="3.5" fill="#18181b" />
    </svg>
  );
}

/* ─────────────────────────── mappers ─────────────────────────── */

type Brand = { label: string; Icon: (p: IconProps) => ReactElement };

const pretty = (stem: string) =>
  stem.replace(/[_-]+/g, " ").replace(/\.py$/, "").replace(/\b\w/g, (c) => c.toUpperCase()).trim();

/** A tool file path (tools/postgres.py) → a brand mark + label for its resource circle. */
export function toolResource(path: string): Brand {
  const stem = (path.split("/").pop() || path).replace(/\.py$/, "");
  const s = stem.toLowerCase();
  if (/postgre|(^|_)pg($|_)|psql/.test(s)) return { label: "Postgres", Icon: PostgresIcon };
  if (/gmail|email|mail/.test(s)) return { label: "Gmail", Icon: GmailIcon };
  if (/slack/.test(s)) return { label: "Slack", Icon: SlackIcon };
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
