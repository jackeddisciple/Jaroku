# Components — feedback

## Inventory

| Surface | Component | Trigger | Persistence | Dismissal |
|---|---|---|---|---|
| Sign-in notice | `AuthFlow.tsx` | session expiry | until sign-in | implicit |
| Admin banner | `AdminModeBanner.tsx` | admin mode on | until relaunch | — |
| Enforcement strip | `EnforcementStrip.tsx` | a workspace enforcement | while active | — |
| Invite notice | `InviteNotice.tsx` | a pending invite | until redeemed | — |
| Finish-setup banner | `FinishSetupBanner.tsx` | abandoned onboarding | until complete | — |
| Role refusal | `RoleRefusal.tsx` | role cannot reach the surface | while on it | — |
| Backend failure | `BackendFailure.tsx` | the sidecar died | until recovery | — |
| Inbox undo toast | `InboxUndoToast.tsx` | an inbox action | timed | `⌘Z`, or timeout |
| Thread archive notice | `threadArchive.ts` | `e` on a row | timed | — |
| No-provider-key notice | `BuildPane.tsx` | no key configured | always | `Add a key` |
| Composer refusal | `cockpitCopy.COMPOSER.restored` | a refused dispatch | until retyped | — |
| Empty states | `EmptyState.tsx` | no data | — | — |
| Status bar | `StatusBar.tsx` | always | always | — |
| Live region | `WorkList.tsx:467` | a job enters `waiting` | — | — |
| Window title | `lib/windowTitle.ts` | a job needs a person | while true | — |

## The status bar

Two facts and nothing else: `● connected` (left) and `N deployed` (right). Observed in every
screenshot in this package. It is the only always-present feedback surface.

## Notices that follow the send, not precede it

A pattern worth naming, because two surfaces record having got it wrong first:

- **Thread archive** — the notice's text is captured *while the row still describes what was
  outstanding*, but only shown *if the mutation actually left the tab*. Written the other way, it
  *"claimed 'Archived · discarded a pending diff (+42−11)' over a socket that had silently dropped
  the command."*
- **Inbox undo** — same shape, same reason: *"a toast claiming forty items were dismissed over a
  socket that silently dropped the command."*

## Announcements

`WorkList.tsx:467` is a `role="status" aria-live="polite"` visually-hidden region. It announces
**`waiting` and nothing else** — deliberately. Every status change announcing would make the one
that needs a person indistinguishable from the five that do not.

## The window title as a feedback surface

`lib/windowTitle.ts` + `backgrounded()` in `App.tsx`. The title carries the signed-in identity —
observed as `Jaroku — e2e@jaroku.test`, `Jaroku — Newcomer`, and plain `Jaroku` when signed out.

A **waiting-job title while backgrounded** is `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` —
`windowTitle.ts` and `App.tsx`'s `backgrounded` import evidence it; no job was `waiting`.

## Do two surfaces claim the same item? ⚠

A deployed run waiting on a confirmation could plausibly appear in **both** the Inbox and the
Cockpit. The product refused that: the Cockpit owns it, the Inbox gets a pointer strip, and the
count is computed **once** and rendered in three places (rail badge, Cockpit header, pointer).

So: **no two badges count overlapping sets.** This was checked and it holds. It is worth recording
as a thing the product got right, because it is the failure a redesign would most easily reintroduce.
