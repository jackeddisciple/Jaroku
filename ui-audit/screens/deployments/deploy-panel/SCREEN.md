# SCREEN — Deploy

| | |
|---|---|
| **Screen ID** | `DEP-01` |
| **Screen name** | Deploy |
| **Route / path** | the `deploy` right-panel tab |
| **Parent area** | Deployments |
| **Purpose** | Package an agent and put it on the user's own hosting |
| **Primary user goal** | Get this agent to a URL |

## The standing notice

Present in both states, at the top:

> A deploy goes to your own Railway account. Jaroku packages the agent, hands your credentials to
> Railway over HTTPS, and returns the URL. **It hosts nothing and keeps no copy of anything it
> sends.**

## Not-connected state — observed

`⏱ No Railway token` · `Connect Railway`

Below it, the six-step ladder is shown greyed as a preview of what a deploy does.

## Live state — observed

The `e2e@jaroku.test` workspace holds a real deployment row.

| Element | Value |
|---|---|
| agent chip | `✓ Tracey` |
| service line | `✓ tracey  anthropic/claude-haiku-4-5` · right-aligned `live for 2d 19h` |
| URL | `🌐 http://127.0.0.1:4599` |
| footer | `Deploy another` · `Forget` |

### The six-step ladder

Each step is a check plus a plain-English clause:

| Step | Clause |
|---|---|
| Packaged | writing the Dockerfile and serve wrapper into the project |
| Provisioned | creating a project and service in your Railway account |
| Set variables | handing the agent's credentials to Railway |
| Uploaded | sending the project to Railway |
| Built | Railway is building the image |
| Published | pointing a public URL at the service |

## Screenshot safety

The URL shown is `http://127.0.0.1:4599` — a loopback address from the local seed, not a real
deployment endpoint. No bearer token, run token or Railway project id appears in either screenshot.
Checked specifically.

## Relationship to the Cockpit

This panel is the **same deployment** the Cockpit's fleet card describes, seen as a pipeline rather
than as a fleet member. It reports `version 3`; so does the fleet card. Agent detail reports `v1` —
see [`../../agents/agent-detail/SCREEN.md`](../../agents/agent-detail/SCREEN.md).

## State list

| State | Screenshot | Notes |
|---|---|---|
| not connected | `not-connected.png` | Observed |
| live | `live.png` | Observed |
| provisioning / starting / building | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `deployStore.ts`, `server/src/deployManager.ts` |
| degraded | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `server/src/agentHealth.ts` |
| failed | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `deployments.error` |
| stopped | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — after a Kill |
| updating / rollback | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `server/src/deployReconcile.ts` |

## Destructive actions on this screen

| Action | Confirmation |
|---|---|
| `Forget` | forgets the deployment record — **no dialog observed** |
| `Deploy another` | starts a real deploy against the user's account |

Compare the Cockpit's `Kill`, which has a full named dialog. See
[`../../../findings/inconsistencies.md`](../../../findings/inconsistencies.md).

## Implementation references

`DeployPanel.tsx` (34 KB) · `store/deployStore.ts` + `deployStore.test.ts` · channel `deploy` ·
`server/src/deployManager.ts`, `deployOps.ts`, `deployStore.ts`, `deployRuns.ts`,
`deployArtifacts.ts`, `deploySecrets.ts`, `deployRunToken.test.ts`, `railwayApi.ts`,
`railwayCli.ts`, `dockerfile.ts`
