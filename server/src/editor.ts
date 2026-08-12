// The fix loop (doc §8 Week 4): instruction + current project -> Claude -> a reviewable
// proposal -> Apply / Undo. The AI never silently edits files.
//
// Safety properties this module is responsible for (🟡 read-every-line):
//   * A proposal lives in the object store under a STAGING ID — the current version's files
//     with the model's applied on top — and the live version is untouched until an explicit
//     Apply. Nothing about a pending proposal is on any machine's disk.
//   * The same validation contract as generation runs on the merged project. A proposal that
//     fails validation is discarded, never applyable.
//   * Reviewed connector templates, jaroku.json, and the top-level __init__.py are hard
//     read-only: the stream is rejected the moment the model opens one.
//   * Apply publishes a new VERSION and moves the pointer. Undo moves the pointer back and
//     marks the version it left behind. Linear history, and neither one copies a project.
//   * Path confinement (safeObjectPath) applies to every emitted path, and agentId is
//     validated so a client-supplied id cannot name anything but an agent.
//
// WHAT CHANGED IN SESSION 3, AND WHAT IT COSTS. Apply used to snapshot the project into
// `.history/<id>/v<n>/` and rename a staging directory over the live one; Undo restored the
// snapshot and popped an entry out of `history.json`. Every part of that lived on the machine
// that ran it, so an edit applied by one replica could not be undone by another, and a
// container restart lost the history.
//
// The honest cost of the move: history begins at the import. An installation that already had
// applied edits keeps its `.history/` directory on disk, and it is no longer what Undo reads —
// the first version is the project as it stood when it was imported, and Undo is offered for
// edits applied after that. Nothing is lost from the project itself; what is lost is the
// ability to step back through edits made before the migration, which is not a thing a hosted
// replica could ever have done.

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { structuredPatch } from "diff";
import { anthropicClient, emptyUsage, summarizeUsage, type UsageSummary } from "./claude.ts";
import { loadConnectors, type Connector } from "./connectors.ts";
import { FileProtocolParser, type ProtocolEvent } from "./fileProtocol.ts";
import { agentsDir, replayFixture } from "./generator.ts";
import { DEPLOY_ARTIFACTS, isSafeAgentId, readOnlyPaths } from "./projectFs.ts";
import { buildEditSystemPrompt, buildEditUserPrompt } from "./prompt.ts";
import type { McpToolView } from "./mcpRegistry.ts";
import { validateProject } from "./validator.ts";
import { BRIDGE_FILE, MANIFEST_FILE, type Manifest } from "./mcpManifest.ts";
import type { AgentRepository, VersionFileStat } from "./db/repositories/agents.ts";
import type { TenantContext } from "./db/tenant.ts";
import { newStagingId, safeObjectPath } from "./storage/keys.ts";
import type { ProjectStore, StoredFile } from "./storage/projectStore.ts";

export const EDIT_MODEL = process.env.JAROKU_EDIT_MODEL ?? "claude-haiku-4-5";
const MAX_TOKENS = 16000;

export interface FileDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[]; // " ctx" | "+add" | "-del", jsdiff structuredPatch format
}

export interface FileDiff {
  path: string;
  status: "added" | "modified";
  additions: number;
  deletions: number;
  hunks: FileDiffHunk[];
}

export interface EditorEvents {
  file_start: [{ path: string }];
  file_delta: [{ path: string; text: string }];
  file_end: [{ path: string }];
  proposal: [{
    proposalId: string; agentId: string; instruction: string; summary: string;
    files: FileDiff[]; usage: UsageSummary;
  }];
  applied: [{ proposalId: string; agentId: string; version: number; summary: string }];
  undone: [{ agentId: string; version: number; summary: string }];
  discarded: [{ proposalId: string; agentId: string }];
  error: [{ message: string; problems?: string[]; agentId?: string; proposalId?: string }];
}

interface PendingProposal {
  proposalId: string;
  /**
   * The context the proposal was made in, carried rather than re-derived.
   *
   * Apply arrives as its own command and could in principle come from a different socket. The
   * version it publishes must land in the workspace whose files were diffed, not in whatever
   * scope happens to be asking — which is the same reason a run carries its workspace from
   * dispatch to ingestion.
   */
  ctx: TenantContext;
  /** The uuid. Object keys are built from it, and it is what a version hangs off. */
  agentUuid: string;
  /** The slug, for the events and for the local materialisation. A display concern. */
  agentId: string;
  stagingId: string;
  /**
   * The version the staged copy was built from.
   *
   * A proposal is the current version's files with the model's applied on top, and it is staged
   * once and applied later — an unbounded window in which anything else may publish. A deploy
   * does exactly that: it adds four artifacts and moves the pointer. Applying afterwards would
   * publish a copy assembled from the older version and silently drop them.
   *
   * So the base is recorded and checked at apply time. Refusing is the only honest answer: the
   * diff the user approved was against files that are no longer current, and rebasing it
   * silently would be applying an edit nobody reviewed.
   */
  baseVersion: number;
  instruction: string;
  summary: string;
  files: FileDiff[];
}

export interface EditorDeps {
  runtimeDir: string;
  agents: AgentRepository;
  projects: ProjectStore;
  /** Returns a refusal message when the project must not be mutated right now (e.g. a run
   *  of it is in flight), or null when mutation is fine. */
  canMutate?: () => string | null;
  /**
   * The MCP tools an agent is scoped to, for the edit prompt.
   *
   * Injected rather than read here, so this module keeps its single dependency on the
   * connector catalogue and does not grow one on the MCP registry.
   */
  mcpTools?: (agentId: string) => McpToolView[];
}

/** An agent's own manifest, or undefined when it was granted no MCP tools. */
function readManifest(files: Map<string, string>): Manifest | undefined {
  const raw = files.get(MANIFEST_FILE);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Manifest;
  } catch {
    return undefined;
  }
}

export class Editor extends EventEmitter<EditorEvents> {
  private pending = new Map<string, PendingProposal>();
  private busy = false;

  constructor(private readonly opts: EditorDeps) {
    super();
  }

  /**
   * Whether an edit is in flight, readable from outside.
   *
   * `propose` refuses a second one anyway, so this is not the guard — it is what lets the
   * CALLER refuse first. The editor's events go out on a channel scoped to one workspace, and
   * the caller is what remembers which; a refused edit that has already repointed that memory
   * has handed the in-flight edit's diff to whoever asked second. See `editContext` in
   * index.ts.
   */
  get inFlight(): boolean {
    return this.busy;
  }

  private fail(e: EditorEvents["error"][0]): void {
    this.emit("error", e);
  }

  async propose(
    ctx: TenantContext,
    agentId: string,
    instruction: string,
    /** The workspace's own Anthropic key, when it has opted its key in for platform calls.
     *  Absent — the default, and the local path — means the platform's own. */
    apiKey?: string,
  ): Promise<void> {
    if (this.busy) {
      this.fail({ message: "an edit is already in progress", agentId });
      return;
    }
    this.busy = true;
    const { runtimeDir, agents, projects } = this.opts;
    const stagingId = newStagingId();
    let agentUuid = "";
    const scratch = join(tmpdir(), `jaroku-edit-${stagingId}`);

    try {
      if (!isSafeAgentId(agentId)) throw new Error(`invalid agent id: ${agentId}`);
      // The membership check AND the uuid lookup, in one. An agent another workspace owns is
      // simply not found here, which is the answer a caller asking for one should get.
      const agent = await agents.bySlug(ctx, agentId);
      if (!agent) throw new Error(`agent "${agentId}" was not found`);
      agentUuid = agent.id;

      const current = await projects.readCurrent(ctx, agent.id, agent.current_version);
      const currentFiles = new Map(current.map((f) => [f.path, f.content]));
      if (!currentFiles.has("agent.py")) {
        throw new Error(`agent "${agentId}" has no published agent.py to edit`);
      }

      // A new request supersedes any pending proposal for this agent — its staged copy was
      // diffed against files that may be about to change meaning.
      await this.discardForAgent(agentId);

      const all = loadConnectors(runtimeDir);
      const installed = all.filter((c) => agent.connectors.includes(c.id));
      const installedFiles = installed.map((c) => `tools/${c.file}`);
      // The emit-block covers every catalog connector filename, installed or not, so the
      // model can never introduce a file masquerading as a reviewed template.
      // readOnlyPaths also covers mcp_tools.json, tools/mcp_bridge.py and the four deploy
      // artifacts unconditionally (projectFs.ts) — the manifest is this agent's entire MCP
      // grant, and serve.py plus the Dockerfile are what a publicly reachable container runs.
      // An edit able to rewrite any of them could widen the agent's reach, or change what
      // answers on the open internet, with nobody approving it.
      const blocked = readOnlyPaths(all.map((c) => `tools/${c.file}`));

      // Read before the model touches anything: whether THIS agent already survives a raising tool.
      const hadToolErrorHandling = /handle_tool_errors\s*=\s*True/.test(currentFiles.get("agent.py") ?? "");

      // The staged project starts as a copy of the current VERSION — the same starting point
      // `copyProject` produced, assembled from the store instead of from a directory.
      const staged = new Map(currentFiles);

      const buffers = new Map<string, string>();
      const onEvent = (event: ProtocolEvent) => {
        if (event.type === "file_start") {
          const safe = safeObjectPath(event.path);
          if (!safe) throw new Error(`refusing unsafe path: ${event.path}`);
          if (blocked.has(safe)) {
            // Each message names the right next move rather than just refusing. The MCP
            // pair gets its own, because "ask for a wrapper" is the wrong advice for a
            // manifest — the fix there is to change the agent's scope, which is a decision
            // the user makes in the MCP panel, not one an edit should be able to make.
            // The deploy artifacts get theirs for the same shape of reason: they are
            // regenerated from jaroku.json on every deploy, so an edit to them would be
            // silently discarded even if it were allowed.
            const isMcp = safe === MANIFEST_FILE || safe === BRIDGE_FILE;
            const isDeploy = DEPLOY_ARTIFACTS.has(safe);
            throw new Error(
              isMcp
                ? `${safe} is host-owned and read-only — it is what scopes this agent's ` +
                  `access to third-party MCP servers. Change the selection in the MCP panel ` +
                  `and re-generate to give it different tools.`
                : isDeploy
                  ? `${safe} is host-owned and read-only — it is deploy tooling Jaroku ` +
                    `regenerates from jaroku.json every time you deploy, so an edit here ` +
                    `would not survive. Change the agent instead, then deploy again.`
                  : safe.startsWith("tools/")
                    ? `${safe} is a reviewed connector template and cannot be edited — ` +
                      `ask for a wrapper tool that adapts its results instead`
                    : `${safe} is host-owned and read-only`,
            );
          }
          buffers.set(event.path, "");
          this.emit("file_start", { path: safe });
        } else if (event.type === "file_delta") {
          buffers.set(event.path, (buffers.get(event.path) ?? "") + event.text);
          this.emit("file_delta", { path: event.path, text: event.text });
        } else {
          // Recorded on close, into the staged copy — the live version is never touched here.
          const safe = safeObjectPath(event.path)!;
          staged.set(safe, buffers.get(event.path) ?? "");
          this.emit("file_end", { path: safe });
        }
      };
      const parser = new FileProtocolParser(onEvent);

      const editable = [...currentFiles.entries()]
        .filter(([path]) => !blocked.has(path))
        .map(([path, content]) => ({ path, content }))
        .sort((a, b) => a.path.localeCompare(b.path));
      const recent = (await agents.versions(ctx, agent.id))
        .filter((v) => v.source === "edit")
        .slice(0, 3)
        .reverse()
        .map((v) => ({ instruction: v.instruction ?? "", summary: v.summary ?? "" }));

      let usage = emptyUsage();
      const fixture = process.env.JAROKU_EDIT_FIXTURE;
      if (fixture && (await import("node:fs")).existsSync(fixture)) {
        // Replay is global and agent-agnostic — an edit fixture recorded against one
        // agent will be replayed verbatim against ANY agent, which looks exactly like
        // a bizarre model hallucination if you've forgotten the env var is set. Say so.
        console.warn(
          `[edit] JAROKU_EDIT_FIXTURE is set — replaying ${fixture} for "${agentId}"; ` +
            `the model is NOT being called. Unset it for real edits.`,
        );
        await replayFixture(fixture, (chunk) => parser.push(chunk));
      } else {
        const raw = await this.streamEdit(
          all,
          {
            agentId, instruction, files: editable, connectors: installed,
            // The scoped set, so an edit can wire an existing MCP tool into a new wrapper
            // without being able to reach for one this agent was never granted.
            mcpTools: this.opts.mcpTools?.(agentId) ?? [],
            history: recent,
          },
          (chunk) => parser.push(chunk),
          (u) => (usage = u),
          apiKey,
        );
        if (fixture) (await import("node:fs")).writeFileSync(fixture, raw, "utf8");
      }

      const protocolError = parser.finish({ allowEmpty: true });
      if (protocolError) throw new Error(protocolError);

      const summary =
        parser.prose.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ??
        "Edit proposal";

      const emitted = [...new Set(parser.files)];
      if (emitted.length === 0) {
        // A valid no-op: the model declined (rule E5) and said why in the summary.
        this.emit("proposal", {
          proposalId: randomUUID(), agentId, instruction, summary, files: [], usage,
        });
        return;
      }

      const files = this.diffEmitted(currentFiles, staged, emitted);
      if (files.length === 0) {
        // Everything the model re-emitted was byte-identical — nothing to apply.
        this.emit("proposal", {
          proposalId: randomUUID(), agentId, instruction, summary, files: [], usage,
        });
        return;
      }

      // The staged copy is now current-version + model files. Into the store under a staging
      // id, then validated exactly as a fresh generation would be — from the store, so what is
      // checked is what would be published.
      for (const path of [...staged.keys()].sort()) {
        await projects.putStaging(ctx, agent.id, stagingId, { path, content: staged.get(path)! });
      }
      await projects.materialiseStaging(ctx, agent.id, stagingId, scratch);

      const result = await validateProject(scratch, {
        runtimeDir,
        // The bridge is reviewed code copied in verbatim, so it is excluded from the
        // model-output lints for the same reason a connector template is.
        connectorFiles: [...installedFiles, ...(currentFiles.has(BRIDGE_FILE) ? [BRIDGE_FILE] : [])],
        connectorToolNames: installed.flatMap((c) => c.tools.map((t) => t.name)),
        // The agent's existing grant, read from its own manifest rather than from the
        // registry: an edit is validated against what this project actually has.
        mcpTools: readManifest(currentFiles),
        // Don't-regress, not a new requirement: only demanded of an agent that already had it.
        // Agents generated before the connector templates started raising carry swallowing copies
        // of those templates, are internally consistent, and must stay editable.
        requireToolErrorHandling: hadToolErrorHandling,
      });
      if (!result.ok) {
        await projects.discardStaging(ctx, agent.id, stagingId);
        this.fail({
          message: "the proposed edit failed validation and was discarded",
          problems: result.problems,
          agentId,
        });
        return;
      }

      const proposalId = randomUUID();
      this.pending.set(proposalId, {
        proposalId, ctx, agentUuid: agent.id, agentId, stagingId,
        baseVersion: agent.current_version, instruction, summary, files,
      });
      this.emit("proposal", { proposalId, agentId, instruction, summary, files, usage });
    } catch (err) {
      if (agentUuid) await this.opts.projects.discardStaging(ctx, agentUuid, stagingId).catch(() => {});
      this.fail({ message: (err as Error).message, agentId });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      this.busy = false;
    }
  }

  /**
   * Apply a pending proposal: publish its staging copy as the next version.
   *
   * No snapshot, because there is nothing to snapshot — the version this replaces was written
   * once and is never rewritten, so it is still exactly where Undo will point.
   *
   * TAKES THE ASKING WORKSPACE, and it is not decoration. A proposal id is the whole argument
   * this command has, and the record it names carries a context of its own — so without this
   * check the handler applied a proposal in ITS workspace rather than in the caller's: one
   * workspace sending another's proposal id published a new version of an agent it has no row
   * for. Every other command on this socket is answered in the caller's scope; this one now is
   * too, and a proposal belonging to somebody else is reported as absent rather than as
   * forbidden, which is what `bySlug` does with an agent for the same reason.
   */
  async apply(ctx: TenantContext, proposalId: string): Promise<void> {
    const rec = this.pending.get(proposalId);
    if (!rec || rec.ctx.workspaceId !== ctx.workspaceId) {
      this.fail({ message: "that proposal is no longer available", proposalId });
      return;
    }
    const refusal = this.opts.canMutate?.();
    if (refusal) {
      this.fail({ message: refusal, proposalId, agentId: rec.agentId });
      return;
    }

    // THE VERSION THIS WAS DIFFED AGAINST MUST STILL BE THE LIVE ONE. `canMutate` covers a run
    // reading the files; it does not cover something else PUBLISHING, and a deploy does exactly
    // that. Applying a copy assembled from an older version would drop whatever landed in
    // between — silently, because the staged copy is complete and looks perfectly valid.
    const agent = await this.opts.agents.bySlug(rec.ctx, rec.agentId);
    if (!agent) {
      this.fail({ message: `agent "${rec.agentId}" was not found`, proposalId, agentId: rec.agentId });
      return;
    }
    if (agent.current_version !== rec.baseVersion) {
      await this.discard(rec.ctx, proposalId);
      this.fail({
        message:
          `this agent changed while the proposal was open (it was v${rec.baseVersion}, it is now ` +
          `v${agent.current_version}), so the diff you reviewed is no longer against what is live. ` +
          `Ask for the edit again.`,
        proposalId,
        agentId: rec.agentId,
      });
      return;
    }

    try {
      const { version } = await this.opts.projects.publishStaging(rec.ctx, rec.agentUuid, rec.stagingId, {
        source: "edit",
        instruction: rec.instruction,
        summary: rec.summary,
        fileStats: rec.files.map(
          (f): VersionFileStat => ({
            path: f.path, status: f.status, additions: f.additions, deletions: f.deletions,
          }),
        ),
      });
      await this.materialise(rec.ctx, rec.agentUuid, version, rec.agentId);
      this.pending.delete(proposalId);
      this.emit("applied", { proposalId, agentId: rec.agentId, version, summary: rec.summary });
    } catch (err) {
      this.fail({ message: `apply failed: ${(err as Error).message}`, proposalId, agentId: rec.agentId });
    }
  }

  /** Revert the last applied edit: move the pointer back, and mark what it left behind. */
  async undo(ctx: TenantContext, agentId: string): Promise<void> {
    if (!isSafeAgentId(agentId)) {
      this.fail({ message: `invalid agent id: ${agentId}`, agentId });
      return;
    }
    const refusal = this.opts.canMutate?.();
    if (refusal) {
      this.fail({ message: refusal, agentId });
      return;
    }

    const agent = await this.opts.agents.bySlug(ctx, agentId);
    if (!agent) {
      this.fail({ message: `agent "${agentId}" was not found`, agentId });
      return;
    }
    // Read BEFORE the undo: afterwards this version is marked and no longer on the line, and
    // the event has to name what was reverted rather than what is now current.
    const reverting = await this.opts.agents.version(ctx, agent.id, agent.current_version);

    // Any pending proposal was diffed against the files being reverted — drop it.
    await this.discardForAgent(agentId);

    const moved = await this.opts.agents.undoVersion(ctx, agent.id);
    if (!moved) {
      this.fail({ message: "nothing to undo — no applied edits", agentId });
      return;
    }
    try {
      await this.materialise(ctx, agent.id, moved.to, agentId);
    } catch (err) {
      this.fail({ message: `undo failed: ${(err as Error).message}`, agentId });
      return;
    }
    this.emit("undone", {
      agentId,
      version: moved.from,
      summary: reverting?.summary ?? "the last applied edit",
    });
  }

  /** Drop a pending proposal without applying it. Only the workspace that made it may. */
  async discard(ctx: TenantContext, proposalId: string): Promise<void> {
    const rec = this.pending.get(proposalId);
    // Already gone, or never theirs. Both are silent: discarding twice is not an error, and
    // answering differently for somebody else's id would confirm that the id exists.
    if (!rec || rec.ctx.workspaceId !== ctx.workspaceId) return;
    this.pending.delete(proposalId);
    await this.opts.projects.discardStaging(rec.ctx, rec.agentUuid, rec.stagingId).catch(() => {});
    this.emit("discarded", { proposalId, agentId: rec.agentId });
  }

  private async discardForAgent(agentId: string): Promise<void> {
    for (const rec of [...this.pending.values()]) {
      if (rec.agentId === agentId) await this.discard(rec.ctx, rec.proposalId);
    }
  }

  /**
   * Write a version into `runtime/agents/<slug>/`.
   *
   * The local run path still imports `agents.<slug>.agent` from a real directory, so a version
   * that becomes current has to appear there. This is a CACHE of the version, not the version:
   * Session 4 replaces it with a sandbox fetching the objects, and this call goes away with it.
   */
  private async materialise(ctx: TenantContext, agentUuid: string, version: number, slug: string): Promise<void> {
    await this.opts.projects.materialise(ctx, agentUuid, version, join(agentsDir(this.opts.runtimeDir), slug));
  }

  private diffEmitted(
    current: Map<string, string>,
    staged: Map<string, string>,
    emitted: string[],
  ): FileDiff[] {
    const out: FileDiff[] = [];
    for (const path of emitted) {
      const safe = safeObjectPath(path);
      if (!safe) continue; // already rejected during streaming
      const oldContent = current.get(safe) ?? null;
      const newContent = staged.get(safe);
      if (newContent === undefined) continue;
      if (oldContent === newContent) continue; // re-emitted unchanged: not part of the diff

      const patch = structuredPatch(safe, safe, oldContent ?? "", newContent, "", "", { context: 3 });
      let additions = 0;
      let deletions = 0;
      for (const hunk of patch.hunks) {
        for (const line of hunk.lines) {
          if (line.startsWith("+")) additions++;
          else if (line.startsWith("-")) deletions++;
        }
      }
      out.push({
        path: safe,
        status: oldContent === null ? "added" : "modified",
        additions,
        deletions,
        hunks: patch.hunks,
      });
    }
    return out;
  }

  private async streamEdit(
    allConnectors: Connector[],
    req: {
      agentId: string;
      instruction: string;
      files: StoredFile[];
      connectors: Connector[];
      mcpTools: McpToolView[];
      history: { instruction: string; summary: string }[];
    },
    onChunk: (text: string) => void,
    onUsage: (u: UsageSummary) => void,
    apiKey?: string,
  ): Promise<string> {
    let raw = "";
    const stream = anthropicClient(apiKey).messages.stream({
      model: EDIT_MODEL,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: "text",
          text: buildEditSystemPrompt(allConnectors),
          // Byte-stable across every edit. NOTE: haiku-4-5's minimum cacheable prefix is
          // 4096 tokens and this prompt is ~2.3k, so the marker is currently inert
          // (cache_creation stays 0). Kept because it costs nothing and takes effect the
          // moment the prompt grows or the model changes. Verified 2026-07-23.
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: buildEditUserPrompt(req) }],
    });

    stream.on("text", (delta) => {
      raw += delta;
      onChunk(delta);
    });

    const final = await stream.finalMessage();
    onUsage(summarizeUsage(final.usage));
    return raw;
  }
}
