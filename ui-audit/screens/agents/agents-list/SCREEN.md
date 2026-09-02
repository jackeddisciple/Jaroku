# SCREEN — Agents board

| | |
|---|---|
| **Screen ID** | `AGT-01` |
| **Screen name** | Agents |
| **Route / path** | `navView = "agents"` (rail item 2) |
| **Parent area** | Agents |
| **Purpose** | Every agent in the workspace, as artefacts rather than conversations |
| **Primary user goal** | Find an agent and open it |

## Header controls, left to right

`<workspace> <n> agents` · `search agents…` · funnel (filter) · `Last active ⌄` (sort) ·
**grid / table toggle** · refresh · `+`

## The grid/table toggle

Two icons. Both render **cards**; the right one is a denser card, not a table — no column headers,
no rows, no sortable columns. With one agent in the seed the difference is a slightly narrower card
that drops the thread preview. Recorded in
[`../../../findings/inconsistencies.md`](../../../findings/inconsistencies.md) as a control whose
icon promises a view the product does not have.

## Card anatomy

| Slot | Content |
|---|---|
| avatar | generated agent art (`lib/agentArt.ts`) |
| name | display name |
| slug | monospace-looking but **not** mono — see `typeScale.ts` `MONO_IS_FOR` |
| chips | lifecycle: `IDLE` · `LIVE` · `UNVERIFIED` · `+1` (overflow) |
| hover | a two-line preview of the last thread, plus the model chip (`fake`) |
| footer | `● live` · `1 thread · Quiet` |
| controls | `+` (new thread) · ⧉ (fork) · `⋮` |

## The `⋮` menu

**Fork · Rename · Export current version · Archive** (destructive, red).

This menu renders **outside the card's bounds**, correctly. The Cockpit's fleet card menu does not.
The pair is the clearest before/after in the product — see
[`../../../findings/inconsistencies.md`](../../../findings/inconsistencies.md).

## Data displayed

Name, slug, lifecycle chips, deployment state, thread count, activity descriptor, last model used.

## State list

| State | Screenshot |
|---|---|
| empty | `empty.png` |
| default (grid) | `default.png` |
| table density | `table-density.png` |
| card hover | `card-hover.png` |
| card menu open | `menu-open.png` |
| filter popover | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `lib/agentFilter.ts` |
| sort open | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `Select.tsx` |
| archived agents | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `agents.archived_at`, hidden behind the filter |

## Implementation references

`AgentsView.tsx` (26 KB) · `AgentCard.tsx` · `AgentTagRow.tsx` · `AgentSparkline.tsx` ·
`agentIcons.tsx` · `useAgentKeys.ts` · `store/agentGridStore.ts` ·
`lib/agentFilter.ts`, `agentArt.ts`, `agentStatus.ts`, `agentTags.ts`, `agentExport.ts`,
`agentNav.ts` · channel `agents`
