# Flow — connect an MCP server and grant a tool

| # | Step | Observed |
|---|---|---|
| 1 | Open the `mcp` tab; read the standing notice | ✓ |
| 2 | `+ Connect a server` | ✗ |
| 3 | Discovery lists the tools it offers | ✗ |
| 4 | Grant specific tools to an agent — *"and nothing else"* | ✗ (the `Grant a tool` control is visible on agent detail) |
| 5 | Tools are marked wherever they appear | ✗ (`McpBadge`, `ACCENT.mcp`) |
| 6 | A high-impact call stops for confirmation | ✗ (`McpConfirmModal`) |

The notice is the whole posture: *"MCP servers are third-party code Jaroku has not reviewed. What a
server says it can do is its own claim."*

Only steps 1 and the agent-detail control were observable.
