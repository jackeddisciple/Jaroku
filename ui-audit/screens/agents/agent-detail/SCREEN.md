# SCREEN — Agent detail

| | |
|---|---|
| **Screen ID** | `AGT-02` |
| **Screen name** | Agent detail |
| **Route / path** | the `agent` right-panel tab — **a tab, not a fourth column** |
| **Parent area** | Agents |
| **Purpose** | Everything about one agent that is not a conversation |
| **Primary user goal** | Understand what this agent is made of and how it is doing |

## Why it is a tab

`uiStore.ts:59-71` records the reasoning. The layout law says clicking a card "restores the 3-pane
layout with that entity selected", and this app's three panes are the sidebar, the composer and the
right panel. Making detail a fourth column would have put the trace, the graph and every other tab
out of reach for anybody who arrived from the Agents board. As a tab, Trace is one click away rather
than a navigation away.

The tab **only appears once an agent has been opened from the Agents board** — it is absent from the
rail otherwise.

## Regions, top to bottom

1. **Hero art** — a generated banner (`lib/agentArt.ts`, `agentArtFiles.ts`)
2. **Identity** — name + a pencil (rename) · slug chip · version chip
3. **Lifecycle chips** — `IDLE` `LIVE` `UNVERIFIED` `+1`
4. **Stat row** — `CREATED` · `COST TO BUILD` · `LIVE VERSION` · `RUNS, 7 DAYS`
5. **VERSION HISTORY** — collapsible, with a count
6. **FILES** — collapsible
7. **Sub-tabs** — Capabilities · Health · Deploy · Evals

### Capabilities

| Group | Sub-label | Seed value |
|---|---|---|
| `REVIEWED CONNECTORS` | *audited templates, copied in verbatim* | None. |
| `GRANTED MCP TOOLS` | *third-party code Jaroku has not reviewed* | None granted. — with a `Grant a tool` control |
| `CREDENTIALS` | *names only — no value is ever carried here* | — |

The three sub-labels are the product's provenance model stated in the UI, and they map onto
`ACCENT.reviewed` (teal), `ACCENT.mcp` (rose) and `ACCENT.bespoke` (violet) in
[`../../../legacy/design-arguments.md`](../../../legacy/design-arguments.md).

### Health

`VALIDATOR` — *the verdict on the live version* — plus `RECENT RUNS` (*the last ~20 — click a bar to
open its trace*), `ERROR RATE` and `RUNS, 7 DAYS`.

## Data displayed — and a contradiction

For the agent `Tracey`, which has a **live Railway deployment and nine dispatched jobs**, this
screen reads:

- `LIVE VERSION` **v1**
- `RUNS, 7 DAYS` **0**
- `VERSION HISTORY` — *Nothing has been published for this agent yet.*
- `VALIDATOR` — *Nothing has been published, so nothing has been validated.*
- `RECENT RUNS` — *Nothing has run yet.*
- `ERROR RATE` — *—*

Meanwhile the Cockpit fleet card, the pre-flight gate and every work detail for the same agent read
**v3**, and the Cockpit header reads **9**.

Both are literally true and they are reading different tables: `agents.current_version` is 1 and
`deployments.version` is 3; `runs` holds nothing for this workspace while `work_items` holds nine.
The screen labels the first of each pair with words that claim the second — "LIVE VERSION" is the
deployment's fact, not the agent row's, and "RUNS, 7 DAYS: 0" is said on the profile of an agent
that ran nine jobs this week.

Recorded in full in [`../../../findings/inconsistencies.md`](../../../findings/inconsistencies.md).

## State list

| State | Screenshot |
|---|---|
| Capabilities | `capabilities.png` |
| Health | `health.png` |
| Deploy | `deploy.png` |
| Evals | `evals.png` |
| renaming | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — the pencil, `AgentDetail.tsx` |
| version history populated | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `AgentVersions.tsx`; 2 rows exist in `agent_versions` but for other agents |
| archived | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `agents.archived_at` |

## Related screens

The Cockpit fleet card is the same agent seen as a deployment; the Deploy panel is the same
deployment seen as a pipeline.

## Implementation references

`AgentTabs.tsx` (32 KB) · `AgentDetail.tsx` · `AgentOverview.tsx` · `AgentFiles.tsx` ·
`AgentVersions.tsx` · `AgentOps.tsx` (also owns `LogPane`) · `AgentSparkline.tsx` ·
`InboxPointer.tsx` · `store/agentGridStore.ts` · `lib/agentContext.ts`, `agentStatus.ts` ·
channels `agents`, `agentFiles`
