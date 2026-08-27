// "Allow for this run" cannot leak from one job to the next in the same container.
//
//   npm run test:serve-confirm
//
// §7 calls this the highest-value test in Part 1, and names the reason: `_run_grants` was a
// module-level set of "<server>/<tool>", and the comment above it said the grant "lasts exactly
// as long as the process does: a new run asks again". That was true of every place mcp_bridge.py
// had ever run — locally and in a sandbox a process IS a run — and false of the one it was about
// to run in. A container serves many jobs. Under the old key, the first person to approve
// `stripe/create_refund` approved it for every request that container answered afterwards,
// silently, until somebody redeployed.
//
// TWO INDEPENDENT GUARANTEES, AND THIS SUITE ASSERTS BOTH, because either one alone is a rule
// that stops holding when somebody changes the other file:
//
//   1. THE KEY. A grant belongs to (run, server/tool). Asserted by driving the real bridge in
//      ONE Python process and changing JAROKU_RUN_ID between two calls — which is precisely
//      "two jobs in one process", and is the shape the regression actually took.
//   2. THE PROCESS BOUNDARY. serve.py starts each run as its own process, so in the deployed
//      path there is no shared module state to leak through at all. Asserted against the real
//      `_run_environment`, which is the function that decides what each job's process sees.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import { deployedProject, pythonExecutable, RUNTIME_DIR } from "../fixtures/deploy/serveHarness.ts";
import { Router } from "./http/router.ts";
import { BackpressureTracker } from "./sandbox/backpressure.ts";
import { RunEventBus } from "./sandbox/eventBus.ts";
import { registerControlPlaneRoutes } from "./sandbox/controlPlaneRoutes.ts";
import { mintRunToken, RunTokenRevocationList } from "./sandbox/runTokens.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const python = pythonExecutable();
if (!python) {
  console.error(
    "no runtime/.venv — this suite drives the real mcp_bridge.py and cannot run without it.\n" +
    "  Run `uv sync` in runtime/ first. CI's `runtime` job does exactly that.",
  );
  process.exitCode = 1;
} else {

const signingKey = randomBytes(32);
const bus = new RunEventBus();
const router = new Router({ log: () => {}, quiet: () => true });
// The nonce is minted inside the Python process and cannot be predicted from here — learned from
// the same callback production wires to raise the confirmation dialog.
const noncesByRun = new Map<string, string[]>();
registerControlPlaneRoutes(router, {
  bus,
  signingKey,
  revocations: new RunTokenRevocationList(),
  backpressure: new BackpressureTracker(),
  onMcpConfirmRequested: (runId, payload) => {
    if (typeof payload.nonce === "string") {
      noncesByRun.set(runId, [...(noncesByRun.get(runId) ?? []), payload.nonce]);
    }
  },
});
const http = createServer((req, res) => {
  void router.handle(req, res).then((h) => { if (!h) res.writeHead(404).end(); });
});
await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

const asked = (runId: string) => noncesByRun.get(runId)?.length ?? 0;

/**
 * TWO JOBS, ONE PROCESS — the regression's exact shape.
 *
 * The script calls `_confirm` for the same high-impact tool three times inside a single
 * interpreter, changing JAROKU_RUN_ID between the second and the third exactly as a long-lived
 * container moves from one job to the next. Every ask is announced to this side through the
 * control plane, so what the suite counts is how many times a HUMAN was actually asked.
 */
function twoJobsInOneProcess(runA: string, runB: string, tokenA: string, tokenB: string): Promise<{ stdout: string; stderr: string }> {
  const script = `
import os, sys
sys.path.insert(0, ${JSON.stringify(RUNTIME_DIR)})
os.environ["JAROKU_MCP_CONFIRM_TIMEOUT_S"] = "25"
os.environ["JAROKU_CONTROL_PLANE_URL"] = ${JSON.stringify(base)}

from tool_templates import mcp_bridge as B

def attempt(label, run_id, token):
    os.environ["JAROKU_RUN_ID"] = run_id
    os.environ["JAROKU_RUN_TOKEN"] = token
    try:
        B._confirm("stripe", "create_refund", {"amount": 500}, "moves money")
        print(f"{label}:PROCEEDED", flush=True)
    except B.ToolNotApproved as e:
        print(f"{label}:DENIED", flush=True)

# Job A asks and is approved "for this run".
attempt("A1", ${JSON.stringify(runA)}, ${JSON.stringify(tokenA)})
# The SAME job asks again for the SAME tool. This must NOT reach the control plane: that is what
# "first use in a run" means, and it is the behaviour the grant exists to provide.
attempt("A2", ${JSON.stringify(runA)}, ${JSON.stringify(tokenA)})
# A DIFFERENT job, same process, same module, same tool. This must ask again.
attempt("B1", ${JSON.stringify(runB)}, ${JSON.stringify(tokenB)})
print("GRANTS:" + repr(sorted(B._run_grants)), flush=True)
`.trim();

  return new Promise((done) => {
    const child = spawn(python!, ["-c", script], { cwd: RUNTIME_DIR, env: { ...process.env } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    child.on("exit", () => done({ stdout, stderr }));
  });
}

const runA = randomUUID();
const runB = randomUUID();
bus.register(runA);
bus.register(runB);
const tokenA = mintRunToken(signingKey, runA, "ws-1", 600);
const tokenB = mintRunToken(signingKey, runB, "ws-1", 600);

const pending = twoJobsInOneProcess(runA, runB, tokenA, tokenB);

// Answer whatever is asked, as it is asked. "run" for job A — the strongest verdict available,
// the one that grants for the whole run — so that a leak, if there were one, would definitely
// happen. Job B is answered "deny", so a leak is visible as job B PROCEEDING without a denial
// rather than merely as an extra question.
{
  const deadline = Date.now() + 90_000;
  let answeredA = 0;
  let answeredB = 0;
  while (Date.now() < deadline && (answeredA + answeredB) < 2) {
    for (const nonce of noncesByRun.get(runA) ?? []) {
      if (bus.resolveMcpConfirm(runA, nonce, "run")) answeredA++;
    }
    for (const nonce of noncesByRun.get(runB) ?? []) {
      if (bus.resolveMcpConfirm(runB, nonce, "deny")) answeredB++;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const { stdout, stderr } = await pending;
const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
const outcome = (label: string) => lines.find((l) => l.startsWith(`${label}:`))?.split(":")[1];

check("a high-impact call in job A asks a human and proceeds when approved",
  outcome("A1") === "PROCEEDED", `${outcome("A1")} :: ${stderr.slice(-400)}`);
check("...and the same tool later in the SAME job does not ask again",
  outcome("A2") === "PROCEEDED" && asked(runA) === 1,
  `A2=${outcome("A2")} asks=${asked(runA)}`);

// THE ASSERTION THIS SUITE EXISTS FOR. Under the old module-level key, job B's call finds
// "stripe/create_refund" already granted and returns immediately: no ask, no denial, a refund
// moved with nobody's approval. Two independent things have to be true for it to fail correctly.
check("a DIFFERENT job in the same process asks again", asked(runB) === 1, `asks=${asked(runB)}`);
check("...and is refused when the answer is no, rather than inheriting job A's approval",
  outcome("B1") === "DENIED", `${outcome("B1")} :: ${stderr.slice(-400)}`);

// And the grant itself, read out of the process that holds it — so the reason the above passed
// is visible rather than inferred. A bare "stripe/create_refund" here would be the old bug.
const grants = lines.find((l) => l.startsWith("GRANTS:"))?.slice("GRANTS:".length) ?? "";
check("a grant is recorded against the run it was given for, not against the tool alone",
  grants.includes(runA) && !grants.includes(runB),
  grants);

http.close();

// --- and the process boundary, which is the other half ------------------------------------------

{
  // WHAT EACH JOB'S PROCESS ACTUALLY SEES, read off the real `_run_environment` rather than
  // described. This is the function that decides whether a deployed run's bridge can ask
  // anybody at all — §7's "your job is to make sure the deployed bridge IS configured" — and it
  // is also why a grant has no shared module state to sit in.
  const project = deployedProject();
  const script = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("serve_under_test", ${JSON.stringify(`${project.projectDir.replace(/\\/g, "\\\\")}\\\\serve.py`.replace(/\\\\/g, "\\\\"))})
serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve)
one = serve._run_environment("run-one", "anthropic", "claude-haiku-4-5", "token-one", "https://cp.example")
two = serve._run_environment("run-two", "anthropic", "claude-haiku-4-5", "token-two", "https://cp.example")
bare = serve._run_environment("run-three", "anthropic", None, None, None)
print(json.dumps({
    "one": {k: one.get(k) for k in ("JAROKU_RUN_ID","JAROKU_RUN_TOKEN","JAROKU_CONTROL_PLANE_URL","JAROKU_MCP_CONFIRM","JAROKU_AGENT_DIR")},
    "two": {k: two.get(k) for k in ("JAROKU_RUN_ID","JAROKU_RUN_TOKEN")},
    "bare": {k: bare.get(k) for k in ("JAROKU_RUN_TOKEN","JAROKU_CONTROL_PLANE_URL")},
    "argv_free": "token-one" not in " ".join(sys.argv),
}))
`.trim();

  const out = await new Promise<string>((done) => {
    const child = spawn(python!, ["-c", script], { cwd: project.runtimeDir, env: { ...process.env, JAROKU_MCP_CONFIRM: "" } });
    let buf = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (buf += d));
    child.stderr.on("data", (d: string) => (err += d));
    child.on("exit", () => done(buf || err));
  });

  let parsed: Record<string, Record<string, unknown>> = {};
  try { parsed = JSON.parse(out.trim().split("\n").at(-1) ?? "{}"); } catch { /* reported below */ }
  const one = parsed["one"] ?? {};
  const two = parsed["two"] ?? {};
  const bare = parsed["bare"] ?? {};

  check("a dispatched run's environment carries the three variables the bridge needs to ask",
    one["JAROKU_CONTROL_PLANE_URL"] === "https://cp.example" &&
      one["JAROKU_RUN_TOKEN"] === "token-one" &&
      one["JAROKU_MCP_CONFIRM"] === "require",
    JSON.stringify(one) || out.slice(-300));
  check("...and the project it is running, by path",
    typeof one["JAROKU_AGENT_DIR"] === "string" && String(one["JAROKU_AGENT_DIR"]).length > 0);
  check("each job gets its own run id and its own token, never a shared one",
    two["JAROKU_RUN_ID"] === "run-two" && two["JAROKU_RUN_TOKEN"] === "token-two" &&
      one["JAROKU_RUN_ID"] === "run-one" && one["JAROKU_RUN_TOKEN"] === "token-one",
    `${JSON.stringify(one)} vs ${JSON.stringify(two)}`);
  // CONFIGURED, NEVER ASSUMED. A dispatch with no control plane must not leave a stale token in
  // the child's environment — that is the copied-out project, and a leftover credential there
  // would make it try to phone home to a server it has no business reaching.
  check("a dispatch with no control plane leaves no credential behind",
    (bare["JAROKU_RUN_TOKEN"] ?? null) === null && (bare["JAROKU_CONTROL_PLANE_URL"] ?? null) === null,
    JSON.stringify(bare));

  project.cleanup();
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;

}
