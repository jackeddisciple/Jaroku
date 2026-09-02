# States — feedback

How this product tells you something happened. See
[`../components/feedback.md`](../components/feedback.md) for the component inventory; this file is
about the behaviour across screens.

## The governing habit: say what is true, after it is true

Two surfaces record having got this wrong and fixed it the same way:

- **Thread archive.** The notice text is captured *while the row still describes what was
  outstanding*, but the notice is only shown *if the mutation actually left the tab*. Written the
  other way it claimed `Archived · discarded a pending diff (+42−11)` over a socket that had
  silently dropped the command.
- **Inbox undo.** Same shape, same reason.

The general rule: **a confirmation is a statement about what happened, not a prediction.**

## Success

There is no success toast anywhere in the product. Success is expressed by **the state changing** —
a row leaving a list, a check landing, a figure updating. The one exception is the archive notice,
which exists because the row leaving is *not* self-explanatory.

## Progress

| Surface | How |
|---|---|
| Deploy | a six-step ladder, each step a check + a clause |
| Trace | steps streaming in |
| Generation | file-write streams |
| Cockpit dispatch | an optimistic `Sending…` row |
| Activity feed | a skeleton — ⚠ invisible |

## Announcements

One live region in the product: `WorkList.tsx:467`, `role="status" aria-live="polite"`. It announces
**`waiting` and nothing else**. Every status change announcing would bury the one that needs a
person among five that do not.

⚠ **The other live surfaces announce nothing.** A job moving `queued → running → failed` is a silent
change to a screen reader; only the transition into `waiting` speaks.

## The window title

Carries the signed-in identity (`Jaroku — e2e@jaroku.test`). `lib/windowTitle.ts` and `App.tsx`'s
`backgrounded()` also drive a waiting-job title while the window is in the background —
`IMPLEMENTED / NOT CURRENTLY OBSERVABLE`.
