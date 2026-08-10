# ADR-025: Route One Composer by Deterministic Intent Heuristics Rather Than a Classifier

## Status

Accepted. Introduced in v0.1.7 (24 July 2026), extended with Chat and Test modes in v0.1.8.

## Context

By v0.1.6 the product had accumulated an entry point per capability: a run bar for running an
agent, a chat box for generation, a Fix button on a failed step, a separate path for
explanations, and a re-run action for branching. Each had its own affordance, its own placement
and its own state.

That produces three problems.

**The same intent behaves differently depending on where it is typed.** "Fix this" in one box and
"fix this" in another are different features with different context, which the user has to learn.

**Selection is not used.** A user with a failed step selected who types "why did this fail" is
asking a question about that step, and an interface with a general chat box throws away the
context that makes the question answerable.

**Every new capability wants a new button.** The surface grows without bound.

The obvious unification is a single input that decides where a message goes. That immediately
raises the question of *how* it decides, and the tempting answer is a small model call per
message to classify intent.

## Decision

**One composer, routed by intent, using pure keyword and pattern heuristics. No per-message model
call.**

Routing is a function of *(selection context + phrasing)*, and it dispatches into mechanisms that
already exist. It invents no new backend for an intent that already has one: edit and fix reuse
the edit path, re-run reuses branching. Only "explain" was a new, lightweight path.

| Typed | With this selected | Goes to |
|---|---|---|
| a description | nothing | plan a new agent |
| feedback | a pending plan | revise that plan |
| "why did this fail?" | a step, a node, or nothing | explain, streaming prose |
| "re-run from here" | a step | branch from that step |
| "fix this" | a **failed** step | the edit loop, pre-filled with the error |
| anything else | an agent | edit this agent |

**The composer shows a live one-line label of where the message will go**, so the routing teaches
itself rather than having to be documented.

**A pending plan captures typed input as feedback on that plan**, not as a new brief. The only way
to abandon a plan is Discard. See ADR-008.

**Chat and Test are two modes of the same input**, with separate drafts that survive switching.
Chat routes by intent; Test sends the input straight to the agent. The separate run bar was
removed entirely, so there is one entry point for running an agent rather than two that can drift
apart.

The justification for heuristics over a classifier is explicit: a mis-route just needs a rephrase,
so the cost of a classifier is not warranted. That cost is real and recurring: latency on every
keystroke-to-send, money on every message, and a non-deterministic routing decision that cannot be
unit tested.

## Alternatives Considered

### Option 1: One composer with deterministic keyword and pattern routing

- Pros
  - Instant, free and deterministic, so routing is unit testable.
  - The live route label makes the behaviour discoverable without documentation.
  - Selection becomes meaningful: the same words mean different things with a step selected.
  - Reuses existing mechanisms rather than adding backends, so the surface does not grow with
    each intent.
  - A mis-route is cheap to recover from, because rephrasing is one action.
- Cons
  - Heuristics are brittle at the edges and will mis-route unusual phrasings.
  - The rules are English-centric.
  - Adding an intent means adding patterns and considering their interaction with existing ones.
  - The user has less explicit control than a button gives them.

### Option 2: A model call per message to classify intent

- Pros
  - Handles arbitrary phrasing, including phrasings nobody anticipated.
  - Extends to new intents by description rather than by pattern.
  - Naturally multilingual.
- Cons
  - Latency on every message, in the path between pressing enter and anything happening.
  - Cost on every message, including the many that are unambiguous.
  - Non-deterministic, so the same message can route differently on two occasions and the
    behaviour cannot be unit tested.
  - Requires an API key for an interaction that should work without one.

### Option 3: Explicit mode selection, either buttons or a slash-command vocabulary

- Pros
  - Unambiguous, with no routing to be wrong.
  - Discoverable through a menu.
  - Trivial to test, and easy to extend.
- Cons
  - Returns to an affordance per capability, which is the problem being solved.
  - The user must know the vocabulary before they can use it.
  - Selection context still has to be applied, so the routing problem does not disappear, it just
    stops being automatic.

## Consequences

### Positive

- One place to type, and the same intent behaves the same way regardless of what the user is
  looking at.
- Selection is load bearing: with a step selected, "why did this fail" is answerable from that
  step's actual execution context rather than from a general conversation.
- Routing is a pure function and is unit tested, so a change to the rules is verifiable.
- Removing the separate run bar removed a real class of bug: two entry points for running an agent
  could read different input state, and centralising it fixed the keyboard shortcut and composer
  disagreeing.
- Adding an intent is cheap, because the mechanisms already exist and only the routing changes.

### Negative

- Unusual phrasings mis-route. The mitigation is the visible route label plus a cheap rephrase.
- The heuristics are English-centric, which bounds where the product works well today.
- The rules are a growing set of patterns whose interactions need thought.
- A user who wants explicit control has no button to press, only phrasing.

### Trade-offs

- Determinism and zero cost were traded for robustness on unanticipated phrasing.
- Automatic routing was traded for explicit control, mitigated by showing the route before the
  message is sent.
- Explanations are grounded strictly in the selection, which makes them accurate and refuses
  questions the selection cannot answer. That was a deliberate narrowing: an explanation that
  reaches beyond its context is an explanation that can be confidently wrong.

## Implementation Notes

- `client/src/lib/intent.ts` holds the routing. Its header states the design: one composer routes
  by selection context plus message intent into existing mechanisms, and routing is pure keyword
  and pattern heuristics with no per-message model call.
- `ComposerContext` carries the selected agent, a pending plan id, the selected trace step and the
  selected graph node. The node takes precedence for explanations.
- `Intent` is a discriminated union: `generate`, `replan`, `edit`, `fix`, `rerun`, `explain`.
- `client/src/lib/composerMoment.ts` derives what the composer should say, which is what makes the
  route label live.
- Explanations use only the selected step's execution context, or the selected node's prompt and
  tools. They stream on the `reply` channel, separately from the execution trace.
- The explain path degrades to raw context with no API key, so the feature is not simply
  unavailable without one.
- Chat and Test keep separate drafts, and placeholders are context aware per mode.
- Runtime input handling was centralised so the keyboard shortcuts and the composer cannot read
  different state. The `R` shortcut re-runs the last test input, which is stored under a
  workspace-scoped key. See ADR-024.
- Voice input uses the Web Speech API with a live waveform fed from a short-lived `getUserMedia`
  stream, and falls back to a plain recording indicator where the APIs are unavailable rather than
  breaking.

## Security Considerations

- Routing decides which existing mechanism receives a message; it grants nothing. Every resulting
  command is still capability checked at the relay door. See ADR-022.
- A mis-route cannot escalate. The worst case is that an edit request is treated as an
  explanation, or the reverse, and both paths have their own gates: edits produce a reviewable
  diff that lands nothing until Apply.
- Because routing is local and deterministic, a message is not sent to a model in order to decide
  where to send it. That is one fewer place where a user's text leaves the machine.
- Explanations are grounded in the selection, which bounds what context is put into a prompt.
- The last test input is real user data, a customer email or an order id, and is stored under a
  workspace-scoped browser key that sign-out sweeps.

## Performance Considerations

- Routing is string matching, so it costs nothing and adds no latency between pressing enter and
  the action starting.
- No model call means no token spend on messages that were unambiguous, which is most of them.
- The route label is derived from the same pure function, so showing it is free.
- Explanations stream on their own channel, so a long answer does not block or interleave with the
  execution trace.

## Operational Considerations

- The composer's route label is the primary support answer for "why did it do that": the routing
  is shown before the message is sent.
- A persistent mis-route is a pattern to add, in one module, with a unit test.
- Explain works without an API key, degraded to raw context, so a user without one is not left
  with a dead feature.
- Voice input availability depends on the browser. Where the Web Speech API is missing the control
  is hidden rather than broken.

## Rejected Alternatives

**A model call per message to classify intent** was rejected on cost and determinism. It would add
latency and money to every message, including the overwhelming majority that are unambiguous, and
it would make routing non-deterministic and therefore untestable. The decisive argument is
asymmetry of consequence: a mis-route costs one rephrase, so paying a per-message tax to reduce an
already cheap failure is a poor trade.

**Explicit mode selection through buttons or slash commands** was rejected because it recreates
the problem being solved: an affordance per capability, growing with every feature. It also does
not remove the routing problem, since selection context still has to be combined with the chosen
mode, and it requires the user to learn a vocabulary before the input becomes useful.

## Related Decisions

- ADR-008: A plan gate before generation, which owns the pending-plan routing case
- ADR-009: The fix loop, which the edit and fix intents dispatch into
- ADR-010: A checkpointed twin for pause, resume and branch, which the re-run intent uses
- ADR-023: One WebSocket carrying many logical channels
- ADR-024: Client state as per concern stores that reset on a workspace switch

## References

- `client/src/lib/intent.ts`, `client/src/lib/composerMoment.ts`,
  `client/src/lib/useVoiceInput.ts`
- `client/src/components/BuildPane.tsx`, `client/src/components/CommandPalette.tsx`
- `server/src/explainer.ts`, the streaming explain path
- README section "The React client"
- CHANGELOG v0.1.7 "Unified Chat Composer and Context Aware Routing" and v0.1.8
