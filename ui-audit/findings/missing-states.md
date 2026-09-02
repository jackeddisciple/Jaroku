# Findings — missing / incomplete states

Labels: **MISSING** · **PARTIAL** · **IMPLEMENTED / NOT EXPOSED** · **UNKNOWN**

"IMPLEMENTED / NOT EXPOSED" means the code exists and this environment could not reach it — a
limitation of the audit, not of the product. **MISSING** means no evidence of the state exists.

---

## Cockpit — states that only exist under failure or at scale

This is where the brief expects the most valuable answers, and it is right to.

| State | Verdict | Evidence / note |
|---|---|---|
| An agent that **stopped reporting** | **IMPLEMENTED / EXPOSED** ✓ | Observed, twice, with a hedged sentence and a verbatim block |
| A **token rotated outside the product** (`unauthorised`) | **IMPLEMENTED / NOT EXPOSED** | `cockpitCopy.ts:119`; the repair (`Reconnect`) is **unreachable** behind the clipped menu |
| A workspace with **forty deployed agents** | **UNKNOWN** | one card in the seed; the strip's overflow and fade were never exercised |
| A work list with **ten thousand rows** | **UNKNOWN** | `WorkList.tsx:670` has a virtualiser spacer; nine rows in the seed |
| A **dropped connection mid-run** | **MISSING (in the UI)** | `diagnosticsStore`, `liveDiagnostics.ts` exist server-side; **no Cockpit surface shows a mid-run disconnection**, and no figure is marked stale |
| A job **waiting on a person** | **IMPLEMENTED / NOT EXPOSED** | the amber edge marker, the badge, the live region and the `CockpitPointer` all key off it |
| **Runtime logs** | **IMPLEMENTED / NOT EXPOSED — and unreachable by defect** | `LogPane` renders only inside the clipped menu |
| An **optimistic dispatch row** | **IMPLEMENTED / NOT EXPOSED** | `cockpitCopy.ts:272` |
| The **new-items pill** | **IMPLEMENTED / NOT EXPOSED** | `cockpitCopy.ts:267-271` |
| A **public** endpoint's warning | **IMPLEMENTED / NOT EXPOSED** | `WorkGate.tsx:56-58` |

---

## Per-screen state coverage

| Screen | Empty | Loading | Error | Success | Permission | Recovery | Responsive |
|---|---|---|---|---|---|---|---|
| Sign in | n/a | **MISSING** | ✓ (expiry) | ✓ | n/a | ✓ | ✓ |
| Onboarding | n/a | **PARTIAL** (optimistic) | **UNKNOWN** | ✓ | n/a | ✓ (banner) | **UNKNOWN** |
| Workspace shell | ✓ | **MISSING** | **UNKNOWN** | n/a | IMPL/NOT EXPOSED | n/a | ✓ |
| Threads board | ✓✓ | **MISSING** | **UNKNOWN** | n/a | n/a | ✓ | ✓ |
| Build thread | ✓ | IMPL/NOT EXPOSED | IMPL/NOT EXPOSED | IMPL/NOT EXPOSED | n/a | ✓ | ✓ |
| **Operate thread** | ✓ | **MISSING** | **MISSING** ⚠ | ✓ | n/a | **MISSING** | ✓ |
| Agents board | ✓ | **MISSING** | **UNKNOWN** | n/a | IMPL/NOT EXPOSED | n/a | ✓ |
| Agent detail | ✓✓ | **MISSING** | **UNKNOWN** | n/a | IMPL/NOT EXPOSED | n/a | **UNKNOWN** |
| **Cockpit work list** | ✓✓✓ | **MISSING** | **UNKNOWN** | n/a | **PARTIAL** | ✓ | **PARTIAL** ⚠ |
| **Cockpit work detail** | n/a | **MISSING** | ✓✓ | ✓ | ✓ (2 of 5) | ✓ | **BROKEN** ⚠ |
| Fleet strip | ✓ | **MISSING** | IMPL/NOT EXPOSED | n/a | ✗ absent | ✓ | **UNKNOWN** |
| Trace | ✓ | IMPL/NOT EXPOSED | IMPL/NOT EXPOSED | ✓ | n/a | n/a | ✓ |
| Graph | ✓ | IMPL/NOT EXPOSED | ✓ | n/a | n/a | ✓ (`Try again`) | ✓ |
| Evals | ✓ | IMPL/NOT EXPOSED | IMPL/NOT EXPOSED | IMPL/NOT EXPOSED | n/a | **UNKNOWN** | **UNKNOWN** |
| Deploy | ✓ | IMPL/NOT EXPOSED | IMPL/NOT EXPOSED | ✓ | IMPL/NOT EXPOSED | **UNKNOWN** | **UNKNOWN** |
| Connections | ✓ | **MISSING** | IMPL/NOT EXPOSED | IMPL/NOT EXPOSED | ✓✓ | ✓ | **UNKNOWN** |
| MCP | ✓ | IMPL/NOT EXPOSED | IMPL/NOT EXPOSED | IMPL/NOT EXPOSED | IMPL/NOT EXPOSED | **UNKNOWN** | **UNKNOWN** |
| Secrets | ✓ (gate) | **MISSING** | IMPL/NOT EXPOSED | IMPL/NOT EXPOSED | ✓ (403) | **UNKNOWN** | **UNKNOWN** |
| GitHub | ✓ | IMPL/NOT EXPOSED | IMPL/NOT EXPOSED | IMPL/NOT EXPOSED | IMPL/NOT EXPOSED | **UNKNOWN** | **UNKNOWN** |
| Usage | ✓ | **MISSING** | **UNKNOWN** | n/a | n/a | n/a | **UNKNOWN** |
| Inbox | ✓✓ | **MISSING** | **UNKNOWN** | ✓ (undo) | **UNKNOWN** | ✓ | ✓ |
| **Activity** | ✓ except the feed ⚠ | **PARTIAL — invisible** ⚠ | **UNKNOWN** | n/a | n/a | n/a | ✓ |
| Billing | ✓ | **MISSING** | **UNKNOWN** | IMPL/NOT EXPOSED | IMPL/NOT EXPOSED | **UNKNOWN** | **UNKNOWN** |
| Members | ✓ | **MISSING** | **UNKNOWN** | **UNKNOWN** | ✗ absent (whole tab) | **UNKNOWN** | **UNKNOWN** |

---

## The patterns

### Loading is the product's least-developed state

**MISSING on fifteen surfaces.** Nearly every channel answers a mutation with a full snapshot, so
panels go from empty to correct with no intermediate state at all. On localhost that is invisible
and arguably correct. On a slow link, the empty state — which is this product's *strongest* copy —
becomes an assertion that nothing exists.

The one deliberate skeleton, Activity's feed, is drawn in a grey that cannot be seen.

### The operate thread has no error and no recovery

The only surface where a **MISSING** verdict is not an audit limitation. A thread whose status is
`errored` renders no error, offers no retry and explains nothing.

### Responsive is unverified almost everywhere, and broken where it was verified

`window.rs` names four destinations with a narrow-width fallback — Threads, Agents, Inbox, Activity.
The Cockpit, added later, is not among them, and it is the one that breaks at the minimum size.
Every right-panel tab is marked **UNKNOWN**: they were only observed at 1440px.

### Permission states are almost entirely unverified

Every seeded account is `owner`. The one refusal observed in the whole audit was a server-side
`403` on `GET /v1/secrets` without an elevation.

### What would make the biggest difference to a re-run

1. **A real deployed agent on real hosting.** Seventeen Cockpit states depend on it.
2. **A second account at `member` or `viewer`.** Every permission cell above becomes answerable.
3. **A provider key.** Unlocks the build pipeline, evals, and real cost figures.
4. **A workspace with hundreds of work items.** The virtualiser, the pill, the strip overflow.
