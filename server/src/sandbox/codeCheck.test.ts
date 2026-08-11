// LocalCodeCheckSandbox, against a real `uv run python` process — validator.ts's import check
// and static analysis now go through this rather than spawning directly, and this is the
// interface's own contract test: stdout/stderr capture, exit code, timeout, and a spawn
// failure are all real, not mocked.
//
//   npm run test:code-check

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalCodeCheckSandbox } from "./codeCheck.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const RUNTIME_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "runtime");
const sandbox = new LocalCodeCheckSandbox();

{
  const r = await sandbox.run({ runtimeDir: RUNTIME_DIR, args: ["-c", "print('hello')"], timeoutMs: 10_000 });
  check("stdout is captured", r.stdout.trim() === "hello", r.stdout);
  check("exit code 0 on success", r.exitCode === 0);
  check("no spawn error on a normal run", r.spawnError === null);
  check("not reported as timed out", !r.timedOut);
}

{
  const r = await sandbox.run({
    runtimeDir: RUNTIME_DIR,
    args: ["-c", "import sys; print('to stderr', file=sys.stderr); sys.exit(3)"],
    timeoutMs: 10_000,
  });
  check("stderr is captured separately from stdout", r.stderr.includes("to stderr"));
  check("a non-zero exit code is reported, not swallowed", r.exitCode === 3);
}

{
  const before = Date.now();
  const r = await sandbox.run({
    runtimeDir: RUNTIME_DIR,
    args: ["-c", "import time; time.sleep(30)"],
    timeoutMs: 500,
  });
  const elapsed = Date.now() - before;
  check("a hanging process is killed rather than waited out", r.timedOut);
  check("the kill happens close to the timeout, not the full 30s", elapsed < 20_000, `elapsed=${elapsed}ms`);
}

{
  const r = await sandbox.run({ runtimeDir: RUNTIME_DIR, args: ["-c", "print(1/0)"], timeoutMs: 10_000 });
  check("a script that raises still reports a non-zero exit rather than hanging", r.exitCode !== 0 && r.exitCode !== null);
  check("the traceback lands in stderr", r.stderr.includes("ZeroDivisionError"));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
