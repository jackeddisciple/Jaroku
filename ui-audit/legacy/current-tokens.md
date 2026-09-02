# Legacy — current token values

> ## ⚠ WARNING
>
> **These are legacy implementation values only. They are NOT the future Jaroku design system. They
> MUST NOT be treated as design constraints.**
>
> They are recorded here as an archaeological record of what the current implementation does —
> nothing more. Nothing in this file is a recommendation to preserve, normalise or extend any value.
> The future Jaroku design system will be created separately from this audit.
>
> The reasoning *beside* these values is a different matter, and it lives in
> [`design-arguments.md`](design-arguments.md).

Source of record: `client/src/lib/palette.ts` (raw values), `client/src/lib/tokens.ts` (what they
mean), `client/src/lib/typeScale.ts` (the type ladder), `client/tailwind.config.js`,
`client/src/index.css`.

---

## Colour — surfaces

| Token | Value | Used for |
|---|---|---|
| `CANVAS.canvas` | `#F7F7F5` | the application canvas |
| `CANVAS.surface` | `#FBFBFA` | cards, panels, the sidebar's neighbours |
| `CANVAS.elevated` | `#FFFFFF` | popovers, dialogs — the only pure white in the system |
| `CANVAS.subtle` | `#F1F1EF` | the page the shell floats on |
| `CANVAS.hover` | `#ECECEA` | hover, and the fill under a selected row |
| `CANVAS.active` | `#E5E5E1` | chrome: scrollbar thumbs, control dividers, a pressed control |

## Colour — sidebar

| Token | Value |
|---|---|
| `SIDEBAR.base` | `#E9EEEF` |
| `SIDEBAR.hover` | `#DEE6E8` |
| `SIDEBAR.active` | `#D3DDE0` |
| `SIDEBAR.border` | `#D2DCDD` |

`PALE_MIST`: 50 `#F3F6F6` · 100 `#E9EEEF` · 200 `#DEE6E8` · 300 `#D3DDE0` · 400 `#C0C8CA`

## Colour — text

| Token | Value |
|---|---|
| `TEXT.primary` | `#1D1D1B` |
| `TEXT.secondary` | `#62625F` |
| `TEXT.muted` | `#90908C` |
| `TEXT.disabled` | `#B5B5B0` |

## Colour — borders

| Token | Value | Used for |
|---|---|---|
| `BORDER.subtle` | `#E6E6E2` | hairline dividers, connector lines |
| `BORDER.default` | `#DCDCD8` | card border |
| `BORDER.strong` | `#C9C9C4` | a seam under the pointer, a dragged scrollbar thumb |

## Colour — interaction

| Token | Value |
|---|---|
| `DEEP_HARBOR.base` | `#2B4851` |
| `DEEP_HARBOR.hover` | `#24404A` |
| `DEEP_HARBOR.soft` | `#E8EFF0` |
| `INTERACTION.soft` | `rgba(43,72,81,0.16)` |

## Colour — status

| Token | Value | Means |
|---|---|---|
| `STATUS.ok` | `#3B8F5A` | succeeded |
| `STATUS.pending` | `#B77A1B` | **in flight** |
| `STATUS.error` | `#C94A43` | something went wrong |
| `STATUS.warn` | `#4B78B8` | caution — a supported mode chosen on purpose |
| `STATUS.neutral` | `#62625F` | decided-but-not-notable |

## Colour — category accents

| Token | Value | Means |
|---|---|---|
| `ACCENT.reviewed` | `#1D6C87` | audited connector tools, copied in verbatim |
| `ACCENT.bespoke` | `#683D8C` | tools about to be written by a model |
| `ACCENT.state` | `#3742A8` | state fields |
| `ACCENT.mcp` | `#A83E82` | tools from an unreviewed third-party server |

## Colour — trace step types

| Type | fg | bg |
|---|---|---|
| `llm_call` | `#2F5F92` | `#EDF2F8` |
| `tool_call` | `#2F7048` | `#EBF3EE` |
| `state_update` | `#8A6520` | `#F8F2E6` |
| `router` | `#6B4A8A` | `#F3EDF8` |

## Colour — share ramp

`SHARE_RAMP` (in order): `#62625F` · `#7C7C78` · `#90908C` · `#A8A8A3` · `#C1C1BB`
`SHARE_ORDER`: `anthropic` · `openai` · `google` · `together` · `groq`
`NEUTRAL_SHARE_FLOOR`: `0.75`

## Brand

`BRAND.strong` `#1D1D1B` · `BRAND.secondary` `#2B4851`

---

## Type — the ladder

| Step | Size | Weight | Line height | Used for (as written) |
|---|---|---|---|---|
| `display` | 32 | 600 | 40 | Rare major headings / hero moments |
| `page` | 24 | 600 | 30 | AGENTS, INBOX, major surfaces |
| `section` | 16 | 600 | 22 | BLOCKING, ATTENTION, sections |
| `title` | 16 | 600 | 22 | Agent names, prominent item titles |
| `body` | 14 | 400 | 20 | Descriptions and normal content |
| `label` | 13 | 500 | 18 | Navigation, buttons, controls |
| `caption` | 12 | 400 | 16 | IDs, timestamps, metadata |
| `tiny` | 11 | 500 | 14 | Very small status / secondary details |

Base step: `body`. `section` and `title` are **identical in every number**.

## Type — weights

`regular` 400 · `medium` 500 · `semibold` 600 · `bold` 700

Shipped as font files: **400, 500, 600 only.** 700 is on the ladder and off the bundle.

## Type — families

- Sans: `Geist Sans, system-ui, -apple-system, Segoe UI, sans-serif`
- Mono: `Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace`

Two families and no third. A display serif was previously used on pre-session screens and was removed.

## Type — roles

| Role | Classes |
|---|---|
| `panelLabel` | `text-tiny uppercase tracking-wider text-faint` |
| `sectionLabel` | `text-tiny uppercase tracking-wider text-muted` |
| `title` | `text-label text-ink` |
| `body` | `text-caption text-ink` |
| `meta` | `text-tiny text-muted` |

---

## Spacing

A 4px grid, named by relationship rather than by number:

| Token | px | Class | Between |
|---|---|---|---|
| `tight` | 8 | `mt-2` | rows in the same group |
| `header` | 10 | `mt-2.5` | a section header and its first row |
| `section` | 20 | `mt-5` | two distinct sections |
| `block` | 24 | `mt-6` | two distinct moments |

## Radii

| Token | px | For |
|---|---|---|
| `chip` | 4 | chips, badges, inline code — under ~22px tall |
| `control` | 6 | buttons, inputs, tabs, rows, popover items — 24–36px |
| `card` | 10 | cards, popovers, panels |
| `modal` | 14 | modals and the composer |

A pill is off this scale and stays `rounded-full`.

## Icon sizes

| Token | px |
|---|---|
| `badge` | 10 |
| `xs` | 12 |
| `sm` | 14 |
| `md` | 16 |
| `strokeWidth` | 1.75 |

Wordmark, off the icon ladder: `chrome` 18 · `screen` 26 · `hero` 40.

## Shadows

| Token | Value |
|---|---|
| `flat` | `none` |
| `raised` | `0 1px 2px rgba(29,29,27,0.06)` |
| `floating` | `0 2px 6px rgba(29,29,27,0.06), 0 12px 28px -8px rgba(29,29,27,0.1)` |
| `overlay` | `0 4px 12px rgba(29,29,27,0.08), 0 28px 64px -16px rgba(29,29,27,0.16)` |
| `FOCUS_RING` | `0 0 0 1px #2B4851, 0 0 0 4px rgba(43,72,81,0.16)` |
| `GLOW.hover` | `0 0 0 1px #C9C9C4, 0 0 32px -10px rgba(29,29,27,0.12)` |
| `GLOW.cta` | `0 0 0 4px rgba(29,29,27,0.07)` |

Border pairings: `flat` → `BORDER.subtle`; `raised` / `floating` / `overlay` → `BORDER.default`.

## Layers

`content` 0 · `sticky` 10 · `panel` 20 · `menu` 30 · `overlay` 40 · `modal` 50

## Motion

| Token | Value |
|---|---|
| `fast` | 120 ms |
| `base` | 180 ms |
| `ease` | `cubic-bezier(0.2, 0, 0, 1)` |

---

## Window

| | |
|---|---|
| Default size | 1440 × 900 |
| **Minimum size** | **1024 × 680**, enforced by the shell (`src-tauri/src/window.rs:29`) |
| Resizable | yes |
| Centred on open | yes |
