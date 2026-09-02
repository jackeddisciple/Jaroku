# Flow — onboarding

**Goal.** From first sign-in to a named workspace and a first agent.

## Two separate mechanisms

| | Account onboarding | First run |
|---|---|---|
| Store | `accountOnboardingStore` | `firstRunStore` |
| Component | `components/onboarding/account/` | `components/firstrun/FirstRun.tsx` |
| Persisted | `users.onboarding_step` (server) | client-side |
| Scope | the person | the workspace's first agent |

## The five steps

`welcome` → `workspace` → `provider` → `agent` → `ready`

- **`workspace` is the only truly mandatory step.**
- **`agent` has a Skip beside it**, and the store tracks whether an agent was actually started, so
  the closing screen does not congratulate somebody for an agent they skipped
  (`accountOnboardingStore.ts:40-48`; commit `7b04008`).
- **Completion is not "reached step 5"** — `countsAsEngaged` is `step >= 3`: somebody who got to
  step 3 has named a workspace and seen what the product is for; somebody who bounced off step 1 has
  seen a greeting.
- **Resume lands where you left off**, and steps already completed are not re-done.
- **Restart** is available from settings.

## ⚠ What was actually observed

A brand-new account went straight to **step 5**. See
[`../screens/onboarding/account-onboarding/SCREEN.md`](../screens/onboarding/account-onboarding/SCREEN.md)
and [`../findings/ux-debt.md`](../findings/ux-debt.md) §3.

## The closing screen — observed

> **You're all set**
> A few things to try next:
> • Describe the agent you want, in the composer
> • Approve the plan you get back — nothing is written until you do
> • Add a provider key in Secrets to run on a real model
> `Open Jaroku`

Three next actions, in the order the product wants them, each naming a real surface.
`ReadyStep.tsx:14` records why they are concrete: *"a closing screen that said 'you're all set!'"*
names a feeling; these name **"the Graph tab", "the composer"**.

## Unresolved gaps

Steps 1–4 were unreachable. See the defect.
