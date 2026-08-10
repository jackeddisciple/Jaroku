# ADR-015: Treat MCP Servers as Untrusted Code, Granted Per Tool, Behind an Impact Ratchet

## Status

Accepted. Introduced in v0.2.0 (31 July 2026) and hardened in v0.2.1.

## Context

Reviewed connectors solve the trust problem by limiting coverage to what has been audited
(ADR-014). That is deliberately restrictive, and the Model Context Protocol is the obvious way
to widen it: a user connects a server, and its tools become available to their agents.

The temptation is to treat an MCP server as a connector that happens to arrive over HTTP. That
would be wrong in four specific ways:

| | Reviewed connector | MCP server |
|---|---|---|
| Provenance | hand audited here | third party, unread |
| Tool list | declared in a catalog | **discovered** at runtime, and can change |
| Parameters | a display-only signature | a machine-readable JSON Schema |
| Output | trusted, because we wrote it | untrusted input |

An MCP server's *description of itself* travels further than its results do. A tool name and
description are stored, put on every registry snapshot every connected client receives, written
into a generated project's manifest, and pasted into the generation prompt. They are read once
and repeated everywhere.

Additional constraints:

1. The frozen event schema must not change. An MCP tool call is an ordinary `tool_call` step.
2. The product cannot promise a user what an unread tool does, so the user has to be the
   reviewer, with enough information to review.
3. Some tools are irreversible. `send_message` is not `get_message`, and the difference has to
   be detected without trusting the server's own claim about it.
4. A copied-out project must still work outside Jaroku, where there is nobody to ask.

## Decision

**An MCP server is never trusted.** Its tool list is a claim, its self-classification is
ignored, its output is untrusted input, and its advertisement is bounded at the point it
arrives. Everything below rides beside the frozen schema in new tables and a new channel,
exactly as pause and resume and the evaluation engine did.

**Only Streamable HTTP endpoints are supported.** stdio is deliberately not, because it means
running a third-party binary on the user's machine, which is a much larger decision than making
a request.

**Discovery is a handshake, and failure is classified rather than swallowed:** `connected`,
`unreachable` (previously discovered tools are kept, because wiping a tool list on a network
blip would silently strip every agent scoped to that server), `auth_required`, or `error`.

**An advertisement has to satisfy bounds before it is stored.** A tool name must be 1 to 128
characters of `[A-Za-z0-9_-]`, because the model API accepts nothing else: one tool called
`my tool` does not produce one broken tool, it produces a 400 on every request the agent makes.
`__proto__` is refused, because as a plain-object key it assigns a prototype rather than an
entry. Descriptions are capped and flattened to one line with ANSI escapes and control
characters stripped. A schema over 64 KB is refused whole rather than truncated, because
checking arguments against a half-schema the server never declared is worse than not having the
tool. `serverInfo` is bounded and stripped for the same reasons. Refusals are counted and
reported, never silent.

**Impact classification is a ratchet.** An untrusted or unreliable signal may raise impact,
never lower it:

1. The server's own `ToolAnnotations`. `destructiveHint: true` is believed. `readOnlyHint: true`
   is **ignored**, because letting a server certify its own tool as safe would make the gate
   opt-out, defeated by four characters of JSON.
2. The tool **name**, which by MCP convention leads with its verb. This is the only signal
   allowed to decide in both directions, because it is a machine identifier the author chose. A
   high verb anywhere outranks a low one, and a leading-position-only lexicon keeps a read's
   object from reading as a verb, so `get_message` stays low while `send_message` does not.
   Matching is exact rather than stemmed, so `list_deleted_items` is low.
3. The description's opening words, and only as evidence of a write.
4. **Otherwise high.** A tool called `frobnicate` gets a prompt, because nobody, including us,
   knows what it does. This mirrors the evaluation engine treating unrecognised failures as
   deterministic: when a heuristic cannot read something, it must fail toward the answer that is
   expensive rather than the one that is silent.

A user can override any classification in either direction, and the reason is shown beside it.
An override is stamped with the schema it was judged against, so if the server later changes
that tool's parameters the override is **voided and says so**.

**Least privilege is per tool, never per server.** Connecting a server makes its tools available
to choose from and grants an agent nothing. The selection travels through the approved plan into
a host-written `mcp_tools.json`, and the reviewed `mcp_bridge.py` builds exactly the tools that
file lists with no dynamic discovery and no tool name passed in from the agent.

**One name, one tool.** Selecting the same tool name from two servers is refused at generation
time, naming both, because whichever entry won the agent would call a server the user did not
pick, and if the two differ in impact a high-impact tool's confirmation gate would be replaced
by a same-named low-impact one and never fire.

**A high-impact tool stops for confirmation before its first call in a run.** The arguments are
the body of the dialog, not a detail behind a disclosure: the tool was approved in principle
when it was selected, and what has never been approved is *this* call with *these* values.
Denying or timing out **raises**, so a refusal lands as a red `tool_call` step the model is told
about. Timing out denies. "Allow for this run" lasts exactly as long as the process. The
mechanism is the one pause and resume already uses: a `@@JAROKU_CTRL@@` line on stderr and an
approval file back.

**Output is isolated.** Capped (default 20,000 characters) with the truncation announced,
stripped of ANSI escapes and control characters, non-text blocks named by type rather than
stringified, and framed as `[mcp:<server>/<tool> returned the following external data]`. That
framing is explicitly *not* claimed to be a defence against prompt injection; it is the only
point in the pipeline where such text can be labelled at all.

**Outside Jaroku the bridge proceeds with a warning**, because a person running a script on
their own machine is the authorisation, and a hard denial would break the portability promise.
`JAROKU_MCP_CONFIRM=require` refuses instead, and deployed containers set it.

## Alternatives Considered

### Option 1: Untrusted by default, per-tool grants, impact ratchet, confirmation gate

- Pros
  - Coverage extends to any MCP server without anyone auditing it, while the trust boundary
    stays honest.
  - Per-tool grants mean a server growing a `delete_everything` tool tomorrow cannot reach an
    agent generated today.
  - The ratchet fails toward asking, which is the recoverable direction.
  - Bounding the advertisement at arrival protects storage, every client, the manifest and the
    prompt in one place.
  - The frozen schema is untouched: an MCP tool call is an ordinary `tool_call` step.
- Cons
  - Substantial machinery: a registry, a classifier, a manifest, a bridge, a confirmation
    protocol and an isolation layer.
  - Friction on legitimate high-impact tools, which risks training users to click through.
  - The classifier is a heuristic and will be wrong in both directions.
  - Per-tool selection is more work for the user than per-server.

### Option 2: Treat an MCP server like a connector once the user has connected it

- Pros
  - Much simpler. Connect, get tools, generate.
  - No classifier, no confirmation gate, no manifest.
  - Less friction for the user.
- Cons
  - Grants an agent a server's entire catalogue, including tools added after the agent was
    built.
  - Makes the reviewed-connector badge meaningless, because reviewed and unread code would look
    identical.
  - An irreversible tool would run without anyone seeing the arguments.
  - A server's self-reported `readOnlyHint` would effectively become the safety boundary.

### Option 3: Do not support MCP at all, and extend the reviewed connector catalogue instead

- Pros
  - The strongest trust story: every reachable capability is audited.
  - No untrusted advertisement, no classifier, no gate.
- Cons
  - Coverage is bounded by authoring capacity, permanently.
  - Users with an existing MCP server would have no route in.
  - Does not remove the trust problem, it removes the feature, and the pressure to widen
    coverage returns immediately.

## Consequences

### Positive

- Coverage is unbounded while the trust boundary stays explicit and visible: MCP tools carry a
  badge everywhere they appear.
- An agent's MCP reach is exactly one file, `mcp_tools.json`, which is host written and
  read-only to the edit loop, so it can be audited by reading one document.
- The whole feature is testable for free. `server/fixtures/mcp/mockServer.ts` speaks real MCP
  over `node:http` and raw JSON-RPC rather than the MCP SDK, precisely so it can advertise
  things a well-behaved server never would, and so the client is tested against something that
  does not share its implementation.
- The free dry-run model synthesises arguments from each tool's real declared JSON Schema, so
  every MCP tool is exercised with no server, no credential and no money.
- v0.2.1's adversarial suite carried 34 assertions, 17 of which failed against the code as it
  stood, which is the value of writing a fixture built to misbehave rather than to pass.

### Negative

- The feature is large: a registry, a client, a classifier, a manifest builder, a bridge, a
  confirmation protocol, an isolation layer and six test suites.
- Friction is real. A misclassified read-only tool prompts on every run until overridden.
- The classifier is a heuristic over names and prose, and will be wrong.
- Per-tool selection is more work than per-server, and the duplicate-name refusal is an
  additional thing a user has to resolve.
- OAuth is not supported, so servers requiring it cannot be connected. They are told so
  explicitly rather than failing as a generic authorisation error.

### Trade-offs

- Friction was accepted over silence. A gate that opens when nobody answers is a gate that opens
  whenever someone steps away from their desk, so timing out denies.
- The honest limit is stated rather than hidden: the finest grain MCP exposes is the tool. There
  is no sub-tool scoping in the protocol, so if a tool's own schema permits more than an agent
  needs, nothing here can narrow it.
- Framing untrusted output is not claimed as a prompt injection defence. An agent's blast radius
  is bounded by its grants, and that is the actual mitigation.
- Standalone projects proceed on a high-impact tool with a warning, trading strictness for the
  portability promise, and deployed containers reverse that trade because nobody is there to ask.

## Implementation Notes

- `server/src/mcpClient.ts` performs the handshake (`initialize`, `notifications/initialized`,
  `tools/list`). Every wait is bounded twice, per request (`JAROKU_MCP_TIMEOUT_MS`, default
  10000) and across the whole discovery (`JAROKU_MCP_DISCOVERY_MS`, default 30000), because a
  slow server is indistinguishable from a hostile one holding a connection open. Pagination is
  bounded too: `nextCursor` is server-controlled state.
- `server/src/mcpImpact.ts` holds the ratchet, with the reason stored alongside the
  classification.
- `server/src/mcpRegistry.ts` handles connect, re-discover and remove. A failed refresh never
  destroys a working tool list.
- `server/src/mcpManifest.ts` builds `mcp_tools.json`, the grant. `runtime/tool_templates/
  mcp_bridge.py` is the reviewed bridge, copied byte for byte like any connector, and updating
  the template does not retroactively change agents that already exist.
- Importing the bridge does file reads only and never network, because validation imports the
  staged project under a 20 second kill timer and graph introspection imports it again, and
  neither may depend on a third party being awake.
- A URL carrying a username or password is refused before anything is sent, and the error does
  not quote it back, because the refusal would otherwise put the password into `last_error`,
  into the database, onto every client's registry snapshot and into the log.
- Runtime configuration: `JAROKU_MCP_CONFIRM` (`require` or `skip`),
  `JAROKU_MCP_CONFIRM_TIMEOUT_S` (default 120, denies on expiry),
  `JAROKU_MCP_CALL_TIMEOUT_S` (default 60), `JAROKU_MCP_MAX_RESULT_CHARS` (default 20000),
  `JAROKU_MCP_<SERVER>_TOKEN` for credentials, and `JAROKU_CONTROL_DIR`, whose *absence* is how
  a copied-out project knows nobody is watching.
- Validation checks MCP wiring the same way it checks reviewed connectors: `MCP_TOOLS` must be
  reachable from `TOOLS`, a generated function shadowing a granted tool's name is rejected, and
  a literal `tool.invoke({...})` is checked for missing required keys and keys the tool does not
  accept, naming the server that declared them. Two things it deliberately does not claim: a
  schema declaring no properties accepts anything, and a dict assembled at run time is left to
  the bridge's own per-call check.

## Security Considerations

- **A server's advertisement is untrusted input that travels far**, so it is bounded at arrival
  rather than at each consumer. This is the single most important structural decision in the
  feature.
- **`readOnlyHint` is ignored.** Trusting it would make the gate opt-out.
- **The manifest is the grant, and the bridge offers no way to reach anything else.** No dynamic
  discovery, no tool name passed in from the agent.
- **Credentials never reach the database, a generated project, a log line or the browser.** A
  token entered in the UI is written to `runtime/.env` under a derived name and read from the
  environment at the moment of a request. What a client learns is `configured: true`.
- **A server flagging its own call as failed becomes a raise**, not a returned string, for the
  same reason connector templates raise.
- **High-impact tools fail closed in a deployed container.** Nobody is there to ask, and the
  bridge's per-run grant is module-global, so one approval would leak across every later request
  for the life of the process. Deployed agents run with `JAROKU_MCP_CONFIRM=require`.
- **Prompt injection is not solved**, and the README and `SECURITY.md` both say so. Framing
  external data is labelling, not defence.
- A gap was recorded rather than quietly patched in v0.2.1: generated agent code can set an
  environment variable that disables the confirmation gate, which needs a new validation rule.

## Performance Considerations

- Every wait is bounded twice, per request and per operation, so a hostile or slow server cannot
  stall discovery indefinitely.
- Pagination is bounded, because an unterminating `nextCursor` would be a trivial denial of
  service against Jaroku itself.
- Results are capped at 20,000 characters by default, which bounds what enters a step payload
  and a model context.
- Non-text content blocks are named by type rather than stringified, so an image never arrives
  as a base64 wall in a step row.
- The confirmation gate stops a run for up to `JAROKU_MCP_CONFIRM_TIMEOUT_S`, which is the one
  place where a human is deliberately in the latency path.

## Operational Considerations

- `npm run mock:mcp` in `server/` starts a fixture server at `http://127.0.0.1:8931/mcp`.
  `MOCK_MCP_TOKEN=...` requires a bearer token and `MOCK_MCP_HOSTILE=1` adds tools that return
  10 MB of text, control characters, non-text-only content, 400-deep nesting, an injection
  attempt, a self-reported error, and one that never answers at all.
- A server showing `unreachable` keeps its previously discovered tools. That is intended.
- An override that suddenly stops applying means the server changed that tool's schema and the
  override was voided, which is stated in the panel.
- A duplicate tool name across two connected servers blocks generation until one is deselected.
- Give the plain URL and add the token separately. A URL with embedded credentials is refused.

## Rejected Alternatives

**Treating an MCP server like a connector once connected** was rejected because it grants an
agent a server's entire catalogue, including tools that server adds later, and because it would
make the reviewed-connector guarantee meaningless by making audited and unread code look
identical. It would also leave the safety boundary at the server's own `readOnlyHint`, which is
four characters of JSON written by the party being constrained.

**Not supporting MCP at all** was rejected because it does not remove the trust problem, it
removes the feature, and the pressure to widen coverage returns immediately. The reviewed
catalogue is bounded by authoring capacity, and a user with an existing MCP server would have no
route in. The chosen design widens coverage without pretending the new code is reviewed.

## Related Decisions

- ADR-005: The generated agent contract
- ADR-008: A plan gate before generation, which is where MCP tool selection is approved
- ADR-010: A checkpointed twin for pause, resume and branch, whose stderr control plane the
  confirmation gate reuses
- ADR-014: Reviewed connector templates copied byte for byte
- ADR-026: Credential handling: names travel, values do not
- ADR-027: Deployment into the user's own hosting account
- ADR-028: Tests as plain scripts, with structural audits

## References

- `server/src/mcpClient.ts`, `mcpImpact.ts`, `mcpRegistry.ts`, `mcpManifest.ts`, `mcpStore.ts`
- `runtime/tool_templates/mcp_bridge.py`
- `server/fixtures/mcp/mockServer.ts` (`npm run mock:mcp`)
- `npm run test:mcp-impact`, `test:mcp-client`, `test:mcp-registry`, `test:mcp-isolation`,
  `test:mcp-validate`, `test:mcp-hardening`
- README section "MCP servers"
- CHANGELOG v0.2.0 "MCP Server Support" and v0.2.1 "MCP Hardening"
- Model Context Protocol specification, https://modelcontextprotocol.io
