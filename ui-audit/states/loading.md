# States — loading

## The three mechanisms

| Mechanism | Where | Notes |
|---|---|---|
| **Skeleton at final height** | `ActivityFeed.tsx:157-165` | *"at the viewport's final height so nothing shifts when the page lands"* — `aria-busy`, `aria-label` |
| **Optimistic write** | `accountOnboardingStore.ts:9-13`, Cockpit dispatch | the local state moves immediately and the POST is fire-and-forget |
| **Nothing at all** | most panels | a full snapshot arrives on the channel and the panel goes from empty to populated |

## Why optimistic rather than a spinner

`accountOnboardingStore.ts:9-13`:

> **The write is fire-and-forget, deliberately.** Advancing moves the local step immediately and
> posts … a round trip between pressing Continue and seeing it would make a five-step flow feel like
> a five-step form.

The Cockpit applies the same idea to a dispatch: an optimistic row appears reading **`Sending…`**,
*"quiet, and never a lie"* (`cockpitCopy.ts:272`). `IMPLEMENTED / NOT CURRENTLY OBSERVABLE`.

## The full-snapshot discipline

Almost every channel answers a mutation with **a fresh snapshot of everything**, not a delta. So
most surfaces have no intermediate loading state at all: they are empty, then they are correct.

This is why so few loading states were observable — on localhost the snapshot arrives in
single-digit milliseconds. It is a real characteristic of the product, not a gap in the audit: on a
slow link these surfaces would show their **empty** state, not a loading one.

⚠ **That is a finding.** A panel that renders its empty state while data is in flight tells the
reader *"there is nothing here"* when the truth is *"we have not heard yet"*. See
[`../findings/missing-states.md`](../findings/missing-states.md).

## Observed

| State | Where |
|---|---|
| Sign-in submitting | not observable — the local issuer answers in ~1 ms |
| Workspace switching | `WorkspaceSwitchLock.tsx` — not observable |
| Operate answer streaming | **observed** — the answer appeared after ~4 s with no intermediate indicator |
| Activity feed skeleton | rendered, but visually indistinguishable from empty |
