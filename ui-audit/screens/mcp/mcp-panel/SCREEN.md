# SCREEN — MCP

| | |
|---|---|
| **Screen ID** | `MCP-01` |
| **Screen name** | MCP servers |
| **Route / path** | the `mcp` right-panel tab |
| **Parent area** | MCP |
| **Purpose** | Connect third-party tool servers, and grant an agent specific tools from them |

## The standing notice

Pinned above everything, and it is the whole security posture in three sentences:

> **MCP servers are third-party code Jaroku has not reviewed.** What a server says it can do is its
> own claim. Tools from here are marked everywhere they appear, an agent only receives the ones its
> plan asked for, and a high-impact one stops for your confirmation before it runs.

Three mechanisms, each real:

| Promise | Where it lives |
|---|---|
| "marked everywhere they appear" | `ACCENT.mcp` rose + `McpBadge.tsx` |
| "only the ones its plan asked for" | `server/src/mcpRegistry.ts`, per-agent grants |
| "a high-impact one stops for your confirmation" | `McpConfirmModal.tsx`, `server/src/mcpImpact.ts` |

`ACCENT.mcp` is deliberately rose and *deliberately not red* — *"MCP is not an error, and crying wolf
on every external tool would teach people to stop looking"* (`tokens.ts:60-68`).

## Empty state

> **No MCP servers connected**
> Connecting one discovers the tools it offers, so you can give an agent the specific ones it needs
> — and nothing else.

Primary action: `+ Connect a server`.

## State list

| State | Screenshot | Notes |
|---|---|---|
| empty | `empty.png` | Observed |
| discovering | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `server/src/mcpDiscovery.ts`, `mcpDiscoveryQueue.test.ts` |
| connected, tools listed | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `McpPanel.tsx` |
| tool grant | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — reachable also from agent detail's `Grant a tool` |
| high-impact confirmation | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `McpConfirmModal.tsx`, mounted in `App.tsx` |
| failed connection | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `server/src/mcpValidate.ts`, `mcpHardening.test.ts` |

## Implementation references

`McpPanel.tsx` (21 KB) · `McpConfirmModal.tsx` · `McpBadge.tsx` · `store/mcpStore.ts` ·
channel `mcp` · `server/src/mcpClient.ts`, `mcpRegistry.ts`, `mcpDiscovery.ts`, `mcpImpact.ts`,
`mcpManifest.ts`, `mcpStore.ts`, `mcpUrl.ts`, `mcpValidate.ts`
