// Standing up a REAL deployed agent — the actual serve.py, the actual runner, the actual
// example agent — with only the model provider replaced by a fixture.
//
// WHY MOCK THE PROVIDER RATHER THAN THE PRODUCT. Every other way of making these suites runnable
// costs something the suites exist to check. Letting serve.py accept the dry-run provider would
// put a test-only escape into the file whose whole job is refusing one. Stubbing the runner
// would test a stub. Running against a real key would make the suite something that runs when
// somebody has a budget. Pointing `ANTHROPIC_BASE_URL` at a node server replaces the one thing
// that genuinely cannot be in a test — a paid third party — and leaves every line of Jaroku's
// own code executing for real.
//
// WHAT THAT BUYS. The trace these suites read is produced by the same interceptor, the same
// tracer, the same checkpointed driver and the same graph a local run uses. So "a deployed
// trace and a local trace differ in run id and timing and nothing else" is a comparison of two
// real traces rather than of a real one against a fixture's idea of one.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, cpSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writeDeployArtifacts } from "../../src/deployArtifacts.ts";

export const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const RUNTIME_DIR = join(REPO_DIR, "runtime");

/**
 * The interpreter these suites drive, or null when this machine has no Python for them.
 *
 * The runtime's own virtualenv first, because that is where LangGraph actually is and because
 * `sys.executable` inside serve.py then names it too — so the runner subprocess serve.py starts
 * inherits the same interpreter rather than finding whatever `python` means on this PATH.
 */
export function pythonExecutable(): string | null {
  for (const candidate of [
    join(RUNTIME_DIR, ".venv", "Scripts", "python.exe"),
    join(RUNTIME_DIR, ".venv", "bin", "python"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** One turn the fixture provider will answer with, in order. */
export type MockTurn =
  | { kind: "tool_use"; name: string; input?: Record<string, unknown>; inputTokens?: number; outputTokens?: number }
  | { kind: "text"; text: string; inputTokens?: number; outputTokens?: number };

export interface MockProvider {
  baseUrl: string;
  /** Every request the agent actually made, so a suite can assert the model was reached. */
  calls: number;
  close: () => Promise<void>;
}

/**
 * An Anthropic Messages API that answers from a script.
 *
 * Deliberately raw `node:http` and raw JSON rather than any Anthropic SDK — the same reasoning
 * the MCP fixture gives. What is under test here is `langchain_anthropic` talking to something
 * that is not itself, and two halves of one library agreeing proves less.
 */
export async function startMockProvider(turns: MockTurn[]): Promise<MockProvider> {
  let index = 0;
  const state = { calls: 0 };
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      state.calls++;
      // The script is consumed in order and the LAST turn repeats. A graph that loops one more
      // time than the suite expected should produce a longer trace, not a 500 that reads as an
      // unrelated transport failure.
      const turn = turns[Math.min(index++, turns.length - 1)]!;
      const content =
        turn.kind === "tool_use"
          ? [{ type: "tool_use", id: `toolu_${index}`, name: turn.name, input: turn.input ?? {} }]
          : [{ type: "text", text: turn.text }];
      const body = JSON.stringify({
        id: `msg_${index}`,
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5",
        content,
        stop_reason: turn.kind === "tool_use" ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: turn.inputTokens ?? 100,
          output_tokens: turn.outputTokens ?? 20,
        },
      });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    get calls() { return state.calls; },
    close: () => new Promise((done) => server.close(() => done())),
  };
}

export interface DeployedProject {
  /** A runtime-shaped directory holding one deployed agent, laid out exactly as an image is. */
  runtimeDir: string;
  projectDir: string;
  agentId: string;
  cleanup: () => void;
}

/**
 * Build the layout a deployed container actually has, on disk, from the real checkout.
 *
 * THROUGH `writeDeployArtifacts` RATHER THAN BY HAND, and that is the point: the vendored
 * runtime, serve.py, the Dockerfile and the pyproject are placed by the same code a real deploy
 * runs. A harness that assembled its own directory would be testing a layout nothing produces.
 */
export function deployedProject(agentId = "example_agent"): DeployedProject {
  const scratch = mkdtempSync(join(tmpdir(), "jaroku-serve-"));
  const runtimeDir = join(scratch, "runtime");
  const projectDir = join(runtimeDir, "agents", agentId);
  mkdirSync(join(runtimeDir, "agents"), { recursive: true });
  writeFileSync(join(runtimeDir, "agents", "__init__.py"), '"""agents."""\n', "utf8");
  cpSync(join(RUNTIME_DIR, "agents", agentId), projectDir, {
    recursive: true,
    filter: (src) => !src.includes("__pycache__"),
  });
  // The three things writeDeployArtifacts reads out of a runtime directory.
  cpSync(join(RUNTIME_DIR, "tool_templates"), join(runtimeDir, "tool_templates"), {
    recursive: true,
    filter: (src) => !src.includes("__pycache__") && !src.includes(`${"tests"}`),
  });
  for (const entry of ["jaroku_interceptor", "jaroku_runner"]) {
    cpSync(join(RUNTIME_DIR, entry), join(runtimeDir, entry), {
      recursive: true,
      filter: (src) => !src.includes("__pycache__"),
    });
  }
  writeFileSync(join(runtimeDir, "pricing.json"), readFileSync(join(RUNTIME_DIR, "pricing.json"), "utf8"), "utf8");

  writeDeployArtifacts({ runtimeDir, agentId, provider: "anthropic" });

  return {
    runtimeDir,
    projectDir,
    agentId,
    cleanup: () => rmSync(scratch, { recursive: true, force: true }),
  };
}

export interface ServedAgent {
  url: string;
  token: string;
  /** Everything the container wrote to its log pane, which is where the runner's stderr lands. */
  logs: string[];
  proc: ChildProcess;
  stop: () => Promise<void>;
}

export interface ServeOptions {
  project: DeployedProject;
  provider: MockProvider;
  /** Extra environment for the container. Where a suite says what it is actually testing. */
  env?: Record<string, string>;
  token?: string;
  concurrency?: number;
}

/**
 * Start the real serve.py against a built project, and wait until it answers /health.
 *
 * Started as `python -m agents.<id>.serve` from the runtime directory, which is the invocation
 * the file's own docstring documents and the one it is run under locally. In a container the
 * package is `<id>` rather than `agents.<id>`; serve.py takes the last segment either way, which
 * is exactly what its `main()` says it does.
 */
export async function startServe(opts: ServeOptions): Promise<ServedAgent> {
  const python = pythonExecutable();
  if (!python) throw new Error("no Python interpreter for the serve harness");
  const token = opts.token ?? "harness-bearer-token";

  // A port picked by the OS and released, then handed to serve.py — it binds a fixed port, and
  // a hardcoded one makes two suites running at once flake against each other.
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));

  const logs: string[] = [];
  const proc = spawn(python, ["-m", `agents.${opts.project.agentId}.serve`], {
    cwd: opts.project.runtimeDir,
    env: {
      ...process.env,
      PORT: String(port),
      JAROKU_SERVE_TOKEN: token,
      JAROKU_SERVE_CONCURRENCY: String(opts.concurrency ?? 4),
      JAROKU_PROVIDER: "anthropic",
      JAROKU_MODEL: "claude-haiku-4-5",
      // The one substitution. Both names are read by the Anthropic SDK itself, which is what
      // langchain_anthropic is built on.
      ANTHROPIC_API_KEY: "sk-ant-harness-not-a-real-key",
      ANTHROPIC_BASE_URL: opts.provider.baseUrl,
      // A deployed container has no runtime/.env and no control directory. Cleared rather than
      // inherited, so this machine's own configuration cannot make a suite pass.
      JAROKU_CONTROL_DIR: "",
      JAROKU_RUN_TOKEN: "",
      JAROKU_CONTROL_PLANE_URL: "",
      JAROKU_CHECKPOINTER: "sqlite",
      PYTHONUNBUFFERED: "1",
      ...opts.env,
    },
  });
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (d: string) => { for (const l of d.split("\n")) if (l.trim()) logs.push(l.trimEnd()); });
  proc.stderr.on("data", (d: string) => { for (const l of d.split("\n")) if (l.trim()) logs.push(`STDERR ${l.trimEnd()}`); });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`serve.py exited ${proc.exitCode}:\n${logs.join("\n")}`);
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) { await res.json(); break; }
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`serve.py never became healthy:\n${logs.join("\n")}`);
    await new Promise((r) => setTimeout(r, 150));
  }

  return {
    url,
    token,
    logs,
    proc,
    stop: () =>
      new Promise((done) => {
        if (proc.exitCode !== null) return done();
        proc.once("exit", () => done());
        proc.kill();
        setTimeout(() => { proc.kill("SIGKILL"); done(); }, 5_000).unref();
      }),
  };
}

/** One dispatch, exactly as Jaroku makes it. */
export async function dispatch(
  served: ServedAgent,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${served.url}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${served.token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed };
}
