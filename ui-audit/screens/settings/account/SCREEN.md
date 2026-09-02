# SCREEN — Account

| | |
|---|---|
| **Screen ID** | `SET-01` |
| **Screen name** | Account |
| **Route / path** | Workspace panel → Account |
| **Parent area** | Settings |
| **Purpose** | The person, not the workspace |

## Contents

Display name, email, email-verified state, marketing opt-in, and sign out.

`users.display_name` is what the window title shows (`lib/windowTitle.ts`), which is why the
sign-in screen asks for it as an optional second field.

## State list

| State | Screenshot |
|---|---|
| default | `default.png` |

## Implementation references

`AccountSection.tsx` · `lib/profile.ts` · `lib/windowTitle.ts` · `server` `/v1/users/me`
