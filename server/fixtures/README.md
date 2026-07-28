# Generation fixtures

Recorded Claude responses, replayed by the generator when `JAROKU_GEN_FIXTURE` points at
one — and by the planner when `JAROKU_PLAN_FIXTURE` does. They make the whole build path —
planning, streaming, staging, validation, commit — testable for free, which matters because
every real generation costs money.

Set the variable to a path that does **not** exist to record a fresh one from a real call.

`JAROKU_PLAN_FIXTURE` deserves more care than the other two. A forgotten `JAROKU_GEN_FIXTURE`
replays a canned project you can see is wrong; a forgotten `JAROKU_PLAN_FIXTURE` feeds stale
plan text into a **real** generation, so the output is genuinely model-written but built to
somebody else's plan. The planner logs a loud warning for exactly this reason.

| File | Purpose |
|---|---|
| `support_bot.txt` | A known-good generation. Should always pass validation. |
| `rejected-tool-call-and-sql.txt` | A real `claude-haiku-4-5` response that shipped two genuine defects: it called the `pg_query` tool directly (a `StructuredTool` is not callable) and built SQL with an f-string. Should always be **rejected** — it is the regression test for prompt rules 9 and 10. |
| `plan-support-bot.txt` | A known-good plan for the support-bot prompt with the `gmail` connector selected. Pairs with `support_bot.txt` to exercise the whole gate — plan, card, confirm, generate — for free. |
