# ADR-014: Ship Connectors as Hand Audited Templates Copied Byte for Byte

## Status

Accepted. Introduced in v0.0.3 (21 July 2026). Wiring protection extended in v0.1.12,
per-connector install requirements added in v0.2.3, and three connectors added in v0.3.6.

## Context

An agent that cannot reach anything is a chatbot. The useful agents read a mailbox, query a
database, or post to a channel, and every one of those capabilities is code that holds a
credential and touches a real system.

The default behaviour of a generative builder is to write that code. Ask for an agent that
queries Postgres and the model produces a `pg_query` function. That function is untrusted text.
It might interpolate SQL. It might not be read-only. It might not close the connection. It might
be subtly different every time the same agent is generated.

There is a specific, demonstrated hazard here. A real generation produced a tool that built SQL
with an f-string, which is an injection vector even against a read-only connection: a crafted
input can widen a `SELECT` to rows the user should never see. That defect was found in a live
call, not hypothesised.

The requirements were therefore:

1. Code that holds credentials and touches real systems should be reviewed by a person.
2. It should be identical in every project, so a review is worth something beyond the project it
   was performed on.
3. It should not force every installation to carry every connector's SDK.
4. The model should still be able to build bespoke tools around it, because that is the product.

## Decision

**Connectors are reviewed, hand-audited tool templates, copied byte for byte into generated
projects. They are never written by a model and never rewritten by one.**

`runtime/tool_templates/catalog.json` is the registry. The server reads it to render tool
signatures into the generation prompt, to copy the right files into a project, and to build
`.env.example` from each connector's `required_env`.

Six connectors ship today, and each carries an explicit safety posture:

| Connector | Tools | Required env | Safety posture |
|---|---|---|---|
| Gmail | `gmail_search`, `gmail_create_draft` | `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | Creates drafts only, never sends |
| Google Calendar | `gcal_list_events`, `gcal_get_event`, `gcal_create_event`, `gcal_update_event` | `GCAL_CLIENT_ID`, `GCAL_CLIENT_SECRET`, `GCAL_REFRESH_TOKEN` | No delete. Writes are irreversible and the prompt says so. Scope is `calendar.events`, not the wide `calendar` |
| Slack | `slack_list_channels`, `slack_read_channel`, `slack_post_message` | `SLACK_BOT_TOKEN` | Posting is immediate and irreversible, and the prompt says so explicitly |
| Stripe | `stripe_get_customer`, `stripe_list_payments`, `stripe_get_payment`, `stripe_list_invoices`, `stripe_get_invoice`, `stripe_get_balance` | `STRIPE_SECRET_KEY` | Read only, enforced twice: only `retrieve`/`list`/`search` are called, asserted from the file's own syntax tree, and a full-access `sk_live_` key is refused at save |
| Postgres | `pg_query` | `DATABASE_URL` | Read only, enforced twice: a statement check and a read-only transaction. One statement, `SELECT` or `WITH ... SELECT` only, capped at 100 rows |
| HTTP/Webhook | `http_request` | `HTTP_ALLOWED_DOMAINS` | HTTPS to exact hostnames only, no wildcards; private ranges refused whatever a name resolves to; DNS pinned at request time; redirects reported, never followed |

Four rules make the guarantee hold.

**Templates are copied, never re-rendered.** Generation copies the file. The model is given the
tool signatures so it can call them, and is told (hard rule 6) to use them exactly as given.

**Templates are hard read-only to the edit loop.** The block list covers every connector
filename in the catalog whether installed or not, so the model cannot introduce a file
masquerading as a reviewed template. A request to change one is refused with a message pointing
at the right move: ask for a wrapper tool that adapts its results instead.

**The wiring is protected too.** `tools/__init__.py` decides which tools get bound and cannot be
read-only, because adding a bespoke tool means editing it. So the validator follows
`TOOLS = ...` assignments through one level of local variable and rejects a project that
advertises a connector it can no longer call, or that defines a function shadowing a reviewed
tool's name.

**Each template lazy-imports its SDK**, so the base install stays light and a missing SDK
produces a clear message rather than an import crash. Connector SDKs live in the `connectors`
optional extra.

Adding a connector means writing the template, adding its entry to `catalog.json`, and running
the `check_catalog()` verification in `tool_templates/__init__.py`.

## Alternatives Considered

### Option 1: Reviewed templates copied byte for byte

- Pros
  - The code that holds credentials is reviewed once by a person and is identical everywhere.
  - Safety properties (drafts only, read only, row caps) are properties of the system rather
    than of a particular generation.
  - Deterministic: the same connector in two projects is the same bytes, so a defect found in
    one is a defect found in all.
  - The generation prompt only needs signatures, which is cheaper than describing an
    implementation.
  - Bespoke tools can still wrap a connector, so expressiveness is preserved where it is safe.
- Cons
  - Adding a connector is manual work: write it, audit it, register it, test it.
  - The catalogue limits what an agent can reach out of the box.
  - Copies are frozen at generation time, so a template improvement does not reach existing
    agents.
  - The read-only rule occasionally blocks a legitimate customisation.

### Option 2: Let the model write connector code

- Pros
  - Unlimited coverage: any API the model knows about becomes reachable immediately.
  - No catalogue to maintain and no review bottleneck.
  - The generated code can be tailored precisely to what the agent needs.
- Cons
  - The code holding a credential is untrusted text, and a real generation demonstrably produced
    an SQL injection vector.
  - Safety properties become per-generation accidents rather than guarantees. "Read only" is
    whatever the model wrote this time.
  - Nothing can be promised to a user about what a connector does, so nothing can be documented.
  - A defect found in one project says nothing about the next.

### Option 3: Depend on an external tool or integration library

- Pros
  - Large existing catalogues, maintained by someone else.
  - No per-connector authoring work.
- Cons
  - Reintroduces the trust question: a third-party integration is code nobody here has read,
    which is precisely the category MCP servers occupy and are treated as untrusted for.
  - The safety postures that matter (drafts only, read-only twice over, row caps) are Jaroku's
    opinions and would not be enforced by a general library.
  - Adds a heavy dependency to every generated project, undermining portability.

## Consequences

### Positive

- A user can be told exactly what a connector does, and it is true for every agent that uses it.
- The Postgres connector's read-only guarantee is enforced twice, by a statement check and a
  read-only transaction, and neither is at the model's discretion.
- Because templates are files, a security review is a code review of three files rather than an
  audit of every generated project.
- The distinction between reviewed connectors and unreviewed MCP tools is meaningful and
  visible, which is what makes the MCP badge mean something. See ADR-015.
- Deployment images install only what an agent actually uses, because each connector declares
  its own install requirements in the catalog.

### Negative

- Connector coverage is limited to what has been written and audited. This is the main reason
  MCP support exists.
- A copied template is frozen at generation time. Updating the template does not retroactively
  change agents that already exist.
- The read-only rule can frustrate a user who wants a small change to a connector's behaviour.
  The answer is a wrapper tool, and the refusal message says so.
- Adding a connector is a review bottleneck by design.

### Trade-offs

- Coverage was traded for trustworthiness. Three audited connectors that behave predictably were
  judged more valuable than an unbounded set that behaves differently each time.
- Copying rather than importing was chosen so generated projects stay portable and self
  contained, at the cost of losing central updates.
- Optional SDK installation was chosen so the base install and the free dry-run path never
  depend on a connector library, at the cost of a clear runtime message when one is missing.

## Implementation Notes

- Templates live in `runtime/tool_templates/`: `gmail.py`, `google_calendar.py`, `slack.py`,
  `stripe_connector.py`, `postgres.py`, `http_connector.py`, plus `mcp_bridge.py` and `serve.py`,
  which are reviewed templates for different purposes.
- `catalog.json` is the registry: ids, tool signatures, `required_env` and the install
  requirements used to build a deployment image.
- `check_catalog()` in `tool_templates/__init__.py` verifies a new entry, and **CI runs it** as of
  v0.3.6. Before then, three documents told a contributor to run it and nothing did — so a catalog
  entry naming a file that is not there, a `required_env` that disagreed with its module, or a
  `pip_requires` outside the extra could each have merged on the word of whoever last typed it into
  a REPL. `npm run test:connector-catalog` is that check, plus `check_failures_raise()`.
- The per-connector suites live in `runtime/tool_templates/tests/` — inside the package, so an
  ordinary relative import reaches the template, and unreachable by the generator, which copies
  connectors one named file at a time. None of them touches a network or a real SDK: each fakes
  its SDK into `sys.modules` before the template's lazy import runs, which is also the only way to
  assert what a template SENDS rather than merely that it did not crash.
- Each template lazy-imports its SDK inside the function that needs it, so importing the module
  never fails on a missing dependency.
- Hard rule 7 requires tools to raise on failure rather than return an error string, and it
  applies to templates too. A returned error string is recorded as a successful tool call, so
  the trace shows a green step whose content is an error. v0.1.12 fixed a case where a reviewed
  connector's failures were swallowed instead of surfaced, which was the most serious defect in
  that release precisely because trust in reviewed code depends on failures being loud.
- Hard rule 6 tells the model to use templates exactly as given; the read-only block list and
  the wiring check enforce it.
- The generation prompt receives tool signatures rendered from the catalog, not implementations.

## Security Considerations

- **The Postgres connector is read-only twice over**: a statement check that permits one
  statement, `SELECT` or `WITH ... SELECT` only, and a read-only transaction. It is also capped
  at 100 rows.
- **f-string SQL is a hard validation failure** in generated code, enforced by AST analysis
  requiring actual query shape. It is an injection vector even against a read-only connection.
- **The Gmail connector creates drafts only.** It never sends.
- **The Google Calendar connector never deletes.** It creates and updates, both of which are
  irreversible in the sense that matters — an invitation cannot be unsent and the attendees have
  already seen it — so both the catalog description and the tool docstrings say so where the model
  reads them. Deleting somebody's meeting has no undo at all and takes two clicks in the calendar
  UI, so there is no `gcal_delete_event` and there should not be one. The scope asked for is
  `calendar.events` rather than `calendar`: the wide one grants creating, deleting and sharing
  CALENDARS, which no tool here does, and it is what the consent screen would then say.
- **The Stripe connector cannot mutate anything, and that is proven from the file rather than
  reviewed into it.** The way "this connector cannot charge anybody" stops being true is a
  seventh tool or a fourth branch, neither of which exists to be called until it has already been
  written — so `test:connector-stripe` walks the template's own syntax tree and refuses any SDK
  call whose method is not `retrieve`, `list` or `search`. A tree rather than a substring scan,
  because `getattr(sdk.Refund, verb)(...)` passes a text search and is the whole vulnerability.
  The second layer is Stripe's: a full-access `sk_live_` key is refused at save, on every write
  path including the bulk `.env` import, so "use a restricted key" is enforcement rather than
  advice. Returned fields are an allowlist, never a denylist, and nothing is `expand`ed —
  a denylist is wrong the first time Stripe adds a field.
- **The HTTP connector's allowlist is the connector.** Without it correct there is no connector,
  only a request-forger running model-written Python inside somebody's infrastructure. HTTPS only;
  exact hostnames with no wildcards, because the domain anybody would want a wildcard on is a
  shared platform and a wildcard there grants every tenant of it; credential-in-URL refused before
  anything is sent and never quoted back into a stored trace; and the name resolved once with
  EVERY answer checked, the socket dialled at a literal address while TLS still validates the
  certificate against the hostname. A redirect is reported and never followed — a redirect is the
  one thing a server at an approved address controls completely, and following it hands the choice
  of destination to whoever answered, which is how an allowlist becomes advisory.
- **The private-range refusal is written twice, deliberately.** `sandbox/egressPolicy.ts` refuses
  for the policy and `http_connector.py` refuses again inside the sandbox, because the control
  plane cannot make this check for a request the sandbox originates and the sandbox cannot call
  TypeScript. Two copies of a rule is normally how they drift, so `test:egress-connectors` reads
  the other language's source and holds them to each other in both directions. Delegating the
  Python half to `ipaddress`'s own predicates was tried first and had a hole in it: `100.64.0.0/10`
  is not `is_private` in Python 3.12, having been in that table in earlier versions.
- **The Slack connector can post**, which is irreversible, and both the catalog description and
  the generation prompt state that explicitly rather than leaving it implied.
- Credentials are read from the environment at the moment of use. Templates never hold, log or
  return a credential value. See ADR-026.
- The read-only block list covers every connector filename in the catalog whether that connector
  is installed or not, so a model cannot introduce a file that impersonates a reviewed template.

## Performance Considerations

- Lazy imports mean a project that uses one connector pays for one SDK, and the dry-run path
  pays for none.
- Copying a template is a file copy at generation time, with no runtime cost.
- The Postgres row cap of 100 bounds the size of a tool result, which bounds what enters a step
  payload and a model context.
- Deployment images install per-connector requirements from the catalog, so an agent with one
  Postgres tool does not pull in the Google API client.

## Operational Considerations

- `uv sync --extra connectors` installs the connector SDKs and the MCP client. Without it,
  connector tools return a clear message rather than crashing.
- A deploy refuses when a required connector credential is missing or was unticked, because
  rule 7 makes an unconfigured template raise on every call: that container deploys green and is
  dead. The refusal is overridable by checkbox, for a user who intends to set the variable in
  their hosting account by hand.
- Updating a template does not change existing agents. Regenerate or edit the agent to pick up
  a new version.
- Adding a connector: write the template, add the catalog entry with `required_env` and install
  requirements, run `check_catalog()`, and add it to the generation prompt's rendered
  signatures automatically through the catalog.

## Rejected Alternatives

**Letting the model write connector code** was rejected on evidence rather than principle. A
real generation produced a tool that built SQL with an f-string, which is an injection vector
even against a read-only connection. When the code that holds a credential is written afresh
each time, every safety property becomes an accident of that generation, and nothing can be
promised to a user or documented in a README.

**Depending on an external integration library** was rejected because it reintroduces exactly
the trust question the templates exist to answer. A third-party integration is code nobody here
has read, which is the category MCP servers occupy and are deliberately treated as untrusted
for. It would also not enforce the specific safety postures that make these connectors
defensible, and it would add a heavy dependency to every generated project.

## Related Decisions

- ADR-005: The generated agent contract
- ADR-007: Staging directories with atomic swap, gated by layered validation
- ADR-009: The fix loop: full file rewrites, reviewable diffs, snapshot based undo
- ADR-015: MCP servers treated as untrusted code
- ADR-026: Credential handling: names travel, values do not
- ADR-027: Deployment into the user's own hosting account

## References

- `runtime/tool_templates/catalog.json`, `gmail.py`, `slack.py`, `postgres.py`
- `runtime/tool_templates/__init__.py`, `check_catalog()`
- `server/src/connectors.ts`, `server/src/validator.ts`, `server/src/projectFs.ts`
- `server/fixtures/rejected-tool-call-and-sql.txt`, the permanent regression fixture
- README section "Connectors"
- CHANGELOG v0.0.3, v0.1.12 "Trust and Stability Fixes", v0.2.3
