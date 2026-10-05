// What a run's environment may hold, on both of the paths that build it.
//
// The Railway account token sits in `runtime/.env` beside the provider keys, and it can create and
// delete whole projects in somebody's hosting account. The process manager deleted it from a run's
// environment — and then the runner's own `.env` loader read it straight back out of the file,
// "loaded 1 var(s) from .env: RAILWAY_API_TOKEN", into generated code. A deployed agent's serve
// token is the same class: it spends that agent's provider key and belongs to no run.
//
// Python, so it runs in the runtime job.
//
//   npm run test:runner-env

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const SRC = dirname(fileURLToPath(import.meta.url));
const RUNTIME = resolve(SRC, "..", "..", "runtime");
const dir = mkdtempSync(join(tmpdir(), "jaroku-runner-env-"));
const envPath = join(dir, ".env");
writeFileSync(envPath, [
  "RAILWAY_API_TOKEN=railway-account-token",
  "JAROKU_DEPLOY_SVC_0A1B_SERVE_TOKEN=serve-token-of-another-agent",
  "ANTHROPIC_API_KEY=sk-ant-the-agents-own-key",
  "",
].join("\n"));

const script = [
  "import json, os",
  "from pathlib import Path",
  "from jaroku_interceptor.env import load_env",
  "names = load_env(Path(os.environ['ENV_FILE']), verbose=False)",
  "print(json.dumps({'loaded': names, 'railway': os.environ.get('RAILWAY_API_TOKEN'),",
  "  'serve': os.environ.get('JAROKU_DEPLOY_SVC_0A1B_SERVE_TOKEN'), 'own': os.environ.get('ANTHROPIC_API_KEY')}))",
].join("\n");

const env: NodeJS.ProcessEnv = { ...process.env, ENV_FILE: envPath };
delete env["RAILWAY_API_TOKEN"];
delete env["ANTHROPIC_API_KEY"];
const out = spawnSync("uv", ["run", "--directory", RUNTIME, "python", "-c", script], { env, encoding: "utf8" });
let parsed: { loaded: string[]; railway: string | null; serve: string | null; own: string | null } | null = null;
try {
  parsed = JSON.parse(out.stdout.trim().split("\n").at(-1) ?? "");
} catch {
  /* reported below */
}

check("the runner's loader ran", parsed !== null, `${out.stderr}\n${out.stdout}`);
check("an agent's own key is still loaded from the file", parsed?.own === "sk-ant-the-agents-own-key");
check("the Railway account token is never loaded into a run", parsed?.railway === null, JSON.stringify(parsed));
check("...nor another deployed agent's serve token", parsed?.serve === null, JSON.stringify(parsed));
check("...and neither is named as loaded", !parsed?.loaded.some((n) => n !== "ANTHROPIC_API_KEY"),
  JSON.stringify(parsed?.loaded));

// THE OTHER PATH: the process manager builds the environment the runner starts with. Read rather
// than run — starting it spawns a real agent — and the rule is one line that is easy to lose.
const manager = readFileSync(join(SRC, "processManager.ts"), "utf8");
check("the process manager strips the Railway token from a run's environment",
  /delete env\[RAILWAY_ENV_KEY\]/.test(manager));
check("...and every serve token", /JAROKU_DEPLOY_\[A-Z0-9_\]\+_SERVE_TOKEN/.test(manager) && /delete env\[name\]/.test(manager));

rmSync(dir, { recursive: true, force: true });
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
