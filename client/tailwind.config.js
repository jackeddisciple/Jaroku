/** @type {import('tailwindcss').Config} */
// Palette + type tokens from jarokudoc.md §4.2 (restraint over decoration).
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Layered surfaces (deepest → top).
        // `void` is what the app itself sits ON. Everything above it is inside the shell; this is
        // the only colour outside it, and it exists so the shell can read as a lifted panel
        // rather than as the window. One step under `bg`, which used to be the floor.
        void: "#08080a",
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
        grip: "#3a3a3f", // the brightest neutral — a seam under the pointer, a thumb being dragged
        // The one interaction accent (see INTERACTION in src/lib/tokens.ts for why one and why
        // this one). Four uses and no fifth: the selected row or tab, live/sync iconography,
        // links, focus rings. Never decoration, never a category — a blue on a non-interactive
        // badge is what makes an accent unusable for selection later.
        accent: "#6b8afd",
        // THE PRE-SESSION SURFACE'S LINK COLOUR, and the one deliberate exception to the sentence
        // above. It is used on first-run, sign-in and account onboarding, and nowhere else — a
        // `text-ember` inside a panel is a review comment rather than a style choice.
        //
        // WHY AN EXCEPTION EXISTS AT ALL. `accent` is a SELECTION colour: it means "this is the row
        // you are on", and it earns that meaning by never appearing on anything that is not
        // selectable. The screens before a session have no rows, no tabs and nothing selected —
        // their only interactive text is "Terms of Service", "Start over", "Where do I find this?"
        // — so painting those in the selection blue would spend the one colour that says "here"
        // on a screen where nothing is anywhere. Warm, because the alternative reading of a blue
        // link on near-black is a hyperlink from 1996.
        ember: "#e08a5c",
        // Its hover. One step up in light rather than a hue shift, so a link answering the pointer
        // reads as the same link rather than as a different kind of thing.
        emberlit: "#eda17b",
        // Status colors — reserved exclusively for meaning, never decoration.
        ok: "#22c55e",
        err: "#ef4444",
        run: "#f59e0b",
        // Caution — a legitimate setting worth noticing, not a failure and not an in-flight thing.
        // See STATUS.warn in src/lib/tokens.ts for why this is a fourth colour rather than a reuse
        // of `run`: amber means "happening right now" everywhere else in this app, and one static
        // exception is all it takes to stop it answering that question.
        warn: "#fb923c",
        // Category accents (see src/lib/tokens.ts for why these three and not others).
        // These say what *kind* of thing something is; the status colors above say how it's doing.
        reviewed: "#5eead4", // audited connector template, copied in verbatim
        bespoke: "#c084fc", // written by a model for this agent only
        stateful: "#a5b4fc", // state fields — the agent's shape, not its capabilities
      },
      // Corner radius — four steps, mirroring RADIUS in src/lib/tokens.ts. The scale is chosen by
      // the SIZE of the box, not by what the component is called, because a radius reads as a
      // proportion of the corner it turns. `rounded-full` is deliberately not on the scale: a pill
      // is a shape, and it has to keep working when the height changes.
      borderRadius: {
        chip: "4px", // chips, badges, inline code
        control: "6px", // buttons, inputs, tabs, rows
        card: "10px", // cards, popovers, panels
        modal: "14px", // modals, the composer
      },
      // Depth — mirrors ELEVATION in src/lib/tokens.ts. Every level pairs with a hairline border;
      // on a near-black background the 1px edge is what actually separates two surfaces, and the
      // shadow only says which way is up.
      boxShadow: {
        raised: "0 1px 2px rgba(0,0,0,0.4)",
        floating: "0 2px 6px rgba(0,0,0,0.35), 0 12px 28px -8px rgba(0,0,0,0.55)",
        overlay: "0 4px 12px rgba(0,0,0,0.4), 0 28px 64px -16px rgba(0,0,0,0.7)",
        // Mirrors FOCUS_RING in src/lib/tokens.ts. The accent, not a grey — a grey ring on a grey
        // control on a near-black page is very nearly nothing, and "where am I" is the question a
        // keyboard user asks most.
        focusring: "0 0 0 1px #6b8afd, 0 0 0 4px rgba(107,138,253,0.16)",
        // Lift by light rather than by dark — mirrors GLOW in src/lib/tokens.ts. A shadow says
        // "this is above the page"; a glow says "this is the one you are on", which is what a
        // hovered or keyboard-reached control needs to say.
        glow: "0 0 0 1px #34343c, 0 0 32px -10px rgba(228,228,231,0.16)",
        "glow-cta": "0 0 0 4px rgba(228,228,231,0.07)",
      },
      transitionDuration: {
        fast: "120ms",
        base: "180ms",
      },
      transitionTimingFunction: {
        state: "cubic-bezier(0.2, 0, 0, 1)",
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
        // Display, and ONLY on the screens before there is a session — first-run, sign-in,
        // account onboarding. See the note beside the @import in src/index.css for why a third
        // family exists and why it is confined to that surface.
        serif: [
          "Newsreader",
          "ui-serif",
          "Georgia",
          "Cambria",
          "Times New Roman",
          "serif",
        ],
      },
      keyframes: {
        // Trace steps slide in — perceptible, never sluggish (doc §4.6).
        "slide-in": {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        // A step, a file or a task finished. The mark scales up past its resting size and settles,
        // which is what makes it read as *landing* rather than as having quietly always been there.
        // Fast, and it never repeats: this is a state change, not a status.
        // A turn somebody jumped to from the pinned rail. Scrolling to a row in a long thread
        // lands the reader somewhere with no indication of WHICH row was meant, so the flash is
        // doing real work rather than decorating — it is the only thing that says "this one".
        //
        // A BACKGROUND WASH RATHER THAN A BORDER OR A SCALE. A border would shift the row's
        // geometry for the duration and reflow everything under it; a scale would move the thing
        // the reader is trying to read. The accent at low alpha changes nothing about the layout.
        // It is skipped entirely under `prefers-reduced-motion` — the caller checks, because the
        // static alternative is simply arriving there, which is fine.
        "flash-highlight": {
          "0%": { backgroundColor: "rgba(107,138,253,0)" },
          "35%": { backgroundColor: "rgba(107,138,253,0.16)" },
          "100%": { backgroundColor: "rgba(107,138,253,0)" },
        },
        "check-in": {
          "0%": { opacity: "0", transform: "scale(0.4)" },
          "60%": { opacity: "1", transform: "scale(1.15)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        // Something is receiving data right now. Distinct from Tailwind's `animate-pulse`, which
        // fades to 50% and reads as "disabled" on text — this holds most of its opacity and moves
        // slowly, so it says "alive" rather than "greyed out".
        "stream-pulse": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.62" },
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
        // A column arriving during first-run onboarding (doc: progressive reveal). It fades and
        // slides in from its own edge rather than scaling, because the panel is already at its
        // final width — the reveal is about it appearing beside the composer, not growing into
        // place. Slower than slide-in: this is a piece of the app arriving, and at 120ms it
        // read as a glitch rather than as something being handed to you.
        "panel-in": {
          "0%": { opacity: "0", transform: "translateX(-8px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        // A block of a first-run screen arriving. Same idea as slide-in and the same easing, one
        // step longer and one step further: these are paragraphs and cards rather than list rows,
        // and they are staggered, so each one has to still be moving when the next begins or the
        // sequence reads as four separate glitches instead of one screen assembling.
        rise: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "slide-in": "slide-in 120ms ease-out",
        "panel-in": "panel-in 260ms cubic-bezier(0.2, 0, 0, 1)",
        // `backwards` matters: these are staggered by animation-delay, and without it every
        // block paints at full opacity first and then jumps back to hidden to start.
        rise: "rise 320ms cubic-bezier(0.2, 0, 0, 1) backwards",
        breathe: "breathe 4.2s ease-in-out infinite",
        "pulse-node": "pulse-node 2.4s ease-in-out infinite",
        "check-in": "check-in 180ms cubic-bezier(0.2, 0, 0, 1)",
        "stream-pulse": "stream-pulse 1.4s ease-in-out infinite",
        // 400ms rather than the spec's 200: at 200 the wash is gone before a smooth scroll has
        // finished arriving, so the one thing it exists to say is said to an empty screen.
        "flash-highlight": "flash-highlight 400ms ease-out",
      },
    },
  },
  plugins: [],
};
