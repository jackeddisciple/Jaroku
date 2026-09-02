# SCREEN — Members (Access)

| | |
|---|---|
| **Screen ID** | `ACC-01` |
| **Screen name** | Members |
| **Route / path** | Workspace panel → Members (`workspaceSection = "members"`) |
| **Parent area** | Access |
| **Purpose** | Who is in this workspace, at what role, and what each may reach |
| **Primary user goal** | Add somebody, or change what somebody can do |

## Availability

**Team workspaces only.** The tab is absent on a personal workspace — a conditional in
`WorkspacePanel.tsx:50-69`, and the clearest example in the product of *deny by absence* rather
than *deny with a stated reason*.

## Main content regions

`AccessPanel.tsx` composes five:

| Region | Component | Shows |
|---|---|---|
| People | `AccessPeople.tsx` | each member, their role, and a role select |
| Invites | `AccessInvites.tsx` | pending invites and their links |
| Exposure | `AccessExposure.tsx` | what each agent is reachable by |
| Sessions | `AccessSessions.tsx` | live sessions for this workspace |
| History | `AccessHistory.tsx` | grant and role changes over time |

## Primary actions

- **Invite** → `InviteWithGrantDialog.tsx` — an invite and a per-agent grant in one dialog
- Change a member's role → a `Select` of Member / Admin / Owner
- Grant per-agent access → `GrantDialog.tsx`
- Remove a member → transfers ownership of what they own rather than dropping it (`lib/socket.ts:1636`)

## Required permissions

Owner. Every mutation here is `members`-channel and gated.

## State list

| State | Screenshot |
|---|---|
| default, one member | `default.png` |
| invite dialog open | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `InviteWithGrantDialog.tsx` |
| grant dialog open | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `GrantDialog.tsx` |
| a second member | `NOT CURRENTLY OBSERVABLE` — the seed has one member per workspace |
| permission denied | `NOT CURRENTLY OBSERVABLE` — only `owner` accounts exist in the seed |

## Implementation references

`AccessPanel.tsx` · `AccessPeople.tsx` · `AccessInvites.tsx` · `AccessExposure.tsx` ·
`AccessSessions.tsx` · `AccessHistory.tsx` · `GrantDialog.tsx` · `InviteWithGrantDialog.tsx` ·
`store/accessStore.ts` · `store/memberStore.ts` · `lib/accessList.ts` · `lib/invite.ts` ·
channels `access` and `members`
