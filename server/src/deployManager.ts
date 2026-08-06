// Driving a deploy from a local project directory to a live URL.
//
// The orchestrator. It owns the ORDER of operations, which is where most of the thinking is:
//
//   1. refuse            everything that can be known before touching the user's account
//   2. record            a row, before the first Railway call
//   3. package           artifacts into the project, staged and atomic-swapped
//   4. project + service created in the user's own Railway account
//   5. variables         the credentials, over HTTPS, in a request body
//   6. upload            the source, over the CLI, token in env
//   7. follow            the deployment until it settles
//   8. domain            a public URL, once there is something behind it
//
// Steps 1 and 2 are the ones worth defending. Every refusal that can happen before step 4
// happens before step 4, because the cost of getting this wrong is not an error message — it
// is a half-made project sitting in somebody's Railway account that Jaroku will never mention
// again. And the row is written before step 4 rather than after step 8, so that if the
// process dies at any point there is still a record saying what was attempted and where.
//
// Events go out through a deps-callback object rather than an import of the relay, the way
// EvalRunnerDeps does, so this file has no idea a WebSocket exists.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Deployment, DeployStatus, DeployStore } from "./deployStore.ts";
import { readAgentMeta, writeDeployArtifacts } from "./deployArtifacts.ts";
import {
  hostEnv, makeScrubber, requiredSecrets, resolveSecretValues,
  type DeploySecretStatus,
} from "./deploySecrets.ts";
import { isSafeAgentId } from "./projectFs.ts";
import { RailwayApi, RailwayError, RAILWAY_ENV_KEY, isTerminalStatus, RAILWAY_TERMINAL_OK } from "./railwayApi.ts";
import { checkRailwayCli, RailwayUpload } from "./railwayCli.ts";
import { numberFromEnv } from "./env.ts";

/** The port serve.py binds, and the port the public domain is pointed at. */
const SERVE_PORT = 8080;

/** How long to keep asking Railway whether the build finished, and how often. */
const FOLLOW_POLL_MS = 5_000;
/**
 * How many build-log lines to ask for per poll, and how many to remember having shown.
 *
 * The page is generous because it is a window onto the END of the log: anything that scrolls
 * past between two polls is gone, and a noisy dependency install can produce hundreds of lines
 * in five seconds.
 */
const BUILD_LOG_PAGE = 1000;
const BUILD_LOG_MEMORY = 5000;
const FOLLOW_TIMEOUT_MS = numberFromEnv("JAROKU_DEPLOY_FOLLOW_MS", 10 * 60_000);

export type DeployStage =
  | "checking" | "packaging" | "provisioning" | "variables"
  | "uploading" | "building" | "publishing" | "done";

export interface DeployManagerDeps {
  runtimeDir: string;
  store: DeployStore;
  /** The agent's Railway token, read at the moment of use. Never held by this class. */
  token: () => string | undefined;
  /** True while a run or an eval job is reading this agent's files. Blocks packaging. */
  agentBusy: (agentId: string) => boolean;
  onStage: (e: { deploymentId: string; stage: DeployStage; status: DeployStatus }) => void;
  onLog: (e: { deploymentId: string; seq: number; stage: string; stream: string; text: string }) => void;
  onFinished: (deployment: Deployment) => void;
  /**
   * The bearer token for a newly live endpoint. Fired ONCE, and deliberately not routed
   * through onLog: a log line is persisted, and this token gates an endpoint that spends the
   * user's provider key. It exists here, in the request that set it on Railway, and nowhere
   * else — the caller shows it and Jaroku keeps no copy.
   */
  onServeToken: (e: { deploymentId: string; url: string; token: string }) => void;
  /** A full snapshot went stale — the caller re-broadcasts. */
  onChanged: () => void;
}

export interface StartDeployRequest {
  agentId: string;
  provider: string;
  model: string;
  /** Which declared variables the user agreed to hand over. Names only. */
  envKeys: string[];
  /** Explicitly proceed with a declared variable this machine has no value for. */
  allowMissing?: boolean;
  /** Serve the endpoint with no bearer token. Off by default; the UI has to ask for it. */
  publicEndpoint?: boolean;
}

export interface DeployPlan {
  agentId: string;
  secrets: DeploySecretStatus[];
  /**
   * Whether this would go back into a Railway service the agent already has.
   *
   * Worth saying before the button is pressed: "this replaces what is live" and "this creates
   * a second one" are different decisions, and the user is the only one who knows which they
   * meant.
   */
  redeploy: boolean;
  /** Blocking problems. A non-empty list means Deploy is refused, with these reasons. */
  problems: string[];
  /** Non-blocking. Worth saying, not worth stopping for. */
  warnings: string[];
  cliVersion: string | null;
}

/**
 * Everything knowable before the user commits: which variables are needed, what is missing,
 * and whether this can work at all.
 *
 * Answered from local state only — no Railway call, nothing created, nothing spent. This is
 * what the deploy form renders, and it is the same function the start path re-checks against,
 * so the UI cannot show a green light for something the server will refuse.
 */
export async function planDeploy(
  deps: DeployManagerDeps,
  req: StartDeployRequest,
): Promise<DeployPlan> {
  const problems: string[] = [];
  const warnings: string[] = [];

  if (!isSafeAgentId(req.agentId)) {
    return {
      agentId: req.agentId, secrets: [], problems: ["invalid agent id"], warnings,
      redeploy: false, cliVersion: null,
    };
  }
  const projectDir = join(deps.runtimeDir, "agents", req.agentId);
  if (!existsSync(join(projectDir, "agent.py"))) {
    problems.push(`${req.agentId} has no agent.py — there is nothing to serve`);
  }

  // The dry-run provider answers with placeholder text. Deploying it would put a URL on the
  // internet that looks like a working agent and is not — so it is refused here rather than
  // three minutes later by serve.py, inside a container the user is paying for.
  if (req.provider !== "anthropic" && req.provider !== "openai") {
    problems.push(
      `${req.provider} cannot be deployed. Pick anthropic or openai — the dry-run provider ` +
      `answers with placeholder text, so a deployed one would be a URL that looks like it works.`,
    );
  }

  const meta = readAgentMeta(deps.runtimeDir, req.agentId);
  const secrets = requiredSecrets({
    requiredEnv: meta.required_env ?? [],
    mcpServers: meta.mcp_servers ?? [],
    provider: req.provider,
  });

  const missing = secrets.filter((s) => s.required && !s.configured).map((s) => s.name);
  if (missing.length) {
    // Rule 7 makes an unconfigured connector RAISE on every call, so a container missing one
    // is a deploy that goes green and is dead. Overridable, because the user may intend to set
    // it in Railway by hand — but not the default.
    const message =
      `not set on this machine: ${missing.join(", ")}. The agent's tools raise without them, ` +
      `so it would deploy successfully and then fail every request.`;
    if (req.allowMissing) warnings.push(message);
    else problems.push(message);
  }

  if (!deps.token()) {
    problems.push(
      `no Railway token. Add one in the deploy panel — it is stored in runtime/.env as ` +
      `${RAILWAY_ENV_KEY} and never leaves this machine except as an Authorization header.`,
    );
  }

  if (deps.agentBusy(req.agentId)) {
    problems.push("cannot deploy while this agent is running — the deploy has to write into its files");
  }

  // Last, because it shells out: no point probing the CLI for a deploy already refused.
  const cli = problems.length ? { present: true, version: null, message: null } : checkRailwayCli();
  if (!cli.present && cli.message) problems.push(cli.message);

  if (req.publicEndpoint) {
    warnings.push(
      "this endpoint will have no token: anyone who finds the URL can run the agent on your " +
      "provider key.",
    );
  }
  if (meta.mcp_servers?.length) {
    warnings.push(
      `high-impact MCP tools cannot ask for confirmation out there, so the deployed agent is ` +
      `set to refuse them. Its read-only tools still work.`,
    );
  }

  return {
    agentId: req.agentId,
    secrets,
    problems,
    warnings,
    redeploy: (await deps.store.reusableTarget(req.agentId)) !== null,
    cliVersion: cli.version,
  };
}

export class DeployManager {
  private active: { deploymentId: string; upload: RailwayUpload | null; cancelled: boolean } | null = null;
  /** Build-log lines already shown for the deploy in flight. See seenBuildLine. */
  private seenBuild = new Set<string>();
  /**
   * Build-log text the CLI already streamed.
   *
   * Kept separately because the CLI's lines carry no timestamp, and `buildLogs` returns the
   * SAME build output the CLI was streaming — so without this the whole log appears twice,
   * once live and once again on the first poll after the upload.
   */
  private streamedByCli = new Set<string>();

  constructor(private deps: DeployManagerDeps) {}

  get busy(): boolean {
    return this.active !== null;
  }

  get activeId(): string | null {
    return this.active?.deploymentId ?? null;
  }

  /**
   * Start a deploy. Resolves when it has settled, one way or another.
   *
   * Returns `{ error }` for a refusal — nothing was created, nothing was recorded. Once a
   * deployment id comes back, there is a row, and every outcome after that point is a status
   * on that row rather than a thrown error.
   */
  async start(req: StartDeployRequest): Promise<{ deploymentId: string } | { error: string }> {
    if (this.active) return { error: "a deploy is already running" };

    const plan = await planDeploy(this.deps, req);
    if (plan.problems.length) return { error: plan.problems.join(" · ") };

    const token = this.deps.token();
    if (!token) return { error: "no Railway token" };

    // Only the names the user actually agreed to, intersected with what is really declared —
    // a client cannot widen the set by sending a name the agent never asked for.
    const declared = new Set(plan.secrets.map((s) => s.name));
    const envKeys = req.envKeys.filter((k) => declared.has(k));

    // Nor narrow it silently. planDeploy refuses over a credential this machine cannot supply,
    // and a credential the user unticked leaves the container in exactly the same state — the
    // template raises on every call and the deploy is green and dead. The two cases deserve
    // the same answer and the same override, so they get it here rather than only in the form.
    const withheld = plan.secrets
      .filter((s) => s.required && s.configured && !envKeys.includes(s.name))
      .map((s) => s.name);
    if (withheld.length && !req.allowMissing) {
      return {
        error:
          `not sending: ${withheld.join(", ")}. The agent's tools raise without them, so it ` +
          `would deploy successfully and then fail every request.`,
      };
    }

    const deployment = await this.deps.store.create({
      agentId: req.agentId,
      provider: req.provider,
      model: req.model,
      envKeys,
    });
    this.active = { deploymentId: deployment.id, upload: null, cancelled: false };
    this.seenBuild.clear();
    this.streamedByCli.clear();
    this.deps.onChanged();

    try {
      await this.drive(deployment.id, req, token, envKeys, plan);
    } catch (err) {
      // Anything that escaped drive() is a bug, not a deploy outcome — but the row still has
      // to settle, or it claims to be in flight forever.
      await this.fail(deployment.id, err instanceof Error ? err.message : String(err));
    } finally {
      this.active = null;
      const final = await this.deps.store.get(deployment.id);
      if (final) this.deps.onFinished(final);
      this.deps.onChanged();
    }
    return { deploymentId: deployment.id };
  }

  /** Stop the deploy in flight. Idempotent, and safe to call when there is nothing running. */
  async cancel(deploymentId: string): Promise<void> {
    const active = this.active;
    if (!active || active.deploymentId !== deploymentId) return;
    active.cancelled = true;
    active.upload?.stop();

    // Past the upload, the build belongs to Railway and only Railway can stop it.
    const row = await this.deps.store.get(deploymentId);
    const token = this.deps.token();
    if (row?.railway_deployment_id && token) {
      try {
        await new RailwayApi({ token }).cancelDeployment(row.railway_deployment_id);
      } catch {
        // A cancel that Railway would not accept is worth saying, not worth failing over:
        // the local record is already cancelled and the user is told to check the dashboard.
        await this.log(deploymentId, "building", "jaroku",
          "could not cancel the build on Railway — check your dashboard.");
      }
    }
  }

  // --- the pipeline ---

  private async drive(
    id: string,
    req: StartDeployRequest,
    token: string,
    envKeys: string[],
    plan: DeployPlan,
  ): Promise<void> {
    for (const warning of plan.warnings) this.log(id, "checking", "jaroku", warning);

    // 🔴 The one read of credential values in the deploy path. Held from here to the finally
    // below, for two purposes and no others: the variables mutation, and the scrubber.
    const secretValues = resolveSecretValues(envKeys);
    const serveToken = req.publicEndpoint ? null : randomBytes(24).toString("base64url");
    const host = hostEnv({ provider: req.provider, model: req.model, serveToken });
    // Credentials only. Scrubbing every host value used to redact the provider name and the
    // model id out of the build log, so an ordinary install line arrived as
    // `langchain-••••••••>=0.3.0` — a log the user cannot read, hiding nothing.
    const scrub = makeScrubber([...secretValues.values(), ...host.secret, token]);

    try {
      // --- package ---
      await this.stage(id, "packaging", "packaging");
      const artifacts = writeDeployArtifacts({
        runtimeDir: this.deps.runtimeDir,
        agentId: req.agentId,
        provider: req.provider,
      });
      await this.log(id, "packaging", "jaroku",
        `wrote ${artifacts.paths.join(", ")} · image installs ${artifacts.requires.join(", ")}`);
      if (await this.stopped(id)) return;

      // --- provision ---
      await this.stage(id, "provisioning", "packaging");
      const api = new RailwayApi({ token, scrub });
      const target = await this.resolveTarget(id, api, req.agentId);
      await this.deps.store.patch(id, {
        railway_project_id: target.projectId,
        railway_environment_id: target.environmentId,
        railway_service_id: target.serviceId,
      });
      this.deps.onChanged();
      if (await this.stopped(id)) return;

      // --- variables ---
      await this.stage(id, "variables", "packaging");
      await api.upsertVariables(target, { ...Object.fromEntries(secretValues), ...host.env });
      // NAMES, never values. The names are already in the row; this line just says it happened.
      await this.log(id, "variables", "jaroku",
        `set ${[...secretValues.keys(), ...Object.keys(host.env)].sort().join(", ")} on Railway`);
      if (await this.stopped(id)) return;

      // --- upload ---
      await this.stage(id, "uploading", "uploading");
      const upload = new RailwayUpload();
      if (this.active) this.active.upload = upload;
      const result = await upload.run({
        token,
        projectId: target.projectId,
        serviceId: target.serviceId,
        environmentId: target.environmentId,
        projectDir: join(this.deps.runtimeDir, "agents", req.agentId),
        onLine: (stream, line) => {
          // Remembered so the buildLogs poll below does not show the same output a second
          // time — it is the same build's log, read a different way.
          if (this.streamedByCli.size < BUILD_LOG_MEMORY) this.streamedByCli.add(line);
          void this.log(id, "building", stream === "stderr" ? "build-err" : "build", scrub(line));
        },
      });
      if (this.active) this.active.upload = null;

      if (result.cancelled || this.active?.cancelled) {
        await this.settle(id, "cancelled", null);
        return;
      }
      if (!result.ok) {
        await this.fail(id, scrub(result.error ?? "the upload failed"));
        return;
      }

      // --- follow ---
      await this.stage(id, "building", "building");
      const deployment = await this.follow(id, api, target, scrub);
      if (!deployment) return; // follow() has already settled the row

      // --- publish ---
      await this.stage(id, "publishing", "deploying");
      const existing = await api.existingDomain(target.projectId, target.environmentId, target.serviceId);
      const url = existing ?? (await api.createDomain(target.serviceId, target.environmentId, SERVE_PORT));
      await this.deps.store.patch(id, { url });
      // Exactly one row may claim to be live on a service. Two would be two different URLs
      // both described as the current one.
      const replaced = await this.deps.store.supersede(id, target.serviceId);
      if (replaced) {
        await this.log(id, "publishing", "jaroku",
          `replaced ${replaced} earlier deployment(s) on this service`);
      }
      await this.log(id, "publishing", "jaroku", `live at ${url}`);
      if (serveToken) {
        // NOT through log(). A log line is persisted to deployment_logs, and this token gates
        // an endpoint that spends the user's provider key — putting it in the database would
        // undo the one thing the whole secrets design is for. It goes out once, on the
        // channel, to whoever is watching, and lives on only in Railway's variable store.
        this.deps.onServeToken({ deploymentId: id, url, token: serveToken });
        await this.log(id, "publishing", "jaroku",
          "a bearer token was generated and set on Railway. It is shown once, above — Jaroku " +
          "does not keep a copy.");
      } else {
        await this.log(id, "publishing", "jaroku",
          "this endpoint has NO token — anyone with the URL can run the agent on your key.");
      }
      await this.settle(id, "live", null);
    } finally {
      // The whole reason the values were held. Cleared on every path out, including a throw.
      secretValues.clear();
    }
  }

  /**
   * Watch Railway's deployment until it settles. Returns the deployment, or null when the
   * row has already been settled here (failure, cancellation, or running out of patience).
   */
  private async follow(
    id: string,
    api: RailwayApi,
    target: { projectId: string; environmentId: string; serviceId: string },
    scrub: (t: string) => string,
  ): Promise<{ id: string; status: string } | null> {
    const deadline = Date.now() + FOLLOW_TIMEOUT_MS;
    let lastStatus = "";

    while (Date.now() < deadline) {
      if (this.active?.cancelled) {
        await this.settle(id, "cancelled", null);
        return null;
      }
      let deployments;
      try {
        deployments = await api.deployments(target.projectId, target.serviceId, target.environmentId, 1);
      } catch (err) {
        // A blip while watching is not a failed deploy. Say so and keep watching — the
        // deadline is what ends this, not one unlucky poll.
        const detail = err instanceof RailwayError ? err.message : String(err);
        await this.log(id, "building", "jaroku", scrub(`could not read the build status: ${detail}`));
        await sleep(FOLLOW_POLL_MS);
        continue;
      }

      const deployment = deployments[0];
      if (!deployment) {
        await sleep(FOLLOW_POLL_MS);
        continue;
      }
      await this.deps.store.patch(id, { railway_deployment_id: deployment.id });

      if (deployment.status !== lastStatus) {
        lastStatus = deployment.status;
        await this.log(id, "building", "jaroku", `Railway: ${deployment.status.toLowerCase()}`);
        if (deployment.status.toUpperCase() === "DEPLOYING") this.stage(id, "building", "deploying");
      }

      // Build output the CLI did not already stream — a build Railway retried, or a tail that
      // arrived after the CLI exited. Deduplicated rather than counted: see emitBuildLogs.
      try {
        for (const line of await api.buildLogs(deployment.id, BUILD_LOG_PAGE)) {
          if (this.seenBuildLine(line.timestamp, line.message)) continue;
          await this.log(id, "building", "build", scrub(line.message));
        }
      } catch {
        /* logs are a nicety; never fail a deploy because they could not be read */
      }

      if (isTerminalStatus(deployment.status)) {
        if (RAILWAY_TERMINAL_OK.has(deployment.status.toUpperCase())) return deployment;
        await this.fail(id, `Railway reported the deployment as ${deployment.status.toLowerCase()}`);
        return null;
      }
      await sleep(FOLLOW_POLL_MS);
    }

    // Deliberately not "failed". Nothing here knows that it failed — only that we stopped
    // watching, and telling someone their deploy failed when it may be about to come up is
    // how they end up deploying a second copy.
    await this.settle(
      id,
      "interrupted",
      "stopped waiting for the build. It may still finish — check your Railway dashboard.",
    );
    return null;
  }

  // --- helpers ---

  /**
   * Where this deploy goes: back into the agent's existing Railway service, or a new one.
   *
   * Reuse is the default and it matters. Creating a fresh project on every deploy left the
   * previous service running and billing, holding a URL the user had already been given and
   * that Jaroku still listed as live — two services, two bills, and nothing saying which URL
   * was current. A redeploy is the ordinary case, not an edge one.
   *
   * The remembered ids are checked before they are trusted, because Railway is not ours: a
   * user can delete a project in their dashboard, and a deploy that then wrote variables into
   * a service that no longer exists would fail somewhere much less legible. If the check
   * fails for any reason, this makes a new project and says so — falling back to working is
   * better than refusing over a stale id we only cached as a convenience.
   */
  private async resolveTarget(
    id: string,
    api: RailwayApi,
    agentId: string,
  ): Promise<{ projectId: string; environmentId: string; serviceId: string }> {
    const remembered = await this.deps.store.reusableTarget(agentId);
    if (remembered) {
      try {
        await api.deployments(remembered.projectId, remembered.serviceId, remembered.environmentId, 1);
        await this.log(id, "provisioning", "jaroku",
          "redeploying into the Railway service this agent already has — no second project");
        return remembered;
      } catch (err) {
        const detail = err instanceof RailwayError ? err.message : String(err);
        await this.log(id, "provisioning", "jaroku",
          `the Railway service this agent used is gone (${detail}); creating a new one`);
      }
    }

    const project = await api.createProject(this.projectName(agentId));
    await this.log(id, "provisioning", "jaroku", `created Railway project ${project.name}`);
    const service = await api.createService(project.id, agentId);
    return {
      projectId: project.id,
      environmentId: project.environmentId,
      serviceId: service.id,
    };
  }

  /** Railway project names are user-visible; keep them recognisable and unique enough. */
  private projectName(agentId: string): string {
    return `${agentId.replace(/_/g, "-")}-${Date.now().toString(36).slice(-4)}`;
  }

  /**
   * Has this build-log line already been shown?
   *
   * Two different bugs made a counter wrong here, and both are why this is a set.
   *
   * `buildLogs` returns the most recent N lines, so it is a sliding window, not a growing
   * list. Treating its length as a cursor meant that once a build produced more lines than
   * one page, the length stopped changing, `slice(cursor)` returned nothing, and the build
   * log simply stopped updating — a user watching a long build saw it freeze partway and had
   * no way to tell that from a stalled build.
   *
   * And the CLI has already streamed most of these lines itself, so anything not deduplicated
   * against what was shown is shown twice.
   *
   * Keyed on timestamp AND text, so two identical lines a build genuinely emitted at
   * different moments both survive. Bounded, because this is a log and not an archive.
   */
  private seenBuildLine(timestamp: string, message: string): boolean {
    if (this.streamedByCli.has(message)) return true;
    const key = `${timestamp}\u0000${message}`;
    if (this.seenBuild.has(key)) return true;
    if (this.seenBuild.size >= BUILD_LOG_MEMORY) {
      // Oldest first — a Set iterates in insertion order, and the oldest line is the one
      // least likely to come round again in a window onto the end of the log.
      const oldest = this.seenBuild.values().next();
      if (!oldest.done) this.seenBuild.delete(oldest.value);
    }
    this.seenBuild.add(key);
    return false;
  }

  /** Cancelled between steps? Settle the row and tell the caller to stop. */
  private async stopped(id: string): Promise<boolean> {
    if (!this.active?.cancelled) return false;
    await this.settle(id, "cancelled", null);
    return true;
  }

  private async stage(id: string, stage: DeployStage, status: DeployStatus): Promise<void> {
    await this.deps.store.patch(id, { status });
    this.deps.onStage({ deploymentId: id, stage, status });
  }

  private async log(id: string, stage: string, stream: string, text: string): Promise<void> {
    const seq = await this.deps.store.appendLog(id, stage, stream, text);
    this.deps.onLog({ deploymentId: id, seq, stage, stream, text });
  }

  private async settle(id: string, status: DeployStatus, error: string | null): Promise<void> {
    await this.deps.store.patch(id, { status, error });
    this.deps.onStage({ deploymentId: id, stage: "done", status });
    if (error) await this.log(id, "done", "jaroku", error);
  }

  private async fail(id: string, message: string): Promise<void> {
    await this.settle(id, "failed", message);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
