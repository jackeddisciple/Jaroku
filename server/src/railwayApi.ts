// Railway's public GraphQL API — the deploy control plane.
//
// A bare `fetch`, no SDK. Same choice providers.ts made for the OpenAI key check: this is a
// handful of POSTs to one URL, and a dependency for that would be a dependency to keep
// current for nothing.
//
// The division of labour with railwayCli.ts is deliberate and is a security decision, not a
// convenience one. Everything here goes over HTTPS with its payload in the request BODY —
// which is what lets `upsertVariables` carry credentials at all. The CLI is used for exactly
// one thing, uploading the source, because `railway variables --set NAME=value` would put
// every secret into an argv, and a process table is world-readable.
//
// Three properties every call holds:
//
//   * Bounded. A hosting API that stops answering must not turn into a deploy that hangs
//     forever with a spinner nobody can cancel — the same reason every MCP wait is bounded.
//   * Classified. "your token is wrong", "Railway is down" and "Railway said no" need three
//     different responses from the user, so they are three different failures here rather
//     than one string.
//   * Scrubbed. A GraphQL error can echo the input that caused it, and one of these calls has
//     credentials in its input. Every error message goes through the deploy's scrubber before
//     it is returned, so a value cannot reach a caller that stores or broadcasts it.

import { numberFromEnv } from "./env.ts";

const DEFAULT_ENDPOINT = "https://backboard.railway.com/graphql/v2";

/** Overridable so the fixture path and any future self-hosted Railway can be pointed at. */
export function railwayEndpoint(): string {
  return process.env["JAROKU_RAILWAY_API"] || DEFAULT_ENDPOINT;
}

/**
 * The env var the user's Railway token lives under. Written by the credential writer.
 *
 * RAILWAY_API_TOKEN rather than RAILWAY_TOKEN because the two mean different things to
 * Railway's own tooling: RAILWAY_TOKEN is a project-scoped token that can only deploy, and
 * RAILWAY_API_TOKEN is the account-scoped one that can also create a project — which is what
 * one-click deploy has to do. Storing an account token under the project-token name would
 * work here and then behave strangely the first time the user ran the CLI themselves.
 */
export const RAILWAY_ENV_KEY = "RAILWAY_API_TOKEN";

const REQUEST_TIMEOUT_MS = numberFromEnv("JAROKU_RAILWAY_TIMEOUT_MS", 20_000);

/**
 * The longest name Railway accepts for a project or a service.
 *
 * "Project names must be between 1 and 32 characters." An agent planned from a sentence gets a
 * forty-character slug — `margot_s_input_names_a_github_repository` — and every deploy of one was
 * refused at the first Railway call, so the name is cut to fit rather than taken whole.
 */
export const RAILWAY_NAME_MAX = 32;

/** A slug as Railway shows it: hyphens for underscores, cut at a word where it can be. */
function railwayLabel(slug: string, max: number): string {
  const label = slug.replace(/_/g, "-").replace(/[^a-zA-Z0-9-]/g, "-").replace(/-{2,}/g, "-");
  if (label.length <= max) return label.replace(/^-+|-+$/g, "") || "agent";
  const cut = label.slice(0, max);
  const atWord = cut.lastIndexOf("-");
  // AT A WORD when one ends past the halfway mark, so `margot-s-input-names-a-github` rather than
  // `margot-s-input-names-a-githu`. A slug that is one long word is simply cut.
  return (atWord >= max / 2 ? cut.slice(0, atWord) : cut).replace(/^-+|-+$/g, "") || "agent";
}

/** `<slug>-<suffix>`, never longer than Railway allows. The suffix is what keeps it unique. */
export function railwayProjectName(slug: string, suffix: string): string {
  return `${railwayLabel(slug, RAILWAY_NAME_MAX - suffix.length - 1)}-${suffix}`;
}

/** The service inside it: the slug, within the same limit. */
export function railwayServiceName(slug: string): string {
  return railwayLabel(slug, RAILWAY_NAME_MAX);
}

export type RailwayFailureKind =
  /** The token is missing, wrong, or lacks the scope. The user has to fix a credential. */
  | "auth"
  /** Reached Railway; it refused the operation. Its own message is the useful part. */
  | "api"
  /** Never reached Railway: DNS, refused, reset, timeout. Usually worth retrying. */
  | "unreachable";

/** The sentence that says whose limit it is. Also what keeps it from being added twice. */
export const RAILWAY_PLAN_NOTE =
  "That is your Railway account's plan, not Jaroku's — delete a project you no longer use in Railway, or upgrade the Railway plan.";

/**
 * Railway's own refusal, with whose limit it is said out loud.
 *
 * "Free plan resource provision limit exceeded. Please upgrade to provision more resources!" reached
 * a Pro workspace's Inbox as if Jaroku had said it — about a plan the person had just paid to leave.
 * It is Railway's, about the Railway account the token belongs to; on its free plan that is one
 * agent live at a time. Anything else Railway says is left as it is.
 */
export function attributeRailwayLimit(message: string): string {
  if (message.includes(RAILWAY_PLAN_NOTE)) return message;
  if (!/\b(free|hobby|trial|pro|team) plan\b|\bplan (limit|allows)|resource provision limit|limit exceeded/i.test(message)) return message;
  return `Railway refused: ${message.trim().replace(/[.!]*$/, ".")} ${RAILWAY_PLAN_NOTE}`;
}

export class RailwayError extends Error {
  constructor(
    readonly kind: RailwayFailureKind,
    message: string,
    readonly operation: string,
  ) {
    super(message);
    this.name = "RailwayError";
  }
}

export interface RailwayProject {
  id: string;
  name: string;
  /** The environment a service and its variables live in. Railway calls the default one "production". */
  environmentId: string;
}

/** A Railway workspace — where a project lives and whose plan it is billed to. */
export interface RailwayWorkspace {
  id: string;
  name: string;
  createdAt: string | null;
}

export interface RailwayDeployment {
  id: string;
  status: string;
  createdAt: string;
  /** Railway's own URL for the deployment, when it has one. */
  url: string | null;
  staticUrl: string | null;
}

export interface RailwayLogLine {
  timestamp: string;
  message: string;
  severity: string | null;
}

/**
 * Railway's deployment statuses, mapped to the three questions a deploy UI asks: is it still
 * going, did it work, did it fail. Anything unrecognised is treated as still going rather
 * than as success — a status we do not know is not a status we can call finished.
 */
export const RAILWAY_TERMINAL_OK = new Set(["SUCCESS"]);
export const RAILWAY_TERMINAL_BAD = new Set(["FAILED", "CRASHED", "REMOVED", "SKIPPED"]);

export function isTerminalStatus(status: string): boolean {
  const s = status.toUpperCase();
  return RAILWAY_TERMINAL_OK.has(s) || RAILWAY_TERMINAL_BAD.has(s);
}

export interface RailwayApiOptions {
  token: string;
  /**
   * Applied to every message this client produces. A GraphQL error can quote the input that
   * caused it, and `upsertVariables` sends credentials — so an unscrubbed error is a leak
   * path straight into last_error, the log table and the browser.
   */
  scrub?: (text: string) => string;
  endpoint?: string;
  timeoutMs?: number;
}

export class RailwayApi {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly scrub: (text: string) => string;

  constructor(private readonly opts: RailwayApiOptions) {
    this.endpoint = opts.endpoint ?? railwayEndpoint();
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.scrub = opts.scrub ?? ((t) => t);
  }

  /**
   * One GraphQL POST.
   *
   * `variables` may contain credentials. It is serialised straight into the body and is never
   * logged, never included in an error, and never returned — the only things that come back
   * out of this method are Railway's data and a scrubbed message.
   */
  private async call<T>(
    operation: string,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.opts.token}`,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Transport-level: DNS, refused, reset, or our own deadline. Never Railway's opinion.
      const detail = err instanceof Error ? err.message : String(err);
      throw new RailwayError("unreachable", this.scrub(`could not reach Railway: ${detail}`), operation);
    }

    if (response.status === 401 || response.status === 403) {
      // Deliberately not quoting the body: a 401's body is not information the user can act
      // on, and quoting a response to a request that carried a credential is a habit worth
      // not having.
      throw new RailwayError(
        "auth",
        "Railway rejected the token. Check it is a valid account token and has not been revoked.",
        operation,
      );
    }

    const text = await response.text();
    if (!response.ok) {
      throw new RailwayError(
        response.status >= 500 ? "unreachable" : "api",
        this.scrub(`Railway returned ${response.status}: ${truncate(text)}`),
        operation,
      );
    }

    let payload: { data?: T; errors?: { message?: string }[] };
    try {
      payload = JSON.parse(text) as typeof payload;
    } catch {
      throw new RailwayError("api", `Railway sent a response that is not JSON: ${truncate(text)}`, operation);
    }

    if (payload.errors?.length) {
      const message = payload.errors.map((e) => e.message ?? "unknown error").join("; ");
      // Railway reports an expired or under-scoped token as a GraphQL error rather than a
      // 401, so the classification has to look at the message too — otherwise "fix your
      // token" arrives as "Railway said no".
      const kind: RailwayFailureKind = /not authorized|unauthorized|authentication/i.test(message)
        ? "auth"
        : "api";
      throw new RailwayError(kind, attributeRailwayLimit(this.scrub(truncate(message))), operation);
    }
    if (!payload.data) {
      throw new RailwayError("api", "Railway answered with no data", operation);
    }
    return payload.data;
  }

  /**
   * Prove the token works, and write nothing.
   *
   * Deliberately verified with `projects` rather than an identity query: this is the exact
   * capability the deploy needs, so a token that passes here is a token that can do the job,
   * rather than one that merely exists.
   */
  async verify(): Promise<{ ok: true; projectCount: number }> {
    const data = await this.call<{ projects: { edges: unknown[] } }>(
      "verify",
      `query { projects(first: 1) { edges { node { id } } } }`,
    );
    return { ok: true, projectCount: data.projects?.edges?.length ?? 0 };
  }

  /**
   * The Railway workspaces this token's user belongs to, oldest first.
   *
   * EMPTY FOR A TOKEN THAT CANNOT ASK. `me` answers for an ACCOUNT token only; a workspace- or
   * project-scoped one is refused, and that refusal is not a reason to fail a deploy — such a
   * token already names its workspace, and `createProject` lets Railway infer it.
   */
  async workspaces(): Promise<RailwayWorkspace[]> {
    let data: { me?: { workspaces?: { id: string; name: string; createdAt?: string | null }[] } };
    try {
      data = await this.call("workspaces", `query { me { workspaces { id name createdAt } } }`);
    } catch (err) {
      if (err instanceof RailwayError && err.kind !== "unreachable") return [];
      throw err;
    }
    return (data.me?.workspaces ?? [])
      .filter((w) => typeof w?.id === "string" && w.id)
      .map((w) => ({ id: w.id, name: w.name ?? w.id, createdAt: w.createdAt ?? null }))
      .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  }

  /**
   * Create a project and return it with the id of the environment everything else needs.
   *
   * `workspaceId` IS REQUIRED BY RAILWAY NOW for an account token: without it every first deploy
   * was refused in under a second with "You must specify a workspaceId to create a project", so
   * nobody could get an agent live at all. Null leaves it out, for a scoped token that implies one.
   */
  async createProject(name: string, workspaceId: string | null = null): Promise<RailwayProject> {
    let created: { projectCreate: { id: string; name: string } };
    try {
      created = await this.call<{ projectCreate: { id: string; name: string } }>(
        "createProject",
        `mutation projectCreate($input: ProjectCreateInput!) {
           projectCreate(input: $input) { id name }
         }`,
        { input: workspaceId ? { name, workspaceId } : { name } },
      );
    } catch (err) {
      if (!workspaceId && err instanceof RailwayError && /workspaceId/i.test(err.message)) {
        throw new RailwayError(
          "auth",
          "Railway needs to know which workspace to create the project in, and this token cannot " +
            "list them. Use an account token from railway.com/account/tokens.",
          "createProject",
        );
      }
      throw err;
    }
    const project = created.projectCreate;
    // projectCreate does not return environments, so the default one is read back. Doing it
    // here rather than at each call site means nothing downstream can forget and end up
    // setting variables into an environment that does not exist.
    const environmentId = await this.defaultEnvironmentId(project.id);
    return { id: project.id, name: project.name, environmentId };
  }

  async defaultEnvironmentId(projectId: string): Promise<string> {
    const data = await this.call<{
      project: { environments: { edges: { node: { id: string; name: string } }[] } };
    }>(
      "defaultEnvironmentId",
      `query project($id: String!) {
         project(id: $id) { environments { edges { node { id name } } } }
       }`,
      { id: projectId },
    );
    const nodes = data.project?.environments?.edges?.map((e) => e.node) ?? [];
    const chosen = nodes.find((n) => n.name === "production") ?? nodes[0];
    if (!chosen) {
      throw new RailwayError("api", "the new project has no environment to deploy into", "defaultEnvironmentId");
    }
    return chosen.id;
  }

  /**
   * An empty service — no repo, no image. The source arrives with the upload, which is what
   * makes a local-first deploy possible without the project being on GitHub first.
   */
  async createService(projectId: string, name: string): Promise<{ id: string; name: string }> {
    const data = await this.call<{ serviceCreate: { id: string; name: string } }>(
      "createService",
      `mutation serviceCreate($input: ServiceCreateInput!) {
         serviceCreate(input: $input) { id name }
       }`,
      { input: { projectId, name } },
    );
    return data.serviceCreate;
  }

  /**
   * Set the deployed instance's environment. 🔴 This is the call that carries credentials.
   *
   * `values` goes into the request body and nowhere else. `replace: false` because Railway
   * sets variables of its own (PORT, RAILWAY_*) that a service needs — replacing the
   * collection would delete them. `skipDeploys: true` because the source has not been
   * uploaded yet: letting this trigger a build would build an empty service and report a
   * failure that has nothing to do with the agent.
   */
  async upsertVariables(
    target: { projectId: string; environmentId: string; serviceId: string },
    values: Map<string, string> | Record<string, string>,
  ): Promise<void> {
    const variables = values instanceof Map ? Object.fromEntries(values) : values;
    await this.call(
      "upsertVariables",
      `mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
         variableCollectionUpsert(input: $input)
       }`,
      {
        input: {
          projectId: target.projectId,
          environmentId: target.environmentId,
          serviceId: target.serviceId,
          variables,
          replace: false,
          skipDeploys: true,
        },
      },
    );
  }

  /** Deployments for a service, newest first. How the build is followed. */
  async deployments(
    projectId: string,
    serviceId: string,
    environmentId: string,
    first = 5,
  ): Promise<RailwayDeployment[]> {
    const data = await this.call<{
      deployments: { edges: { node: RailwayDeployment }[] };
    }>(
      "deployments",
      `query deployments($input: DeploymentListInput!, $first: Int) {
         deployments(input: $input, first: $first) {
           edges { node { id status createdAt url staticUrl } }
         }
       }`,
      { input: { projectId, serviceId, environmentId }, first },
    );
    return data.deployments?.edges?.map((e) => e.node) ?? [];
  }

  async buildLogs(deploymentId: string, limit = 500): Promise<RailwayLogLine[]> {
    const data = await this.call<{ buildLogs: RailwayLogLine[] }>(
      "buildLogs",
      `query buildLogs($deploymentId: String!, $limit: Int) {
         buildLogs(deploymentId: $deploymentId, limit: $limit) { timestamp message severity }
       }`,
      { deploymentId, limit },
    );
    return data.buildLogs ?? [];
  }

  async deploymentLogs(deploymentId: string, limit = 200): Promise<RailwayLogLine[]> {
    const data = await this.call<{ deploymentLogs: RailwayLogLine[] }>(
      "deploymentLogs",
      `query deploymentLogs($deploymentId: String!, $limit: Int) {
         deploymentLogs(deploymentId: $deploymentId, limit: $limit) { timestamp message severity }
       }`,
      { deploymentId, limit },
    );
    return data.deploymentLogs ?? [];
  }

  /**
   * Stop a service for good.
   *
   * DESTRUCTIVE AND IRREVERSIBLE FROM THE USER'S POINT OF VIEW, which is why it is spelled out
   * here rather than folded into something more general. The service, its variables and its
   * public domain go; the deployment ROW stays, because the record of what was deployed and what
   * it cost outlives the thing that was running.
   *
   * `serviceDelete` rather than pausing or scaling to zero: Railway's own dashboard offers
   * exactly this, and a "stopped" service that still exists is a service still costing money in
   * an account Jaroku does not own. A user who asked to stop paying for something should stop
   * paying for it.
   */
  async deleteService(serviceId: string): Promise<void> {
    await this.call(
      "deleteService",
      `mutation serviceDelete($id: String!) { serviceDelete(id: $id) }`,
      { id: serviceId },
    );
  }

  /** The services a project still holds. What decides whether an emptied project may go. */
  async projectServices(projectId: string): Promise<{ id: string; name: string }[]> {
    const data = await this.call<{ project: { services?: { edges?: { node: { id: string; name: string } }[] } } }>(
      "projectServices",
      `query project($id: String!) { project(id: $id) { services { edges { node { id name } } } } }`,
      { id: projectId },
    );
    return data.project?.services?.edges?.map((e) => e.node).filter((n) => n?.id) ?? [];
  }

  /**
   * Delete a whole project. Only ever called on one Jaroku made, once nothing else is in it.
   *
   * A project emptied by Kill, or left half-made by a deploy that failed between creating it and
   * creating its service, is still a project in somebody's account — and on Railway's free plan
   * it is one of a handful they are allowed. Leaving them is how a free allowance gets used up by
   * things nobody can see from Jaroku.
   */
  async deleteProject(projectId: string): Promise<void> {
    await this.call(
      "deleteProject",
      `mutation projectDelete($id: String!) { projectDelete(id: $id) }`,
      { id: projectId },
    );
  }

  /**
   * The public URL. `targetPort` is passed explicitly rather than left to Railway's port
   * detection: serve.py binds $PORT with a documented default of 8080, so guessing would be
   * a way to produce a domain that routes nowhere.
   */
  async createDomain(
    serviceId: string,
    environmentId: string,
    targetPort: number,
  ): Promise<string> {
    const data = await this.call<{ serviceDomainCreate: { id: string; domain: string } }>(
      "createDomain",
      `mutation serviceDomainCreate($input: ServiceDomainCreateInput!) {
         serviceDomainCreate(input: $input) { id domain }
       }`,
      { input: { serviceId, environmentId, targetPort } },
    );
    const domain = data.serviceDomainCreate?.domain;
    if (!domain) throw new RailwayError("api", "Railway created no domain", "createDomain");
    return domain.startsWith("http") ? domain : `https://${domain}`;
  }

  /** Any domain the service already has, so a redeploy does not mint a second one. */
  async existingDomain(
    projectId: string,
    environmentId: string,
    serviceId: string,
  ): Promise<string | null> {
    const data = await this.call<{
      domains: { serviceDomains: { domain: string }[] };
    }>(
      "existingDomain",
      `query domains($projectId: String!, $environmentId: String!, $serviceId: String!) {
         domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
           serviceDomains { id domain }
         }
       }`,
      { projectId, environmentId, serviceId },
    );
    const domain = data.domains?.serviceDomains?.[0]?.domain;
    return domain ? (domain.startsWith("http") ? domain : `https://${domain}`) : null;
  }

  /** Stop a build that is already Railway's. Cancelling before upload is the CLI's job. */
  async cancelDeployment(deploymentId: string): Promise<void> {
    await this.call(
      "cancelDeployment",
      `mutation deploymentCancel($id: String!) { deploymentCancel(id: $id) }`,
      { id: deploymentId },
    );
  }
}

/** Bounded, because an error message is rendered in a UI and written to a database. */
function truncate(text: string, max = 500): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Delete a project once nothing but `goneServiceId` is left in it. Never throws.
 *
 * Kill uses it on the project a deleted service leaves behind; the deploy uses it to roll back a
 * project it created and could not finish setting up.
 */
export async function removeEmptyProject(
  api: RailwayApi,
  projectId: string,
  goneServiceId: string | null,
): Promise<"removed" | "kept" | "failed"> {
  try {
    const left = (await api.projectServices(projectId)).filter((s) => s.id !== goneServiceId);
    if (left.length > 0) return "kept";
    await api.deleteProject(projectId);
    return "removed";
  } catch {
    return "failed";
  }
}
