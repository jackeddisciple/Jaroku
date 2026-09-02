# SCREEN — Workspace switcher

| | |
|---|---|
| **Screen ID** | `WS-02` |
| **Screen name** | Workspace switcher |
| **Route / path** | popover, anchored under the sidebar's workspace chip |
| **Parent area** | Workspace |
| **Purpose** | Move between workspaces, and reach a workspace's settings |

## Entry points

The chevron on the sidebar's workspace chip.

## Exit points

- Selecting a workspace → a full store reset and a **new socket** (`store/reset.ts:10-19`)
- `… settings` → the Workspace panel
- Creating a workspace → the new workspace, switched into

## Main content regions

1. The current workspace, marked
2. Other workspaces this account is a member of, each with its kind and plan
3. `<workspace> settings`
4. `New workspace`

## Data displayed

Workspace name, kind (`personal` / `team`), plan, and membership role.

## Behaviour worth recording

Switching does **not** reset `uiStore`, on purpose (`store/reset.ts:61-66`): the person stays on the
destination they were on and the app re-fetches for the new scope. Everything workspace-scoped —
25 stores — is reset, because a `traceStore` still holding another workspace's run would be a
tenancy leak wearing a rendering bug's clothes.

## State list

| State | Screenshot |
|---|---|
| menu open | `menu-open.png` |
| switching | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `WorkspaceSwitchLock.tsx` |

## Implementation references

`client/src/components/WorkspaceSwitcher.tsx` (30 KB) · `WorkspaceSwitchLock.tsx` ·
`client/src/lib/workspaceSwitch.ts` · `client/src/store/reset.ts` · `lib/socket.ts` `switchWorkspace`
