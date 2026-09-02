# States — live updates

No other surface in this product has a list that changes while somebody is reading it. This file
exists because that is a genuinely new class of state for Jaroku, and because most of it could not
be observed.

**Nothing in this file was seen moving.** The deployed container in the seed does not answer, so no
job changed state during the audit. Everything below is read from source and marked accordingly, and
nothing was simulated.

## What the design intends

### New items arriving while the reader is scrolled down

A **pill**, not a jump. `cockpitCopy.ts:262-273`:

> **"3 new"** rather than "3 new jobs", because the pill sits at the top of a list of jobs and the
> noun is the list. Pluralised anyway — a pill that read "1 new" beside a hard-coded plural would be
> the `(s)` failure one word further along.

Its title is *"Scroll to the top and show them"* — so content does **not** move under the reader;
the pill offers the move. `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `lib/workLive.ts`,
`workDelta.test.ts`, `workWindow.ts`.

### New items arriving while at the top

Not separately evidenced. The window logic in `lib/workWindow.ts` and the delta logic in
`store/workDelta.test.ts` are where it would live. **UNKNOWN.**

### A status changing in place

The row is keyed by work-item id and the store applies deltas (`workDelta.test.ts`), so a status
change should repaint the glyph in place rather than move the row. **Not observed.**

### Does the list ever reorder?

Rows are ordered by `created_seq` and grouped by day. Nothing in `workStore` re-sorts on status
change, so a running job that fails should **not** jump. **Not observed — UNKNOWN in practice.**

### Under virtualisation, at large row counts

`WorkList.tsx:670` renders a trailing spacer sized to the full list
(`view.totalHeight - view.end * ROW_HEIGHT`), and the Inbox feed uses the same idea — *"the spacer is
the FULL list's height, so the scrollbar is the size of the whole feed rather than of the slice
currently rendered."* Nine rows in the seed; **the virtualiser was never exercised.**

### The strip when it overflows

`overflow-x-auto` on the track with a fade affordance. One card in the seed. **Not observed.**

## What happens when the connection drops mid-run

`store/diagnosticsStore.ts` and `server/src/liveDiagnostics.ts` exist for this. The `StatusBar`
carries `● connected`, which is the one always-visible connection indicator.

**One related state was observed, by accident:** the relay closes an hour-old socket
(`[relay] closing a socket: expired`), and the app fell back to the sign-in screen with *"your
session expired"*. That is the only live disconnection this audit saw, and it is a session expiry
rather than a mid-run drop.

## ⚠ Are stale figures labelled as stale?

**Partly, and the good case is deliberate.** A fleet card that cannot be reached has its sentence
**replaced, not prefixed** (`lib/fleetSentence.ts`):

> "the sentence is replaced, not appended. **'Not connected' and nothing else.** A card that says
> 'not connected · 11 jobs today' invites the reader to wonder which half is current." The counts on
> such a card are stale by construction — nothing has been able to dispatch to it — so carrying them
> would be describing a yesterday the reader has no way to date.

That is the right answer, and it is scoped to the fleet card. **Elsewhere no figure is labelled
stale.** The Cockpit header's count, the rail badge and the Activity cards all render whatever the
last snapshot said, with no age and no staleness marker. A workspace whose socket dropped shows
confident, silently frozen numbers.

## Announcements

One live region, announcing `waiting` only. See [`feedback.md`](feedback.md).

## Summary — what an audit of the moving states would still need

| Question | Answer |
|---|---|
| Does content move under the reader? | **No, by design** — a pill offers the move. Unverified. |
| Does anything animate? | `animate-stream-pulse` on skeletons and in-flight amber. Partly observed. |
| Does the list reorder? | Nothing re-sorts on status change. **UNKNOWN in practice.** |
| What appears when the connection drops mid-run? | `diagnosticsStore`. **Not observed.** |
| Are stale figures labelled? | Fleet card: yes, by replacement. **Everywhere else: no.** |
