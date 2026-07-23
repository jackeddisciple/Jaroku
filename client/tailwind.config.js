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
        // Status colors — reserved exclusively for meaning, never decoration.
        ok: "#22c55e",
        err: "#ef4444",
        run: "#f59e0b",
      },
      fontFamily: {
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
        // The executing graph node glows — a subtle amber pulse, not a flash (doc §4.6).
        "pulse-node": {
          "0%, 100%": { boxShadow: "0 0 0 3px rgba(245,158,11,0.28)" },
          "50%": { boxShadow: "0 0 0 6px rgba(245,158,11,0.10)" },
        },
      },
      animation: {
        "slide-in": "slide-in 120ms ease-out",
        "pulse-node": "pulse-node 1.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
