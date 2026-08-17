# Architecture Decision Records

This directory records the architectural decisions behind Jaroku: what was decided, what problem
it solved, what else was considered, and what it cost.

An ADR is written for a decision that is **expensive to reverse**. If a choice could be changed
next week by editing one file, it does not need a record. If changing it would mean re-migrating
every table, regenerating every agent project, breaking a promise made in the README, or
rewriting a security boundary, it does.

These documents explain **why**, and the why is usually a specific bug, a specific cost, or a
specific promise. The code says what the system does; the comments at the top of each module say
why that module is shaped as it is; these records say why the shape was chosen over the
alternatives that were on the table at the time.

---

## Contents

- [How to read a record](#how-to-read-a-record)
- [Index](#index)
- [Reading paths](#reading-paths)
- [Writing a new record](#writing-a-new-record)
- [Status vocabulary](#status-vocabulary)
- [Conventions](#conventions)
- [Related documents](#related-documents)

---

## How to read a record

Every record follows the same structure, and each section answers a question a future maintainer
will actually ask.

| Section | Answers |
|---|---|
| **Status** | Is this current, and when did it land? |
| **Context** | What problem was being solved, and under what constraints? |
| **Decision** | What exactly was decided? |
| **Alternatives Considered** | What else was on the table, with the honest case for and against each? |
| **Consequences** | What did this buy, what did it cost, and what was traded? |
| **Implementation Notes** | What does somebody touching this code need to know? |
| **Security Considerations** | What does this protect, and what does it explicitly not? |
| **Performance Considerations** | What does it cost at run time, and where? |
| **Operational Considerations** | Deployment, configuration, monitoring, migration, failure modes. |
| **Rejected Alternatives** | Why the other options lost, stated so nobody has to re-litigate them. |
| **Related Decisions** | Which other records this one leans on or constrains. |
| **References** | The files, suites, releases and specifications behind it. |

The **Rejected Alternatives** section is the most valuable one over time. A decision whose
alternatives were never written down gets re-proposed every eighteen months by somebody who
cannot tell the difference between an option nobody thought of and an option that was considered
and refused.

---

## Index

### Foundations

| ADR | Decision |
|---|---|
| [ADR-001](ADR-001-frozen-trace-event-schema.md) | Freeze a versioned trace event schema as the product's primitive |
| [ADR-002](ADR-002-ndjson-stdout-transport-and-guard.md) | Carry trace events as NDJSON on stdout, guarded at the file descriptor |
| [ADR-003](ADR-003-three-process-architecture.md) | Split the system into a Python runtime, a Node control plane and a browser client |
| [ADR-004](ADR-004-langgraph-as-the-agent-framework.md) | Standardise on LangGraph as the agent runtime framework |
| [ADR-005](ADR-005-generated-agent-contract.md) | Define a three symbol agent contract with an injected model and no host imports |

### The build pipeline

| ADR | Decision |
|---|---|
| [ADR-006](ADR-006-delimiter-framed-streaming-protocol.md) | Stream generated files and plans over a delimiter framed protocol |
| [ADR-007](ADR-007-staging-atomic-swap-and-validation.md) | Stage generated projects and promote them by atomic swap after layered validation |
| [ADR-008](ADR-008-plan-gate-before-generation.md) | Require an approved plan before any code is generated |
| [ADR-009](ADR-009-fix-loop-full-file-rewrites-and-snapshot-undo.md) | Implement editing as full file rewrites with a reviewable diff and snapshot undo |

### Execution, debugging and measurement

| ADR | Decision |
|---|---|
| [ADR-010](ADR-010-checkpointed-twin-and-stderr-control-plane.md) | Drive runs through a checkpointed twin, with the control plane on stderr |
| [ADR-011](ADR-011-evaluations-as-ordinary-runs-on-a-persisted-queue.md) | Execute evaluations as batches of ordinary runs on a persisted job queue |
| [ADR-012](ADR-012-llm-as-judge-with-a-data-driven-rubric.md) | Score evaluations with an LLM judge in a separate phase, against a data driven rubric |
| [ADR-013](ADR-013-shared-pricing-table-and-unknown-is-not-zero.md) | Read one pricing table from both runtimes, and never report unknown cost as zero |
| [ADR-030](ADR-030-graph-topology-introspected-from-the-compiled-object.md) | Introspect graph topology from the compiled object, never from source or names |

### What an agent may reach

| ADR | Decision |
|---|---|
| [ADR-014](ADR-014-reviewed-connector-templates.md) | Ship connectors as hand audited templates copied byte for byte |
| [ADR-015](ADR-015-mcp-servers-as-untrusted-code.md) | Treat MCP servers as untrusted code, granted per tool, behind an impact ratchet |
| [ADR-027](ADR-027-deploy-into-the-users-own-hosting-account.md) | Deploy agents into the user's own hosting account through a reviewed serve template |

### Data, tenancy and identity

| ADR | Decision |
|---|---|
| [ADR-016](ADR-016-database-interface-with-two-drivers.md) | Put every database access behind one interface with two drivers |
| [ADR-017](ADR-017-forward-only-checksummed-migrations.md) | Apply schema changes with a forward only, checksummed runner across two dialects |
| [ADR-018](ADR-018-workspace-as-the-tenancy-unit.md) | Make the workspace the tenancy unit and require an explicit context argument |
| [ADR-019](ADR-019-row-level-security-as-the-backstop.md) | Use Postgres row level security as the backstop, not as the enforcement |
| [ADR-020](ADR-020-provider-agnostic-oidc-with-a-local-issuer.md) | Verify provider agnostic OIDC tokens, and run a real local issuer for development |
| [ADR-021](ADR-021-single-use-websocket-tickets-and-origin-allowlist.md) | Open sockets with a single use ticket, behind a mandatory Origin allowlist |
| [ADR-022](ADR-022-roles-as-data-with-one-capability-matrix.md) | Express roles as data in one capability matrix, checked at the door |
| [ADR-026](ADR-026-credential-handling-names-travel-values-do-not.md) | Handle credentials so that names travel and values do not |
| [ADR-031](ADR-031-object-store-with-workspace-first-keys.md) | Put an object store behind an interface, and the workspace first in every key |
| [ADR-032](ADR-032-versions-replace-the-atomic-swap.md) | Replace the atomic directory swap with an immutable version and a pointer |
| [ADR-033](ADR-033-a-secret-store-with-no-way-to-read-one.md) | Give the secret store no method that returns a plaintext value |
| [ADR-034](ADR-034-checkpoints-in-their-own-schema-keyed-by-workspace.md) | Keep LangGraph's checkpoints in their own schema, isolated by the thread id |
| [ADR-035](ADR-035-a-reveal-path-gated-by-elevation.md) | Add one way to read a stored credential, behind an unforgeable elevation receipt |
| [ADR-036](ADR-036-github-app-installation-as-the-connection.md) | Connect GitHub as an App installation, and mint the credential per hour |

### Interface and delivery

| ADR | Decision |
|---|---|
| [ADR-023](ADR-023-one-websocket-with-many-logical-channels.md) | Carry everything on one WebSocket with many logical channels |
| [ADR-024](ADR-024-client-stores-separated-by-invariant-and-reset-on-switch.md) | Separate client stores by invariant, and reset every one on a workspace switch |
| [ADR-025](ADR-025-one-composer-with-deterministic-intent-routing.md) | Route one composer by deterministic intent heuristics rather than a classifier |

### Engineering practice

| ADR | Decision |
|---|---|
| [ADR-028](ADR-028-tests-as-plain-scripts-with-structural-audits.md) | Write tests as plain scripts, and audit invariants by enumerating the source |
| [ADR-029](ADR-029-recorded-fixtures-for-free-development.md) | Record and replay model responses so the build path is free to develop against |

---

## Reading paths

**New to the codebase.** Read ADR-001, ADR-002, ADR-003, ADR-004 and ADR-005 in order. They
describe the primitive, the transport, the process split, the framework and the contract, which
together explain the shape of everything else.

**Working on generation or editing.** ADR-006, ADR-007, ADR-008, ADR-009, then ADR-029 for how to
do it without spending money.

**Working on storage — files, credentials or checkpoints.** ADR-031 through ADR-035, then
ADR-018 for the scope they all rest on and ADR-026 for the credential rule ADR-033 turns into a
type.

**Working on the GitHub integration.** ADR-036 first — it decides what the credential is and
therefore what every call in that feature travels on — then ADR-026 for the rule it satisfies by
storing no credential at all, and ADR-027 for the same principle applied to hosting.

**Working on tenancy, authentication or anything in `server/src/auth/`.** ADR-018 and ADR-019
first, then ADR-020, ADR-021 and ADR-022. Read
[`server/src/auth/THREAT-MODEL.md`](../server/src/auth/THREAT-MODEL.md) alongside them; it
describes what each layer is defending against, which these records assume.

**Working on anything an agent can reach.** ADR-014, ADR-015 and ADR-026, then ADR-027 for what
happens when an agent leaves this machine.

**Working on the client.** ADR-023, ADR-024 and ADR-025.

**About to propose removing something that looks redundant.** Read that thing's record first. The
codebase contains several deliberate-looking oddities that are load bearing: an asynchronous
database interface over a synchronous driver, twelve duplicated lines in `serve.py`, an allowed
missing `Origin` header, a hard read-only list covering connectors that are not installed. Each is
explained in a Rejected Alternatives section.

---

## Writing a new record

1. **Confirm it needs one.** Would reversing this decision be expensive? Does it change a public
   promise, a security boundary, a data model, or a contract with generated projects? If not, a
   comment at the top of the module is the right artifact instead. Several of the best explanations
   in this codebase live there, and this directory is not a reason to move them.

2. **Take the next free number.** Numbers are permanent and are never reused, including for
   superseded records.

3. **Copy [`TEMPLATE.md`](TEMPLATE.md)** and name the file
   `ADR-NNN-short-kebab-case-title.md`. The title should state the decision as an action, not a
   topic: "Freeze a versioned trace event schema", not "Event schema".

4. **Fill in every section.** If a section genuinely does not apply, say so in one line and say
   why. An empty Security Considerations section is a claim that there are none, and that claim
   should be deliberate.

5. **Write the alternatives honestly.** An alternative with no genuine advantages was not an
   alternative, it was a straw man, and a record full of straw men teaches a future reader
   nothing. Give each option a real case in its favour before explaining why it lost.

6. **Cite what exists.** Reference real files, real test suites, real releases in
   [`CHANGELOG.md`](../CHANGELOG.md), and real specifications. Do not cite issues, pull requests
   or documents that do not exist.

7. **Update this index**, and add the record to the Related Decisions list of anything it touches.
   A record nobody links to is a record nobody finds.

8. **Never rewrite an accepted record to reflect a new decision.** Write a new record that
   supersedes it, and mark the old one. The value of this directory is the history, and history
   that gets edited is not history.

---

## Status vocabulary

| Status | Meaning |
|---|---|
| **Proposed** | Under discussion. Not yet acted on, and safe to argue with. |
| **Accepted** | In force. The codebase reflects it, and changing it means a new record. |
| **Superseded by ADR-NNN** | No longer in force. Kept, because the reasoning explains why the code once looked the way it did. |
| **Deprecated** | Still partly in force, being unwound, with no single replacement record. |

Every record in this directory is currently **Accepted**. Where a decision has been extended or
hardened since it landed, the Status line names the releases involved.

---

## Conventions

- **One decision per record.** A record that decides three things cannot be superseded cleanly.
- **State the limits.** Several records name something the decision explicitly does not do:
  MCP output framing is not a defence against prompt injection, the process split is not a
  sandbox, row-level security does not guard what the server pushes. A boundary whose limits are
  not written down gets trusted for things it never did.
- **Prefer the specific to the general.** "A real generation shipped a class definition that
  parsed and raised `TypeError` on import" is worth more than "validation should be thorough".
- **Numbers are permanent.** Never renumber, never reuse.
- **Records are historical.** They describe the decision at the time it was made. Later
  developments belong in a later record or in the Status line, not in a rewritten Context section.

---

## Related documents

| Document | What it holds |
|---|---|
| [`README.md`](../README.md) | How the system works, in full, and how to run it |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | The rules enforced by tests rather than by review, and the invariant to suite table |
| [`SECURITY.md`](../SECURITY.md) | Reporting policy, scope, severity, and the known limitations that are not findings |
| [`CHANGELOG.md`](../CHANGELOG.md) | Every release, what changed in it, and what was verified |
| [`schema/events.md`](../schema/events.md) | The frozen v1 event schema, normative |
| [`server/src/auth/THREAT-MODEL.md`](../server/src/auth/THREAT-MODEL.md) | What the authentication boundary stops, and what it does not |
