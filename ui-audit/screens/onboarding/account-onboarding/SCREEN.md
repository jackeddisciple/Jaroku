# SCREEN — Account onboarding

| | |
|---|---|
| **Screen ID** | `ONB-01` |
| **Screen name** | Account onboarding |
| **Route / path** | none — `AccountOnboarding.tsx` renders over the shell while `onboarded_at` is null |
| **Parent area** | Onboarding |
| **Purpose** | Take a new account from first sign-in to a named workspace and a first agent |
| **Primary user goal** | Get to a working Jaroku without reading anything |

## The flow as implemented

Five steps, stored server-side as `users.onboarding_step` (1–5). The steps are data and the
transitions are arithmetic — `lib/accountOnboarding.ts:14-45`:

```
ONBOARDING_STEPS = ["welcome", "workspace", "provider", "agent", "ready"]
                      1           2            3           4        5
```

| # | Step | Component | What it asks for |
|---|---|---|---|
| 1 | `welcome` | `WelcomeStep.tsx` | nothing — a greeting |
| 2 | `workspace` | `WorkspaceStep.tsx` | a workspace name — **the only truly mandatory step** |
| 3 | `provider` | `ProviderStep.tsx` | a provider key (skippable) |
| 4 | `agent` | `AgentStep.tsx` | a first agent (has a **Skip** beside it) |
| 5 | `ready` | `ReadyStep.tsx` | nothing — "You're all set" |

Completion is not "reached step 5". `countsAsEngaged(step)` is `step >= 3`
(`accountOnboarding.ts:51-68`): somebody who got to step 3 has named a workspace and seen what the
product is for; somebody who bounced off step 1 has seen a greeting.

`FinishSetupBanner.tsx` re-offers an abandoned flow from inside the shell, and the flow can be
restarted from settings via `POST /v1/users/me/onboarding/restart`.

## Entry points

- First sign-in on an account with `onboarded_at IS NULL`
- The **Finish setup** banner in the shell
- Settings → restart onboarding

## Exit points

- `Open Jaroku` on step 5 → the workspace shell
- Skipping step 4 → step 5 (and `startedAnAgent` reads false, which the closing screen is supposed
  to notice — see `accountOnboardingStore.ts:40-48`)

## State list

| State | Screenshot | Notes |
|---|---|---|
| step 1 `welcome` | — | **NOT OBSERVABLE — see the defect below** |
| step 2 `workspace` | — | NOT OBSERVABLE |
| step 3 `provider` | — | NOT OBSERVABLE |
| step 4 `agent` | — | NOT OBSERVABLE |
| step 5 `ready` | `ready-step-shown-to-new-user.png` | Observed — but shown at the wrong time |
| resumed mid-flow | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `accountOnboardingStore.ts:79-92` |

## Screenshot index

| File | State |
|---|---|
| `ready-step-shown-to-new-user.png` | Step 5 rendered to an account sitting at step 1 |

## Implementation references

| Concern | File |
|---|---|
| Flow shell | `client/src/components/onboarding/account/AccountOnboarding.tsx` |
| Steps | `WelcomeStep.tsx`, `WorkspaceStep.tsx`, `ProviderStep.tsx`, `AgentStep.tsx`, `ReadyStep.tsx` |
| Step model | `client/src/lib/accountOnboarding.ts` |
| Store | `client/src/store/accountOnboardingStore.ts` |
| Re-entry banner | `client/src/components/onboarding/account/FinishSetupBanner.tsx` |
| Server | `POST /v1/users/me/onboarding/step` · `/complete` · `/restart` |
| First-run (separate) | `client/src/components/firstrun/FirstRun.tsx`, `store/firstRunStore.ts` |

---

## Observed defect — a brand-new account is shown the closing screen

**Severity: high.** A brand-new account signing in **during a session in which another account has
already signed in** lands directly on step 5, "You're all set", and never sees steps 1–4.

**Reproduced.** Signed out of `e2e@jaroku.test`, signed in as `audit-newcomer@jaroku.test` (an
address with no row in `users`). The screen rendered `ReadyStep`. The database disagrees:

```
email: audit-newcomer@jaroku.test
onboarding_started_at: None
onboarding_step: 1
onboarded_at: None
```

The server says step 1. The UI drew step 5.

**Cause, verified in source.** `accountOnboardingStore.ts:79-85`:

```ts
hydrate: (step) => set((s) => {
  if (s.step !== null) return {};   // ← already hydrated: ignore the server
  ...
})
```

The guard is correct in isolation — it stops the flow flashing step 1 for a frame on every
re-hydration. But `accountOnboardingStore` is **not in the reset registry**
(`client/src/store/reset.ts`), which resets 25 stores on a workspace switch and names its only two
deliberate exclusions as `sessionStore` and `uiStore`. So the store is a module-level singleton
that survives sign-out, still holding `step = 5` from the previous account, and the new account's
hydrate call is discarded.

**Consequence:** the new user never names a workspace (the one mandatory step), is never offered a
provider key, and is never offered a first agent — but is congratulated for finishing.

**Not reproducible from a cold launch**, because the store starts at `step: null` there. This is a
same-session, second-account defect. `firstRunStore` is absent from the same registry.
