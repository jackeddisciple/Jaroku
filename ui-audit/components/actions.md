# Components — actions

| Component | Source | Notes |
|---|---|---|
| `buttons.ts` | `components/buttons.ts` | the shared class sets |
| `SplitButton` | `SplitButton.tsx` | a primary plus a menu |
| `ActionRow` | `ActionRow.tsx` | a labelled row of actions |
| `MenuItem` (fleet) | `FleetStrip.tsx:236-260` | *"a component so the four cannot drift in padding or in tone"* |
| `Capable` | `Capable.tsx` | renders children only if the role may act — **absent, not disabled** |
| `DisabledReason` | `DisabledReason.tsx` | disabled **with a stated reason** |
| `Cta` | `onboarding/Cta.tsx` | the one action a screen is asking for; wears `GLOW.cta` |

## The primary button

`bg-ink text-bg` — *"the app's one loud control is its ink turned inside out."* One per screen,
and `GLOW.cta` sits **on** the filled control rather than around it.

## Destructive actions — the graded ladder

`cockpitCopy.ts:226-258`. Three consequences, three weights, and the reason they are graded:

> **Giving all three the same confirmation teaches people to click through all three.**

| Action | Weight | Names the subject? |
|---|---|---|
| **Stop** a job | a single press, no dialog | scoped to an item on screen |
| **Reconnect** an agent | a dialog | no |
| **Kill** an agent's service | a dialog, `destructive`, last in the menu, behind a hairline | **yes** — *"a dialog that does not name what it is about is one somebody confirms over the wrong card"* |

`Cancel` is never the default focus on either dialog. Kill is *"never adjacent to a non-destructive
control"* — the hairline above it is the point.

## ⚠ Where the ladder does not hold

Actions of **very different consequence** elsewhere in the product share one weight, or none:

| Action | Consequence | Confirmation observed |
|---|---|---|
| Archive a thread (`e`) | reversible | **none** — immediate, with a notice after |
| Archive an agent (`⋮`) | reversible | red menu item; no dialog observed |
| `Forget` a deployment | drops the record of live production | **no dialog observed** |
| `Deploy another` | spends money on real hosting | none beyond the button |
| Dispatch a job | spends money, touches the world | **a full gate** |
| Reconnect | restarts a service, other people's runs lose checkpoints | a dialog |
| Kill | ends a service Jaroku cannot restore | a named dialog |

The Cockpit's three are graded carefully against each other. The Deploy panel's two — which are at
least as consequential — are not on the same ladder. See
[`../findings/inconsistencies.md`](../findings/inconsistencies.md).
