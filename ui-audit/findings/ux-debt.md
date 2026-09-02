# Findings — UX debt

Each entry: **problem · location · evidence · user impact · affected flow · screenshot.**
Nothing here was fixed.

---

## 1. The fleet card's overflow menu is clipped, and three verbs are unreachable

- **Location** — Cockpit → fleet strip → any card's `⋮`
- **Evidence** — `FleetStrip.tsx:306` (`overflow-hidden` on the card root), `:136` (menu wrapper
  inside it), `:155` (`top-full`), `:538` (a second clipping ancestor). Reproduced twice.
- **Impact** — **Runtime logs, Reconnect and Kill cannot be reached at all.** Runtime logs have no
  other route in the product; `LogPane` renders only inside this menu. Today's spend and the health
  probe line — which the spec deliberately moved here — are also unreadable.
- **Affected flows** — [`reconnect.md`](../flows/reconnect.md), [`production-failure.md`](../flows/production-failure.md)
- **Screenshot** — [`../screens/cockpit/fleet-card-overflow/menu-open.png`](../screens/cockpit/fleet-card-overflow/menu-open.png)

---

## 2. The work detail panel overprints itself at the minimum supported window size

- **Location** — Cockpit → work detail, at 1024×680
- **Evidence** — reproduced at 1024×700 and at exactly 1024×680. `src-tauri/src/window.rs:29` sets
  that minimum; `:11-15` names the four destinations with a narrow-width fallback and the Cockpit is
  not among them.
- **Impact** — the `WHAT WENT WRONG` heading is drawn on top of the `WHAT WAS ASKED` value box and
  the asked text is cut through the middle. The operator cannot read what the job was asked to do —
  on the screen whose entire purpose is answering that.
- **Screenshot** — [`shots/work-detail-overlap-1024.png`](shots/work-detail-overlap-1024.png)

---

## 3. A brand-new account is shown the closing screen of onboarding

- **Location** — first sign-in, in a session where another account signed in first
- **Evidence** — `audit-newcomer@jaroku.test` rendered `ReadyStep` while the database recorded
  `onboarding_step: 1, onboarded_at: NULL`. Cause: `accountOnboardingStore.ts:84`
  (`if (s.step !== null) return {}`) combined with that store's absence from `store/reset.ts`, which
  resets 25 stores and names only two deliberate exclusions.
- **Impact** — the new user never names a workspace (**the only mandatory step**), is never offered
  a provider key, and is never offered a first agent — and is congratulated for finishing.
- **Affected flow** — [`onboarding.md`](../flows/onboarding.md)
- **Screenshot** — [`../screens/onboarding/account-onboarding/ready-step-shown-to-new-user.png`](../screens/onboarding/account-onboarding/ready-step-shown-to-new-user.png)

---

## 4. An operate thread in `errored` shows no error

- **Location** — Threads → any operate thread whose `status = 'errored'`
- **Evidence** — thread `6fe64cb0` holds eleven `user` messages and five `work` rows and **no
  assistant rows** (verified in `thread_items`). The Threads board row for the same thread shows a
  red glyph and the word `failed`.
- **Impact** — the conversation renders eleven unanswered questions in a row with no notice, no
  retry and no explanation. The list knows something went wrong; the surface a person is actually
  reading does not.
- **Screenshot** — [`../screens/threads/operate-thread/default.png`](../screens/threads/operate-thread/default.png)

---

## 5. Activity's event feed renders nothing — and loading looks identical to empty

- **Location** — Activity → EVENT FEED, at any range
- **Evidence** — reproduced in two separate sessions. `ActivityFeed.tsx:157-170` has both a skeleton
  (`bg-hair/40` at `FEED_HEIGHT`) and an empty sentence (`— nothing happened in …`). Neither is
  legible: `#E6E6E2` at 40% sits on a `#FBFBFA` card.
- **Impact** — the one card on the dashboard whose job is to say what happened shows a blank box. A
  feed still loading and a feed with nothing in it are indistinguishable from each other **and from
  a rendering fault**, while every sibling card answers an empty range with an em dash and a
  sentence.
- **Screenshot** — [`shots/event-feed-blank.png`](shots/event-feed-blank.png)

---

## 6. The command palette hides its most useful entries below an unmarked fold

- **Location** — `⌘K`, root mode
- **Evidence** — at rest the list ends at `Open Deploy`. Scrolling reveals eight more entries
  including **Open the Cockpit** and **Show what is waiting**. No scrollbar, no fade, no affordance.
- **Impact** — "Show what is waiting" is the Cockpit's only urgent question, and reaching it by hand
  is three controls of which the middle one is the one people forget. The palette entry exists
  precisely to avoid that, and it is invisible.
- **Screenshots** — [`../navigation/shots/command-palette-root.png`](../navigation/shots/command-palette-root.png) ·
  [`../navigation/shots/command-palette-scrolled.png`](../navigation/shots/command-palette-scrolled.png)

---

## 7. Opening a card menu and then clicking the rail leaves the nav desynced

- **Location** — Agents board → a card's `⋮` → click a different rail destination
- **Evidence** — reproduced. The menu closes, the Inbox rail item takes the active treatment **and
  keeps it**, and the **Agents view stays on screen**. Two rail destinations render as active at
  once. `navSection` moved; `navView` did not.
- **Impact** — the sidebar — which `uiStore.ts:238-251` describes as *"the single source of
  navigation"* and the reason the app needs no back button — is showing a destination the user is
  not on.
- **Screenshot** — [`shots/nav-desync.png`](shots/nav-desync.png)

---

## 8. The gear opens a popover on the opposite side of the window

- **Location** — the foot of the icon rail
- **Evidence** — the trigger is at roughly (29, 780); the popover renders under the `Dry run (free)`
  control at roughly (1330, 110).
- **Impact** — the pointer is 1300px from the thing that appeared. A gear is also the settings
  glyph, and this does not open settings.
- **Screenshot** — [`../screens/settings/provider-keys/popover-open.png`](../screens/settings/provider-keys/popover-open.png)

---

## 9. The work list cannot be navigated by keyboard, or searched

- **Location** — Cockpit → the record
- **Evidence** — no `onKeyDown` anywhere in `WorkList.tsx`; no roving tabindex; no text field in the
  filter bar. Threads and the Inbox each have a full `j`/`k`/`↵` grammar and a `/` filter.
- **Impact** — the product's one surface built for scanning a long operational record is the one
  that must be scanned with a mouse. At scale every row is a tab stop.

---

## 10. The work row's responsive shedding exists in the comments and not in the CSS

- **Location** — `WorkList.tsx:140-205`
- **Evidence** — the source describes an order (*"the first thing to go"* for the actor column), but
  only the failure sentence carries a breakpoint (`hidden md:block`). Columns 3–6 are `shrink-0`
  with fixed widths and no breakpoint removes any of them.
- **Impact** — at narrow widths the list does not shed columns; the detail panel simply covers them.
  A reader at 1024px sees a truncated input and cannot see the cost or the agent at all.

---

## 11. Loading is expressed as emptiness almost everywhere

- **Location** — most channel-backed panels
- **Evidence** — nearly every channel answers with a full snapshot, so panels go from *empty* to
  *correct* with no intermediate state. On localhost this is invisible.
- **Impact** — on a slow or degraded link a panel says *"No agents are live yet"* when the truth is
  *"we have not heard yet"*. The strongest empty-state copy in the product becomes its most
  confident wrong answer.

---

## 12. A stale tooltip survives its owner

- **Location** — sign-out
- **Evidence** — reproduced twice. The sidebar unmounts; its "Sign out" tooltip is still painted.
- **Impact** — cosmetic, but on the sign-in screen, which is the first thing a returning user sees.

---

## 13. Nothing outside the fleet card is labelled stale

- **Location** — Cockpit header count, rail badges, Activity cards
- **Evidence** — `lib/fleetSentence.ts` replaces a card's sentence entirely when the agent cannot be
  reached, with an explicit argument about not mixing current and stale halves. No other surface
  carries an age or a staleness marker.
- **Impact** — a workspace whose socket has dropped shows confident, silently frozen numbers. The
  one indicator is `● connected` in the status bar.
