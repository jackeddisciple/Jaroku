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

const DEFAULT_ENDPOINT = "https://backboard.railway.com/graphql/v2";

/** Overridable so the fixture path and any future self-hosted Railway can be pointed at. */
export function railwayEndpoint(): string {
  return process.env["JAROKU_RAILWAY_API"] || DEFAULT_ENDPOINT;
}

/** The env var the user's Railway token lives under. Written by the credential writer. */
export const RAILWAY_ENV_KEY = "RAILWAY_TOKEN";

const REQUEST_TIMEOUT_MS = Number(process.env["JAROKU_RAILWAY_TIMEOUT_MS"] ?? 20_000);

export type RailwayFailureKind =
  /** The token is missing, wrong, or lacks the scope. The user has to fix a credential. */
  | "auth"
  /** Reached Railway; it refused the operation. Its own message is the useful part. */
  | "api"
  /** Never reached Railway: DNS, refused, reset, timeout. Usually worth retrying. */
  | "unreachable";

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
      throw new RailwayError(kind, this.scrub(truncate(message)), operation);
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

  /** Create a project and return it with the id of the environment everything else needs. */
  async createProject(name: string): Promise<RailwayProject> {
    const created = await this.call<{ projectCreate: { id: string; name: string } }>(
      "createProject",
      `mutation projectCreate($input: ProjectCreateInput!) {
         projectCreate(input: $input) { id name }
       }`,
      { input: { name } },
    );
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
