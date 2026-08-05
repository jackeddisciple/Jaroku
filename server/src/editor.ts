// The fix loop (doc §8 Week 4): instruction + current project -> Claude -> a reviewable
// proposal -> Apply / Undo. The AI never silently edits files.
//
// Safety properties this module is responsible for (🟡 read-every-line):
//   * A proposal lives in agents/.staging/<id>__edit/ — a full copy of the project with the
//     model's files applied — and the live project is untouched until an explicit Apply.
//   * The same validation contract as generation runs on the merged project. A proposal
//     that fails validation is discarded, never applyable.
//   * Reviewed connector templates, jaroku.json, and the top-level __init__.py are hard
//     read-only: the stream is rejected the moment the model opens one.
//   * Apply snapshots the current project into agents/.history/<id>/v<n>/ first, then
//     atomic-swaps. Undo restores the latest snapshot the same way. Linear history.
//   * Path confinement (safeRelativePath) applies to every emitted path, and agentId is
//     validated so a client-supplied id cannot traverse out of agents/.

import { EventEmitter } from "node:events";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { structuredPatch } from "diff";
import { anthropicClient, emptyUsage, summarizeUsage, type UsageSummary } from "./claude.ts";
import { loadConnectors, type Connector } from "./connectors.ts";
import { FileProtocolParser, type ProtocolEvent } from "./fileProtocol.ts";
import { agentsDir, replayFixture, safeRelativePath } from "./generator.ts";
import {
  atomicSwap, copyProject, DEPLOY_ARTIFACTS, isSafeAgentId, listProjectFiles, readOnlyPaths,
} from "./projectFs.ts";
import { buildEditSystemPrompt, buildEditUserPrompt } from "./prompt.ts";
import type { McpToolView } from "./mcpRegistry.ts";
import { validateProject } from "./validator.ts";
import { BRIDGE_FILE, MANIFEST_FILE, type Manifest } from "./mcpManifest.ts";

export const EDIT_MODEL = process.env.JAROKU_EDIT_MODEL ?? "claude-haiku-4-5";
const MAX_TOKENS = 16000;
const HISTORY_DIRNAME = ".history";

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

interface HistoryEntry {
  version: number;
  instruction: string;
  summary: string;
  files: { path: string; status: string; additions: number; deletions: number }[];
  applied_at: string;
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
  agentId: string;
  staging: string;
  instruction: string;
  summary: string;
  files: FileDiff[];
}

export interface EditorOptions {
  runtimeDir: string;
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
function readProjectManifest(projectDir: string): Manifest | undefined {
  const path = join(projectDir, MANIFEST_FILE);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Manifest;
  } catch {
    return undefined;
  }
}

function historyDir(runtimeDir: string, agentId: string): string {
  return join(agentsDir(runtimeDir), HISTORY_DIRNAME, agentId);
}

function readHistory(runtimeDir: string, agentId: string): HistoryEntry[] {
  const path = join(historyDir(runtimeDir, agentId), "history.json");
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function writeHistory(runtimeDir: string, agentId: string, entries: HistoryEntry[]): void {
  const dir = historyDir(runtimeDir, agentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "history.json"), JSON.stringify(entries, null, 2) + "\n", "utf8");
}

/** How many applied edits an agent has (drives Undo availability across reloads). */
export function editCount(runtimeDir: string, agentId: string): number {
  return isSafeAgentId(agentId) ? readHistory(runtimeDir, agentId).length : 0;
}

export class Editor extends EventEmitter<EditorEvents> {
  private pending = new Map<string, PendingProposal>();
  private busy = false;

  constructor(private readonly opts: EditorOptions) {
    super();
  }

  private fail(e: EditorEvents["error"][0]): void {
    this.emit("error", e);
  }

  async propose(agentId: string, instruction: string): Promise<void> {
    if (this.busy) {
      this.fail({ message: "an edit is already in progress", agentId });
      return;
    }
    this.busy = true;
    const { runtimeDir } = this.opts;
    const staging = join(agentsDir(runtimeDir), ".staging", `${agentId}__edit`);

    try {
      if (!isSafeAgentId(agentId)) throw new Error(`invalid agent id: ${agentId}`);
      const target = join(agentsDir(runtimeDir), agentId);
      if (!existsSync(join(target, "agent.py"))) {
        throw new Error(`agent "${agentId}" was not found (or has no agent.py)`);
      }

      // A new request supersedes any pending proposal for this agent — its staging copy
      // was diffed against files that may be about to change meaning.
      this.discardForAgent(agentId);

      const meta = this.readMeta(target);
      const all = loadConnectors(runtimeDir);
      const installed = all.filter((c) => (meta.connectors ?? []).includes(c.id));
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
      const hadToolErrorHandling = /handle_tool_errors\s*=\s*True/.test(
        readFileSync(join(target, "agent.py"), "utf8"),
      );

      copyProject(target, staging);

      const editable = listProjectFiles(target, installedFiles).filter((f) => !f.readOnly);
      const recent = readHistory(runtimeDir, agentId)
        .slice(-3)
        .map((h) => ({ instruction: h.instruction, summary: h.summary }));

      const buffers = new Map<string, string>();
      const onEvent = (event: ProtocolEvent) => {
        if (event.type === "file_start") {
          const safe = safeRelativePath(staging, event.path);
          if (!safe) throw new Error(`refusing unsafe path: ${event.path}`);
          if (blocked.has(safe)) {
            // Each message names the right next move rather than just refusing. The MCP
            // pair gets its own, because "ask for a wrapper" is the wrong advice for a
            // manifest — the fix there is to change the agent's scope, which is a decision
            // the user makes in the MCP panel, not one an edit should be able to make.
            // The deploy artifacts get theirs for the same shape of reason: they are
            // regenerated from jaroku.json on every deploy, so an edit to them would be
            // silently discarded even if it were allowed.
            const isMcp = safe === "mcp_tools.json" || safe === "tools/mcp_bridge.py";
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
          // Write on close, into the staged copy — the live project is never touched here.
          const safe = safeRelativePath(staging, event.path)!;
          const targetFile = join(staging, safe);
          mkdirSync(dirname(targetFile), { recursive: true });
          writeFileSync(targetFile, buffers.get(event.path) ?? "", "utf8");
          this.emit("file_end", { path: safe });
        }
      };
      const parser = new FileProtocolParser(onEvent);

      let usage = emptyUsage();
      const fixture = process.env.JAROKU_EDIT_FIXTURE;
      if (fixture && existsSync(fixture)) {
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
        );
        if (fixture) writeFileSync(fixture, raw, "utf8"); // record for future free replays
      }

      const protocolError = parser.finish({ allowEmpty: true });
      if (protocolError) throw new Error(protocolError);

      const summary =
        parser.prose.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ??
        "Edit proposal";

      const emitted = [...new Set(parser.files)];
      if (emitted.length === 0) {
        // A valid no-op: the model declined (rule E5) and said why in the summary.
        rmSync(staging, { recursive: true, force: true });
        this.emit("proposal", {
          proposalId: randomUUID(), agentId, instruction, summary, files: [], usage,
        });
        return;
      }

      // The staged copy is now current-project + model files: validate it exactly as a
      // fresh generation would be. Failure means the proposal is never applyable.
      const result = await validateProject(staging, {
        runtimeDir,
        // The bridge is reviewed code copied in verbatim, so it is excluded from the
        // model-output lints for the same reason a connector template is.
        connectorFiles: [...installedFiles, ...(existsSync(join(target, BRIDGE_FILE)) ? [BRIDGE_FILE] : [])],
        connectorToolNames: installed.flatMap((c) => c.tools.map((t) => t.name)),
        // The agent's existing grant, read from its own manifest rather than from the
        // registry: an edit is validated against what this project actually has.
        mcpTools: readProjectManifest(target),
        // Don't-regress, not a new requirement: only demanded of an agent that already had it.
        // Agents generated before the connector templates started raising carry swallowing copies
        // of those templates, are internally consistent, and must stay editable.
        requireToolErrorHandling: hadToolErrorHandling,
      });
      if (!result.ok) {
        rmSync(staging, { recursive: true, force: true });
        this.fail({
          message: "the proposed edit failed validation and was discarded",
          problems: result.problems,
          agentId,
        });
        return;
      }

      const files = this.diffEmitted(target, staging, emitted);
      if (files.length === 0) {
        // Everything the model re-emitted was byte-identical — nothing to apply.
        rmSync(staging, { recursive: true, force: true });
        this.emit("proposal", {
          proposalId: randomUUID(), agentId, instruction, summary, files: [], usage,
        });
        return;
      }

      const proposalId = randomUUID();
      this.pending.set(proposalId, { proposalId, agentId, staging, instruction, summary, files });
      this.emit("proposal", { proposalId, agentId, instruction, summary, files, usage });
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      this.fail({ message: (err as Error).message, agentId });
    } finally {
      this.busy = false;
    }
  }

  /** Apply a pending proposal: snapshot the current project, then atomic-swap it in. */
  apply(proposalId: string): void {
    const rec = this.pending.get(proposalId);
    if (!rec) {
      this.fail({ message: "that proposal is no longer available", proposalId });
      return;
    }
    const refusal = this.opts.canMutate?.();
    if (refusal) {
      this.fail({ message: refusal, proposalId, agentId: rec.agentId });
      return;
    }

    const { runtimeDir } = this.opts;
    const target = join(agentsDir(runtimeDir), rec.agentId);
    const entries = readHistory(runtimeDir, rec.agentId);
    const version = entries.length + 1;
    const snapshot = join(historyDir(runtimeDir, rec.agentId), `v${version}`);

    try {
      copyProject(target, snapshot); // what Undo will restore
      atomicSwap(rec.staging, target);
    } catch (err) {
      rmSync(snapshot, { recursive: true, force: true });
      this.fail({ message: `apply failed: ${(err as Error).message}`, proposalId, agentId: rec.agentId });
      return;
    }

    // Record only after the swap succeeded — an orphan snapshot dir is harmless; a history
    // entry pointing at files that never landed is not.
    entries.push({
      version,
      instruction: rec.instruction,
      summary: rec.summary,
      files: rec.files.map((f) => ({
        path: f.path, status: f.status, additions: f.additions, deletions: f.deletions,
      })),
      applied_at: new Date().toISOString(),
    });
    writeHistory(runtimeDir, rec.agentId, entries);

    this.pending.delete(proposalId);
    this.emit("applied", { proposalId, agentId: rec.agentId, version, summary: rec.summary });
  }

  /** Revert the last applied edit: restore snapshot v<n>, pop the history entry. */
  undo(agentId: string): void {
    if (!isSafeAgentId(agentId)) {
      this.fail({ message: `invalid agent id: ${agentId}`, agentId });
      return;
    }
    const refusal = this.opts.canMutate?.();
    if (refusal) {
      this.fail({ message: refusal, agentId });
      return;
    }

    const { runtimeDir } = this.opts;
    const entries = readHistory(runtimeDir, agentId);
    const last = entries[entries.length - 1];
    if (!last) {
      this.fail({ message: "nothing to undo — no applied edits", agentId });
      return;
    }
    const snapshot = join(historyDir(runtimeDir, agentId), `v${last.version}`);
    if (!existsSync(snapshot)) {
      this.fail({ message: `history snapshot v${last.version} is missing`, agentId });
      return;
    }

    // Any pending proposal was diffed against the files being reverted — drop it.
    this.discardForAgent(agentId);

    try {
      atomicSwap(snapshot, join(agentsDir(runtimeDir), agentId));
    } catch (err) {
      this.fail({ message: `undo failed: ${(err as Error).message}`, agentId });
      return;
    }
    entries.pop();
    writeHistory(runtimeDir, agentId, entries);
    this.emit("undone", { agentId, version: last.version, summary: last.summary });
  }

  /** Drop a pending proposal without applying it. */
  discard(proposalId: string): void {
    const rec = this.pending.get(proposalId);
    if (!rec) return; // already gone — discarding twice is not an error
    rmSync(rec.staging, { recursive: true, force: true });
    this.pending.delete(proposalId);
    this.emit("discarded", { proposalId, agentId: rec.agentId });
  }

  private discardForAgent(agentId: string): void {
    for (const rec of [...this.pending.values()]) {
      if (rec.agentId === agentId) this.discard(rec.proposalId);
    }
  }

  private readMeta(target: string): { connectors?: string[] } {
    const path = join(target, "jaroku.json");
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, "utf8")) as { connectors?: string[] };
    } catch {
      return {};
    }
  }

  private diffEmitted(currentDir: string, stagingDir: string, emitted: string[]): FileDiff[] {
    const out: FileDiff[] = [];
    for (const path of emitted) {
      const safe = safeRelativePath(stagingDir, path);
      if (!safe) continue; // already rejected during streaming
      const oldPath = join(currentDir, safe);
      const oldContent = existsSync(oldPath) ? readFileSync(oldPath, "utf8") : null;
      const newContent = readFileSync(join(stagingDir, safe), "utf8");
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
      files: { path: string; content: string }[];
      connectors: Connector[];
      mcpTools: McpToolView[];
      history: { instruction: string; summary: string }[];
    },
    onChunk: (text: string) => void,
    onUsage: (u: UsageSummary) => void,
  ): Promise<string> {
    let raw = "";
    const stream = anthropicClient().messages.stream({
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
