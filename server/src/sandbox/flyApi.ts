// Fly Machines' own REST API — the hosted substrate D4 picked: per-run micro-VM, fast cold
// start, per-machine resource caps, no shared kernel with any other run.
//
// A bare `fetch`, no SDK — the same choice railwayApi.ts already made for the same reason: this
// is a handful of JSON calls to one host, and a dependency here is a dependency in the path
// every sandboxed run takes. Three properties every call holds, deliberately the same three
// railwayApi.ts holds for the same reasons:
//
//   BOUNDED. A hosting API that stops answering must not turn "start a sandbox" into a request
//   that hangs forever with nothing to cancel it.
//   CLASSIFIED. "the token is wrong", "Fly is down" and "Fly refused the machine spec" need
//   three different responses, so they are three different failures here rather than one string.
//   SCRUBBED. Fly can echo back what it was sent, and what it is sent includes the run's own
//   secrets (as machine env) — every error message is scrubbed before it leaves this module.

import { numberFromEnv } from "../env.ts";

const DEFAULT_API_BASE = "https://api.machines.dev/v1";

export function flyApiBase(): string {
  return process.env["JAROKU_FLY_API"] || DEFAULT_API_BASE;
}

/** Written by the deploy/ops flow, never by a run. Account/org scoped, never logged. */
export const FLY_API_TOKEN_ENV = "JAROKU_FLY_API_TOKEN";

const REQUEST_TIMEOUT_MS = numberFromEnv("JAROKU_FLY_TIMEOUT_MS", 20_000);
/** Machine boot can take longer than an ordinary API call — pulling a large image cold. */
const WAIT_TIMEOUT_S = Math.ceil(numberFromEnv("JAROKU_FLY_WAIT_TIMEOUT_MS", 60_000) / 1000);

export type FlyFailureKind =
  /** The token is missing, wrong, or lacks the scope for this app/org. */
  | "auth"
  /** Reached Fly; it refused the request (a bad machine spec, a quota, ...). */
  | "api"
  /** Never reached Fly: DNS, refused, reset, timeout. */
  | "unreachable";

export class FlyError extends Error {
  constructor(
    readonly kind: FlyFailureKind,
    message: string,
    readonly operation: string,
  ) {
    super(message);
    this.name = "FlyError";
  }
}

/** Values that must never appear in an error message reaching a caller — the token itself, and
 *  every value in the env a machine was started with (a run's own resolved secrets). */
function scrub(message: string, secrets: string[]): string {
  let out = message;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join("[redacted]");
  }
  return out;
}

export interface FlyMachineConfig {
  image: string; // digest-pinned — see image.ts:requireDigestPinnedImage
  guest: { cpu_kind: "shared" | "performance"; cpus: number; memory_mb: number };
  init: { entrypoint?: string[]; cmd: string[] };
  env: Record<string, string>;
  restart: { policy: "no" };
  auto_destroy: boolean;
  /** Wall-clock ceiling Fly itself enforces, belt-and-braces alongside the run's own deadline. */
  stop_config?: { timeout: string };
}

export interface FlyMachine {
  id: string;
  instance_id: string;
  state: string; // "created" | "starting" | "started" | "stopping" | "stopped" | "destroyed" | ...
  region: string;
}

export interface FlyExitEvent {
  exit_code: number | null;
  oom_killed: boolean;
  signal: number | null;
}

async function call<T>(
  op: string,
  method: string,
  path: string,
  body: unknown,
  secrets: string[],
): Promise<T> {
  const token = process.env[FLY_API_TOKEN_ENV];
  if (!token) throw new FlyError("auth", `${FLY_API_TOKEN_ENV} is not set`, op);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${flyApiBase()}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new FlyError("unreachable", scrub((err as Error).message, secrets), op);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new FlyError("auth", `Fly refused the request (${res.status})`, op);
  }
  if (!res.ok) {
    throw new FlyError("api", scrub(`Fly returned ${res.status}: ${text.slice(0, 500)}`, secrets), op);
  }
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new FlyError("api", "Fly's response was not valid JSON", op);
  }
}

export async function createMachine(
  app: string,
  name: string,
  config: FlyMachineConfig,
): Promise<FlyMachine> {
  const secrets = Object.values(config.env);
  return call<FlyMachine>("createMachine", "POST", `/apps/${app}/machines`, { name, config }, secrets);
}

/** Block until the machine reaches `state`, or Fly's own wait timeout elapses. */
export async function waitForState(
  app: string,
  machine: FlyMachine,
  state: "started" | "stopped",
): Promise<void> {
  await call<unknown>(
    "waitForState",
    "GET",
    `/apps/${app}/machines/${machine.id}/wait?instance_id=${machine.instance_id}&state=${state}&timeout=${WAIT_TIMEOUT_S}`,
    undefined,
    [],
  );
}

export async function getMachine(app: string, id: string): Promise<FlyMachine> {
  return call<FlyMachine>("getMachine", "GET", `/apps/${app}/machines/${id}`, undefined, []);
}

/** The most recent exit, if the machine has stopped at least once. Fly records these as
 *  machine events; the last "exit" event is the one this run's own process produced. */
export async function getLastExit(app: string, id: string): Promise<FlyExitEvent | null> {
  const events = await call<Array<{ type: string; request?: { exit_event?: FlyExitEvent } }>>(
    "getLastExit",
    "GET",
    `/apps/${app}/machines/${id}/events`,
    undefined,
    [],
  );
  for (let i = events.length - 1; i >= 0; i--) {
    const exitEvent = events[i]!.request?.exit_event;
    if (events[i]!.type === "exit" && exitEvent) return exitEvent;
  }
  return null;
}

export async function signalMachine(app: string, id: string, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
  await call<unknown>("signalMachine", "POST", `/apps/${app}/machines/${id}/signal`, { signal }, []);
}

export async function stopMachine(app: string, id: string): Promise<void> {
  await call<unknown>("stopMachine", "POST", `/apps/${app}/machines/${id}/stop`, {}, []);
}

export async function destroyMachine(app: string, id: string): Promise<void> {
  await call<unknown>("destroyMachine", "DELETE", `/apps/${app}/machines/${id}?force=true`, undefined, []);
}
