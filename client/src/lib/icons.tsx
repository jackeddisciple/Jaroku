// Brand marks. The design rule (doc §4.2): a brand icon shows its real color only when it's
// the active/chosen/connected thing; otherwise it renders muted grey. These are simple
// geometric marks, not pixel logos — enough to read "Claude" vs "OpenAI" at a glance.

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
  if (provider === "anthropic") {
    // Claude sunburst: eight rays.
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill="none" stroke={color} strokeWidth="2" strokeLinecap="round">
        {Array.from({ length: 8 }).map((_, i) => {
          const a = (i * Math.PI) / 4;
          const x = 12 + Math.cos(a) * 8;
          const y = 12 + Math.sin(a) * 8;
          return <line key={i} x1="12" y1="12" x2={x} y2={y} />;
        })}
      </svg>
    );
  }
  if (provider === "openai") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill="none" stroke={color} strokeWidth="1.8">
        <circle cx="12" cy="12" r="7" />
        <path d="M12 5v14M5 12h14" opacity="0.5" />
      </svg>
    );
  }
  // fake / unknown: a hollow dot.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill="none" stroke={color} strokeWidth="2">
      <circle cx="12" cy="12" r="6" />
    </svg>
  );
}

/** A tiny connector dot — brand color when the agent is wired to it, grey otherwise. */
export function ConnectorDot({ id, active = true }: { id: string; active?: boolean }) {
  const color = active ? BRAND_COLOR[id] ?? MUTED : MUTED;
  return <span className="inline-block w-1.5 h-1.5 rounded-full align-middle" style={{ background: color }} aria-hidden />;
}
