# ADR-008: Require an Approved Plan Before Any Code Is Generated

## Status

Accepted. Introduced in v0.1.10 (28 July 2026).

## Context

Before v0.1.10, typing a description with no agent selected produced a complete generated
project. That is a fast path to a result and a poor path to the *right* result, for three
reasons.

**A misunderstanding is expensive.** A generation is a paid model call producing a full
multi-file project. If the model misread the brief, the user discovers it by reading generated
code, and the correction is another full generation.

**Code is a bad review surface for intent.** Asking "does this agent do what I meant" while
reading Python is much harder than asking it while reading four sentences about which tools
will exist, what state the agent will carry, and what shape the graph will be.

**Connector and MCP scope is a decision, not a detail.** Which reviewed connectors an agent
uses, and which third-party MCP tools it is granted, determines what the agent can reach. That
decision deserves an explicit approval step rather than being inferred inside a code stream the
user is watching scroll past.

There was also a specific hazard discovered during the design. If generation reads the
composer's current contents rather than the approved plan, then a user who retypes the prompt
or toggles a connector chip after planning gets a build they never reviewed, which is precisely
the failure the gate exists to prevent.

## Decision

**Describing an agent produces a plan, not code.**

The planner writes nothing to disk and reserves no agent id. A plan is text about code that
does not exist yet. It states, in plain language, the tools the agent will have (split into
reviewed connector templates, bespoke tools, and granted MCP tools), the state fields it will
carry, and the shape of its graph.

Four rules define the gate's behaviour.

**Typing again while a plan is on screen is feedback on that plan**, not a new brief. The
original brief is kept, the revision counter increments, and the plan updates in place. The
only way to abandon a plan is Discard, which hands the original request back to the composer
unchanged.

**Generation builds the stored plan record**, not whatever the composer currently says. If the
user retyped the prompt or toggled a connector chip after planning, the approved plan still
wins.

**Catalog drift is refused loudly.** If a connector named by the plan has since vanished from
the catalog, generation is refused with a message and the plan survives so the user can re-plan.

**Parsing degrades, never hard-fails.** Every plan carries its raw text, the card always falls
back to rendering it, and confirming is never blocked on a successful parse. See ADR-006.

The plan reuses the generation model and prompt infrastructure as an earlier phase of the same
call rather than a second pathway, and `JAROKU_PLAN_MODEL` falls through to `JAROKU_GEN_MODEL`
on purpose: two phases describing the same build should not disagree about who is doing the
thinking.

## Alternatives Considered

### Option 1: A plan gate with in-place revision

- Pros
  - The user reviews intent in prose, which is where a misunderstanding is visible.
  - A plan is cheap relative to a generation, so correcting a misreading is cheap.
  - Connector and MCP scope becomes an explicit approval, which is a security-relevant decision
    made deliberately.
  - Revision is conversational, so redirecting mid-plan does not throw away what was already
    proposed.
  - Building from the stored plan record makes "you build what was approved" a structural
    property rather than a hope.
- Cons
  - An extra step and an extra model call on every new agent.
  - Two artifacts to keep coherent, the plan and the generation, with a staleness relationship
    between them.
  - The plan can be wrong in ways that are only visible in code, so the gate reduces but does
    not eliminate bad generations.

### Option 2: Generate immediately and let the user review the code

- Pros
  - One step, one call, fastest path to something runnable.
  - The code is the ground truth, so there is no plan-versus-code mismatch to reason about.
- Cons
  - Reviewing intent by reading generated Python is exactly the task the product exists to
    make unnecessary.
  - Every correction costs a full generation.
  - Connector and MCP scope is decided implicitly, inside a stream the user is watching rather
    than approving.

### Option 3: A structured form the user fills in before generation

- Pros
  - Unambiguous scope, since the user states tools and state directly.
  - No parsing and no staleness, because the form is the input.
- Cons
  - Requires the user to already know the shape of the agent they want, which is precisely what
    a natural-language builder exists to avoid.
  - A form cannot propose. Much of the plan's value is that it suggests tools and state the
    user had not thought of.
  - Poor fit with the single composer, which routes by intent rather than by mode. See ADR-025.

## Consequences

### Positive

- The user approves scope in language before any file exists, and the approval is what gets
  built.
- Corrections are cheap. A revision is a short call against a short artifact.
- Connector and MCP tool selection travels through the approved plan into the generated
  project's manifest, which makes least privilege a reviewed decision rather than an inferred
  one. See ADR-015.
- Plan cost is recorded separately from generation cost and both are written into `jaroku.json`,
  so "what did this agent cost to create" is answerable long after the conversation is gone.
- A refused confirmation does not consume the plan, so a rejection is recoverable.

### Negative

- Every new agent costs an additional model call and an additional user interaction.
- Plan and generation can disagree if the plan text is ambiguous, and the generation is the one
  that produces code.
- Staleness between the plan and the connector selection has to be modelled and displayed.
  Getting this wrong once produced a one-way latch where an accidental untick left the plan
  permanently dead with re-planning the only escape, fixed in v0.1.12.
- `JAROKU_PLAN_FIXTURE` is a sharper foot-gun than the generation fixture: a forgotten one
  feeds stale plan text into a real generation, producing genuinely model-written code built to
  somebody else's plan.

### Trade-offs

- An extra step was accepted in exchange for the user reviewing intent rather than code.
- Staleness was chosen to be a local, reversible UI state rather than a server-side discard,
  which is a deliberate deviation from the original design: throwing away a plan to protect a
  slot that costs nothing to keep is not worth the friction.
- Plan parsing is deliberately lenient while generation validation is deliberately strict. A
  half-parsed plan is still readable; a half-valid project is not runnable.

## Implementation Notes

- `server/src/planner.ts` produces plans and holds the plan records. `planner.take()` is what
  generation calls, and it returns the stored plan rather than the command's other fields.
- `server/src/planProtocol.ts` parses the `<<<PLAN section="...">>>` protocol and always carries
  `raw`.
- `server/src/prompt.ts` holds every system and user prompt for generation, editing and
  planning in one module, so the three can never drift.
- `JAROKU_PLAN_MODEL` falls through to `JAROKU_GEN_MODEL`. Pointing generation at a different
  model moves the plan with it.
- The plan's output is bounded, because a plan that runs into the generation is a plan that
  costs generation money.
- Client side, `client/src/store/planFlow.test.ts` (`npm run test:plan-flow`) covers the plan,
  confirm and generate state machine, including the case where the composer content diverges
  from the approved plan.
- The name field locks once a plan exists, because typing in it previously marked the plan
  stale and blamed it on connectors.

## Security Considerations

- The gate is where an agent's reach is approved. Reviewed connectors imply credentials; MCP
  tools imply a third-party server. Both are stated in the plan and both are approved together.
- Because generation builds the stored plan, a client cannot widen an agent's scope after
  approval by sending a different connector or MCP tool list with the generate command. The
  server ignores those fields in favour of the plan record.
- Catalog drift is refused rather than silently resolved. Building an agent against a connector
  that no longer exists, or quietly substituting another, would produce an agent whose reach
  differs from what was approved.
- The MCP duplicate-name refusal happens at generation time, before the model is called, and
  names both servers. Resolving it quietly could replace a high-impact tool's confirmation gate
  with a same-named low-impact one, so the gate would never fire. See ADR-015.

## Performance Considerations

- A plan is a short structured response, typically far cheaper and faster than a generation.
- Because the plan and the generation share the prompt infrastructure, the stable half of the
  prompt is cached across both, and cached input is billed at the cached rate. See ADR-013.
- Revision is a fresh short call, not a re-generation, so iterating on scope is inexpensive.
- The plan writes nothing to disk and reserves no agent id, so an abandoned plan costs nothing
  to clean up.

## Operational Considerations

- Plan cost and generation cost are shown separately and recorded in `jaroku.json`.
- `JAROKU_PLAN_FIXTURE` should be unset unless deliberately replaying. The planner logs a loud
  warning on every replay.
- A refused generation leaves the plan intact, so the user can correct and retry without
  starting over.
- A known limitation recorded at the time: the generation model used for cost accounting is
  fixed in one place regardless of what is configured, and the plan step inherits the same
  issue.

## Rejected Alternatives

**Generating immediately and reviewing the code** was rejected because reading generated Python
to check whether it matches an intent is the exact task the product exists to remove. It also
makes every correction cost a full generation, and it decides connector and MCP scope
implicitly inside a stream the user is watching rather than approving.

**A structured form** was rejected because it requires the user to know the shape of the agent
before describing it, which inverts the value of a natural-language builder. A form also cannot
propose: a large part of the plan's usefulness is that it suggests tools and state fields the
user had not considered, and then lets them argue with the suggestion in prose.

## Related Decisions

- ADR-006: Delimiter framed streaming protocol for generated files and plans
- ADR-007: Staging directories with atomic swap, gated by layered validation
- ADR-013: One pricing table read by both runtimes, and unknown is never zero
- ADR-015: MCP servers treated as untrusted code
- ADR-025: One composer with deterministic intent routing
- ADR-029: Recorded fixtures so the build path is free to develop against

## References

- `server/src/planner.ts`, `server/src/planProtocol.ts`, `server/src/prompt.ts`
- `server/src/planProtocol.test.ts` (`npm run test:plan`)
- `client/src/store/planFlow.test.ts` (`npm run test:plan-flow`)
- `client/src/components/PlanCard.tsx`
- README section "The build pipeline: plan, generate, validate"
- CHANGELOG v0.1.10 "Plan Before Generate", v0.1.11, v0.1.12
