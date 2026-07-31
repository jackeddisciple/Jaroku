// Builder AI layer (doc §8, 🟡): prompt -> Claude -> a complete LangGraph project, streamed.
//
// Safety properties this module is responsible for:
//   * Staging + atomic swap. Files are written to agents/.staging/<id>/ and only moved into
//     agents/<id>/ after validation passes. A crash, a truncated stream, or a rule violation
//     leaves any previously working agent untouched.
//   * Path confinement. Every path the model emits is checked; absolute paths, "..", and
//     anything escaping the staging root are rejected outright.
//   * The API key never leaves this process. It is read from runtime/.env and is never
//     logged, echoed to a client, or written into a generated file.
//
// Cost control: the stable half of the prompt carries a cache breakpoint, and
// JAROKU_GEN_FIXTURE records/replays a generation so streaming UX can be iterated for free.

import { EventEmitter } from "node:events";
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { anthropicClient, emptyUsage, summarizeUsage, type UsageSummary } from "./claude.ts";
import { loadConnectors, requiredEnv, resolveSelected, templatesDir, type Connector } from "./connectors.ts";
import { FileProtocolParser, type ProtocolEvent } from "./fileProtocol.ts";
import { round8 } from "./pricing.ts";
import { atomicSwap } from "./projectFs.ts";
import { buildSystemPrompt, buildUserPrompt, type GenerationRequest } from "./prompt.ts";
import {
  BRIDGE_FILE, BRIDGE_TEMPLATE, buildManifest, manifestCollisions, manifestEnv, manifestRefs,
  manifestToolNames, writeManifest, type Manifest,
} from "./mcpManifest.ts";
import type { McpServerView, McpToolView } from "./mcpRegistry.ts";
import { validateProject } from "./validator.ts";

export type { UsageSummary } from "./claude.ts";

export const GENERATION_MODEL = process.env.JAROKU_GEN_MODEL ?? "claude-haiku-4-5";
const MAX_TOKENS = 16000;
const STAGING_DIRNAME = ".staging";

export interface GenerateOptions {
  runtimeDir: string;
  prompt: string;
  connectors?: string[];
  /**
   * The MCP tools this agent is scoped to, resolved from the APPROVED plan record.
   *
   * These become mcp_tools.json, and mcp_tools.json is the entire grant — the bridge builds
   * these tools and offers no path to any other.
   */
  mcpTools?: McpToolView[];
  /** The servers those tools came from, for their endpoints and credential key names. */
  mcpServers?: McpServerView[];
  name?: string;
  /** The plan the user confirmed at the pre-generation gate, verbatim (planner.ts). Absent =
   *  an unplanned generation, whose prompt stays byte-identical to the pre-gate one. */
  plan?: string;
  /** What the plan itself cost. Part of what creating this agent cost, so it is reported and
   *  recorded alongside the generation rather than quietly absorbed. */
  planUsage?: UsageSummary;
}

export interface GeneratorEvents {
  file_start: [{ path: string }];
  file_delta: [{ path: string; text: string }];
  file_end: [{ path: string }];
  done: [{ agentId: string; name: string; files: string[]; usage: UsageSummary; planUsage: UsageSummary }];
  error: [{ message: string; problems?: string[] }];
}

export function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  const cleaned = /^[a-z]/.test(base) ? base : `agent_${base}`;
  return cleaned.replace(/_+$/, "") || "agent";
}

export function agentsDir(runtimeDir: string): string {
  return join(runtimeDir, "agents");
}

function uniqueAgentId(runtimeDir: string, desired: string): string {
  let id = desired;
  let n = 2;
  while (existsSync(join(agentsDir(runtimeDir), id))) id = `${desired}_${n++}`;
  return id;
}

/** Reject anything that could write outside the project directory. */
export function safeRelativePath(root: string, candidate: string): string | null {
  if (!candidate || isAbsolute(candidate) || candidate.includes("\0")) return null;
  const normalized = normalize(candidate).replace(/^(\.\/)+/, "");
  if (normalized.startsWith("..")) return null;
  const resolved = join(root, normalized);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return normalized;
}

/**
 * The request the generation prompt is built from.
 *
 * A named seam rather than an object literal at the call site, because the call site is where
 * this went wrong: the model was never told the agent had any MCP tools, while the host wrote
 * the bridge and the manifest anyway. The result was not a degraded agent but a discarded one —
 * validation rule 12 rejects a project that advertises MCP tools it never wired in, so every
 * MCP-scoped generation failed, after being paid for.
 *
 * Nothing here is optional-by-omission. What the model is shown and what the manifest grants
 * come from the same field of the same options object, and mcpHardening.test.ts asserts that
 * the prompt names every tool the manifest contains.
 */
export function generationRequest(
  opts: GenerateOptions,
  agentId: string,
  agentName: string,
  connectors: Connector[],
): GenerationRequest {
  return {
    prompt: opts.prompt,
    agentId,
    agentName,
    connectors,
    mcpTools: opts.mcpTools ?? [],
    plan: opts.plan,
  };
}

export class Generator extends EventEmitter<GeneratorEvents> {
  async generate(opts: GenerateOptions): Promise<void> {
    const { runtimeDir } = opts;
    const all = loadConnectors(runtimeDir);
    const selected = resolveSelected(all, opts.connectors);

    const name = (opts.name?.trim() || opts.prompt.trim().split("\n")[0] || "agent").slice(0, 60);
    const agentId = uniqueAgentId(runtimeDir, slugify(opts.name?.trim() || opts.prompt));

    const staging = join(agentsDir(runtimeDir), STAGING_DIRNAME, agentId);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });

    const buffers = new Map<string, string>();
    let usage: UsageSummary = emptyUsage();

    const onEvent = (event: ProtocolEvent) => {
      if (event.type === "file_start") {
        const safe = safeRelativePath(staging, event.path);
        if (!safe) throw new Error(`refusing unsafe generated path: ${event.path}`);
        buffers.set(event.path, "");
        this.emit("file_start", { path: safe });
      } else if (event.type === "file_delta") {
        buffers.set(event.path, (buffers.get(event.path) ?? "") + event.text);
        this.emit("file_delta", { path: event.path, text: event.text });
      } else {
        // Write on close: a file exists on disk only once it is complete.
        const safe = safeRelativePath(staging, event.path)!;
        const target = join(staging, safe);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, buffers.get(event.path) ?? "", "utf8");
        this.emit("file_end", { path: safe });
      }
    };

    const parser = new FileProtocolParser(onEvent);

    // The manifest is built BEFORE the model is called, not after, for two reasons that both
    // come down to it being the agent's MCP grant rather than a by-product of generation.
    //
    // It is what the model has to be told about: the prompt lists exactly the tools the
    // manifest will contain, so a tool named in one and missing from the other is a project
    // that cannot validate. Building it here makes them one fact instead of two.
    //
    // And a grant that cannot be represented has to fail before anything is spent. Nothing in
    // the model's output can fix two servers advertising one name — see manifestCollisions.
    const manifest = buildManifest(opts.mcpTools ?? [], opts.mcpServers ?? []);

    try {
      const clash = manifestCollisions(manifest);
      if (clash.length) {
        // Named in full, with the servers involved, because the fix is a selection the user
        // makes in the MCP panel and they need to know which one to change.
        const detail = clash
          .map((tool) => {
            const from = manifest.servers
              .filter((s) => s.tools.some((t) => t.name === tool))
              .map((s) => s.id)
              .join(" and ");
            return `${tool} (from ${from})`;
          })
          .join(", ");
        throw new Error(
          `two MCP servers advertise the same tool name: ${detail}. An agent has one tool ` +
            `per name, so only one of each can be granted — deselect the duplicate in the MCP ` +
            `panel and generate again.`,
        );
      }

      const connectorNames = new Set(selected.flatMap((c) => c.tools.map((t) => t.name)));
      const shadowed = manifestToolNames(manifest).filter((n) => connectorNames.has(n));
      if (shadowed.length) {
        // Same failure, other direction. A reviewed connector and an unreviewed MCP server
        // sharing a name is worse than two MCP servers doing it: whichever wins, a badge that
        // says "reviewed" and a tool that is not are one name apart.
        throw new Error(
          `${shadowed.join(", ")} ${shadowed.length > 1 ? "are" : "is"} the name of both a ` +
            `selected connector tool and a selected MCP tool. They cannot both be granted — ` +
            `drop one of the two in the MCP panel and generate again.`,
        );
      }

      const fixture = process.env.JAROKU_GEN_FIXTURE;
      if (fixture && existsSync(fixture)) {
        // Same warning as the edit path: replay ignores the prompt entirely, and a
        // forgotten env var makes every generation return the same canned project.
        console.warn(
          `[gen] JAROKU_GEN_FIXTURE is set — replaying ${fixture}; the prompt is ` +
            `ignored and the model is NOT being called. Unset it for real generations.`,
        );
        await replayFixture(fixture, (chunk) => parser.push(chunk));
      } else {
        const raw = await this.streamGeneration(
          all,
          generationRequest(opts, agentId, name, selected),
          (chunk) => parser.push(chunk),
          (u) => (usage = u),
        );
        if (fixture) writeFileSync(fixture, raw, "utf8"); // record for future free runs
      }

      const protocolError = parser.finish();
      if (protocolError) throw new Error(protocolError);

      // Host-owned files. Written after the model's, so the model cannot shadow them.
      const connectorFiles = this.installConnectors(staging, selected, runtimeDir);
      const mcpFiles = this.installMcpBridge(staging, manifest, runtimeDir);
      this.writeHostFiles(staging, {
        agentId, name, description: opts.prompt, selected, manifest,
        planned: Boolean(opts.plan),
        planCost: opts.planUsage?.cost_usd ?? 0,
        generationCost: usage.cost_usd,
      });

      const result = await validateProject(staging, {
        runtimeDir,
        // The bridge is reviewed code copied in verbatim, exactly like a connector template,
        // so it is excluded from the model-output lints for the same reason.
        connectorFiles: [...connectorFiles, ...mcpFiles],
        // Connector tools are real tool objects too — calling one directly crashes the
        // same way, so they must be part of the "do not call directly" set.
        connectorToolNames: selected.flatMap((c) => c.tools.map((t) => t.name)),
        // The grant, so a generated call can be checked against the schema the server
        // actually declared rather than against a guess.
        mcpTools: manifest,
        // Fresh project: the connector templates raise, so the tool node has to survive a raise.
        requireToolErrorHandling: true,
      });
      if (!result.ok) {
        rmSync(staging, { recursive: true, force: true });
        this.emit("error", {
          message: "the generated project failed validation and was discarded",
          problems: result.problems,
        });
        return;
      }

      atomicSwap(staging, join(agentsDir(runtimeDir), agentId));
      this.emit("done", {
        agentId, name, files: parser.files, usage, planUsage: opts.planUsage ?? emptyUsage(),
      });
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      this.emit("error", { message: (err as Error).message });
    }
  }

  private async streamGeneration(
    allConnectors: Connector[],
    // GenerationRequest itself, not a narrower structural copy of it. The copy is what let the
    // MCP tools go missing: buildUserPrompt has always rendered them, and a hand-written
    // parameter type that omitted the field made passing them a compile error nobody saw.
    req: GenerationRequest,
    onChunk: (text: string) => void,
    onUsage: (u: UsageSummary) => void,
  ): Promise<string> {
    let raw = "";
    const stream = anthropicClient().messages.stream({
      model: GENERATION_MODEL,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: "text",
          text: buildSystemPrompt(allConnectors),
          // Byte-stable across every generation. NOTE: haiku-4-5's minimum cacheable
          // prefix is 4096 tokens and this prompt is ~2.3k, so the marker is currently
          // inert (cache_creation stays 0) — the "cache hit" this comment used to promise
          // never actually happened. Kept because it costs nothing and takes effect the
          // moment the prompt grows or the model changes. Verified 2026-07-23.
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: buildUserPrompt(req) }],
    });

    stream.on("text", (delta) => {
      raw += delta;
      onChunk(delta);
    });

    const final = await stream.finalMessage();
    onUsage(summarizeUsage(final.usage));
    return raw;
  }

  /** Copy reviewed connector templates in verbatim. Returns their project-relative paths. */
  private installConnectors(staging: string, selected: Connector[], runtimeDir: string): string[] {
    const toolsDir = join(staging, "tools");
    mkdirSync(toolsDir, { recursive: true });
    const written: string[] = [];
    for (const c of selected) {
      const src = join(templatesDir(runtimeDir), c.file);
      if (!existsSync(src)) continue;
      copyFileSync(src, join(toolsDir, c.file)); // byte-for-byte; never re-rendered
      written.push(join("tools", c.file));
    }
    return written;
  }

  /**
   * Copy the reviewed MCP bridge and write the manifest beside it.
   *
   * Both are host-owned, both are written after the model's files, and neither exists when
   * the agent has no MCP tools — a project that was never granted any carries no MCP
   * machinery at all. Returns their project-relative paths.
   */
  private installMcpBridge(staging: string, manifest: Manifest, runtimeDir: string): string[] {
    if (!manifest.servers.length) return [];
    const toolsDir = join(staging, "tools");
    mkdirSync(toolsDir, { recursive: true });
    const src = join(templatesDir(runtimeDir), BRIDGE_TEMPLATE);
    if (!existsSync(src)) return [];
    copyFileSync(src, join(toolsDir, BRIDGE_TEMPLATE)); // byte-for-byte; never re-rendered
    writeManifest(staging, manifest);
    return [BRIDGE_FILE];
  }

  private writeHostFiles(
    staging: string,
    meta: {
      agentId: string; name: string; description: string; selected: Connector[];
      manifest: Manifest;
      planned: boolean; planCost: number; generationCost: number;
    },
  ): void {
    // Connector env and MCP credential keys land in the same list: both are things this
    // agent cannot run without, and .env.example exists to tell a user what those are.
    const env = [...requiredEnv(meta.selected), ...manifestEnv(meta.manifest)];

    writeFileSync(
      join(staging, "jaroku.json"),
      JSON.stringify(
        {
          agent_id: meta.agentId,
          name: meta.name,
          description: meta.description.trim().slice(0, 500),
          entry: "agent",
          schema_version: 1,
          connectors: meta.selected.map((c) => c.id),
          // Recorded so the client can mark this agent's MCP-sourced tools everywhere they
          // appear — the frozen Step schema carries no provenance and must not learn one,
          // so a trace badge is derived by joining agent metadata on the tool name.
          mcp_servers: meta.manifest.servers.map((s) => s.id),
          mcp_tools: manifestRefs(meta.manifest),
          required_env: env,
          default_provider: "fake",
          created_at: new Date().toISOString(),
          // What this agent cost to bring into existence. Additive to schema_version 1:
          // contract.py never reads this file, and listAgents() parses it as a partial and
          // ignores keys it doesn't know. Recorded because the conversation that showed these
          // numbers is in-memory and gone on reload, and "what did this cost me" is a question
          // asked long after.
          creation: {
            planned: meta.planned,
            plan_cost_usd: round8(meta.planCost),
            generation_cost_usd: round8(meta.generationCost),
            total_cost_usd: round8(meta.planCost + meta.generationCost),
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    // Merge connector env into whatever the model wrote, so .env.example is complete even
    // if the model forgot a key.
    const envPath = join(staging, ".env.example");
    const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    const missing = env.filter((k) => !existing.includes(k));
    if (missing.length) {
      const block = ["", "# Required by the connectors and MCP servers this agent uses:", ...missing.map((k) => `${k}=`), ""].join("\n");
      writeFileSync(envPath, `${existing.trimEnd()}\n${block}`, "utf8");
    } else if (!existing) {
      writeFileSync(envPath, "# This agent needs no credentials.\n", "utf8");
    }

    // Package markers so `agents.<id>.agent` imports cleanly.
    writeFileSync(join(staging, "__init__.py"), `"""${meta.name} — generated by Jaroku."""\n`, "utf8");
  }

}

/** Replay a recorded stream, chunked and paced, so the UI behaves as it would live. */
export async function replayFixture(path: string, onChunk: (text: string) => void): Promise<void> {
  const raw = readFileSync(path, "utf8");
  const size = 24;
  for (let i = 0; i < raw.length; i += size) {
    onChunk(raw.slice(i, i + size));
    await new Promise((r) => setTimeout(r, 4));
  }
}
