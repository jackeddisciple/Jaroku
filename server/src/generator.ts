// Builder AI layer (doc §8, 🟡): prompt -> Claude -> a complete LangGraph project, streamed.
//
// Safety properties this module is responsible for:
//   * Staging + a version bump. Files are written to object-store keys under a STAGING ID and
//     are promoted to a version only after validation passes. A crash, a truncated stream, or a
//     rule violation leaves any previously working agent untouched — the same promise the old
//     `.staging/` directory plus `atomicSwap` made, in the only form that survives having
//     several replicas and no shared disk. See storage/projectStore.ts.
//   * Path confinement. Every path the model emits is checked; absolute paths, "..", and
//     anything escaping the staging root are rejected outright.
//   * The API key never leaves this process. It is read from runtime/.env and is never
//     logged, echoed to a client, or written into a generated file.
//
// Cost control: the stable half of the prompt carries a cache breakpoint, and
// JAROKU_GEN_FIXTURE records/replays a generation so streaming UX can be iterated for free.

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { anthropicClient, emptyUsage, summarizeUsage, type UsageSummary } from "./claude.ts";
import {
  connectionSuppliedEnv, loadConnectors, optionalEnv, requiredEnv, resolveSelected, templatesDir,
  type Connector,
} from "./connectors.ts";
import { FileProtocolParser, type ProtocolEvent } from "./fileProtocol.ts";
import { round8 } from "./pricing.ts";
import type { AgentRepository } from "./db/repositories/agents.ts";
import type { TenantContext } from "./db/tenant.ts";
import { newStagingId, safeObjectPath } from "./storage/keys.ts";
import type { ProjectStore } from "./storage/projectStore.ts";
import { buildSystemPrompt, buildUserPrompt, type GenerationRequest } from "./prompt.ts";
import {
  BRIDGE_FILE, BRIDGE_TEMPLATE, MANIFEST_FILE, buildManifest, manifestCollisions, manifestEnv,
  manifestRefs, manifestToolNames, type Manifest,
} from "./mcpManifest.ts";
import type { McpServerView, McpToolView } from "./mcpRegistry.ts";
import { validateProject } from "./validator.ts";

export type { UsageSummary } from "./claude.ts";

export const GENERATION_MODEL = process.env.JAROKU_GEN_MODEL ?? "claude-haiku-4-5";
const MAX_TOKENS = 16000;
const STAGING_DIRNAME = ".staging";

export interface GeneratorDeps {
  /** Where a published version is materialised for the local run path, and where templates live. */
  runtimeDir: string;
  agents: AgentRepository;
  projects: ProjectStore;
}

export interface GenerateOptions {
  runtimeDir: string;
  /**
   * The workspace's OWN Anthropic key, when it has asked that its key pay for the platform's
   * calls on its behalf. Absent — the default, and the local path — means the platform's own.
   *
   * Passed per call rather than held, so a workspace that turns the option off stops using its
   * key on the very next request rather than on the next restart. See billing/providerKeys.ts.
   */
  apiKey?: string;

  /** Whose agent this is. Every key the generation writes is built from its workspace id. */
  ctx: TenantContext;
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

/**
 * A slug nothing in this workspace is already using.
 *
 * BOTH the table and the disk are consulted, and they are asking different questions. The table
 * is the one that matters: slugs became unique PER WORKSPACE in Session 1, so two tenants may
 * each have a `support_bot` and neither may have two. The disk is checked as well because
 * `runtime/agents/` is still one namespace shared by every workspace on a development box, and
 * materialising a new agent over a directory another workspace is running out of would be a
 * local-only data loss that no hosted test would ever see.
 */
async function uniqueAgentSlug(
  agents: AgentRepository,
  ctx: TenantContext,
  runtimeDir: string,
  desired: string,
): Promise<string> {
  let id = desired;
  let n = 2;
  while ((await agents.bySlug(ctx, id)) || existsSync(join(agentsDir(runtimeDir), id))) {
    id = `${desired}_${n++}`;
  }
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
  constructor(private readonly deps: GeneratorDeps) {
    super();
  }

  async generate(opts: GenerateOptions): Promise<void> {
    const { runtimeDir, ctx } = opts;
    const { agents, projects } = this.deps;
    const all = loadConnectors(runtimeDir);
    const selected = resolveSelected(all, opts.connectors);

    const name = (opts.name?.trim() || opts.prompt.trim().split("\n")[0] || "agent").slice(0, 60);
    const slug = await uniqueAgentSlug(agents, ctx, runtimeDir, slugify(opts.name?.trim() || opts.prompt));

    // THE AGENT'S UUID IS MINTED HERE AND ITS ROW IS WRITTEN AT THE END.
    //
    // Object keys are built from the uuid, so staging needs one before there is anything worth
    // recording. Writing the row up front instead would leave an agent with no version behind
    // every failed generation — visible in the sidebar, unopenable, and needing its own cleanup
    // path. The keyspace does not care whether a row exists; the sidebar does.
    const agentUuid = randomUUID();
    const stagingId = newStagingId();

    const buffers = new Map<string, string>();
    /** Complete files, by project-relative path. What becomes the staging objects. */
    const staged = new Map<string, string>();
    let usage: UsageSummary = emptyUsage();

    const onEvent = (event: ProtocolEvent) => {
      if (event.type === "file_start") {
        const safe = safeObjectPath(event.path);
        if (!safe) throw new Error(`refusing unsafe generated path: ${event.path}`);
        buffers.set(event.path, "");
        this.emit("file_start", { path: safe });
      } else if (event.type === "file_delta") {
        buffers.set(event.path, (buffers.get(event.path) ?? "") + event.text);
        this.emit("file_delta", { path: event.path, text: event.text });
      } else {
        // Recorded on close, so a file exists as a unit or not at all — the same property
        // "write on close" gave when the destination was a directory. The write to the store
        // happens once the whole stream is in, because this callback is synchronous and an
        // upload is not, and a half-awaited put is worse than a buffered one.
        const safe = safeObjectPath(event.path)!;
        staged.set(safe, buffers.get(event.path) ?? "");
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

    // Where the project is assembled for the checks that need a filesystem. A temp directory,
    // not `runtime/agents/.staging/`, and that is the change: nothing this generation touches
    // is on a path another replica or another workspace shares. Session 4 replaces it with a
    // sandbox's tmpfs and this call site does not change.
    const scratch = join(tmpdir(), `jaroku-gen-${stagingId}`);

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
          generationRequest(opts, slug, name, selected),
          (chunk) => parser.push(chunk),
          (u) => (usage = u),
          opts.apiKey,
        );
        if (fixture) writeFileSync(fixture, raw, "utf8"); // record for future free runs
      }

      const protocolError = parser.finish();
      if (protocolError) throw new Error(protocolError);

      // Host-owned files, added after the model's so the model cannot shadow them. Same order
      // and same content as when they were written to a directory; the only difference is that
      // "written" now means "put in the map that becomes the staging objects".
      const connectorFiles = this.connectorFiles(selected, runtimeDir);
      const mcpFiles = this.mcpBridgeFiles(manifest, runtimeDir);
      const hostFiles = this.hostFiles(staged, {
        agentId: slug, name, description: opts.prompt, selected, manifest,
        planned: Boolean(opts.plan),
        planCost: opts.planUsage?.cost_usd ?? 0,
        generationCost: usage.cost_usd,
      });
      for (const f of [...connectorFiles, ...mcpFiles, ...hostFiles]) staged.set(f.path, f.content);

      // STAGING IS THE OBJECT STORE NOW. Under a staging id nothing else refers to, so a
      // generation that never lands leaves objects behind and no version at all.
      for (const path of [...staged.keys()].sort()) {
        await projects.putStaging(ctx, agentUuid, stagingId, { path, content: staged.get(path)! });
      }

      // ...and validation reads from there, rather than from wherever the files happened to be
      // written. That is what makes this the same code path on a replica holding no copy.
      await projects.materialiseStaging(ctx, agentUuid, stagingId, scratch);
      const result = await validateProject(scratch, {
        runtimeDir,
        // The bridge is reviewed code copied in verbatim, exactly like a connector template,
        // so it is excluded from the model-output lints for the same reason.
        connectorFiles: [...connectorFiles, ...mcpFiles].map((f) => f.path),
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
        await projects.discardStaging(ctx, agentUuid, stagingId);
        this.emit("error", {
          message: "the generated project failed validation and was discarded",
          problems: result.problems,
        });
        return;
      }

      // The row, then the version. In that order because a version hangs off an agent, and in
      // one direction because a failure here leaves staging objects rather than a half-agent.
      await agents.create(ctx, {
        id: agentUuid,
        slug,
        display_name: name,
        description: opts.prompt.trim().slice(0, 500),
        connectors: selected.map((c) => c.id),
        mcp_tools: manifestRefs(manifest),
        required_env: [...requiredEnv(selected), ...manifestEnv(manifest)],
        default_provider: "fake",
        creation_cost: round8((opts.planUsage?.cost_usd ?? 0) + usage.cost_usd),
      });
      const { version } = await projects.publishStaging(ctx, agentUuid, stagingId, {
        source: "generation",
        summary: name,
      });

      // AND A LOCAL COPY, because a run is still a subprocess importing `agents.<slug>.agent`
      // from `runtime/agents/`. That directory stops being the source of truth here and becomes
      // a materialisation of one — Session 4 replaces it with a sandbox fetching the version.
      await projects.materialise(ctx, agentUuid, version, join(agentsDir(runtimeDir), slug));

      this.emit("done", {
        agentId: slug, name, files: parser.files, usage, planUsage: opts.planUsage ?? emptyUsage(),
      });
    } catch (err) {
      await projects.discardStaging(ctx, agentUuid, stagingId).catch(() => {});
      this.emit("error", { message: (err as Error).message });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
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
    apiKey?: string,
  ): Promise<string> {
    let raw = "";
    const stream = anthropicClient(apiKey).messages.stream({
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

  /** Reviewed connector templates, verbatim. Read rather than copied, and still byte-for-byte. */
  private connectorFiles(selected: Connector[], runtimeDir: string): StagedFile[] {
    const out: StagedFile[] = [];
    for (const c of selected) {
      const src = join(templatesDir(runtimeDir), c.file);
      if (!existsSync(src)) continue;
      out.push({ path: `tools/${c.file}`, content: readFileSync(src, "utf8") }); // never re-rendered
    }
    return out;
  }

  /**
   * The reviewed MCP bridge and the manifest beside it.
   *
   * Both are host-owned, both are added after the model's files, and neither exists when the
   * agent has no MCP tools — a project that was never granted any carries no MCP machinery at
   * all.
   */
  private mcpBridgeFiles(manifest: Manifest, runtimeDir: string): StagedFile[] {
    if (!manifest.servers.length) return [];
    const src = join(templatesDir(runtimeDir), BRIDGE_TEMPLATE);
    if (!existsSync(src)) return [];
    return [
      { path: BRIDGE_FILE, content: readFileSync(src, "utf8") }, // byte-for-byte
      { path: MANIFEST_FILE, content: `${JSON.stringify(manifest, null, 2)}\n` },
    ];
  }

  private hostFiles(
    staged: Map<string, string>,
    meta: {
      agentId: string; name: string; description: string; selected: Connector[];
      manifest: Manifest;
      planned: boolean; planCost: number; generationCost: number;
    },
  ): StagedFile[] {
    // Connector env and MCP credential keys land in the same list: both are things this
    // agent cannot run without, and .env.example exists to tell a user what those are.
    const env = [...requiredEnv(meta.selected), ...manifestEnv(meta.manifest)];

    const jaroku =
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
      ) + "\n";

    // Merge connector env into whatever the model wrote, so .env.example is complete even
    // if the model forgot a key.
    //
    // TWO BLOCKS NOW, BECAUSE THE KEYS MEAN TWO DIFFERENT THINGS. A `user_secret` connector's
    // keys are a to-do list — nothing works until somebody pastes a value in. An `oauth`
    // connector's keys are documentation: hosted, they are filled by a connection the workspace
    // made by clicking Connect, and presenting `GMAIL_REFRESH_TOKEN=` as a blank would tell a
    // user to go and do by hand precisely the thing that button exists to do for them.
    //
    // The names stay in the file either way, and that is deliberate rather than tidiness: this
    // project is portable, and a copy of it running outside Jaroku has no connection to ask.
    // What changes is only what the file SAYS about them.
    const connectionFilled = connectionSuppliedEnv(meta.selected);
    const existing = staged.get(".env.example") ?? "";
    const missing = env.filter((k) => !existing.includes(k));
    const toFill = missing.filter((k) => !connectionFilled.includes(k));
    const documented = missing.filter((k) => connectionFilled.includes(k));
    let envExample = existing;
    const blocks: string[] = [];
    if (toFill.length) {
      blocks.push(
        "",
        "# Required by the connectors and MCP servers this agent uses:",
        ...toFill.map((k) => `${k}=`),
      );
    }
    if (documented.length) {
      blocks.push(
        "",
        "# Filled in for you when this agent runs in Jaroku, from the connection this",
        "# workspace made. Set them by hand only if you are running this project on your",
        "# own, outside Jaroku:",
        ...documented.map((k) => `# ${k}=`),
      );
    }
    // AND THE OPTIONAL ONES, AS A THIRD BLOCK. They are not in `env` — that list is built from
    // `required_env`, which is what a deploy refuses over — so without this they appear in no
    // file at all, and a copy of this project running outside Jaroku has no way to learn the
    // name exists. Commented rather than blank, like the connection-filled block above and for
    // the same reason: a blank says "fill this in or nothing works", which is false here.
    const optional = optionalEnv(meta.selected).filter((k) => !existing.includes(k) && !env.includes(k));
    if (optional.length) {
      blocks.push(
        "",
        "# Optional. These connectors read them when set and work without them:",
        ...optional.map((k) => `# ${k}=`),
      );
    }
    if (blocks.length) {
      envExample = `${existing.trimEnd()}\n${[...blocks, ""].join("\n")}`;
    } else if (!existing) {
      envExample = "# This agent needs no credentials.\n";
    }

    return [
      { path: "jaroku.json", content: jaroku },
      { path: ".env.example", content: envExample },
      // Package markers so `agents.<id>.agent` imports cleanly.
      { path: "__init__.py", content: `"""${meta.name} — generated by Jaroku."""\n` },
    ];
  }
}

/** A file on its way into staging. Same shape as the project store's, named where it is built. */
interface StagedFile {
  path: string;
  content: string;
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
