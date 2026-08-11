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

// --- a check that writes more than a check has any business writing -----------------------
//
// This module's whole premise is that it runs untrusted, model-written code — a file being
// VALIDATED, before anything has been saved. Both streams used to accumulate straight into a
// string with no ceiling, so `print("x" * 10**10)` inside a candidate agent took the control
// plane's memory rather than being rejected by it. "10 GB stdout" is one of the named cases in
// the sandbox escape suite; this is the same case arriving through the door marked "validation".

{
  const before = Date.now();
  const r = await sandbox.run({
    runtimeDir: RUNTIME_DIR,
    // An unbounded write loop, no newlines — nothing that only inspects completed lines sees it.
    args: ["-c", "import sys\nwhile True: sys.stdout.write('x' * 65536)"],
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024,
  });
  const elapsed = Date.now() - before;
  check("an unbounded writer is cut off rather than buffered whole", r.truncated);
  check("...and what was kept is bounded", r.stdout.length <= 1024 * 1024, `kept ${r.stdout.length} bytes`);
  check("...well before the check's own 30s deadline", !r.timedOut && elapsed < 25_000, `elapsed=${elapsed}ms`);
}

{
  // A flood on stderr is the same flood. The import check reads stderr for its rejection reason,
  // which is exactly the stream a hostile file would pick to grow.
  const r = await sandbox.run({
    runtimeDir: RUNTIME_DIR,
    args: ["-c", "import sys\nwhile True: sys.stderr.write('y' * 65536)"],
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024,
  });
  check("the cap covers stderr too", r.truncated && r.stderr.length <= 1024 * 1024);
}

{
  const r = await sandbox.run({ runtimeDir: RUNTIME_DIR, args: ["-c", "print('small')"], timeoutMs: 10_000 });
  check("an ordinary check is not marked truncated", !r.truncated && r.stdout.trim() === "small");
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
