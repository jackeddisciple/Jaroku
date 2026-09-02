# Components — agent

| Component | Source | Purpose |
|---|---|---|
| `AgentCard` | `AgentCard.tsx` (19 KB) | the board's card |
| `AgentTabs` | `AgentTabs.tsx` (32 KB) | detail's four sub-tabs |
| `AgentDetail` | `AgentDetail.tsx` | identity + rename |
| `AgentOverview` | `AgentOverview.tsx` | the stat row |
| `AgentVersions` | `AgentVersions.tsx` | version history |
| `AgentFiles` | `AgentFiles.tsx` | the file tree |
| `AgentOps` | `AgentOps.tsx` | ops surface — **and `LogPane`, which the Cockpit reuses** |
| `AgentSparkline` | `AgentSparkline.tsx` | recent runs |
| `AgentTagRow` | `AgentTagRow.tsx` | tags |
| `agentIcons.tsx` | | the glyph set |
| `lib/agentArt.ts` | | generated avatar + hero art |

## Lifecycle chips

`IDLE` · `LIVE` · `UNVERIFIED` · `+n`. Rendered on both the card and detail, identically.

## ⚠ `LogPane` is shared and reachable from one of its two homes

`AgentOps.tsx` owns `LogPane`. Agent detail can render it; the Cockpit's fleet-card menu also
renders it — and that menu is clipped, so the Cockpit's copy is unreachable. Same component, two
call sites, one of them dead in practice.
