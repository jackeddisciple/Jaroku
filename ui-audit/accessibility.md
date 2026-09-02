# Accessibility observations

**No WCAG conformance is claimed.** Nothing here was measured with an audit tool; these are
observations from the running application and from source.

---

## What is done well

### Every icon-only control has an accessible name

Stated as a rule and applied consistently. `RightPanel.tsx:255-259`:

> The tooltip is not decoration here — **it is the label.** A glyph nobody can name is worse than a
> text button.

And names are **specific** where a generic one would be useless: the fleet card's `⋮` is
`More for Tracey`, because *"twenty identical 'More' buttons in a strip is twenty controls a screen
reader cannot tell apart."*

### Status is never colour alone

Six work statuses, six **marks**, each with a word from `STATUS_WORD` used as the accessible name —
and `waiting` is named **"waiting on you"** rather than "waiting", because the word alone leaves the
reader to guess whether a machine or a person is the blocker. `tokens.ts` states the rule for the
caution colour too: *"it is never the ONLY signal … a word or a mark beside it."*

### Disabled is a colour, not an opacity

`TEXT.disabled` exists as a named token specifically because opacity compounds: *"a faded control
inside a faded panel compounds, which is how a disabled row ends up less legible than the empty
space beside it."*

### Semantic grouping in the Cockpit

`role="group"` with `aria-label="Whose work to show"` and `"Filter by status"` on the two filter
groups; `role="list"` / `role="listitem"` on the fleet strip; `role="menu"` / `role="menuitem"` on
the overflow.

### The focus ring is the accent, and it is the same everywhere

One `FOCUS_RING` value. It is the interaction accent rather than a neutral because *"'where am I' is
the one question a keyboard user asks constantly"* and a grey ring on a grey control answered it
badly.

---

## The detail panel: is it a dialog or a complementary region?

**It is `role="complementary"` (`WorkDetail.tsx:324`), and its behaviour matches.**

| Property | Behaviour |
|---|---|
| Focus trap | **no** — deliberately |
| Background inert | **no** — the list stays live and clickable |
| `Escape` | closes it, and **returns focus to the row that opened it** |
| `aria-hidden` | `!open` |
| `aria-label` | `"Job"` |

Role and behaviour **agree**. A panel that claimed `role="dialog"` and did not trap focus would be
the mismatch; this is the correct pairing.

---

## Do live status changes announce?

**One live region exists** — `WorkList.tsx:467`, `role="status" aria-live="polite"`, visually
hidden.

**It announces `waiting` and nothing else.** Deliberately: every status change announcing would bury
the one that needs a person among five that do not.

⚠ **The consequence is that a job moving `queued → running → failed` is silent to a screen reader.**
A sighted reader sees the glyph change; a screen-reader user is told nothing until a job needs them.
Whether that is the right trade is a design question this audit does not answer — but it is a
deliberate choice, not an omission, and a redesign should know it was made on purpose.

---

## Modal focus and escape

| Surface | Traps focus | `Escape` | Confirming control default-focused |
|---|---|---|---|
| Command palette | yes | closes | n/a |
| Pre-flight gate | yes | cancels | **no — deliberately** |
| Reconnect / Kill dialogs | yes | cancels | **no** |
| Work detail | **no** | closes + restores focus | n/a |
| Popovers / menus | no | closes | n/a |

**No destructive control is focused by default anywhere** — checked in source
(`cockpitCopy.ts:220-221`, `WorkGate.tsx:24-26`) and at runtime on the gate.

---

## Keyboard navigability

| Surface | Verdict |
|---|---|
| Fleet strip | ✓ roving tabindex + arrow keys |
| Threads board | ✓ full `j`/`k`/`↵`/`e`/`p`/`/`/digits grammar |
| Inbox board | ✓ full grammar + `⌘Z` |
| Trace timeline | ✓ `j`/`k`/`↵` |
| **Cockpit work list** | ⚠ **tabbable but not navigable** — no arrow keys, no roving tabindex, no filter field. Every row is a tab stop |
| Command palette | ✓ |
| Right-panel tabs | ✓ |

---

## Motion

`MOTION.fast` 120 ms, `MOTION.base` 180 ms. The Activity skeleton carries
`motion-reduce:animate-none`, so at least one animation respects the reduced-motion preference.
Whether all do was **not** verified.

---

## Contrast — not measured

The palette is a light system with `TEXT.primary #1D1D1B` on `#FBFBFA`, which is a high ratio. The
values most worth measuring in a future pass, and **not** measured here:

- `TEXT.muted` `#90908C` on `CANVAS.surface` `#FBFBFA` — used for the Cockpit's failure sentences,
  every caption and every metadata line
- `TEXT.disabled` `#B5B5B0` on the same
- `STATUS.pending` `#B77A1B` and `STATUS.warn` `#4B78B8` as text
- the four `STEP_TYPE` foregrounds on their pale fills

---

## Not verified

Screen-reader output, tab order beyond the surfaces above, heading structure, form-label
association, reduced-motion coverage, zoom/reflow behaviour, and colour-contrast ratios.
