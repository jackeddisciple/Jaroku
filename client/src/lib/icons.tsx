// Brand marks. The design rule (doc §4.2): a brand icon shows its real color only when it's
// the active/chosen/connected thing; otherwise it renders muted grey. These are simple
// geometric marks, not pixel logos — enough to read "Claude" vs "OpenAI" at a glance.

// Stroke weight comes from ICON.strokeWidth like every other icon in the app. These used to be
// drawn at 2 / 1.8 / 2 with their own inline <svg> attributes, so the provider mark in the top
// bar sat visibly heavier than the icons either side of it.
import { ICON } from "./tokens.ts";

const MUTED = "#71717a";

export const BRAND_COLOR: Record<string, string> = {
  anthropic: "#d97757", // Claude terracotta
  openai: "#10a37f", // OpenAI green
  fake: MUTED,
  gmail: "#ea4335",
  slack: "#e01e5a",
  postgres: "#336791",
};

/** Provider mark for the chip in the top bar / status bar. */
export function ProviderMark({ provider, active = true, size = 12 }: { provider: string; active?: boolean; size?: number }) {
  const color = active ? BRAND_COLOR[provider] ?? MUTED : MUTED;
  const mark = (children: React.ReactNode) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden
      fill="none"
      stroke={color}
      strokeWidth={ICON.strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
  if (provider === "anthropic") {
    // Claude sunburst: eight rays.
    return mark(
      Array.from({ length: 8 }).map((_, i) => {
        const a = (i * Math.PI) / 4;
        const x = 12 + Math.cos(a) * 8;
        const y = 12 + Math.sin(a) * 8;
        return <line key={i} x1="12" y1="12" x2={x} y2={y} />;
      }),
    );
  }
  if (provider === "openai") {
    return mark(
      <>
        <circle cx="12" cy="12" r="7" />
        <path d="M12 5v14M5 12h14" opacity="0.5" />
      </>,
    );
  }
  // fake / unknown: a hollow dot.
  return mark(<circle cx="12" cy="12" r="6" />);
}

/**
 * The Jaroku mark in the top bar.
 *
 * It was `◭` — a font character, which means it renders as whatever the user's system decides,
 * at whatever weight that font draws it, and on a machine without the glyph as a box. A wordmark
 * is the one thing in a UI that must look the same everywhere, so it is drawn.
 *
 * A triangle with its left half filled, which is what the character was standing in for. Solid
 * rather than stroked because it is a mark, not an icon — the stroke ladder governs the icon set,
 * and a logo drawn to the same rules as a chevron reads as neither.
 */
export function JarokuGlyph({ size = 15, color = "#f59e0b" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill="none">
      <path d="M12 3 21 20H3z" fill={color} fillOpacity="0.22" />
      <path d="M12 3v17H3z" fill={color} />
      <path d="M12 3 21 20H3z" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

/** A tiny connector dot — brand color when the agent is wired to it, grey otherwise. */
export function ConnectorDot({ id, active = true }: { id: string; active?: boolean }) {
  const color = active ? BRAND_COLOR[id] ?? MUTED : MUTED;
  return <span className="inline-block w-1.5 h-1.5 rounded-full align-middle" style={{ background: color }} aria-hidden />;
}
