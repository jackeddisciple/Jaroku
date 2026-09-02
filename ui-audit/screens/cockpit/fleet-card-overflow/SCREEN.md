# SCREEN — Fleet card overflow menu

| | |
|---|---|
| **Screen ID** | `CKP-05` |
| **Screen name** | Fleet card overflow |
| **Route / path** | the `⋮` on a fleet card |
| **Parent area** | Cockpit |
| **Purpose** | The facts about one deployed agent, and the two verbs that repair or stop it |

## Intended contents

`FleetStrip.tsx:152-205`, in order — **the facts first, the verbs after**, because *"somebody
opening this menu is usually answering 'what is wrong with this agent' rather than reaching for a
control, and putting the probe and the spend above the actions means the commonest use of the menu
costs no press at all"*:

| # | Item | Notes |
|---|---|---|
| 1 | `Today` + the day's spend | moved here from the card's sentence by §4 |
| 2 | the health probe's answer, with its age | **absent when nobody has asked** — a third state, not "unhealthy". *"A card reporting red because it had never been probed would be the product accusing a working agent."* |
| — | hairline | |
| 3 | `Logs` / `Hide logs` | expands `LogPane` **inline, inside the menu** |
| 4 | `Reconnect` | offered at **every** connection state, not only `unconnected` — a token can be rotated on Railway under a card that still reads `connected`, and the repair has to be reachable before the first job fails to prove it |
| — | hairline | the separator is the point |
| 5 | `Kill` | destructive, last, and **never adjacent to a non-destructive control** |

## Observed defect — the menu is clipped by the card and is unusable

**Severity: high. Reproduced twice.**

Opening the menu renders it *inside* the fleet card, and the card is `overflow-hidden`. The menu is
cut off two rows in: the reader sees `Today —` and the top two pixels of the word `Logs`. **`Logs`,
`Reconnect` and `Kill` cannot be read or clicked.**

![The overflow menu, clipped](menu-open.png)

### Cause, verified in source

| Line | Code | Effect |
|---|---|---|
| `FleetStrip.tsx:306` | the card root carries `overflow-hidden` | a **clipping ancestor** |
| `FleetStrip.tsx:136` | the menu's wrapper is `relative z-20`, **inside** that card | the menu is a descendant of the clip |
| `FleetStrip.tsx:155` | the menu is `absolute right-0 top-full z-30` | it opens **below** the trigger, past the card's bottom edge |
| `FleetStrip.tsx:538` | the track is `overflow-x-auto` | a **second** clipping ancestor |

`z-30` cannot escape a clipping ancestor. No z-index can.

### What is unreachable because of it

- **Runtime logs.** `LogPane` (from `AgentOps.tsx`) renders only inside this menu — there is no
  other route to it in the product. The brief asks for "runtime logs view — wherever it renders";
  it renders here, and here is not reachable.
- **Reconnect**, and therefore the whole reconnect/token-rotation flow from the Cockpit.
- **Kill.**
- **Today's spend** and the health probe line, which §4 deliberately moved here.

### The contrast that makes it a finding rather than a bug report

The agent card on the Agents board has the same shape of menu — a `⋮` on a card, a floating list —
and it renders **correctly outside the card**. Two implementations of one pattern, one of which is
clipped.

![The Agents board's card menu, rendering correctly](../../agents/agents-list/menu-open.png)

## The two dialogs behind it

Both are `CockpitDialog`, and both live **outside** the menu's `open` branch so that dismissing the
menu to show the dialog does not unmount the dialog with it (`FleetStrip.tsx:207-228`).

| Verb | Warning, verbatim | Confirm |
|---|---|---|
| **Reconnect** | *This will briefly take the agent offline: setting the token on Railway restarts the service, and any run in flight — including a paused one — loses its checkpoint.* | `Reconnect anyway` |
| **Kill** | *Stopping \<agent\>'s service kills everything running on it. Jaroku cannot bring it back — the service is redeployed from the Deploy panel.* | `Kill it` |

Kill's warning **names the agent**, because *"a dialog that does not name what it is about is one
somebody confirms over the wrong card"*. `Cancel` is never the default focus on either.

`IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — both dialogs are unreachable behind the clip.

## State list

| State | Screenshot |
|---|---|
| menu open (clipped) | `menu-open.png`, `menu-open-2.png` |
| logs expanded | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `AgentOps.tsx` `LogPane` |
| reconnect dialog | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `FleetStrip.tsx:213-219` |
| kill dialog | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `FleetStrip.tsx:220-228` |

## Implementation references

`FleetStrip.tsx:110-260` · `CockpitDialog.tsx` · `AgentOps.tsx` (`LogPane`) · `Capable.tsx` ·
`cockpitCopy.ts:238-258` (`DESTRUCTIVE`)
