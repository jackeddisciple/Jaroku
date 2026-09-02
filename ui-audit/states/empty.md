# States — empty

Jaroku's empty states are unusually strong, and the pattern is consistent enough to name.

## The shape

**A figure, a sentence that says what is true, and — when there is one — the action that changes it.**
Never "no data". `EmptyState.tsx` has two variants: `full` (a centred block) and `line` (a single
row), and the choice is about whether the surface has another answer nearby.

## The inventory

| Surface | Copy | Action | Variant |
|---|---|---|---|
| Threads, no threads | *No threads yet* | — | full |
| Threads, filter matched nothing | **Nothing under Running** | — | full |
| Agents, none | *No agents yet* | `+` | full |
| Sidebar RUNS | *No runs yet* | — | line |
| **Cockpit, no agents live** | **No agents are live yet.** + *Deploy an agent from its Deploy panel and it will appear here, with everything it has been asked to do.* | `Open the Deploy panel` | **full** |
| **Cockpit, nothing asked** | **Nothing has been asked of them yet.** | — | **line** — the composer below is the answer |
| **Cockpit, filter matched nothing** | **Nothing here matches this filter.** | `Show everything` | line |
| Inbox ATTENTION | *Nothing to look at* | — | line |
| Inbox PROPOSALS | *Nothing to decide* | — | line |
| Trace | *No trace yet — Run the agent below and every LLM call, tool call and routing decision it makes streams in here.* | — | full |
| Graph | *Nothing to graph yet* + a sentence | — | full |
| Evals | **No evals yet** + *Build a dataset of inputs, run it across providers, and compare quality, latency and cost side by side.* | — | full |
| MCP | **No MCP servers connected** + *Connecting one discovers the tools it offers, so you can give an agent the specific ones it needs — and nothing else.* | `+ Connect a server` | full |
| Composer `⊕` | **Nothing to attach yet** + *Generate an agent, run it, or link it to GitHub…* | — | full |
| Agent detail VERSION HISTORY | *Nothing has been published for this agent yet.* | — | line |
| Agent detail VALIDATOR | *Nothing has been published, so nothing has been validated.* | — | line |
| Agent detail RECENT RUNS | *Nothing has run yet.* | — | line |
| Usage MOST EXPENSIVE RUNS | *No runs this period.* | — | line |
| Activity RUN HEALTH | — *no run has settled in this range* | — | line |
| Activity AGENT LEADERBOARD | — *no agent ran in the last 30 days* | — | line |
| **Activity EVENT FEED** | **nothing rendered** | — | ⚠ **see below** |

## The rule the Cockpit states explicitly

`cockpitCopy.ts:145-151` — three empty states that **must not collapse into one**:

> They must be distinguishable at a glance because they call for three different things: deploy
> something, give it something to do, or undo a filter. **Collapsing any two would tell an operator
> with forty jobs that nothing has been asked of their agents, because they had clicked "failed".**

## Two patterns worth copying

- **The em dash carries a sentence.** Activity and agent detail never show a bare `—`. The Cockpit's
  detail panel goes furthest: four distinct sentences for four reasons a figure is unknown, because
  *"an em dash with no explanation is a figure the reader assumes is a bug in the product rather
  than an absence in the record."*
- **The empty state names the mechanism, not the absence.** MCP's does not say "no servers"; it says
  what connecting one *does*.

## ⚠ The one that breaks the pattern

**Activity's EVENT FEED renders nothing** — no figure, no sentence, no skeleton the eye can see.
The component has both a skeleton and an empty sentence; the skeleton is `bg-hair/40` on a card that
is already near-white, so a feed still loading and a feed that is empty are indistinguishable from
each other and from a rendering fault. Reproduced in two sessions. See
[`../screens/activity/activity-dashboard/SCREEN.md`](../screens/activity/activity-dashboard/SCREEN.md).
