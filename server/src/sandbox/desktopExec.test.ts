// An agent's code, executed on the desktop app of whoever asked for it.
//
// WHAT IS WORTH A SUITE. The broker is where three quiet failures would live. A result accepted from
// the wrong socket settles somebody else's validation with an answer about different code. An
// execution whose app vanished, with nothing to end it, holds a Graph tab or a run's slot for ever.
// And a run handed to a desktop app with this server's own paths or checkpointer in its environment
// either fails on a directory that does not exist there or, worse, is told where a database lives.
// Each is asserted against a transport the suite controls, so no socket and no Python is needed.
//
//   npm run test:desktop-exec

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TenantContext } from "../db/tenant.ts";
import { PROJECT_PARENT_TOKEN, PROJECT_TOKEN } from "./codeCheck.ts";
import {
  DesktopCodeCheckSandbox,
  DesktopExecBroker,
  DesktopRunSandbox,
  EXEC_DIR_TOKEN,
  packProject,
  type ExecHostRef,
  type ExecMessage,
} from "./desktopExec.ts";
import { RunEventBus } from "./eventBus.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ctx(workspaceId: string, requestId: string, user: string | null = "user-1"): TenantContext {
  return { workspaceId, requestId, actorUserId: user, role: "owner" } as TenantContext;
}

/** A transport that records what was sent and answers `pick` from a table the suite edits. */
function fakeTransport() {
  const sent: { to: ExecHostRef; message: ExecMessage }[] = [];
  const open = new Set<string>();
  let refusal: string | null = null;
  return {
    sent,
    open,
    refuse(r: string | null) { refusal = r; },
    transport: {
      pick: (c: TenantContext): ExecHostRef | { refusal: string } =>
        refusal ? { refusal } : { workspaceId: c.workspaceId, requestId: c.requestId, userId: c.actorUserId },
      send: (to: ExecHostRef, message: ExecMessage): boolean => {
        if (!open.has(to.requestId)) return false;
        sent.push({ to, message });
        return true;
      },
    },
  };
}

// The broker's own timers are unref'd — a server shutting down is not held open by a check — so
// this is what keeps the suite alive while it waits for one of them to fire.
const keepAlive = setInterval(() => {}, 1_000);
const project = mkdtempSync(join(tmpdir(), "jaroku-desktop-exec-"));
try {
  console.log("\na project travels whole, and only the project");
  {
    const dir = join(project, "my_agent");
    mkdirSync(join(dir, "tools"), { recursive: true });
    mkdirSync(join(dir, "__pycache__"), { recursive: true });
    mkdirSync(join(dir, ".venv", "lib"), { recursive: true });
    writeFileSync(join(dir, "agent.py"), "TOOLS = []\n# é — not ascii\n");
    writeFileSync(join(dir, "tools", "notes.py"), "x = 1\n");
    writeFileSync(join(dir, "__pycache__", "agent.cpython-312.pyc"), Buffer.from([0, 1, 2]));
    writeFileSync(join(dir, ".venv", "lib", "site.py"), "nope\n");
    writeFileSync(join(dir, "logo.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x10]));
    symlinkSync("/etc/hosts", join(dir, "hosts"));
    const files = packProject(dir, "proj");
    const paths = files.map((f) => f.path).sort();
    check("the source files are shipped under the name asked for", paths.includes("proj/agent.py") && paths.includes("proj/tools/notes.py"), paths.join(", "));
    check("...text as text, unchanged", files.find((f) => f.path === "proj/agent.py")?.text === "TOOLS = []\n# é — not ascii\n");
    check("...and a binary file as base64 rather than dropped", files.find((f) => f.path === "proj/logo.bin")?.b64 === Buffer.from([0xff, 0xfe, 0x00, 0x10]).toString("base64"));
    check("caches and environments are not shipped", !paths.some((p) => p.includes("__pycache__") || p.includes(".venv")));
    check("a symlink is neither followed nor shipped", !paths.includes("proj/hosts"));
  }

  console.log("\na check goes to the asking app, and only that app may answer it");
  {
    const t = fakeTransport();
    t.open.add("req-a");
    const broker = new DesktopExecBroker(t.transport, { checkMarginMs: 50 });
    const asking = ctx("ws-1", "req-a");
    const sandbox = new DesktopCodeCheckSandbox(broker, asking, () => "exec-check-1");
    const pending = sandbox.run({
      runtimeDir: "/server/runtime",
      args: ["-c", "script", PROJECT_PARENT_TOKEN, "my_agent", PROJECT_TOKEN],
      env: { JAROKU_AGENT_DIR: PROJECT_TOKEN },
      timeoutMs: 1000,
      project: join(project, "my_agent"),
    });
    const start = t.sent[0]?.message;
    check("one start was sent", t.sent.length === 1 && start?.type === "start");
    if (start?.type === "start") {
      check("...to the socket that asked", t.sent[0]!.to.requestId === "req-a");
      check("...with the project's tokens replaced by where the app will write it",
        start.args[2] === EXEC_DIR_TOKEN && start.args[4] === `${EXEC_DIR_TOKEN}/my_agent` && start.env.JAROKU_AGENT_DIR === `${EXEC_DIR_TOKEN}/my_agent`,
        JSON.stringify(start.args));
      check("...and the project under its own name, because the import check imports it as that", start.files.some((f) => f.path === "my_agent/agent.py"));
      check("...and no server path anywhere in it", !JSON.stringify(start).includes(project));
    }
    broker.result({ workspaceId: "ws-1", requestId: "req-b", userId: "user-1" }, { execId: "exec-check-1", code: 0, stdout: "WRONG" });
    broker.result({ workspaceId: "ws-2", requestId: "req-a", userId: "user-1" }, { execId: "exec-check-1", code: 0, stdout: "WRONG" });
    check("a result from another socket, or another workspace, is ignored", broker.size === 1);
    broker.result({ workspaceId: "ws-1", requestId: "req-a", userId: "user-1" }, { execId: "exec-check-1", code: 0, stdout: "[]", stderr: "" });
    const r = await pending;
    check("the asking app's result settles it", r.stdout === "[]" && r.exitCode === 0 && r.spawnError === null);
    check("...and it is forgotten", broker.size === 0);
  }

  console.log("\nnobody to run it is said, not waited out");
  {
    const t = fakeTransport();
    t.refuse("Agents run in the Jaroku desktop app on your computer. Open Jaroku, then try again.");
    const broker = new DesktopExecBroker(t.transport);
    check("unavailable() names the reason", broker.unavailable(ctx("ws-1", "req-a"))?.startsWith("Agents run in the Jaroku desktop app") === true);
    const r = await broker.check(ctx("ws-1", "req-a"), { runtimeDir: "/r", args: ["-c", "1"], timeoutMs: 1000 }, "exec-x");
    check("a check with no app is a spawn error carrying that sentence", r.spawnError?.includes("desktop app") === true && t.sent.length === 0);

    const t2 = fakeTransport(); // nothing open: the asking socket closed between pick and send
    const broker2 = new DesktopExecBroker(t2.transport);
    const r2 = await broker2.check(ctx("ws-1", "req-gone"), { runtimeDir: "/r", args: ["-c", "1"], timeoutMs: 1000 }, "exec-y");
    check("a socket gone before the start is a refusal too, not a hang", r2.spawnError?.includes("closed") === true && broker2.size === 0);
  }

  console.log("\nan app that never answers is given up on, and told to stop");
  {
    const t = fakeTransport();
    t.open.add("req-a");
    const broker = new DesktopExecBroker(t.transport, { checkMarginMs: 20 });
    const r = await broker.check(ctx("ws-1", "req-a"), { runtimeDir: "/r", args: ["-c", "1"], timeoutMs: 10 }, "exec-slow");
    check("past its deadline the check is reported timed out", r.timedOut && r.spawnError !== null);
    check("...and the app is told to stop it", t.sent.some((s) => s.message.type === "stop" && s.message.execId === "exec-slow"));
    check("...and nothing is left pending", broker.size === 0);
  }

  console.log("\nan app that closes gets its executions back if it returns in time");
  {
    const t = fakeTransport();
    t.open.add("req-a");
    const broker = new DesktopExecBroker(t.transport, { orphanGraceMs: 40 });
    const ends: { error: string | null; code: number | null }[] = [];
    const logs: string[] = [];
    const refusal = broker.run(ctx("ws-1", "req-a"), { execId: "run-1", args: ["-m", "jaroku_runner", "a"], env: {}, files: [] }, {
      onLog: (text) => logs.push(text),
      onEnd: (o) => ends.push({ error: o.error, code: o.code }),
    });
    check("a run is handed over", refusal === null && t.sent[0]?.message.type === "start");
    broker.log({ workspaceId: "ws-1", requestId: "req-a", userId: "user-1" }, "run-1", "line one\n");
    broker.log({ workspaceId: "ws-1", requestId: "req-z", userId: "user-2" }, "run-1", "not yours\n");
    check("its own app's stderr is relayed, nobody else's", logs.join("") === "line one\n");

    broker.socketClosed({ workspaceId: "ws-1", requestId: "req-a", userId: "user-1" });
    broker.hostReport({ workspaceId: "ws-1", requestId: "req-a2", userId: "user-2" }, ["run-1"]);
    await sleep(10);
    check("another person's app cannot claim it", ends.length === 0);
    broker.hostReport({ workspaceId: "ws-1", requestId: "req-a2", userId: "user-1" }, ["run-1"]);
    await sleep(60);
    check("the same person's reconnected app claims it before the grace runs out", ends.length === 0 && broker.size === 1);
    broker.result({ workspaceId: "ws-1", requestId: "req-a", userId: "user-1" }, { execId: "run-1", code: 0 });
    check("...after which the old socket cannot settle it", ends.length === 0);
    broker.result({ workspaceId: "ws-1", requestId: "req-a2", userId: "user-1" }, { execId: "run-1", code: 0 });
    check("...and the new one can, exactly once", ends.length === 1 && ends[0]!.code === 0);

    t.open.add("req-a2");
    const refused = broker.run(ctx("ws-1", "req-a2"), { execId: "run-2", args: ["-m", "x"], env: {}, files: [] }, {
      onLog: () => {},
      onEnd: (o) => ends.push({ error: o.error, code: o.code }),
    });
    check("a second run is handed over", refused === null && broker.size === 1);
    broker.socketClosed({ workspaceId: "ws-1", requestId: "req-a2", userId: "user-1" });
    await sleep(15);
    check("...and is not ended the instant its app closes", ends.length === 1);
    await sleep(60);
    const last = ends[ends.length - 1];
    check("an app that never comes back has its run ended, with the reason",
      ends.length === 2 && last?.error?.includes("closed") === true && last.code === null && broker.size === 0, JSON.stringify(ends));
  }

  console.log("\na run on a desktop app is handed nothing that only means something here");
  {
    const t = fakeTransport();
    t.open.add("req-a");
    const broker = new DesktopExecBroker(t.transport);
    const bus = new RunEventBus();
    const sandbox = new DesktopRunSandbox({ broker, bus });
    const editFile = join(project, "branch.edit.json");
    writeFileSync(editFile, JSON.stringify({ topic: "edited" }));
    const runtimeDir = project;
    mkdirSync(join(project, "agents", "my_agent"), { recursive: true });
    writeFileSync(join(project, "agents", "my_agent", "agent.py"), "TOOLS = []\n");
    const events: string[] = [];
    sandbox.on("event", () => events.push("event"));
    sandbox.on("stderr", (l) => events.push(`stderr:${l}`));
    const exits: { code: number | null }[] = [];
    sandbox.on("exit", (e) => exits.push(e));
    sandbox.start({
      runId: "run-9",
      workspaceId: "ws-1",
      runtimeDir,
      agentId: "my_agent",
      input: "hello",
      env: {
        ANTHROPIC_API_KEY: "sk-own",
        JAROKU_CONTROL_DIR: "/server/.checkpoints",
        JAROKU_CHECKPOINT_DIR: "/server/.checkpoints",
        JAROKU_BRANCH_EDIT_FILE: editFile,
        JAROKU_CHECKPOINTER: "postgres",
      },
      controlPlane: { url: "https://api.example", runToken: "tok" },
      host: ctx("ws-1", "req-a"),
    });
    const start = t.sent[0]?.message;
    check("the run went to the asking app", start?.type === "start" && start.kind === "run");
    if (start?.type === "start") {
      check("its own key travels with it", start.env.ANTHROPIC_API_KEY === "sk-own");
      check("it calls home over HTTP with a run token", start.env.JAROKU_CONTROL_PLANE_URL === "https://api.example" && start.env.JAROKU_RUN_TOKEN === "tok");
      check("this server's control and checkpoint directories are not handed over", !("JAROKU_CONTROL_DIR" in start.env) && !("JAROKU_CHECKPOINT_DIR" in start.env));
      check("it checkpoints to a local file, never to this server's database", start.env.JAROKU_CHECKPOINTER === "sqlite");
      check("the project travels, and the run is pointed at where it lands",
        start.files.some((f) => f.path === "project/agent.py") && start.env.JAROKU_AGENT_DIR === `${EXEC_DIR_TOKEN}/project`);
      check("a branch's edit travels as a file of its own",
        start.files.some((f) => f.path === "branch.edit.json" && f.text?.includes("edited")) && start.env.JAROKU_BRANCH_EDIT_FILE === `${EXEC_DIR_TOKEN}/branch.edit.json`);
      check("the runner is started with the agent and its input", JSON.stringify(start.args) === JSON.stringify(["-m", "jaroku_runner", "my_agent", "hello"]));
    }
    bus.pushTrace("run-9", { kind: "run_start", run_id: "run-9" } as never);
    broker.log({ workspaceId: "ws-1", requestId: "req-a", userId: "user-1" }, "run-9", "half a li");
    broker.log({ workspaceId: "ws-1", requestId: "req-a", userId: "user-1" }, "run-9", "ne\nnext\n");
    broker.log({ workspaceId: "ws-1", requestId: "req-a", userId: "user-1" }, "run-9", '@@JAROKU_CTRL@@ {"ctrl": "boundary"}\n');
    check("what the run pushes over HTTP arrives as the sandbox's own events", events.includes("event"));
    check("stderr arrives as whole lines", events.includes("stderr:half a line") && events.includes("stderr:next"));
    check("a control line is not shown as log — its HTTP copy is the one acted on", !events.some((e) => e.includes("@@JAROKU_CTRL@@")));
    check("it is running until its app says otherwise", sandbox.running);
    sandbox.stop(100);
    check("Stop is passed on to the app", t.sent.some((s) => s.message.type === "stop" && s.message.execId === "run-9"));
    broker.result({ workspaceId: "ws-1", requestId: "req-a", userId: "user-1" }, { execId: "run-9", code: 0 });
    check("its end is the pool's exit", exits.length === 1 && exits[0]!.code === 0 && !sandbox.running);
  }

  console.log("\na run with nowhere to go is a spawn error, not a slot held for ever");
  {
    const t = fakeTransport();
    t.refuse("Jaroku is still setting up Python on this computer. Try again in a minute.");
    const sandbox = new DesktopRunSandbox({ broker: new DesktopExecBroker(t.transport), bus: new RunEventBus() });
    const errors: string[] = [];
    sandbox.on("spawnError", (e) => errors.push(e.message));
    sandbox.start({
      runId: "run-x", workspaceId: "ws-1", runtimeDir: project,
      controlPlane: { url: "https://api.example", runToken: "tok" }, host: ctx("ws-1", "req-a"),
    });
    await tick();
    check("the refusal is the spawn error's message", errors[0]?.includes("setting up Python") === true && !sandbox.running);

    const nobody = new DesktopRunSandbox({ broker: new DesktopExecBroker(fakeTransport().transport), bus: new RunEventBus() });
    const e2: string[] = [];
    nobody.on("spawnError", (e) => e2.push(e.message));
    nobody.start({ runId: "run-y", runtimeDir: project, controlPlane: { url: "u", runToken: "t" } });
    await tick();
    check("a run nobody asked for has no app to run on, and says so", e2.length === 1);
  }

  console.log("\nthe wiring a broker cannot see");
  {
    const { readFileSync } = await import("node:fs");
    const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    check("a desktop run is never lent a platform key", /if \(desktopExec\) \{[\s\S]{0,400}Runs use your own/.test(index));
    check("every interactive start names who asked", (index.match(/interactivePool\.tryStart\(\{[^}]*host: ctx/g) ?? []).length === 3);
    check("generation and edits ask whether code can run before spending a model turn",
      (index.match(/const cannotCheck = codeCannotRun\(ctx\)/g) ?? []).length === 2);
  }
} finally {
  clearInterval(keepAlive);
  rmSync(project, { recursive: true, force: true });
}

if (fail > 0) {
  console.log(`\n${fail} FAILURE${fail === 1 ? "" : "S"}`);
  process.exit(1);
}
console.log("\nALL CORRECT");
