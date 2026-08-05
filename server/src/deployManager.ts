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

/** The port serve.py binds, and the port the public domain is pointed at. */
const SERVE_PORT = 8080;

/** How long to keep asking Railway whether the build finished, and how often. */
const FOLLOW_POLL_MS = 5_000;
const FOLLOW_TIMEOUT_MS = Number(process.env["JAROKU_DEPLOY_FOLLOW_MS"] ?? 10 * 60_000);

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
export function planDeploy(deps: DeployManagerDeps, req: StartDeployRequest): DeployPlan {
  const problems: string[] = [];
  const warnings: string[] = [];

  if (!isSafeAgentId(req.agentId)) {
    return { agentId: req.agentId, secrets: [], problems: ["invalid agent id"], warnings, cliVersion: null };
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

  return { agentId: req.agentId, secrets, problems, warnings, cliVersion: cli.version };
}

export class DeployManager {
  private active: { deploymentId: string; upload: RailwayUpload | null; cancelled: boolean } | null = null;

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

    const plan = planDeploy(this.deps, req);
    if (plan.problems.length) return { error: plan.problems.join(" · ") };

    const token = this.deps.token();
    if (!token) return { error: "no Railway token" };

    // Only the names the user actually agreed to, intersected with what is really declared —
    // a client cannot widen the set by sending a name the agent never asked for.
    const declared = new Set(plan.secrets.map((s) => s.name));
    const envKeys = req.envKeys.filter((k) => declared.has(k));

    const deployment = this.deps.store.create({
      agentId: req.agentId,
      provider: req.provider,
      model: req.model,
      envKeys,
    });
    this.active = { deploymentId: deployment.id, upload: null, cancelled: false };
    this.deps.onChanged();

    try {
      await this.drive(deployment.id, req, token, envKeys, plan);
    } catch (err) {
      // Anything that escaped drive() is a bug, not a deploy outcome — but the row still has
      // to settle, or it claims to be in flight forever.
      this.fail(deployment.id, err instanceof Error ? err.message : String(err));
    } finally {
      this.active = null;
      const final = this.deps.store.get(deployment.id);
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
    const row = this.deps.store.get(deploymentId);
    const token = this.deps.token();
    if (row?.railway_deployment_id && token) {
      try {
        await new RailwayApi({ token }).cancelDeployment(row.railway_deployment_id);
      } catch {
        // A cancel that Railway would not accept is worth saying, not worth failing over:
        // the local record is already cancelled and the user is told to check the dashboard.
        this.log(deploymentId, "building", "jaroku",
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
    const scrub = makeScrubber([...secretValues.values(), ...Object.values(host), token]);

    try {
      // --- package ---
      this.stage(id, "packaging", "packaging");
      const artifacts = writeDeployArtifacts({
        runtimeDir: this.deps.runtimeDir,
        agentId: req.agentId,
        provider: req.provider,
      });
      this.log(id, "packaging", "jaroku",
        `wrote ${artifacts.paths.join(", ")} · image installs ${artifacts.requires.join(", ")}`);
      if (this.stopped(id)) return;

      // --- provision ---
      this.stage(id, "provisioning", "packaging");
      const api = new RailwayApi({ token, scrub });
      const project = await api.createProject(this.projectName(req.agentId));
      this.deps.store.patch(id, {
        railway_project_id: project.id,
        railway_environment_id: project.environmentId,
      });
      this.log(id, "provisioning", "jaroku", `created Railway project ${project.name}`);

      const service = await api.createService(project.id, req.agentId);
      this.deps.store.patch(id, { railway_service_id: service.id });
      this.deps.onChanged();
      if (this.stopped(id)) return;

      // --- variables ---
      this.stage(id, "variables", "packaging");
      const target = {
        projectId: project.id,
        environmentId: project.environmentId,
        serviceId: service.id,
      };
      await api.upsertVariables(target, { ...Object.fromEntries(secretValues), ...host });
      // NAMES, never values. The names are already in the row; this line just says it happened.
      this.log(id, "variables", "jaroku",
        `set ${[...secretValues.keys(), ...Object.keys(host)].sort().join(", ")} on Railway`);
      if (this.stopped(id)) return;

      // --- upload ---
      this.stage(id, "uploading", "uploading");
      const upload = new RailwayUpload();
      if (this.active) this.active.upload = upload;
      const result = await upload.run({
        token,
        projectId: project.id,
        serviceId: service.id,
        environmentId: project.environmentId,
        projectDir: join(this.deps.runtimeDir, "agents", req.agentId),
        onLine: (stream, line) =>
          this.log(id, "building", stream === "stderr" ? "build-err" : "build", scrub(line)),
      });
      if (this.active) this.active.upload = null;

      if (result.cancelled || this.active?.cancelled) {
        this.settle(id, "cancelled", null);
        return;
      }
      if (!result.ok) {
        this.fail(id, scrub(result.error ?? "the upload failed"));
        return;
      }

      // --- follow ---
      this.stage(id, "building", "building");
      const deployment = await this.follow(id, api, target, scrub);
      if (!deployment) return; // follow() has already settled the row

      // --- publish ---
      this.stage(id, "publishing", "deploying");
      const existing = await api.existingDomain(target.projectId, target.environmentId, target.serviceId);
      const url = existing ?? (await api.createDomain(target.serviceId, target.environmentId, SERVE_PORT));
      this.deps.store.patch(id, { url });
      this.log(id, "publishing", "jaroku", `live at ${url}`);
      if (serveToken) {
        // NOT through log(). A log line is persisted to deployment_logs, and this token gates
        // an endpoint that spends the user's provider key — putting it in the database would
        // undo the one thing the whole secrets design is for. It goes out once, on the
        // channel, to whoever is watching, and lives on only in Railway's variable store.
        this.deps.onServeToken({ deploymentId: id, url, token: serveToken });
        this.log(id, "publishing", "jaroku",
          "a bearer token was generated and set on Railway. It is shown once, above — Jaroku " +
          "does not keep a copy.");
      } else {
        this.log(id, "publishing", "jaroku",
          "this endpoint has NO token — anyone with the URL can run the agent on your key.");
      }
      this.settle(id, "live", null);
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
    let seenLogs = 0;

    while (Date.now() < deadline) {
      if (this.active?.cancelled) {
        this.settle(id, "cancelled", null);
        return null;
      }
      let deployments;
      try {
        deployments = await api.deployments(target.projectId, target.serviceId, target.environmentId, 1);
      } catch (err) {
        // A blip while watching is not a failed deploy. Say so and keep watching — the
        // deadline is what ends this, not one unlucky poll.
        const detail = err instanceof RailwayError ? err.message : String(err);
        this.log(id, "building", "jaroku", scrub(`could not read the build status: ${detail}`));
        await sleep(FOLLOW_POLL_MS);
        continue;
      }

      const deployment = deployments[0];
      if (!deployment) {
        await sleep(FOLLOW_POLL_MS);
        continue;
      }
      this.deps.store.patch(id, { railway_deployment_id: deployment.id });

      if (deployment.status !== lastStatus) {
        lastStatus = deployment.status;
        this.log(id, "building", "jaroku", `Railway: ${deployment.status.toLowerCase()}`);
        if (deployment.status.toUpperCase() === "DEPLOYING") this.stage(id, "building", "deploying");
      }

      // Build output the CLI did not already stream — a build that Railway retried, or one
      // whose tail arrived after the CLI exited.
      try {
        const logs = await api.buildLogs(deployment.id, 200);
        for (const line of logs.slice(seenLogs)) this.log(id, "building", "build", scrub(line.message));
        seenLogs = Math.max(seenLogs, logs.length);
      } catch {
        /* logs are a nicety; never fail a deploy because they could not be read */
      }

      if (isTerminalStatus(deployment.status)) {
        if (RAILWAY_TERMINAL_OK.has(deployment.status.toUpperCase())) return deployment;
        this.fail(id, `Railway reported the deployment as ${deployment.status.toLowerCase()}`);
        return null;
      }
      await sleep(FOLLOW_POLL_MS);
    }

    // Deliberately not "failed". Nothing here knows that it failed — only that we stopped
    // watching, and telling someone their deploy failed when it may be about to come up is
    // how they end up deploying a second copy.
    this.settle(
      id,
      "interrupted",
      "stopped waiting for the build. It may still finish — check your Railway dashboard.",
    );
    return null;
  }

  // --- helpers ---

  /** Railway project names are user-visible; keep them recognisable and unique enough. */
  private projectName(agentId: string): string {
    return `${agentId.replace(/_/g, "-")}-${Date.now().toString(36).slice(-4)}`;
  }

  /** Cancelled between steps? Settle the row and tell the caller to stop. */
  private stopped(id: string): boolean {
    if (!this.active?.cancelled) return false;
    this.settle(id, "cancelled", null);
    return true;
  }

  private stage(id: string, stage: DeployStage, status: DeployStatus): void {
    this.deps.store.patch(id, { status });
    this.deps.onStage({ deploymentId: id, stage, status });
  }

  private log(id: string, stage: string, stream: string, text: string): void {
    const seq = this.deps.store.appendLog(id, stage, stream, text);
    this.deps.onLog({ deploymentId: id, seq, stage, stream, text });
  }

  private settle(id: string, status: DeployStatus, error: string | null): void {
    this.deps.store.patch(id, { status, error });
    this.deps.onStage({ deploymentId: id, stage: "done", status });
    if (error) this.log(id, "done", "jaroku", error);
  }

  private fail(id: string, message: string): void {
    this.settle(id, "failed", message);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
