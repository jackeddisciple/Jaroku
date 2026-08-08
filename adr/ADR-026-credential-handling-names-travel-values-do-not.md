# ADR-026: Handle Credentials So That Names Travel and Values Do Not

## Status

Accepted. Established in v0.0.3 (21 July 2026) as a read-only discipline, extended to writing in
v0.2.0, and generalised to the deployment path in v0.2.3.

## Context

Jaroku holds a lot of other people's credentials: provider API keys that are spendable, MCP server
tokens that reach third-party systems, connector credentials for a mailbox or a database, and a
hosting account token. It also generates code, streams data to browsers, writes logs, stores rows
in a database, and packages container images. Every one of those is a place a credential can
escape to.

The failure modes are all silent. A key in a log line is discovered when the log is read by
somebody who should not have it. A key echoed to a browser is in the developer tools of anyone
watching. A key in a database column is in every backup. A key in an argument is in a
world-readable process table.

Two further constraints made the design specific.

**The credential file is the user's.** `runtime/.env` holds their Anthropic key and their database
URL alongside anything Jaroku writes. It is edited by hand far more often than by the product, so
anything that writes to it must leave every other line alone.

**The `.env` format has no escape sequences.** The loaders strip one layer of matching quotes and
stop. A value that cannot be represented faithfully must be refused rather than mangled, because a
credential quietly altered on the way to disk produces a 401 with no explanation anywhere.

## Decision

**Names travel. Values do not.**

`runtime/.env` is the only home for a credential value on this machine. `process.env` is the only
reader. What crosses a socket, lands in a database column, appears in a log line or reaches a
generated project is a **name** and a boolean.

```
runtime/.env  (chmod 600, gitignored)          the only home
     |
process.env                                     the only reader
     |
NAMES  --->  the browser sees [{ name, configured: true|false }]
     |       NO VALUE CROSSES THE SOCKET
VALUES --->  read at the moment of use
               - into an HTTPS request body, never argv, never a log, never the database
               - held for one operation, to scrub the value out of returned output
               - cleared in a finally
```

Six rules implement it.

**One writer.** `server/src/envWriter.ts` is the only code that writes `runtime/.env`. Provider
keys entered during onboarding or in Settings, MCP tokens and the Railway token all go through the
same instance.

**Every other line survives byte for byte.** An existing key is rewritten in place, a new one is
appended, and comments, ordering, blank lines and unrelated keys are untouched.

**A value containing a newline is refused.** Without that check, pasting
`abc\nANTHROPIC_API_KEY=...` into a token field would rewrite the user's API key.

**Nothing is written that cannot be read back identically.** Every candidate line is parsed back
with the real loader first, and a value with no faithful representation is refused rather than
quietly mangled.

**The file is `chmod 600` and gitignored.** A credential Jaroku wrote should not be the one that
is world readable.

**Environment beats file, on both sides, by design.** A variable already exported in the user's
shell wins after a restart, so shell environment and CI secrets still override the file. Writing
one that is shadowed warns, because a token that silently reverts is a baffling thing to debug.

**Testing a credential writes nothing.** `setProviderKey` and `testProviderKey` are two commands
rather than one on purpose, so "Test connection" cannot put a credential on disk before Save is
pressed. The same split exists for the Railway token. Both tests are list calls, so checking a key
is free.

For the deployment path, where a credential genuinely has to leave the machine, three additional
rules apply.

**Never in an argument.** A process table is world readable. This is the only reason the deploy
transport is split: the API sets variables in a request body, and the CLI, which would need
`--set NAME=value`, is used only to upload source.

**Never in a log.** Values exist as a local inside one function, and every build log line is
scrubbed before it is broadcast or stored, because the hosting platform echoes build output and a
`RUN echo $DATABASE_URL` would otherwise land in the log pane, the database table and every
browser at once. Values under 8 characters are left alone, because a log full of holes says more
than it hides.

**Never in the image.** `.dockerignore` excludes `.env`, and no artifact contains a credential.
Secrets arrive only as host environment variables at run time, which is exactly what the "the
environment wins" precedence was built for.

Both env loaders, `server/src/env.ts` and `runtime/jaroku_interceptor/env.py`, log key **names**
only, never values.

## Alternatives Considered

### Option 1: A single dotenv file, one writer, and a names-only interface

- Pros
  - One place a value can be, so auditing "where could this leak" is tractable.
  - Familiar to developers and directly usable by both runtimes.
  - `configured: true` is enough for every UI purpose, so no value ever needs to reach a browser.
  - Round-trip verification makes silent corruption impossible.
  - No infrastructure required, so the local path stays installation free.
- Cons
  - Plaintext on disk, protected by file permissions rather than encryption.
  - Process-wide rather than per workspace, so "anthropic is configured" is a fact about the
    install rather than about a tenant.
  - A file edited by hand and by the product needs careful merge behaviour.
  - No rotation, versioning or access audit.

### Option 2: A secret manager or an encrypted store

- Pros
  - Encryption at rest, access auditing, rotation and per-workspace scoping.
  - The correct answer for a multi-tenant hosted product.
- Cons
  - Requires infrastructure, which costs the property that `npm run dev` needs nothing installed.
  - The Python runtime would need to reach it too, so the credential path grows a network
    dependency in the middle of a run.
  - Substantial machinery for a single-user local tool, and premature before per-workspace
    secrets exist as a product concept.

### Option 3: Store credentials in the application database

- Pros
  - Already present, already backed up, already workspace scoped.
  - Natural place for per-workspace secrets.
- Cons
  - Every database dump becomes a credential dump, and dumps are shared far more casually than
    key files.
  - A row is reachable by any query bug, whereas a file is reachable only by the process.
  - Requires an encryption scheme and key management, which relocates the problem rather than
    solving it.

## Consequences

### Positive

- There is exactly one place a value lives, so "could this leak" is answerable by reading one
  module and one file path.
- The browser has never received a credential value. What it learns is `configured: true`, by
  name.
- The deployment path moves a value exactly once, into an HTTPS request body, and scrubs it out of
  everything that comes back.
- The one credential ever sent *to* a browser is the deployed agent's bearer token, which is shown
  once and persisted nowhere: not in the deployments row, not in the deployment logs, not in
  `localStorage`. Reloading loses it, and the card says so.
- Round-trip verification means a credential is never silently altered on the way to disk.
- The Railway token is stripped from every agent subprocess. An agent's own keys have to be there;
  a deploy credential does not.

### Negative

- Credentials are plaintext on disk, protected by file permissions.
- Provider keys are process wide, so "anthropic is configured" is a fact about the installation
  rather than about a workspace. The `providers` channel is already scoped per workspace, so the
  shape is right for a per-workspace secret store when one arrives.
- No rotation, no versioning and no access audit.
- The "environment wins" precedence surprises people, which is why the writer warns when it writes
  a shadowed variable.
- Scrubbing skips values under 8 characters, so a very short secret would not be redacted from a
  build log. That is a deliberate trade against unreadable output.

### Trade-offs

- Simplicity and zero infrastructure were traded for encryption at rest, appropriate for a local
  tool and explicitly inadequate for a multi-tenant hosted deployment.
- Refusing an unrepresentable value was chosen over escaping it, because refusal produces a
  sentence and mangling produces a 401 with no explanation.
- The transport split in the deployment path (API for variables, CLI only for upload) exists for
  one reason: the CLI would require the value in an argument, and a process table is world
  readable.
- Deploy values are held in memory for the duration of a deploy so build output can be scrubbed.
  That is no worse than `process.env`, which holds them for the whole process, and they are
  cleared in a `finally`.

## Implementation Notes

- `server/src/envWriter.ts` is the only writer. Its header states each rule and the reason.
- `server/src/env.ts` and `runtime/jaroku_interceptor/env.py` read with identical precedence:
  a variable already present in the environment always wins. Neither ever logs a value, only the
  names of the keys it set.
- `server/src/providers.ts` answers with names and `configured` booleans.
  `server/src/deploySecrets.ts` does the same for a deploy and owns the scrubber.
- MCP tokens are written under a derived name, `JAROKU_MCP_<SERVER>_TOKEN`, and read from the
  environment at the moment a request is made.
- `deployments.env_keys` is a JSON array of names. There is no column a value would fit in.
- The server logs `[providers] anthropic key set`. The value appears nowhere.
- The deployed agent's bearer check is constant time.
- `npm run test:env-writer` covers no clobbering, no injection and exact round trips.
  `npm run test:providers` covers names out, values never, and that a test writes nothing.
  `npm run test:deploy-secrets` covers the scrubber's hard cases.
- A URL carrying a username or password is refused before anything is sent when connecting an MCP
  server, and the error does not quote it back, because the refusal would otherwise put the
  password into an error column, into every client's registry snapshot and into the log.

## Security Considerations

- **Keys never leave the server process** except on the deployment path, where a value travels once
  in an HTTPS request body to the user's own hosting account.
- **Never in an argument.** A process table is world readable, and this single fact determines the
  deployment transport split.
- **Never in a log.** Both env loaders log names only, the HTTP request logger redacts `ticket`,
  `token`, `key`, `code` and `access_token` by name, and every build log line is scrubbed before
  it is broadcast or stored.
- **Never in the database.** MCP and deploy records store variable names. Tickets and invitations
  are stored as SHA-256 digests, so a copy of either table is not a set of usable credentials.
- **Never in a generated project or an image.** `.dockerignore` excludes `.env`, and host-owned
  files carry no values.
- **A deployed URL requires a bearer token**, because it runs on the user's provider key and an
  open one is an unmetered way for anyone who finds it to spend their money. `serve.py` refuses to
  start without one unless `JAROKU_SERVE_PUBLIC=1` says so explicitly.
- **A newline in a value is refused**, which closes an injection path into the credential file.
- **The scrubber ignores values under 8 characters** by design. A very short secret would survive
  in a build log, and the alternative is output so redacted it cannot be read.
- The security policy tells operators to rotate any key that appeared in a terminal, a screenshot
  or a bug report, including ones they believe were redacted.

## Performance Considerations

- Credential reads are `process.env` lookups, so they cost nothing.
- Writing `runtime/.env` reads and rewrites a small file, and happens only on an explicit save.
- The build log scrubber runs per line over the values held for that deploy, which is a small
  constant set.
- Testing a key is a models-list call, chosen because it is free.

## Operational Considerations

- Keep `runtime/.env` at `chmod 600` and out of version control. It is gitignored and
  `.dockerignore`d.
- A variable exported in the shell beats the file, so a key that appears not to update after a
  save is usually shadowed. The writer warns when it writes a shadowed variable.
- Scope every provider and connector key to the minimum it needs, and give agents the narrowest
  MCP grant that works. The manifest is the grant.
- Rotate a deployed agent's bearer token if it was shown on a shared screen. It is displayed once
  by design; rotating means setting `JAROKU_SERVE_TOKEN` in the hosting account or deploying
  again.
- A deployed agent returning 500 on every request is usually a credential the container does not
  have. Rule 7 makes an unconfigured connector template raise, so a missing key is a failed
  request rather than a degraded one.
- Never set `JAROKU_SERVE_PUBLIC=1` unless an unauthenticated agent endpoint running on your
  provider key is genuinely intended.

## Rejected Alternatives

**A secret manager or encrypted store** was rejected as premature rather than wrong. It is the
correct answer for a multi-tenant hosted product, and the current design is explicitly shaped so
that it can arrive: the `providers` channel is already scoped per workspace, and every interface
already deals in names. Adopting it now would cost the property that `npm run dev` needs nothing
installed, and would put a network dependency in the middle of a run for the Python runtime.

**Storing credentials in the application database** was rejected because a database dump would
become a credential dump. Dumps are copied, shared and restored into test environments far more
casually than key files are, and a row is reachable by any query bug whereas a file is reachable
only by the process that opens it. Encrypting the column relocates the problem to key management
without removing it.

## Related Decisions

- ADR-014: Reviewed connector templates copied byte for byte
- ADR-015: MCP servers treated as untrusted code
- ADR-018: The workspace as the tenancy unit, and why provider keys are still process wide
- ADR-021: Single use WebSocket tickets, which are hashed at rest for the same reason
- ADR-027: Deployment into the user's own hosting account

## References

- `server/src/envWriter.ts`, `server/src/env.ts`, `runtime/jaroku_interceptor/env.py`
- `server/src/providers.ts`, `server/src/deploySecrets.ts`
- `npm run test:env-writer`, `test:providers`, `test:deploy-secrets`
- README sections "Security notes", "Secrets handoff", "Configuration"
- `SECURITY.md`, "Hardening the deployment you run"
- CHANGELOG v0.2.0, v0.2.3 "Introducing Agent Deployments", v0.2.4
