// The pre-generation gate (see planProtocol.ts): prompt -> a short plan -> the user confirms
// -> generation. An earlier phase of the same generation call, sharing its model, its prompt
// module and its usage accounting.
//
// Safety properties this module is responsible for — or rather, the ones it deliberately does
// NOT need:
//   * It writes nothing to disk. No staging directory, no agent id, no atomic swap. A plan is
//     text about code that does not exist yet, so the staging/validation contract has nothing
//     to protect here and this module cannot damage a working agent.
//   * It reserves no agent id. uniqueAgentId() is only correct because generator.ts mkdirs
//     immediately after calling it; promising a directory name at plan time would put a
//     reservation outside that discipline.
//
// State is a SINGLE pending slot, not a map. There is one plan card, one composer, and
// broadcastGen has no per-client targeting — a map keyed by id would imply a concurrency that
// doesn't exist while still needing every one of its edge cases handled.

import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { anthropicClient, emptyUsage, summarizeUsage, type UsageSummary } from "./claude.ts";
import { loadConnectors, resolveSelected, type Connector } from "./connectors.ts";
import { parsePlan, planProblem, reconcileWithSelection, type AgentPlan } from "./planProtocol.ts";
import { buildPlanSystemPrompt, buildPlanUserPrompt } from "./prompt.ts";
import type { McpToolView } from "./mcpRegistry.ts";
import type { EffortPlan } from "./effort.ts";

// Falls through JAROKU_GEN_MODEL so that pointing generation at a different model moves the
// plan with it — the two phases describing the same build should not disagree about who is
// doing the thinking.
export const PLAN_MODEL =
  process.env.JAROKU_PLAN_MODEL ?? process.env.JAROKU_GEN_MODEL ?? "claude-haiku-4-5";

// A plan is ~200 words. This is a ceiling against a runaway response, not a target; the
// prompt does the actual work of keeping it short.
/** Exported so the effort adapter clamps a thinking budget against the number THIS call sends. */
export const MAX_TOKENS = 600;

export interface PlanOptions {
  runtimeDir: string;
  /**
   * The workspace's OWN Anthropic key, when it has asked that its key pay for the platform's
   * calls on its behalf. Absent — the default, and the local path — means the platform's own.
   *
   * Passed per call rather than held, so a workspace that turns the option off stops using its
   * key on the very next request rather than on the next restart. See billing/providerKeys.ts.
   */
  apiKey?: string;

  /** The workspace asking. A plan is one workspace's, and only that one may spend it. */
  workspaceId: string;
  prompt: string;
  connectors?: string[];
  /**
   * MCP tools the user scoped this agent to, already resolved against the registry by the
   * caller — so this module keeps its single dependency on the connector catalogue and does
   * not grow a second one on the MCP registry.
   */
  mcpTools?: McpToolView[];
  name?: string;
  /** Present when the user asked for a change to the plan they were shown. */
  revisePlanId?: string;
  feedback?: string;
  /**
   * §3.2 REACHING THE REQUEST, which is the link the whole abstraction was missing.
   *
   * Resolved by the caller through the conversation → workspace → default chain and translated by
   * the one adapter, so this module never learns what a level means for a provider. Null when the
   * model has no reasoning control or nothing asked for one, and the request is then exactly the
   * one that shipped.
   */
  effort?: EffortPlan | null;
}

/** A plan awaiting the user's confirmation. Holds the request it was planned FOR, because
 *  generation must build what was approved, not what the composer happens to say later. */
export interface PendingPlan {
  planId: string;
  /**
   * Whose plan this is.
   *
   * There is one slot, and a plan id is the whole of what `generate` and `discardPlan` carry —
   * so without this the slot answered to whoever held the id. Another workspace could spend a
   * plan it never wrote (its prompt and its reviewed design becoming the agent THEY build) or
   * throw it away between the user reading it and pressing Generate.
   */
  workspaceId: string;
  prompt: string;
  connectors: string[];
  /**
   * The MCP tools this plan was written against, as `"server/tool"` refs.
   *
   * Recorded for the same reason `connectors` is: generation builds what was APPROVED, not
   * what the composer says by the time Generate is pressed. Ticking another third-party tool
   * after planning must not smuggle it into a build nobody reviewed.
   */
  mcpTools: string[];
  name?: string;
  plan: AgentPlan;
  warnings: string[];
  usage: UsageSummary;
  revision: number;
  createdAt: number;
}

export interface PlannerEvents {
  // `prompt` is the effective brief; `input` is what the user actually typed this turn —
  // the brief on the first plan, the feedback on a revision. The conversation renders
  // `input`, because echoing the original brief back on every revision would be a lie about
  // what was said.
  started: [{ prompt: string; input: string; revision: number }];
  delta: [{ text: string }];
  plan: [
    {
      planId: string;
      prompt: string;
      connectors: string[];
      name?: string;
      plan: AgentPlan;
      warnings: string[];
      usage: UsageSummary;
      revision: number;
    },
  ];
  // `workspaceId` so the listener can route it to the plan's OWN tenant rather than to whichever
  // one the planner's scope happens to point at — see `discard`.
  discarded: [{ planId: string; workspaceId: string }];
  error: [{ message: string }];
}

export class Planner extends EventEmitter<PlannerEvents> {
  /**
   * The plan each workspace has awaiting a decision, by workspace id.
   *
   * ONE SLOT PER TENANT, NOT ONE FOR THE PROCESS. It was one, and `plan()` cleared whatever was in
   * it before writing its own — so workspace B asking for a plan silently destroyed workspace A's,
   * A's Generate button answered "that plan is no longer available" with no explanation, and the
   * `discarded` event naming A's plan id was delivered to B, who had never seen it.
   *
   * Superseding is a real rule and it is kept, scoped to the asker: a workspace's second plan
   * replaces its own first, because the card that first one belongs to has visibly been replaced
   * on screen. That argument was always about ONE session and never about two tenants.
   *
   * Bounded by "workspaces with an unspent plan", and each entry is replaced by that workspace's
   * next plan or removed by its Generate — the same lifetime the single slot had.
   */
  private pending = new Map<string, PendingPlan>();
  private busy = false;
  /**
   * The slot won by a caller that has not reached `plan()` yet.
   *
   * The widest of the three such windows in the product: `planAgent` resolves a thread, a provider
   * key and the MCP catalogue between its guard and this call. For all three awaits `busy` was
   * false, so the guard was testing a flag nothing had set — see `tryClaim`.
   */
  private claimed = false;

  /** This workspace's plan awaiting confirmation, if any. Read-only — use take() to consume it. */
  peek(workspaceId: string): PendingPlan | null {
    return this.pending.get(workspaceId) ?? null;
  }

  /**
   * Whether a plan is being written, readable from outside.
   *
   * `plan()` refuses a second one anyway; this is what lets the CALLER refuse first, so that a
   * refused request never repoints the workspace scope the in-flight plan's deltas are being
   * broadcast to. See `planContext` in index.ts.
   */
  get inFlight(): boolean {
    return this.busy || this.claimed;
  }

  /**
   * Take the single planning slot, or answer false because somebody else holds it.
   *
   * Test and set in one synchronous statement, for the reason spelled out on `Editor.tryClaim`:
   * a guard separated from its flag by an `await` is not a guard.
   */
  tryClaim(): boolean {
    if (this.busy || this.claimed) return false;
    this.claimed = true;
    return true;
  }

  /** Give back a claim that never became a plan — the caller threw before `plan()` ran. */
  releaseClaim(): void {
    this.claimed = false;
  }

  /**
   * Consume the pending plan. Returns null if the id doesn't match — a stale card in another
   * tab, or a second click on a plan already spent. The caller must treat that as a refusal,
   * never as "generate without the plan": the user approved a specific plan, and silently
   * building something unreviewed instead is the exact failure this gate exists to prevent.
   */
  take(workspaceId: string, planId: string): PendingPlan | null {
    const rec = this.pending.get(workspaceId);
    if (!rec || rec.planId !== planId) return null;
    this.pending.delete(workspaceId);
    return rec;
  }

  /**
   * Put a spent plan back, because the generation it authorised never happened.
   *
   * `take()` is called with the comment "spend it: this generation is now certain to START" — and
   * certain to start is not certain to succeed. A build that fails validation therefore consumed
   * the approved plan and left nothing to retry from: the card's Generate, Revise and Discard all
   * unmounted, the composer was empty, and the failure's own reassurance — "Nothing was written" —
   * read as "nothing was lost" while the plan was exactly what had been. The way out was to re-type
   * the brief and pay for a second planning call.
   *
   * THE APPROVED PLAN IS STILL GOOD. It described an agent a person read and confirmed; what failed
   * was the build, and the same argument the "already in progress" branch makes about not spending
   * a plan on a refused click applies with more force to a plan spent on a build that produced
   * nothing.
   *
   * REFUSED IF THIS WORKSPACE HAS MOVED ON. Somebody who described a different agent while the
   * failing build was running holds the slot now, and putting the old plan back over it would
   * resurrect a card they have visibly replaced. Answers whether it restored, so the caller only
   * tells the client about a plan that is genuinely takeable again.
   */
  restore(workspaceId: string, rec: PendingPlan): boolean {
    if (this.pending.has(workspaceId)) return false;
    this.pending.set(workspaceId, rec);
    return true;
  }

  /**
   * Throw a plan away, and say whose it was.
   *
   * `workspaceId` RIDES THE EVENT because the listener has to route it, and the only thing it had
   * to route by was the planner's current scope — which, when one workspace's new plan superseded
   * another's, belonged to the wrong tenant. A workspace whose plan died was told nothing, and one
   * that had never seen it was handed its id.
   */
  discard(workspaceId: string, planId: string): void {
    const rec = this.pending.get(workspaceId);
    if (!rec || rec.planId !== planId) return;
    this.pending.delete(workspaceId);
    this.emit("discarded", { planId, workspaceId });
  }

  async plan(opts: PlanOptions): Promise<void> {
    if (this.busy) {
      this.emit("error", { message: "a plan is already being written" });
      return;
    }
    this.busy = true;
    // The caller's claim has become the plan it was holding the slot for.
    this.claimed = false;

    try {
      const all = loadConnectors(opts.runtimeDir);
      const selected = resolveSelected(all, opts.connectors);
      const mcpTools = opts.mcpTools ?? [];

      // A revision reads the plan it is revising BEFORE the slot is cleared.
      const previous = opts.revisePlanId ? this.take(opts.workspaceId, opts.revisePlanId) : null;
      if (opts.revisePlanId && !previous) {
        this.emit("error", {
          message: "that plan is no longer available — describe the agent again",
        });
        return;
      }
      const revision = (previous?.revision ?? 0) + 1;

      // THIS WORKSPACE's other pending plan is superseded the moment a new one starts streaming:
      // the card it belongs to has already been replaced on screen, and leaving it takeable would
      // let a stale tab generate from a plan the user has visibly moved on from. Scoped to the
      // asker, because that argument is about one session — across tenants it superseded a card
      // nobody had replaced and refused a Generate nobody could explain.
      const mine = this.pending.get(opts.workspaceId);
      if (mine) this.discard(opts.workspaceId, mine.planId);

      // A revision keeps the ORIGINAL brief; feedback is a correction to part of the plan, not
      // a replacement for what the user asked for.
      const prompt = previous?.prompt ?? opts.prompt;
      const name = previous?.name ?? opts.name;

      this.emit("started", { prompt, input: opts.prompt, revision });

      let raw = "";
      let usage = emptyUsage();
      const fixture = process.env.JAROKU_PLAN_FIXTURE;

      if (fixture && existsSync(fixture)) {
        // Louder than the gen/edit fixture warnings, and it needs to be. Those replay canned
        // output into a canned result you can see is wrong. This one feeds stale plan text
        // into a REAL generation, so a forgotten env var silently corrupts genuine output.
        console.warn(
          `[plan] JAROKU_PLAN_FIXTURE is set — replaying ${fixture}; the prompt is ignored ` +
            `and the model is NOT being called. Anything you generate from this plan will be ` +
            `built against the FIXTURE's plan, not yours. Unset it for real planning.`,
        );
        raw = readFileSync(fixture, "utf8");
        await replayPlan(raw, (chunk) => this.emit("delta", { text: chunk }));
      } else {
        if (!process.env.ANTHROPIC_API_KEY) {
          throw new Error(
            "ANTHROPIC_API_KEY is not set (expected in runtime/.env) — planning needs the " +
              "same key generation does",
          );
        }
        raw = await this.streamPlan(
          all,
          {
            prompt,
            agentName: (name?.trim() || prompt.trim().split("\n")[0] || "agent").slice(0, 60),
            connectors: selected,
            mcpTools,
            previousPlan: previous?.plan.raw,
            feedback: previous ? opts.prompt : undefined,
          },
          (chunk) => this.emit("delta", { text: chunk }),
          (u) => (usage = u),
          opts.apiKey,
          opts.effort,
        );
        if (fixture) writeFileSync(fixture, raw, "utf8"); // record for future free runs
      }

      const plan = parsePlan(raw);
      const problem = planProblem(plan);
      if (problem) throw new Error(problem);

      const rec: PendingPlan = {
        planId: randomUUID(),
        workspaceId: opts.workspaceId,
        prompt,
        connectors: selected.map((c) => c.id),
        mcpTools: mcpTools.map((t) => `${t.server_id}/${t.name}`),
        name,
        plan,
        warnings: reconcileWithSelection(plan, selected, mcpTools),
        usage,
        revision,
        createdAt: Date.now(),
      };
      this.pending.set(opts.workspaceId, rec);
      this.emit("plan", { ...rec });
    } catch (err) {
      this.emit("error", { message: (err as Error).message });
    } finally {
      this.busy = false;
    }
  }

  private async streamPlan(
    allConnectors: Connector[],
    req: Parameters<typeof buildPlanUserPrompt>[0],
    onChunk: (text: string) => void,
    onUsage: (u: UsageSummary) => void,
    apiKey?: string,
    effort?: EffortPlan | null,
  ): Promise<string> {
    let raw = "";
    const stream = anthropicClient(apiKey).messages.stream({
      model: PLAN_MODEL,
      max_tokens: MAX_TOKENS,
      // SPREAD RATHER THAN SET, so a call with no plan is byte-identical to the one that shipped —
      // and the budget inside it was already validated against THIS call's `max_tokens` by the
      // adapter, not against whatever the model could theoretically produce.
      ...(effort?.thinking?.type === "enabled" ? { thinking: effort.thinking } : {}),
      system: [
        {
          type: "text",
          text: buildPlanSystemPrompt(allConnectors),
          // Byte-stable like the generation prefix, and inert for the same reason: at ~1.35k
          // tokens it is below haiku-4-5's 4096-token minimum cacheable prefix. Costs nothing
          // to declare and takes effect if the prompt grows or the model changes.
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: buildPlanUserPrompt(req) }],
    });

    stream.on("text", (delta: string) => {
      raw += delta;
      onChunk(delta);
    });

    const final = await stream.finalMessage();
    onUsage(summarizeUsage(final.usage));
    return raw;
  }
}

/** Replay a recorded plan, chunked and paced, so the UI behaves as it would live. */
export async function replayPlan(raw: string, onChunk: (text: string) => void): Promise<void> {
  const size = 16;
  for (let i = 0; i < raw.length; i += size) {
    onChunk(raw.slice(i, i + size));
    await new Promise((r) => setTimeout(r, 4));
  }
}
