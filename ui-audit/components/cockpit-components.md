# Components — Cockpit

Everything the Cockpit introduced, with **new vs reuse** recorded for each, as the brief requires.

| Component | Source | New or reuse? | Behaves identically elsewhere? |
|---|---|---|---|
| **Fleet card** | `FleetStrip.tsx:282-430` | **New** | n/a — only here |
| **Fleet sentence** | `lib/fleetSentence.ts` | **New** (a pure function) | n/a |
| **Work row** | `WorkList.tsx:96-205` | **New** | n/a |
| **Work status glyph** | `WorkGlyph.tsx` | **New** — six marks | n/a |
| **Work detail panel** | `WorkDetail.tsx` | **New** | n/a |
| **Dispatch composer** | `WorkComposer.tsx` | **New** — ⚠ *looks like the build composer, does something very different* | — |
| **Pre-flight gate** | `WorkGate.tsx` | **New**, wrapping `CockpitDialog` | Rendered by **both** composers — one copy, deliberately |
| **`CockpitDialog`** | `CockpitDialog.tsx` | **New** | Used by the gate, Reconnect and Kill |
| **Filter bar** | `WorkList.tsx:343-370` | **New** | ⚠ *unlike Threads' chips: no text field, no digit shortcuts* |
| **New-items pill** | `cockpitCopy.ts:267-273` | **New** | Unobservable |
| **Citation chip** | `server/src/work/citations.ts` + `BuildPane` | **New** | Appears in operate threads only |
| **Sparkline** | `AgentSparkline.tsx` | **Reuse** — also on agent detail and the Agents board | Same rendering; different data window |
| **`StatusDot`** | `StatusBadge.tsx` | **Reuse** — sidebar, agent cards, fleet cards | Same |
| **`Capable`** | `Capable.tsx` | **Reuse** | ⚠ *renders nothing here, where the Cockpit's own spec asks for a stated reason* |
| **`Truncate`** | `Truncate.tsx` | **Reuse** — `variant="prose"` for the input | Same |
| **`LogPane`** | `AgentOps.tsx` | **Reuse** — agent detail's Ops surface | Same component, **unreachable here** (clipped menu) |
| **`DisabledReason`** | `DisabledReason.tsx` | **Reuse** | Used for Cancel and Retry only |
| **`EmptyState`** | `EmptyState.tsx` | **Reuse** | Three distinct copies, per `cockpitCopy.EMPTY` |

## The fleet card

**Anatomy.** Name · `#` (open the operate thread) · version-or-connection · the composed sentence ·
the health strip · `⋮`. The whole card is a target, implemented as an `absolute inset-0` button
**behind** the content so the two inner controls are not nested buttons.

**Variants.** By connection: `connected` (version shown) · `unconnected` / `unauthorised` (label
replaces the version) · `public` (a warning label in `STATUS.warn`).

**States.** default · hover · focused (`focus-within:shadow-focusring`) · **selected** (gains a ring
when its agent filters the list) · menu open.

⚠ **The card is `overflow-hidden` and its menu opens inside it.** See
[`../screens/cockpit/fleet-card-overflow/SCREEN.md`](../screens/cockpit/fleet-card-overflow/SCREEN.md).

## The work row

Six slots plus a conditional failure sentence. Only the failure sentence is responsive
(`hidden md:block`); slots 3–6 are `shrink-0` with fixed widths and **no breakpoint removes any of
them**, despite the source comments describing a shedding order ("the first thing to go" for the
actor column). The order exists in the comments and not in the CSS.

## The status glyph set

Six statuses, six marks, each with an accessible name from `STATUS_WORD`. `waiting` is named
**"waiting on you"** rather than "waiting", because *"'waiting' alone leaves the reader to guess
whether the machine or a person is the blocker — and it is always a person."*

Two of six were observable. `workGlyphs.test.ts` asserts all six are distinct.

## The connection glyph set

Four: `connected` · `unconnected` · `unauthorised` · `public`. Only `connected` observable.

## The detail panel

`role="complementary"`, not a dialog; does not trap focus; `Escape` returns focus to the originating
row. Role and behaviour agree — see [`../screens/cockpit/work-detail/SCREEN.md`](../screens/cockpit/work-detail/SCREEN.md).

## The dispatch composer ⚠

A one-line input and a send button. It has **none** of the build composer's control bar. Two
composers that look alike at a glance and do very different things — one proposes a diff you can
discard, one spends money on a container in the world.
