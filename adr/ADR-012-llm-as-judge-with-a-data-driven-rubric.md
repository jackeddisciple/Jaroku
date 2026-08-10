# ADR-012: Score Evaluations With an LLM Judge in a Separate Phase, Against a Data Driven Rubric

## Status

Accepted. Introduced in v0.1.9 (28 July 2026).

## Context

The evaluation engine produces cost, latency and token counts for free, because those are
measured. Quality is not measured, it is judged, and a comparison of providers without a quality
column compares only price.

Automated scoring of open-ended agent output has well-known failure modes, and each one had to
be answered explicitly:

1. **A judge that fails silently corrupts the comparison.** If a judge error becomes a low
   score, a provider is punished for the judge's formatting slip.
2. **Judges are inconsistent on continuous scales.** Asking for a number between 0 and 1
   produces variance that swamps the signal, and "0.73" implies a precision that does not exist.
3. **Mixed polarity criteria produce uninterpretable aggregates.** "Hallucination", as normally
   written, is a negative: a high score means a bad answer. Summing it with positively phrased
   criteria produces a number nobody can read.
4. **One rubric does not fit every agent.** "Correct" for a refund bot is not "correct" for a
   SQL agent.
5. **Judging costs money**, and charging it to the providers being compared would distort the
   comparison, since it is the same model for every leg.

There is also an ordering question. If scoring happens inline with execution, a broken judge
takes down the run it was scoring, and the money already spent on that run is wasted.

## Decision

**Scoring is a separate phase from execution.** A job is scored once its run is already
terminal and recorded, so a broken judge costs the quality column and nothing else. Only
succeeded runs are judged, because a failed run has no answer to grade.

Six rules define the judge.

**The rubric is data, not code.** Criteria live in the `rubrics` table and are editable per
dataset.

**A coarse, anchored scale.** Each criterion is scored 0 to 4 against written anchors, not on a
continuous 0 to 1. Judges are far more consistent choosing between described levels than
emitting a float. The overall 0 to 1 figure is derived, never asked for.

**Every criterion is phrased positively.** Hallucination ships as **grounding** instead,
measuring the same thing upward, so a weighted sum of criteria means something.

**An incomplete verdict is an error, not a zero.** If the judge omits a criterion, the verdict
is rejected and the example is **unscored**. Defaulting a missing score to 0 would silently
punish a provider for a formatting slip.

**Judge cost is evaluation overhead**, tracked separately from provider cost. It is the same
model for every leg, so charging it to the providers would add a constant to each and make cheap
ones look worse than they are. It still counts toward true spend and toward the budget ceiling.

**Only succeeded runs are judged.**

The judge module is split by testability: `judge/rubric.ts` is pure, holding prompt construction
and verdict parsing; `judge/score.ts` is the pipeline; `judge/output.ts` extracts the agent's
answer from a trace.

Export carries the uncertainty rather than hiding it. An unscored run is an empty score *with*
the judge's reason beside it, machine readable and impossible to mistake for a measurement.

## Alternatives Considered

### Option 1: An LLM judge, run as a separate phase, against a data driven anchored rubric

- Pros
  - Handles open-ended output, which is what agents produce.
  - Editable per dataset, so the definition of quality follows the agent.
  - Anchored coarse levels are materially more consistent than a continuous scale.
  - Separate phase means a judge failure costs one column, not a run.
  - Unscored is representable, so the dashboard can say "we do not know" rather than "zero".
- Cons
  - Costs money and adds latency after every evaluation.
  - The judge is itself a model and can be wrong, biased or inconsistent.
  - Scores are comparable within one rubric and one judge model, and not across changes to
    either.
  - Requires prompt and parser maintenance.

### Option 2: Deterministic assertions, for example exact match or regular expressions on the
answer

- Pros
  - Free, instant, perfectly reproducible.
  - No judge to be wrong.
- Cons
  - Agent output is open ended natural language. Exact match is almost never the right test,
    and a regular expression encodes one acceptable phrasing out of many.
  - Building an assertion per example is substantial user effort, and the effort scales with the
    dataset.
  - Cannot express partial credit or grade dimensions such as grounding and tone.

### Option 3: Human rating only

- Pros
  - The highest quality signal available, and the ground truth every other method approximates.
  - No judge model cost and no judge model bias.
- Cons
  - Does not scale. Sixty runs across three providers is sixty judgements per comparison.
  - Turns an automated comparison into a manual task, which defeats the purpose of running the
    evaluation unattended.
  - Human ratings are themselves inconsistent without anchors, so the rubric work is still
    required.

## Consequences

### Positive

- A quality column exists alongside cost and latency, so the comparison is about value rather
  than price.
- A judge failure is contained: the run's cost, latency and trace are all recorded and usable,
  and only the score is missing.
- The rubric being data means a user can encode what "correct" means for their agent without
  writing code.
- Because judge cost is tracked separately, cheap providers are not penalised by a constant
  added to every leg.
- The judge was verified to discriminate rather than to agree: a correct answer, a hallucinated
  one and an empty one scored distinctly apart.

### Negative

- Evaluations cost more and take longer than execution alone.
- Scores are only comparable within a fixed rubric and judge model. Changing either invalidates
  comparison with earlier results, and nothing currently enforces that.
- The judge introduces a second model dependency into the evaluation path, so an outage in the
  judge provider removes the quality column.
- Rubric quality is now a user responsibility, and a badly written rubric produces confident
  nonsense.

### Trade-offs

- Cost and latency were traded for a quality signal that generalises across agents.
- Precision was deliberately reduced: a 0 to 4 anchored scale is coarser than a float and far
  more consistent, and consistency is what makes a comparison meaningful.
- Coverage was traded for honesty. Refusing an incomplete verdict produces fewer scores than
  defaulting missing criteria to zero would, and every score that does exist is real.
- Judge attempts are bounded (`JAROKU_JUDGE_ATTEMPTS`, default 2), so a persistently
  malformed verdict becomes unscored rather than an unbounded retry cost.

## Implementation Notes

- `server/src/judge/rubric.ts` is deliberately pure: prompt construction and verdict parsing,
  with no I/O, which is what makes `npm run test:judge` a fast unit suite rather than an
  integration test.
- `server/src/judge/output.ts` extracts the agent's answer from a trace. This is the coupling
  point with the frozen schema, and it reads step outputs rather than any evaluation-specific
  field.
- `JAROKU_JUDGE_MODEL` defaults to `claude-haiku-4-5`. `JAROKU_JUDGE_CONCURRENCY` defaults to 4
  and `JAROKU_JUDGE_ATTEMPTS` to 2.
- Judge cost is accumulated into true spend, which is what the budget ceiling checks, and is
  reported separately from provider cost in the dashboard.
- The overall 0 to 1 score is derived from the per-criterion 0 to 4 scores and their weights. It
  is never requested from the judge directly.
- The default rubric ships with positively phrased criteria including grounding. A user editing
  a rubric should keep polarity consistent, and the shipped default demonstrates it.
- An unscored example carries the judge's reason, and that reason survives CSV and JSON export.

## Security Considerations

- The judge reads agent output, which is untrusted content, and puts it into a prompt. Prompt
  injection against the judge is possible in principle: an agent output crafted to instruct the
  judge could influence its verdict. This is the same class of risk the product states plainly
  about MCP output framing, and the mitigation is the same: the judge's verdict affects a
  score, not an action, so the blast radius is a wrong number rather than a side effect.
- Judge calls use the same Anthropic client and the same key handling as every other model call.
  The key is read from `runtime/.env`, never logged and never leaves the process.
- Rubrics are workspace scoped like every other row, so one workspace cannot read or modify
  another's definition of quality.
- Judge cost counts toward the enforced budget ceiling, so a pathological rubric cannot spend
  without bound.

## Performance Considerations

- One judge call per succeeded job, bounded by `JAROKU_JUDGE_CONCURRENCY`.
- Judging is a separate phase, so it does not compete with execution for run pool slots.
- A cheap default judge model keeps overhead proportionate: the judge reads one answer and
  emits a short structured verdict.
- Bounded attempts mean a malformed verdict costs at most two calls before the example becomes
  unscored.

## Operational Considerations

- If the quality column is empty for an entire evaluation, check the judge model configuration
  and the key. Execution results are unaffected and are still worth reading.
- Changing `JAROKU_JUDGE_MODEL` or editing a rubric changes what a score means. Comparisons
  across such a change are not valid, and the product does not currently prevent them.
- Judge cost appears separately in the dashboard and in exports, so evaluation overhead is
  visible rather than buried in the per-provider figures.
- An unscored example is not a failure to investigate in the provider; it is a judge outcome,
  and its reason is recorded.

## Rejected Alternatives

**Deterministic assertions** were rejected because agent output is open-ended natural language.
Exact match is almost never the right test, and a regular expression encodes one acceptable
phrasing when many are correct. It would also push a large authoring burden onto the user, one
assertion per example, and still could not express partial credit across dimensions such as
grounding and tone.

**Human rating only** was rejected because it does not scale to the workload. A comparison of
three providers over twenty examples is sixty judgements, which turns an unattended background
evaluation into a manual session. Human rating also needs anchored criteria to be consistent, so
the rubric design work is required either way; the judge simply applies the same rubric at
machine speed, and a human can still override by reading the drill-down trace.

## Related Decisions

- ADR-011: Evaluations as batches of ordinary runs on a persisted job queue
- ADR-013: One pricing table read by both runtimes, and unknown is never zero
- ADR-015: MCP servers treated as untrusted code, for the same honesty about prompt injection
- ADR-028: Tests as plain scripts, with structural audits

## References

- `server/src/judge/rubric.ts`, `server/src/judge/score.ts`, `server/src/judge/output.ts`
- `server/src/judge/rubric.test.ts` (`npm run test:judge`)
- `server/src/evalStore.ts`, the `rubrics` and `eval_scores` tables
- `client/src/lib/evalExport.ts` and `client/src/lib/evalExport.test.ts` (`npm run test:export`)
- README section "The judge"
- CHANGELOG v0.1.9 "Eval Engine, Multi Provider Comparison"
