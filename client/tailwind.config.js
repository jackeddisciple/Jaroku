/** @type {import('tailwindcss').Config} */
// The palette from colour_system.pdf and the type ladder from typography.pdf, as utility classes.
// Both specifications are LOCKED; both are held to this file by a suite rather than by care.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // colour_system.pdf, as utility classes. `src/lib/palette.ts` holds the specification's own
      // tokens and `src/lib/tokens.ts` holds what they mean; this is the third copy, and
      // `colourSystem.test.ts` is what holds all three to each other — a Tailwind config cannot
      // import a `.ts` module without moving the whole config to TypeScript, so the values are
      // written out and the agreement is a test rather than an import.
      //
      // THE NAMES ARE THIS APP'S AND THE VALUES ARE THE SPECIFICATION'S. Two thousand call sites
      // say `bg-panel` and `text-faint`, and renaming them to `bg-bg-surface` and
      // `text-text-muted` would be a rename of every file in the client to gain nothing: what
      // matters is that `panel` IS `--color-bg-surface`, which the suite asserts token by token.
      // The specification's own names are published as custom properties in src/index.css, for the
      // three consumers a class cannot reach.
      colors: {
        // §01. Layered surfaces (under the page → floating above it).
        //
        // THE LADDER INVERTED WITH THE THEME. Each step used to be lighter than the one below it,
        // because on a near-black page that is the only direction a surface can move; here each
        // step is lighter than the page and the page is lighter than what it sits on. The ORDER of
        // the names is unchanged, which is why two thousand call sites did not have to move.
        //
        // `void` is what the app itself sits ON. Everything above it is inside the shell; this is
        // the only colour outside it, and it exists so the shell can read as a lifted panel
        // rather than as the window. One step under `bg`, which is the canvas.
        void: "#F1F1EF", // --color-bg-subtle
        bg: "#F7F7F5", // --color-bg-canvas — the main application canvas
        panel: "#FBFBFA", // --color-bg-surface — cards and standard content surfaces
        // §01's fourth surface, and a rung the dark palette did not have. Popovers used `panel`
        // and a shadow said "above"; on a light page a floating surface one percent off the card
        // behind it reads as the same surface, so this is the pure white §01 reserves for them.
        elevated: "#FFFFFF", // --color-bg-elevated — elevated panels, popovers and dialogs
        active: "#ECECEA", // --color-bg-hover — hover, and the fill under a selected row
        // §02. THE SIDEBAR IS ITS OWN PLANE, which is a decision rather than a shade: "it should
        // visibly differ from the main content without becoming dark or dashboard-like. It has no
        // outer shadow and no outer radius; a quiet border separates it from the main workspace."
        // Four tokens of its own rather than four of §01's, because the sidebar's hover is a cool
        // grey and the content area's is a warm one — a shared `hover` would make the sidebar warm
        // the first time somebody reused it.
        sidebar: "#E9EEEF", // --color-sidebar
        "sidebar-hover": "#DEE6E8", // --color-sidebar-hover
        "sidebar-active": "#D3DDE0", // --color-sidebar-active
        "sidebar-border": "#D2DCDD", // --color-sidebar-border
        // §03. Pale Mist — surfaces, selection and atmosphere. `400` is the reference colour and
        // §03 says it "is used selectively; lighter derived steps carry most of the UI". 100, 200
        // and 300 are the sidebar's three values, deliberately: the sidebar IS this family, and
        // naming them twice is what lets another surface join it without copying the sidebar.
        mist: {
          50: "#F3F6F6",
          100: "#E9EEEF",
          200: "#DEE6E8",
          300: "#D3DDE0",
          400: "#C0C8CA",
        },
        // §05. Text.
        ink: "#1D1D1B", // --color-text-primary — and §08's `brand-strong`, see below
        muted: "#62625F", // --color-text-secondary
        faint: "#90908C", // --color-text-muted — timestamps, slugs
        // §05's fourth step, and a STATE rather than a fourth level of emphasis. New here: the
        // dark palette expressed "unavailable" as `opacity-40` on whatever the control already
        // was, which compounds — a faded control inside a faded panel ends up less legible than
        // the empty space beside it.
        disabled: "#B5B5B0", // --color-text-disabled
        // §06. Borders, in three weights chosen by how much the boundary is meant to be noticed.
        hair: "#E6E6E2", // --color-border-subtle — hairline dividers, connector lines
        edge: "#DCDCD8", // --color-border-default — card border, inputs
        // Chrome: scrollbar thumbs, control dividers, a pressed control.
        chrome: "#E5E5E1", // --color-bg-active
        // The strongest neutral the app draws — a seam under the pointer, a thumb being dragged.
        // It used to be the BRIGHTEST, for the same reason in the opposite direction.
        grip: "#C9C9C4", // --color-border-strong
        // §04. Deep Harbor, the one interaction accent (see INTERACTION in src/lib/tokens.ts for
        // why one and why this one). Four uses and no fifth: the selected row or tab, live/sync
        // iconography, links, focus rings. §09 says it twice more — "rare and intentional", "not
        // every button or heading" — and a Harbor badge on a non-interactive label is what makes
        // an accent unusable for selection later.
        accent: "#2B4851", // --color-deep-harbor
        "accent-hover": "#24404A", // --color-deep-harbor-hover
        "accent-soft": "#E8EFF0", // --color-deep-harbor-soft — a Harbor-tinted background
        // §07. Semantic colours — reserved exclusively for meaning, never decoration. §09: "green,
        // amber, red and blue retain functional meaning and are not replaced by the secondary
        // palette."
        ok: "#3B8F5A", // --color-success
        err: "#C94A43", // --color-danger
        run: "#B77A1B", // --color-warning — in this product amber means IN FLIGHT
        // Caution — a legitimate setting worth noticing, not a failure and not an in-flight thing.
        // §07's `info`, and see STATUS.warn in src/lib/tokens.ts for why it is the blue rather than
        // the amber its wording describes: amber already answers "is this happening right now" at
        // forty-eight call sites against this one's two, and one static exception is all it takes
        // to stop a colour answering its question.
        warn: "#4B78B8", // --color-info
        // Category accents (see src/lib/tokens.ts for why these four and not others). These say
        // what *kind* of thing something is; the status colors above say how it's doing. §09 is
        // where they are allowed to exist at all — "additional personality colours ... belong to
        // the agent layer, not the global theme" — and every one has been re-struck for a light
        // page, because the pastels that read on near-black vanish on #FBFBFA.
        reviewed: "#1D6C87", // audited connector template, copied in verbatim
        bespoke: "#683D8C", // written by a model for this agent only
        stateful: "#3742A8", // state fields — the agent's shape, not its capabilities
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
      // Depth — mirrors ELEVATION in src/lib/tokens.ts. Every level still pairs with a hairline
      // border, and which half does the work has swapped: on near-black the 1px edge separated two
      // surfaces and the shadow only said which way was up, and on #F7F7F5 it is the shadow that
      // separates while the hairline stops a card reading as a drawn rectangle.
      //
      // THE ALPHAS ARE ROUGHLY A FIFTH OF WHAT THEY WERE, which is the whole difference between a
      // light system's depth and a dark one's — 40% black under a card is invisible on near-black
      // and a bruise on off-white. Struck from ink (#1D1D1B) rather than from black, because a
      // neutral-warm page casts a neutral-warm shadow and pure black under #FBFBFA goes grey-blue.
      boxShadow: {
        raised: "0 1px 2px rgba(29, 29, 27, 0.06)",
        floating: "0 2px 6px rgba(29, 29, 27, 0.06), 0 12px 28px -8px rgba(29, 29, 27, 0.1)",
        overlay: "0 4px 12px rgba(29, 29, 27, 0.08), 0 28px 64px -16px rgba(29, 29, 27, 0.16)",
        // Mirrors FOCUS_RING in src/lib/tokens.ts. Deep Harbor, not a grey — a grey ring on a grey
        // control is very nearly nothing whichever way up the greys are, and "where am I" is the
        // question a keyboard user asks most.
        focusring: "0 0 0 1px #2B4851, 0 0 0 4px rgba(43, 72, 81, 0.16)",
        // Weight by shade — mirrors GLOW in src/lib/tokens.ts. A shadow says "this is above the
        // page"; this says "this is the one you are on", which is what a hovered or
        // keyboard-reached control needs to say. It lifted by LIGHT under the dark palette,
        // because a card on #0d0d0f can only get brighter; on #FBFBFA it can only get darker.
        glow: "0 0 0 1px #C9C9C4, 0 0 32px -10px rgba(29, 29, 27, 0.12)",
        "glow-cta": "0 0 0 4px rgba(29, 29, 27, 0.07)",
      },
      transitionDuration: {
        fast: "120ms",
        base: "180ms",
      },
      transitionTimingFunction: {
        state: "cubic-bezier(0.2, 0, 0, 1)",
      },
      // Type. Both halves of this block are a transcription of src/lib/typeScale.ts, which is the
      // file that holds typography.pdf's table — and `typeScale.test.ts` compares the two rather
      // than trusting that a person copied ten numbers correctly twice. A Tailwind config cannot
      // import a `.ts` module without moving the whole config to TypeScript, so the values are
      // written out here and the agreement is a test rather than an import.
      fontFamily: {
        // §01. The product's voice — everything users read and interact with. There is no third
        // family any more: the display serif that carried the pre-session headings is gone,
        // because §01 says Geist Sans is the primary typeface *across the product* and §05 makes
        // that a principle rather than a preference.
        sans: [
          "Geist Sans",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        // §01. Code's voice, and only code's: source, snippets, terminal output, logs, stack
        // traces, diffs, and the file paths and line numbers that sit beside them. §05 is the rule
        // that matters here — do not switch fonts merely because a string looks technical. Slugs,
        // versions, timestamps, model names and every figure in the app are Sans now.
        mono: [
          "Geist Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      // §02's eight rungs. Each carries its line height AND its weight, so `text-title` is a whole
      // decision rather than a size that still needs `font-semibold` beside it to mean anything.
      //
      // These REPLACE eight hundred hand-written pixel counts. The client rendered 9, 10, 11, 12,
      // 13, 15, 18, 19, 32 and 34 — ten sizes, four of which existed because a component was
      // matched to whatever sat next to it. `section` and `title` are identical numbers on purpose:
      // §02 lists them as two rows because they are two jobs, and collapsing them would cost the
      // distinction at every call site.
      fontSize: {
        display: ["32px", { lineHeight: "40px", fontWeight: "600" }],
        page: ["24px", { lineHeight: "30px", fontWeight: "600" }],
        section: ["16px", { lineHeight: "22px", fontWeight: "600" }],
        title: ["16px", { lineHeight: "22px", fontWeight: "600" }],
        body: ["14px", { lineHeight: "20px", fontWeight: "400" }],
        label: ["13px", { lineHeight: "18px", fontWeight: "500" }],
        caption: ["12px", { lineHeight: "16px", fontWeight: "400" }],
        tiny: ["11px", { lineHeight: "14px", fontWeight: "500" }],
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
          "0%": { backgroundColor: "rgba(43, 72, 81, 0)" },
          "35%": { backgroundColor: "rgba(43, 72, 81, 0.12)" },
          "100%": { backgroundColor: "rgba(43, 72, 81, 0)" },
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
        //
        // THE AMBER IS §07's (#B77A1B) AND THE DEPTH UNDER IT IS INK AT A LIGHT SYSTEM'S ALPHA. The
        // ring alphas are barely reduced and the SPREAD alphas are, which is the part a light page
        // changes: a wide soft halo of colour on near-black reads as light coming off the node, and
        // the same halo on #F1F1EF reads as a smudge. The ring is what says "this one is running";
        // the spread only has to be perceptible.
        "pulse-node": {
          "0%, 100%": {
            boxShadow:
              "0 1px 2px rgba(29, 29, 27, 0.08), 0 12px 30px -8px rgba(29, 29, 27, 0.14), " +
              "0 0 0 1px rgba(183, 122, 27, 0.55), 0 0 16px 1px rgba(183, 122, 27, 0.3), 0 0 44px 6px rgba(183, 122, 27, 0.1)",
          },
          "50%": {
            boxShadow:
              "0 1px 2px rgba(29, 29, 27, 0.08), 0 12px 30px -8px rgba(29, 29, 27, 0.14), " +
              "0 0 0 1px rgba(183, 122, 27, 0.85), 0 0 24px 3px rgba(183, 122, 27, 0.42), 0 0 64px 13px rgba(183, 122, 27, 0.18)",
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
