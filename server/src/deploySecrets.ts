// Moving a credential from this machine to somebody else's. 🔴 Hand-written, read every line.
//
// This is the first time a secret leaves Jaroku's own host. Everything before it — provider
// keys, MCP tokens, connector credentials — took exactly one path: into runtime/.env through
// envWriter, out of process.env at the moment of use, never further. Deploy is the point where
// that stops being enough, because a deployed agent needs its own keys in its own environment.
//
// The design, and what enforces each half:
//
//   NAMES travel. requiredSecrets() answers with names and a boolean, which is what the
//   browser sees, what the user ticks, and what deployments.env_keys stores. There is no shape
//   in this module, on the deploy channel, or in the schema that a value fits in. That is the
//   same distinction providerStatus() and McpRegistry.configured() already draw.
//
//   VALUES are read once, at the moment of the mutation, straight into the HTTPS request body
//   that sets them on the host. Never an argv (a process table is world-readable, which is the
//   single reason the deploy transport does not use the Railway CLI for variables). Never a
//   log. Never a file. Never the database. Never back to the browser.
//
//   And then, for as long as the deploy runs, the values are held for ONE purpose: scrubbing
//   them out of the host's build output before it is shown or stored. A build log is somebody
//   else's text echoed back at us; a Dockerfile RUN that prints a variable, or a library
//   banner that helpfully logs its connection string, would otherwise put a live credential
//   into the log pane, the deployment_logs table, and every connected browser at once. Held
//   values are no worse than process.env, which has them for the whole process lifetime — and
//   they are cleared in a finally.

import { authEnvKeyFor } from "./envWriter.ts";
import { PROVIDER_ENV_KEY, isProviderId } from "./providers.ts";

/** What the browser is told about one variable. A name and a fact. Never a value. */
export interface DeploySecretStatus {
  name: string;
  /** Whether this machine currently has a value for it. */
  configured: boolean;
  /** Why the agent needs it, so a list of variable names reads as something. */
  reason: string;
  /**
   * Whether the deploy should refuse without it. A connector's credential is required
   * because rule 7 makes an unconfigured template raise on every call — a container missing
   * one is a deploy that looks green and is dead.
   */
  required: boolean;
}

export interface RequiredSecretsInput {
  /** From the agent's jaroku.json. Connector + MCP variables the generator already merged. */
  requiredEnv: string[];
  /** MCP server ids from the manifest, so their derived token names are included. */
  mcpServers?: string[];
  /** What the deployed instance will run on. */
  provider: string;
}

/**
 * The environment a deployed instance needs, as names.
 *
 * Three sources, in the order they matter: the provider key (without it the container starts
 * and every request 500s), the agent's own declared variables, and the derived token name for
 * each MCP server it was granted. Deduplicated, stable order.
 */
export function requiredSecrets(input: RequiredSecretsInput): DeploySecretStatus[] {
  const out: DeploySecretStatus[] = [];
  const seen = new Set<string>();

  const add = (name: string, reason: string, required: boolean): void => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ name, configured: Boolean(process.env[name]), reason, required });
  };

  if (isProviderId(input.provider)) {
    add(PROVIDER_ENV_KEY[input.provider], `the agent runs on ${input.provider}`, true);
  }

  for (const name of input.requiredEnv) {
    // JAROKU_* in an agent's required_env are host-supplied knobs, not user credentials, and
    // the deploy sets the ones that matter itself (see hostEnv). Offering to copy this
    // machine's value for one would hand a container a local path or a local port.
    if (name.startsWith("JAROKU_")) continue;
    add(name, "declared in this agent's .env.example", true);
  }

  for (const serverId of input.mcpServers ?? []) {
    // Optional: plenty of MCP servers need no credential, and refusing to deploy over a token
    // that was never required locally either would be wrong.
    add(authEnvKeyFor(serverId), `the ${serverId} MCP server, if it needs a token`, false);
  }

  return out;
}

/**
 * Variables the DEPLOY sets rather than copies, and their values.
 *
 * These are not credentials to hand over — they are how the container is told it is running
 * unattended. Kept here beside the secrets so the full set of what reaches a host is readable
 * in one place.
 */
export function hostEnv(opts: {
  provider: string;
  model: string;
  serveToken: string | null;
}): Record<string, string> {
  const env: Record<string, string> = {
    JAROKU_PROVIDER: opts.provider,
    JAROKU_MODEL: opts.model,
    // The bridge's "allow for this run" grant is module-global and would outlive a single
    // request in a long-lived process. Nothing out there can show a confirmation, so fail
    // closed. The Dockerfile sets this too; setting it here as well means it survives someone
    // rebuilding the service from a different source.
    JAROKU_MCP_CONFIRM: "require",
  };
  if (opts.serveToken) env["JAROKU_SERVE_TOKEN"] = opts.serveToken;
  return env;
}

/**
 * Read the values for the chosen names, at the moment they are needed.
 *
 * The only read of a credential in the deploy path. The returned map goes straight into the
 * request body and into the scrubber, and nowhere else — in particular it is never returned
 * to a caller that broadcasts, logs or persists. Names with no value are skipped rather than
 * sent as empty strings, because an empty variable on the host shadows nothing and reads as
 * "configured" in Railway's UI.
 */
export function resolveSecretValues(names: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value !== "") out.set(name, value);
  }
  return out;
}

/** Names in `names` that this machine has no value for. What a deploy refuses over. */
export function missingSecrets(names: string[]): string[] {
  return names.filter((n) => !process.env[n]);
}

/**
 * The shortest value worth redacting.
 *
 * A three-character secret matched across a build log would shred it — every "abc" in every
 * path and package name replaced — and a log full of holes tells an observer more about the
 * value than the value's absence hides. Eight is comfortably below any real API key and
 * comfortably above the substrings that occur by accident.
 */
const MIN_SCRUB_LENGTH = 8;

export const REDACTION = "••••••••";

/**
 * A reusable scrubber for one deploy's secrets.
 *
 * Built once from the values being deployed and applied to every log line before it is
 * broadcast or stored. Longest first, so a value that contains another value is replaced
 * whole rather than leaving the tail of the longer one exposed.
 */
export function makeScrubber(values: Iterable<string>): (line: string) => string {
  const targets = [...new Set(values)]
    .filter((v) => v.length >= MIN_SCRUB_LENGTH)
    .sort((a, b) => b.length - a.length);

  if (!targets.length) return (line) => line;

  return (line: string): string => {
    let out = line;
    for (const value of targets) {
      // split/join rather than a RegExp: a credential is arbitrary text and may contain
      // regex metacharacters, and building a pattern out of one is how a scrubber silently
      // stops matching the exact values it exists to catch.
      if (out.includes(value)) out = out.split(value).join(REDACTION);
    }
    return out;
  };
}

/** One-shot form, for a caller that has no long-lived deploy to build a scrubber for. */
export function scrubSecrets(line: string, values: Iterable<string>): string {
  return makeScrubber(values)(line);
}
