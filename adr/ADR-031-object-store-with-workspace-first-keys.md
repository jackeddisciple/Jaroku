# ADR-031: Put an Object Store Behind an Interface, and the Workspace First in Every Key

## Status

Accepted. Introduced in Session 3, alongside `server/src/storage/`.

## Context

Three things in Jaroku were files: `runtime/agents/<id>/` (an agent's project), `.staging/`
(in-flight generations and edit proposals), and `.history/` (edit snapshots). All three assume the
server, the agent's code and the checkpoints share one disk.

Hosted, they do not. A generation lands on one replica, the edit that follows on another, and the
undo after that on a replica four minutes old. None of those three replicas has the others' disk,
and the failure is intermittent in proportion to how many are running — the least debuggable shape
a bug can have.

D5 answered R2: no egress fees, S3-compatible. But the same rule that governs the database driver
governs this — the local development path must keep working with nothing installed and nothing
running, because the fixtures, the mock MCP server and `npm run dev` depend on it and no hosted
feature is allowed to cost that.

There is also a hazard specific to object storage. An object store has no directories and no
notion of traversal: `..` in a key is two dots, stored without comment. The traversal happens
later, on whatever turns the key back into a path — which, in this codebase, is the local
development store, writing under `runtime/.objects/` on somebody's laptop. The hole is invisible
in production and lands squarely on a developer.

## Decision

**An `ObjectStore` interface with two implementations**, selected by `JAROKU_OBJECT_STORE` and
defaulting to `fs`. `FsObjectStore` roots under `runtime/.objects/`; `S3ObjectStore` speaks S3 and
therefore covers R2, S3 and MinIO with an endpoint, a region and a path-style flag as the only
differences. The local one refuses to run under `NODE_ENV=production`.

**The surface is small and implies no directories**: put, get, head, list, delete, deletePrefix,
copy, presignGet, presignPut. `list` takes a byte prefix, exactly as S3 does.

**Signing is `node:crypto`, not the AWS SDK.** SigV4 is four HMACs and a canonical string, and the
canonical string is what AWS publishes test vectors for.

**Every key starts with `ws/<workspace_id>/`**, before anything that reads more naturally, and the
components after it are uuids rather than slugs.

**A key is validated on the way in and the resolved path re-checked on the way out.** Both, in the
local store, even though the first already refused traversal.

## Alternatives considered

**`@aws-sdk/client-s3`.** Multipart, retries, presigning and pagination for free, all of it
battle-tested. Rejected: roughly fifteen megabytes and forty transitive packages to sign four
verbs against one bucket, in a repository whose test suites are plain scripts, whose migration
runner is a hundred lines, and whose event transport is delimiters rather than a parser library.
The consistent judgement here is that a script somebody can read beats a tool they have to trust.
The cost is real — the retry ladder, the multipart assembly and the pagination are hand-written
and hand-tested rather than inherited.

**Keep using the filesystem locally and only abstract in production.** Rejected outright: it makes
the code that matters in production the code nobody runs locally, so every bug in it is found by a
user. The same argument the local OIDC issuer rests on.

**A key layout with the agent first** — `agents/<agent_id>/ws/<workspace_id>/…`, which reads more
naturally. Rejected: a presigned URL is a bearer credential that outlives its request, and the
thing checking one has only the key. Workspace-first makes "whose object is this" answerable from
the key alone, with no database lookup on a path that is already leaking.

**Slugs in keys.** Rejected: slugs stopped being globally unique in Session 1, so two workspaces
may each have a `support_bot`. Threading the uuid is what §6.2 of the migration spec asks for, and
a key built from a display name is a key that changes when somebody renames something.

**Trusting the key builders and skipping validation in the store.** Rejected: a key also arrives
off a presigned URL, out of a stored manifest written by older code, and out of a `list()` result
on its way into `copy()`. A store that trusts its caller is a store whose safety depends on every
caller.

## Consequences

The application cannot tell which store it got, and the conformance suite is what keeps that true:
the same assertions run against both, including the ones about pagination and byte prefixes, which
are where a filesystem's instincts and S3's semantics genuinely differ.

The fixture S3 in `server/fixtures/s3/` verifies signatures rather than accepting anything, so the
hosted path is exercisable with no cloud account — but it is a fixture, and a real bucket can
still surprise it. `JAROKU_S3_ENDPOINT` points the same suite at one.

Presigned URLs need a route in local mode, because a directory has no endpoint of its own. That
route also enforces the workspace check that the key layout makes possible.

Hand-written SigV4 means an AWS change to the signing scheme is our problem. It has not changed
since 2012.
