# ADR-013: Read One Pricing Table From Both Runtimes, and Never Report Unknown Cost as Zero

## Status

Accepted. Introduced in v0.1.9 (28 July 2026), consolidating cost accounting that had existed
since v0.0.1.

## Context

Jaroku reports what a run cost in dollars. That number appears in the trace status bar, in the
step detail panel, in the comparison dashboard, in the pre-run estimate, in the budget ceiling
and in `jaroku.json` as the recorded cost of creating an agent. It is one of the product's most
load-bearing claims, because a user makes provider decisions with it.

Cost is computed in two places by necessity. The Python interceptor computes per-step cost as a
run executes, because that is where token counts arrive. The TypeScript server computes pre-run
estimates and evaluation aggregates, because that is where datasets and comparisons live.

Two copies of a pricing table drift. A drifted table means the dashboard and the estimate
disagree about the same run, and the user has no way to tell which is right.

Three further hazards were identified from real defects:

1. **An unpriced model rendered silently as free**, reporting `$0.00` next to real numbers,
   which reads as "this provider is free" rather than "we do not know".
2. **A run that crashed partway reported spending nothing**, because `runs.cost` is written by
   `run_end` and a crashed run never emits one, while its completed steps hold real money
   already spent.
3. **Cached tokens were billed at the full input rate**, overstating cost by as much as ten
   times whenever caching engaged.

## Decision

**`runtime/pricing.json` is the single source of truth, read by both sides.** Prices are USD per
million tokens, so they are auditable line by line against a provider's published price sheet.

Three matching and pricing rules, implemented identically in Python and TypeScript:

1. **An unpriced model costs `null`, never `$0`.** A silent zero next to a real number reads as
   "free" rather than "unknown".
2. **Matching is exact, then longest prefix.** Never unordered substring matching, which
   produces wrong matches on model names that share fragments.
3. **Cached input is priced as cached input.** For Anthropic, roughly 0.1 times the input rate
   for a cache read and 1.25 times for a cache write. Charging cache reads at the full input
   rate overstates cost by up to ten times.

Two aggregation rules:

4. **Cost comes from `steps`, not `runs.cost`.** `runs.cost` is written by `run_end`; a run that
   crashes mid-graph never emits one and its row still reads zero while its steps record real
   money already spent. Summing the steps is the only figure that matches the bill.
5. **Partial pricing is flagged, not hidden.** If any `llm_call` reports tokens but no cost, the
   total is an undercount and the run is marked cost-incomplete so the dashboard can say so
   rather than presenting a confidently wrong number.

And one reporting split:

6. **Comparison cost counts succeeded runs only; true spend counts every attempt plus judge
   cost.** A provider that hit transient rate limits is not scored as expensive for being
   unlucky, and the budget ceiling checks true spend, because that is what hit the card.

The principle generalises beyond cost and is stated in the README as a product principle:
**unknown is not zero**. An unpriced model reports `null`. A judge failure is *unscored*, never
a score of 0. Both survive CSV export, where an unknown cost is an empty cell with a
`cost_known` column beside it and an unscored run is an empty score with the judge's reason.

## Alternatives Considered

### Option 1: One shared pricing file, read by both runtimes, with null for unknown

- Pros
  - The two sides cannot disagree, because they read the same bytes.
  - Prices are auditable against a published price sheet, since the unit matches how providers
    publish.
  - `null` is representable end to end, through the database, the aggregation, the dashboard
    and the export.
  - Updating a price is a data change, not a code change in two languages.
- Cons
  - `null` has to be handled at every consumer, which is more code than assuming a number.
  - The file must be reachable from both runtimes, which constrains packaging.
  - A price sheet change is a manual update, so the table can be stale.
  - Two readers still exist, so a test is required to prove they compute identically.

### Option 2: A pricing table per runtime

- Pros
  - Each side owns its own data in its own idiomatic format.
  - No shared file to package or locate.
- Cons
  - The two drift, and the drift is silent. This is precisely the defect the shared file was
    introduced to fix.
  - A price update has to be made twice and can be made inconsistently.
  - A discrepancy between the estimate and the dashboard is unexplainable to the user.

### Option 3: Fetch pricing from a provider API at runtime

- Pros
  - Always current, with no manual updates.
  - No stale table.
- Cons
  - Providers do not offer a consistent machine-readable pricing endpoint, so this is not
    uniformly available.
  - Adds a network dependency to cost accounting, which then fails when the network does.
  - Makes cost non-deterministic across time, so a recorded run's cost could change on replay.
  - Requires credentials to compute a number that should be computable offline.

## Consequences

### Positive

- Estimate, live figure and aggregate all agree, because they use one table and one set of
  rules.
- Real verification was possible: a two-provider evaluation was checked directly against the
  Anthropic billing console, and the estimate, the actual cost and the internally recorded cost
  agreed. The published per-token rate was reconstructed from the recorded numbers alone.
- A crashed run reports the money it actually spent, which is the figure that matters when
  reading a failed evaluation.
- Caching is priced correctly, which matters because the generation prompt carries a cache
  breakpoint and caching engages on every repeat build.
- The `null` discipline propagates: unknown cost is an empty CSV cell with a `cost_known`
  column, and neither can be mistaken for a measurement.

### Negative

- `null` handling is required at every consumer, including the UI, the aggregation and the
  export. Forgetting it produces a rendering bug rather than a wrong number, which is the
  correct direction but is still work.
- The pricing table is maintained by hand and can lag a provider's published changes.
- The file has to be reachable from both the Python runtime and the Node server, which is a
  packaging constraint.
- Two implementations of the same matching rules exist and must be kept identical, which is why
  a test asserts both compute byte-identical numbers for the same inputs.

### Trade-offs

- Manual maintenance of the table was accepted in exchange for offline, deterministic,
  auditable cost accounting.
- Reporting `null` rather than a best guess was chosen deliberately: a missing number the user
  can see is better than a plausible number they cannot check.
- The comparison and true-spend split adds a second cost concept to explain, and was accepted
  because collapsing them makes either the comparison unfair or the budget unenforceable.

## Implementation Notes

- `runtime/pricing.json` holds the table. `runtime/jaroku_interceptor/pricing.py` is the Python
  reader and `server/src/pricing.ts` is the Node reader.
- Prices are USD per million tokens. Keep them in that unit so a reviewer can compare a line to
  a published price sheet without arithmetic.
- Matching is exact first, then longest prefix. Do not introduce substring matching: model names
  share fragments, and an unordered substring match silently prices one model as another.
- `npm run test:pricing` covers exact and prefix matching, cache multipliers and the unpriced to
  `null` path. A test asserts the Python and TypeScript implementations compute identical
  numbers for the same inputs.
- `npm run test:aggregate` covers cost from steps, unknown versus free, and the partial-pricing
  flag.
- The schema stores per-step `cost` and `tokens` as nullable, and `null` means unknown rather
  than zero. That is stated in `schema/events.md` and is part of the frozen contract.
- `jaroku.json` records what the plan and the generation each cost, because the conversation
  that showed those numbers is in memory and gone on reload, and "what did this cost me" is a
  question asked long afterwards.

## Security Considerations

- Cost figures are not sensitive in themselves, but the budget ceiling they feed is a spending
  control. It is enforced server side, checked before dispatch, and reads true spend, so a
  client cannot spend past it by manipulating a displayed figure.
- Pricing data is static local configuration with no credentials attached, so there is no
  network trust decision embedded in cost accounting.
- Under-reporting cost would be the security-relevant failure, because it would let a budget
  ceiling be crossed without the ceiling noticing. Rules 4 and 5 exist to prevent exactly that:
  cost is summed from steps and partial pricing is flagged.

## Performance Considerations

- Pricing lookups are a map lookup plus, at worst, a longest-prefix scan over a small table.
  Cost is negligible.
- Aggregation sums per-step costs with a database query rather than loading traces, which is why
  the evaluation tables and the frozen `steps` table live in the same database and can be
  joined directly.
- The generation prompt's stable half carries a cache breakpoint, so repeat builds bill most of
  the instruction block at the cached read rate. Pricing that correctly is what makes the saving
  visible rather than invisible.

## Operational Considerations

- Updating a price is a one-line change to `runtime/pricing.json` and requires no code change on
  either side.
- Adding a new model means adding an entry. Until then, the model prices to `null` and is
  excluded from cost rankings, which is the intended degradation.
- If the dashboard shows a run as cost-incomplete, at least one `llm_call` reported tokens with
  no price. The fix is a pricing entry, not a code change.
- A known limit recorded at the time: a run killed for taking too long can still be billed by
  the provider for the call in progress, even though that spend never appears in the trace.
- A second known limit: pre-run estimates assume a fixed ratio of input to output tokens,
  because only a combined count is available beforehand. The estimate is presented as a range
  and says what it was calibrated from.

## Rejected Alternatives

**A pricing table per runtime** was rejected because it is the defect that motivated this
decision. Two tables drift, the drift is silent, and the user sees an estimate and a dashboard
figure that disagree about the same run with no way to tell which is correct. A single file read
by both sides removes the failure class entirely, and a parity test removes the residual risk in
the two readers.

**Fetching pricing from a provider API at runtime** was rejected because it is not uniformly
available, it adds a network dependency and a credential requirement to a computation that
should work offline, and it makes cost non-deterministic across time. A run's recorded cost
should not change when it is replayed.

## Related Decisions

- ADR-001: Freeze a versioned trace event schema as the product's primitive
- ADR-003: Three process architecture with a Python runtime and a Node control plane
- ADR-011: Evaluations as batches of ordinary runs on a persisted job queue
- ADR-012: LLM as judge as a separate phase with a data driven rubric

## References

- `runtime/pricing.json`
- `runtime/jaroku_interceptor/pricing.py`, `server/src/pricing.ts`
- `server/src/pricing.test.ts` (`npm run test:pricing`),
  `server/src/evalAggregate.test.ts` (`npm run test:aggregate`)
- `client/src/lib/evalExport.ts` and `client/src/lib/csv.ts`
- `schema/events.md`, nullable `cost` and `tokens` on Step
- README sections "Cost accounting" and "Why it exists" (the "Unknown is not zero" principle)
- CHANGELOG v0.1.9 "Eval Engine, Multi Provider Comparison"
- RFC 4180, Common Format and MIME Type for CSV Files
