# SCREEN — Secrets

| | |
|---|---|
| **Screen ID** | `SEC-01` |
| **Screen name** | Secrets |
| **Route / path** | the `secrets` right-panel tab |
| **Parent area** | Secrets |
| **Purpose** | Credentials an agent needs at runtime |

## The gate — what is actually observable

The tab does not open onto a list. It opens onto a **passcode gate** (`SecretsGate.tsx`):

> **Set a secrets passcode**
> Asked for whenever you open Secrets. It protects this view — **it does not encrypt your secrets.**
>
> New passcode · Confirm · `Verify identity & save`
>
> 🔒 Six to twelve characters, and it is per person, not per workspace.

Three things are stated that a lesser screen would leave implicit: **what the passcode does**, **what
it explicitly does not do** ("it does not encrypt your secrets"), and **its scope** ("per person, not
per workspace"). The honesty about the second is the notable part — the gate refuses to be mistaken
for encryption.

The workspace's `secrets_gate` column is `'tab'` on every seeded workspace.

## Elevation

`GET /v1/secrets/elevation` and `GET /v1/secrets/health` are polled once a minute (visible in
`~/.jaroku/logs/desktop.log`). Without an elevation, `GET /v1/secrets` answers **403** — observed in
the log, and the correct behaviour.

## State list

| State | Screenshot | Notes |
|---|---|---|
| gate — set a passcode | `empty.png` | Observed |
| gate — enter a passcode | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `SecretsGate.tsx`; 1 row in `user_secret_passcodes` |
| list, elevated | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `SecretsList.tsx` (23 KB) |
| health warning / rotation due | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — the right rail's credential badge, `RightPanel.tsx:278` |
| deletion | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — a destructive action, see `findings/` |

## Screenshot safety

No secret value is rendered anywhere in this area by design — the gate is what is observable, and it
contains no credential. Agent detail states the same rule for its own list: *"CREDENTIALS — names
only, no value is ever carried here."*

## Implementation references

`SecretsPanel.tsx` (23 KB) · `SecretsGate.tsx` · `SecretsList.tsx` · `store/secretsStore.ts` ·
`lib/secrets.ts` · `server/src/secrets/`, `secretScan.ts`, `envWriter.ts` ·
`src-tauri/src/secrets.rs` (the session token → OS credential store)
