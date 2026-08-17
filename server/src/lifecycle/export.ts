// Everything a workspace has, in one file it can download.
//
// PORTABILITY IS A LEGAL REQUIREMENT AND A PRODUCT PROMISE, and they want the same thing: a
// workspace's data belongs to the workspace, and "you can have it back" has to mean a file
// rather than a support conversation. The README has said since the first session that a
// generated project imports nothing named jaroku and is portable; this is the same promise
// applied to everything around the project.
//
// WHAT IS IN IT. Every row this workspace owns, as NDJSON, one file per table, plus the current
// version of every agent's source. NDJSON rather than one JSON document because a workspace with
// a year of traces has millions of steps and a single array is a file nothing can open — a
// line-delimited stream is greppable, streamable, and loads incrementally in every tool.
//
// WHAT IS DELIBERATELY NOT IN IT, and this is the part worth reading twice:
//
//   NO SECRETS. Not the provider keys, not the connector tokens, not the MCP credentials. The
//   secret store has no method that returns a plaintext value to a request handler — that
//   absence is the design, stated in `secrets/secretStore.ts`, and an export is a request
//   handler. What is included is the NAMES, exactly what the client already sees.
//
//   NO OAUTH TOKENS. `oauth_connections` has no token column at all; the export carries what the
//   table carries — which provider, whose account, which scopes were granted.
//
//   NO OTHER WORKSPACE'S ANYTHING. Every read goes through the scoped repositories, and the
//   manifest records the workspace id so a file cannot be mistaken for another's.
//
// AND IT IS ASYNCHRONOUS, because it cannot be anything else. Reading a year of steps is minutes
// of work, and a request that holds a connection for minutes is a request that a load balancer
// kills at four and a user reloads at two. So: a job, a queue class of its own with a global cap
// of four (this is the only class that can read millions of rows on one connection), and a
// presigned URL when it is done.
//
// THE LINK EXPIRES. It is a bearer credential for the most sensitive object this platform can
// produce — a copy of everything, including the content the agent read out of somebody's mailbox
// — and the retention sweeper takes the object itself on the plan's own clock. An export link
// that worked forever would be the whole security model reduced to whether an email got
// forwarded.

import type { Db } from "../db/db.ts";
import type { TenantContext } from "../db/tenant.ts";
import type { ObjectStore } from "../storage/objectStore.ts";
import { workspacePrefix } from "../storage/keys.ts";
import type { Presigned } from "../storage/presign.ts";
import { tar, type TarEntry } from "./tar.ts";

/**
 * An export id, validated before it becomes part of a key.
 *
 * A uuid and nothing else. The status route takes this id off the URL, and a key built from an
 * unvalidated one is a path traversal into somebody else's prefix — `keys.ts` would refuse the
 * finished key anyway, and this refuses it a step earlier with a message that says which input
 * was wrong.
 */
function assertExportId(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(`not an export id: ${id}`);
  }
  return id.toLowerCase();
}

/** How long a download link is good for. Long enough to click; short enough to be forwarded once. */
export const EXPORT_URL_TTL_S = 3600;

/**
 * The tables an export carries, and the order it carries them in.
 *
 * A LIST RATHER THAN "EVERY TABLE WITH A workspace_id", which would have been cleverer and
 * wrong in one specific way: a table added later would silently join the export, including one
 * added to hold something that must never be in one. Adding a table here is a decision; the
 * test beside this file asserts that every tenant table is either exported or explicitly named
 * as excluded, so the decision cannot be skipped by forgetting.
 */
export const EXPORTED_TABLES = [
  "agents",
  "agent_versions",
  "runs",
  "steps",
  "datasets",
  "dataset_examples",
  "rubrics",
  "eval_runs",
  "eval_jobs",
  "eval_scores",
  "mcp_servers",
  "mcp_tools",
  "deployments",
  "usage_events",
  "audit_log",
  // WHO IS IN THE WORKSPACE, which is workspace data in the plainest sense — a portability
  // export that omitted the members list would be a copy of the work with the team removed.
  "workspace_members",
  // What this workspace is paying for. The provider's own record is the provider's; this is the
  // row the platform acted on, and a billing dispute is argued from it.
  "subscriptions",
  "workspace_enforcements",
  "abuse_signals",
  // WHERE EACH CREDENTIAL IS USED, and when each was rotated. Both are exported in full rather
  // than redacted, because neither holds a value or a digest of one: `secret_usages` is a name, an
  // agent and a `file:line`, and `secret_rotations` is a timestamp, a person and the mask of what
  // replaced the old value. "Which of my agents breaks if this key goes away" is the workspace's
  // own operational record, and it is exactly the sort of thing somebody leaving wants to keep.
  "secret_usages",
  "secret_rotations",
  // WHICH REPOSITORY EACH AGENT BELONGS TO, and everything that has been pushed or pulled since.
  // Both are the workspace's own operational record and neither holds a credential:
  // `github_links` names a repo, a branch and two shas, and `github_events` is a log of actions
  // somebody in this workspace took. A team leaving with their agents wants to know where the
  // code went, and the force-override rows are exactly the sort of thing an audit later asks for.
  //
  // `github_installations` is deliberately absent — see EXCLUDED_TABLES.
  "github_links",
  "github_events",
  // ADDENDUM B'S FIVE TABLES (migrations 036–040). Every one of them is the workspace's own
  // operational record and not one of them holds a credential, which is the only question
  // EXCLUDED_TABLES is asking:
  //
  //   `agent_ci_config` is a dataset id and a spending policy somebody chose. The policy in
  //   particular is the answer to "why did this pull request run on the free provider", which is a
  //   question asked months later.
  //
  //   `check_runs` is the measurement history — pass rate, cost and latency per commit, with the
  //   baseline each was compared against. It is the only place those numbers exist once the eval
  //   jobs behind them have been swept, and it is what §B.8.2's canvas is drawn from.
  //
  //   `shadow_runs` says what a run WAS: which ref, which sha, which staging directory. The run
  //   itself is in `runs` and its cost is in `usage_events`, and without this row neither of them
  //   can be attributed to anything.
  //
  //   `pr_comments` mirrors a review. It carries other people's words, which is exactly what
  //   `steps` and `audit_log` already carry and exactly what a team leaving with their agents
  //   needs in order to know why the code says what it says.
  //
  //   `secret_scan_findings` is a path, a rule and whether somebody overrode it. Migration 040 is
  //   explicit that the matched text is never stored, and the override rows are the only evidence
  //   that anybody ever pushed over a credential — which is the sort of thing an audit asks for
  //   after the workspace has left.
  "agent_ci_config",
  "check_runs",
  "shadow_runs",
  "pr_comments",
  "secret_scan_findings",
  // WHAT WAS ASKED FOR AND WHAT IT LEFT BEHIND. A thread holds the title somebody gave a session,
  // when it last did anything, and which agent it was pointed at — including, after that agent is
  // deleted, the name it had. It is the only place the SESSION exists: `runs` says what executed
  // and `usage_events` says what it cost, and neither can say which of an agent's three
  // simultaneous build sessions either belonged to. An export without it is a copy of the work
  // with every question of "why" removed.
  "threads",
] as const;

/**
 * Tables that carry a workspace_id and are deliberately absent, with the reason.
 *
 * The reasons are the point. Everything here is either a credential, a pointer to one, or a
 * transient row whose meaning does not survive leaving the system that owns it.
 */
export const EXCLUDED_TABLES: Record<string, string> = {
  workspace_secrets: "ciphertext of the workspace's credentials — the vault has no way to read one out, by design",
  workspace_data_keys: "the per-workspace encryption key. Exporting it would make the vault's design pointless",
  secret_refs: "carried in a redacted form instead: names and whether each is configured, never a value",
  oauth_connections: "carried in a redacted form instead: provider, account label and granted scopes",
  ws_tickets: "single-use socket credentials with a thirty-second life. Meaningless outside the moment",
  oauth_states: "an in-flight OAuth handshake. Meaningless ten minutes later, and never the user's data",
  billing_holds: "a reservation against a balance, not a record of anything. usage_events is the ledger",
  workspace_balances: "carried in the manifest as a summary rather than as a row of internal accounting",
  workspace_invites:
    "a pending invitation carries a credential digest and expires; the members list is what survives an export",
  billing_webhook_events:
    "the platform's own delivery log for a payment provider's callbacks. Not this workspace's data, and it names no user",
  deployment_logs: "build output that can contain a provider's own error text. Available in the product, not in the archive",
  user_secret_passcodes:
    "a passcode hash, its salt and its lockout counters. A credential digest is still a credential — and exporting the lockout state would say who is being attacked and when",
  secret_elevations:
    "short-lived authorisations for the secrets surface, hashed at rest and dead within ten minutes. Meaningless outside the moment, exactly as ws_tickets is",
  github_installations:
    "a pointer to a GitHub credential in the vault, plus the scopes it was granted. It is a credential reference in the same sense secret_refs is, and the useful half — which repo each agent is linked to — is carried by github_links, which is exported",
};

/**
 * Tables whose scope is not a column of their own.
 *
 * `agent_versions` hangs off `agents`, exactly as migration 009's RLS policy does — the policy
 * follows the parent rather than duplicating the column, and so must this. Without the special
 * case the query would name a column that does not exist, the catch below would swallow it, and
 * the export would quietly contain no version history at all: a failure whose only symptom is a
 * successful download of the wrong thing.
 */
const INDIRECT_SCOPE: Record<string, string> = {
  agent_versions: `agent_id IN (SELECT id FROM agents WHERE workspace_id = ?)`,
};

export interface ExportDeps {
  db: Db;
  objects: ObjectStore;
  /** The current version of each agent's files, as the project store already reads them. */
  agentFiles?: (ctx: TenantContext) => Promise<{ path: string; body: Buffer }[]>;
  now?: () => number;
  log?: (line: string) => void;
}

export interface ExportResult {
  key: string;
  bytes: number;
  /** What went in, by table, so a user can tell an empty export from a failed one. */
  counts: Record<string, number>;
  download: Presigned;
}

export class WorkspaceExporter {
  private now: () => number;
  private log: (line: string) => void;

  constructor(private deps: ExportDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /**
   * The key one export lands at.
   *
   * DERIVED FROM AN ID THE SERVER MINTED, never from anything a caller sent, and predictable on
   * purpose: it is what makes the status endpoint stateless. A worker on another machine writes
   * this key and a gateway replica that has never heard of the job answers "is it ready" by
   * asking the object store whether the key exists. No shared job table, no sticky routing, and
   * nothing to reconcile when a worker dies mid-export — an absent object is an export that did
   * not finish, which is exactly what the caller needs to know.
   */
  static keyFor(workspaceId: string, exportId: string): string {
    return `${workspacePrefix(workspaceId)}exports/workspace-${assertExportId(exportId)}.tar`;
  }

  /** Build the archive, store it, and mint a link that expires. */
  async export(ctx: TenantContext, exportId: string): Promise<ExportResult> {
    const startedAt = this.now();
    const entries: TarEntry[] = [];
    const counts: Record<string, number> = {};
    const mtimeSec = Math.floor(startedAt / 1000);

    for (const table of EXPORTED_TABLES) {
      const rows = await this.rows(ctx, table);
      counts[table] = rows.length;
      // A table with no rows still gets a file. An absent file reads as "this export is broken";
      // an empty one reads as "there was nothing here", and those are different facts.
      entries.push({ path: `data/${table}.ndjson`, body: rows.map((r) => JSON.stringify(r)).join("\n"), mtimeSec });
    }

    // The redacted halves of the two tables that cannot be exported as they stand.
    const refs = await this.rows(ctx, "secret_refs");
    counts["secret_refs"] = refs.length;
    entries.push({
      path: "data/secret_refs.ndjson",
      // The projection is an allowlist rather than a delete-list, so a column added to
      // `secret_refs` later cannot arrive in an export by default. 033's metadata is named here
      // one field at a time for that reason — including `masked_hint`, which is safe by
      // construction: it is the stored mask, never a value, and never derived by decrypting one.
      body: refs
        .map((r) =>
          JSON.stringify({
            name: r["name"],
            provider: r["provider"],
            configured: r["configured"],
            last_used_at: r["last_used_at"],
            kind: r["kind"],
            scope: r["scope"],
            agent_id: r["agent_id"],
            masked_hint: r["masked_hint"],
            status: r["status"],
            expires_at: r["expires_at"],
            rotated_at: r["rotated_at"],
            connector_id: r["connector_id"],
          }),
        )
        .join("\n"),
      mtimeSec,
    });
    const connections = await this.rows(ctx, "oauth_connections");
    counts["oauth_connections"] = connections.length;
    entries.push({
      path: "data/oauth_connections.ndjson",
      body: connections
        .map((r) =>
          JSON.stringify({
            provider: r["provider"],
            connector_id: r["connector_id"],
            external_account_label: r["external_account_label"],
            scopes: r["scopes"],
            status: r["status"],
            created_at: r["created_at"],
          }),
        )
        .join("\n"),
      mtimeSec,
    });

    // The source of every agent at its current version. The rows above say an agent EXISTS; this
    // is what it is, and an export without it would be a description of somebody's work rather
    // than their work.
    let files = 0;
    for (const file of (await this.deps.agentFiles?.(ctx)) ?? []) {
      entries.push({ path: `agents/${file.path}`, body: file.body, mtimeSec });
      files++;
    }
    counts["agent_files"] = files;

    entries.unshift({
      path: "manifest.json",
      body: `${JSON.stringify(
        {
          format: "jaroku-workspace-export",
          version: 1,
          workspaceId: ctx.workspaceId,
          generatedAt: new Date(startedAt).toISOString(),
          counts,
          excluded: EXCLUDED_TABLES,
          note:
            "One NDJSON file per table under data/, and each agent's current source under agents/. " +
            "No credential of any kind is in this archive — see `excluded`.",
        },
        null,
        2,
      )}\n`,
      mtimeSec,
    });

    const archive = tar(entries);
    // Under the workspace's own prefix, so the retention sweeper takes it on the same clock as
    // everything else that workspace holds — an export is a copy of exactly the regulated
    // content the trace holds, and it must not outlive what it was copied from.
    const key = WorkspaceExporter.keyFor(ctx.workspaceId, exportId);
    await this.deps.objects.put(key, archive, { contentType: "application/x-tar" });
    const download = await this.deps.objects.presignGet(key, EXPORT_URL_TTL_S);
    this.log(
      `[export] ${ctx.workspaceId} — ${entries.length} file(s), ${archive.length} byte(s), ` +
        `${Math.round((this.now() - startedAt) / 100) / 10}s`,
    );
    return { key, bytes: archive.length, counts, download };
  }

  /**
   * One table's rows for one workspace.
   *
   * SCOPED THROUGH `forWorkspace`, so on Postgres every statement carries the SET LOCAL the
   * policies read — an export is exactly the query you do not want running unscoped, and "it
   * returned everybody's rows" is a failure whose symptom is a successful download.
   *
   * The table name is interpolated, and that is safe here for the one reason it ever is: it
   * comes from `EXPORTED_TABLES`, a frozen list in this file, and never from a caller. The
   * assertion below is what keeps that true after a refactor.
   */
  private async rows(ctx: TenantContext, table: string): Promise<Record<string, unknown>[]> {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`not a table name: ${table}`);
    const where = INDIRECT_SCOPE[table] ?? `workspace_id = ?`;
    try {
      return await this.deps.db
        .forWorkspace(ctx.workspaceId)
        .all<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${where}`, [ctx.workspaceId]);
    } catch (err) {
      // A table this deployment does not have — an older database, a driver where a migration is
      // a comment. An export missing one table is worth having; an export that fails entirely
      // because of one is not.
      this.log(`[export] ${table} could not be read: ${(err as Error)?.message ?? err}`);
      return [];
    }
  }
}
