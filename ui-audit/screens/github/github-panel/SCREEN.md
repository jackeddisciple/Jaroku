# SCREEN — GitHub

| | |
|---|---|
| **Screen ID** | `GH-01` |
| **Screen name** | GitHub |
| **Route / path** | the `github` right-panel tab |
| **Parent area** | GitHub — **an area the audit brief's folder list does not name** |
| **Purpose** | Put each agent's generated code in the user's own repository |

This is one of two substantial product areas outside the brief's list. It is not small: seven
components totalling ~150 KB, its own store, its own channel and a webhook path on the server.

## Not-connected state — observed

> **Your agent's code, in your repo**
> Every version you apply becomes a commit. Jaroku pushes. You own the repo.
>
> `⬛ Connect GitHub`
>
> You pick the repositories on GitHub's own screen, and Jaroku gets **code**, **pull requests**,
> **checks** and **workflows** on those and nothing else. Change or revoke it any time from GitHub
> settings.
>
> Nothing is copied or pasted. Jaroku holds no long-lived key for your account — **access is issued
> for an hour at a time and renewed while the installation is live.**

Four scopes are named inline, emphasised, and bounded ("on those and nothing else"). The last
paragraph states the credential lifetime, unprompted.

## Components behind the connected state

| Component | Size | Purpose |
|---|---|---|
| `GitHubPanel.tsx` | 40 KB | the shell |
| `GitHubSync.tsx` | 27 KB | sync state |
| `GitHubHistory.tsx` | 31 KB | commit history |
| `GitHubStaging.tsx` | 23 KB | what will be pushed |
| `GitHubAttach.tsx` | 21 KB | attaching a repo |
| `GitHubChecks.tsx` | 11 KB | CI checks |
| `GitHubCommitBox.tsx` | 10 KB | the commit message |

## The naming conflict

This tab is labelled **GitHub** in the right rail. The Workspace panel's card for the **same tab** is
labelled **Integrations** (`WorkspacePanel.tsx:252`). One surface, two names — see
[`../../../findings/inconsistencies.md`](../../../findings/inconsistencies.md).

## Badge

The right rail carries a GitHub badge (`RightPanel.tsx:108`, `title={`GitHub: ${badge}`}`) — the only
right-panel tab with one.

## State list

| State | Screenshot | Notes |
|---|---|---|
| not connected | `not-connected.png` | Observed |
| connected / synced / ahead / behind | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — no GitHub App installed |
| checks running / failing | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `GitHubChecks.tsx`, `server/src/checkRunner.ts` |
| staging a commit | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `GitHubStaging.tsx` |
| scan findings | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `server/src/secretScan.ts` |

## Implementation references

`GitHubPanel.tsx` · `GitHubSync.tsx` · `GitHubHistory.tsx` · `GitHubStaging.tsx` ·
`GitHubAttach.tsx` · `GitHubChecks.tsx` · `GitHubCommitBox.tsx` · `store/githubStore.ts` ·
channel `github` · `server/src/githubApp.ts`, `githubApi.ts`, `githubService.ts`,
`githubWebhook.ts`, `githubSync.ts`, `githubPush.ts`, `githubTrailers.ts`, `unpushedStack.ts`
