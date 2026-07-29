/** @type {import('tailwindcss').Config} */
// Palette + type tokens from jarokudoc.md §4.2 (restraint over decoration).
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Layered surfaces (deepest → top).
        bg: "#0d0d0f", // near-black background
        panel: "#18181b", // sidebar / panels, one layer up
        active: "#1e1e22", // selected/active row
        // Text.
        ink: "#e4e4e7", // primary (off-white, never pure white)
        muted: "#71717a", // secondary
        faint: "#52525b", // tertiary (seq numbers, etc.)
        hair: "#1e1e22", // hairline dividers / connector line
        // Chrome. Both were hardcoded in several places before they were named.
        edge: "#2a2a30", // card border — raised without reading as a visible box
        chrome: "#26262b", // scrollbar thumbs, control dividers
        // Status colors — reserved exclusively for meaning, never decoration.
        ok: "#22c55e",
        err: "#ef4444",
        run: "#f59e0b",
        // Category accents (see src/lib/tokens.ts for why these three and not others).
        // These say what *kind* of thing something is; the status colors above say how it's doing.
        reviewed: "#5eead4", // audited connector template, copied in verbatim
        bespoke: "#c084fc", // written by a model for this agent only
        stateful: "#a5b4fc", // state fields — the agent's shape, not its capabilities
      },
      fontFamily: {
        // Prose. The body default — plan explanations, notes, descriptions, labels.
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        // Code. Opted into explicitly, and only for things that are literally identifiers:
        // file paths, tool names, type annotations, diff hunks, figures.
        mono: [
          "JetBrains Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      keyframes: {
        // Trace steps slide in — perceptible, never sluggish (doc §4.6).
        "slide-in": {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        // Idle "breathing" — the graph feels alive at rest. A ~1.8% scale over a slow loop;
        // per-node delay (set inline) desyncs the field so it never reads as one mechanical pulse.
        breathe: {
          "0%, 100%": { transform: "scale(1)" },
          "50%": { transform: "scale(1.018)" },
        },
        // The executing graph node glows — a real, layered amber glow (tight ring + soft spread)
        // that swells and settles, over the persistent depth shadow. Not a flash (doc §4.6).
        "pulse-node": {
          "0%, 100%": {
            boxShadow:
              "0 1px 2px rgba(0,0,0,0.6), 0 12px 30px -8px rgba(0,0,0,0.65), " +
              "0 0 0 1px rgba(245,158,11,0.55), 0 0 16px 1px rgba(245,158,11,0.42), 0 0 44px 6px rgba(245,158,11,0.16)",
          },
          "50%": {
            boxShadow:
              "0 1px 2px rgba(0,0,0,0.6), 0 12px 30px -8px rgba(0,0,0,0.65), " +
              "0 0 0 1px rgba(245,158,11,0.8), 0 0 24px 3px rgba(245,158,11,0.58), 0 0 64px 13px rgba(245,158,11,0.3)",
          },
        },
      },
      animation: {
        "slide-in": "slide-in 120ms ease-out",
        breathe: "breathe 4.2s ease-in-out infinite",
        "pulse-node": "pulse-node 2.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
