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
import { buildSystemPrompt, buildUserPrompt } from "./prompt.ts";
import { validateProject } from "./validator.ts";

export type { UsageSummary } from "./claude.ts";

export const GENERATION_MODEL = process.env.JAROKU_GEN_MODEL ?? "claude-haiku-4-5";
const MAX_TOKENS = 16000;
const STAGING_DIRNAME = ".staging";

export interface GenerateOptions {
  runtimeDir: string;
  prompt: string;
  connectors?: string[];
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

    try {
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
        const raw = await this.streamGeneration(all, {
          prompt: opts.prompt, agentId, agentName: name, connectors: selected, plan: opts.plan,
        }, (chunk) => parser.push(chunk), (u) => (usage = u));
        if (fixture) writeFileSync(fixture, raw, "utf8"); // record for future free runs
      }

      const protocolError = parser.finish();
      if (protocolError) throw new Error(protocolError);

      // Host-owned files. Written after the model's, so the model cannot shadow them.
      const connectorFiles = this.installConnectors(staging, selected, runtimeDir);
      this.writeHostFiles(staging, {
        agentId, name, description: opts.prompt, selected,
        planned: Boolean(opts.plan),
        planCost: opts.planUsage?.cost_usd ?? 0,
        generationCost: usage.cost_usd,
      });

      const result = await validateProject(staging, {
        runtimeDir,
        connectorFiles,
        // Connector tools are real tool objects too — calling one directly crashes the
        // same way, so they must be part of the "do not call directly" set.
        connectorToolNames: selected.flatMap((c) => c.tools.map((t) => t.name)),
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
    req: { prompt: string; agentId: string; agentName: string; connectors: Connector[]; plan?: string },
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

  private writeHostFiles(
    staging: string,
    meta: {
      agentId: string; name: string; description: string; selected: Connector[];
      planned: boolean; planCost: number; generationCost: number;
    },
  ): void {
    const env = requiredEnv(meta.selected);

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
      const block = ["", "# Required by the connectors this agent uses:", ...missing.map((k) => `${k}=`), ""].join("\n");
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
