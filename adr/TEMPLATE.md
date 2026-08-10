# ADR-NNN: State the Decision as an Action, Not a Topic

## Status

Accepted | Proposed | Superseded by ADR-NNN | Deprecated

Name the release the decision landed in, and any later release that extended or hardened it.

## Context

What problem are we solving?

What constraints or requirements led to this decision? State the ones that actually narrowed the
field, including the awkward ones: an existing promise, a demonstrated defect, a property of a
dependency, a cost. If a specific bug motivated this, describe it concretely rather than as a
category.

## Decision

What exactly are we deciding?

Be precise enough that somebody could implement it from this section alone. Where a detail is load
bearing, say so and say why, because that is the sentence a future cleanup will not know.

## Alternatives Considered

### Option 1: <the option that was chosen>

- Pros
- Cons

### Option 2: <a genuine alternative>

- Pros
- Cons

### Option 3: <a genuine alternative>

- Pros
- Cons

Give every option a real case in its favour. An option with no advantages was never an
alternative, and listing it teaches a future reader nothing.

## Consequences

### Positive

- What this buys, stated as facts about the system rather than as hopes.

### Negative

- What it costs. Include the things that will annoy somebody later.

### Trade-offs

- What was deliberately given up, and in exchange for what.

## Implementation Notes

Anything developers need to know when implementing this decision. Where the code lives, the
ordering that matters, the configuration involved, and the mistakes that are easy to make.

## Security Considerations

Any security implications. Include what this decision explicitly does **not** protect against: a
boundary whose limits are not written down gets trusted for things it never did.

## Performance Considerations

Expected performance characteristics or constraints. What it costs at run time, where the cost
falls, and what bounds it.

## Operational Considerations

Deployment, configuration, monitoring, migrations, backups, failure modes, and the troubleshooting
answer somebody will need at three in the morning.

## Rejected Alternatives

Why the alternatives were ultimately rejected. Write this for a reader who is about to propose one
of them again, and give them the reasoning rather than the conclusion.

## Related Decisions

- ADR-NNN: ...
- ADR-NNN: ...

## References

- Source files, test suites and configuration this record describes
- Releases in `CHANGELOG.md`
- Relevant sections of `README.md`, `CONTRIBUTING.md`, `SECURITY.md` or `schema/events.md`
- External specifications, RFCs and vendor documentation

Cite only what exists. Do not reference issues, pull requests or documents that were never
written.
