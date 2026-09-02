# SCREEN — Audit log

| | |
|---|---|
| **Screen ID** | `ACC-02` |
| **Screen name** | Audit |
| **Route / path** | Workspace panel → Audit |
| **Parent area** | Access |
| **Purpose** | What was done in this workspace, by whom, and when |

## Behaviour worth recording

The `audit` channel is **the only channel in the product answered to one socket alone** rather than
broadcast to the workspace (`lib/socket.ts:469-471`). Every other channel sends a full snapshot to
everyone; a read of the audit log goes to the reader who asked.

## Data displayed

One row per event: actor, action, subject, timestamp. The seed holds 33 rows.

## State list

| State | Screenshot |
|---|---|
| default | `default.png` |
| empty | `NOT CURRENTLY OBSERVABLE` — every workspace in the seed has events |

## Implementation references

`WorkspacePanel.tsx` · `store/auditStore.ts` · channel `audit` · `server/src/obs/`
