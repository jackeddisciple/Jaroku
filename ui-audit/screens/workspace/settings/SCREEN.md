# SCREEN — Workspace panel

| | |
|---|---|
| **Screen ID** | `WS-03` |
| **Screen name** | Workspace panel |
| **Route / path** | overlay panel; section held in `uiStore.workspaceSection` |
| **Parent area** | Workspace / Settings |
| **Purpose** | Everything about the workspace itself, and the account |

## Sections

`SECTIONS` in `WorkspacePanel.tsx:50-69`:

| Section | Shown when | Contents |
|---|---|---|
| General | always | workspace name, slug, secrets gate, default reasoning effort, default permission mode |
| **Members** | **team workspaces only** | member list, roles, invites, per-agent grants |
| Audit | always | the workspace audit log |
| Billing | always | plan, seats, usage against ceiling, upgrade |
| Data | always | export, retention, deletion |
| Account | always | display name, email, marketing opt-in, sign out |

**Members is conditional and this is visible in the screenshots.** A personal workspace shows five
tabs (`general-*.png` vs `general-team.png` — the team workspace shows six).

## Roles

`ROLES` in `WorkspacePanel.tsx:78-82`, and the wording is cumulative:

| Role | What it can do |
|---|---|
| Member | Build, run, edit and evaluate agents |
| Admin | …and connect keys, servers, repositories and deployments |
| Owner | …and membership, billing, and the workspace itself |

## Related surfaces — and a duplication

`WorkspacePanel.tsx:249-252` defines a set of cards pointing at right-panel tabs:

| Card | Points at | Description as written |
|---|---|---|
| Usage | the `usage` right tab | "What this workspace has spent, and against which ceiling" |
| Secrets | the `secrets` right tab | "Credentials, their health, and when each was last rotated" |
| Connections | the `connections` right tab | "Accounts this workspace's agents may act on behalf of" |
| **Integrations** | the **`github`** right tab | "Where each agent's code goes, its checks and its scan findings" |

The fourth card is labelled **Integrations** and opens the tab labelled **GitHub**. One surface,
two names. See [`../../../findings/inconsistencies.md`](../../../findings/inconsistencies.md).

## State list

| State | Screenshot |
|---|---|
| General (personal) | `general.png` |
| General (team) | `general-team.png` |
| Data | `data.png` |
| Members | [`../../access/members/default.png`](../../access/members/default.png) |
| Audit | [`../../access/audit/default.png`](../../access/audit/default.png) |
| Billing | [`../../billing/plan/free.png`](../../billing/plan/free.png) |
| Account | [`../../settings/account/default.png`](../../settings/account/default.png) |

## Implementation references

`client/src/components/WorkspacePanel.tsx` (65 KB — the second-largest file in the client) ·
`AccessPanel.tsx` · `BillingSection.tsx` · `AccountSection.tsx` · `store/memberStore.ts` ·
`store/auditStore.ts` · `store/billingStore.ts`
