// Writing a credential into runtime/.env.
//
// This is the only code in Jaroku that writes that file, and the file holds the user's
// Anthropic key and their database URL beside anything we put there. So the tests are less
// about the happy path than about the ways a write could damage something that was already
// correct — and about the one case where a token field becomes an injection vector.
//
//   npm run test:env-writer

import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authEnvKeyFor, clearEnvVar, setEnvVar } from "./envWriter.ts";
import { loadRuntimeEnv } from "./env.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const paths: string[] = [];
const tmpEnv = (contents: string): string => {
  const p = join(tmpdir(), `jaroku-env-${randomUUID()}`);
  writeFileSync(p, contents);
  paths.push(p);
  return p;
};

// A realistic file: comments, a blank line, a quoted value, keys that matter.
const ORIGINAL = `# Provider keys
ANTHROPIC_API_KEY=sk-ant-realkey

# The support agent needs this
DATABASE_URL="postgres://user:pw@host:5432/db"
SLACK_BOT_TOKEN=xoxb-123
`;

// --- 1. key derivation ----------------------------------------------------------------
{
  check("a key name is derived, never guessed",
    authEnvKeyFor("linear") === "JAROKU_MCP_LINEAR_TOKEN");
  check("punctuation is normalised out of the key name",
    authEnvKeyFor("my_server_2") === "JAROKU_MCP_MY_SERVER_2_TOKEN");
}

// --- 2. appending must not disturb what is already there -------------------------------
{
  const p = tmpEnv(ORIGINAL);
  const res = setEnvVar(p, "JAROKU_MCP_LINEAR_TOKEN", "lin_abc123");
  check("the write succeeds", res.ok);

  const after = readFileSync(p, "utf8");
  check("every original line survives verbatim",
    ORIGINAL.trimEnd().split("\n").every((l) => after.includes(l)),
    "an original line was lost or rewritten");
  check("the comments survive", after.includes("# The support agent needs this"));
  check("the new key is present", after.includes("JAROKU_MCP_LINEAR_TOKEN=lin_abc123"));
  check("the original ordering is preserved",
    after.indexOf("ANTHROPIC_API_KEY") < after.indexOf("DATABASE_URL"));
  check("it lands after the existing content, not in the middle",
    after.indexOf("JAROKU_MCP_LINEAR_TOKEN") > after.indexOf("SLACK_BOT_TOKEN"));

  // A file holding secrets should not be the one that is world-readable.
  check("the file is chmod 600", (statSync(p).mode & 0o777) === 0o600,
    (statSync(p).mode & 0o777).toString(8));

  // It has to be readable back by the loader that every other key goes through.
  delete process.env["JAROKU_MCP_LINEAR_TOKEN"];
  const loaded = loadRuntimeEnv(p);
  check("the loader reads it back", loaded.includes("JAROKU_MCP_LINEAR_TOKEN"));
  check("...with the right value", process.env["JAROKU_MCP_LINEAR_TOKEN"] === "lin_abc123");
}

// --- 3. a newline in a value is an injection vector, not a formatting problem -----------
{
  const p = tmpEnv(ORIGINAL);
  // Pasting this into a token field would otherwise rewrite the user's real API key.
  const attack = "harmless\nANTHROPIC_API_KEY=sk-ant-attacker";
  const res = setEnvVar(p, "JAROKU_MCP_EVIL_TOKEN", attack);

  check("a value containing a line break is refused", res.ok === false);
  check("...with a reason", (res.warning ?? "").includes("line break"));

  const after = readFileSync(p, "utf8");
  // The important assertion: refusing must also mean NOT WRITING. A partial write here
  // would be worse than the attack it was meant to stop.
  check("the file is byte-for-byte unchanged", after === ORIGINAL);
  check("the real API key is untouched", after.includes("ANTHROPIC_API_KEY=sk-ant-realkey"));
  check("the attacker's key was never written", !after.includes("sk-ant-attacker"));
  check("a carriage return is refused too",
    setEnvVar(p, "K", "a\rb").ok === false);
}

// --- 4. replacing an existing key ------------------------------------------------------
{
  const p = tmpEnv(ORIGINAL);
  setEnvVar(p, "JAROKU_MCP_LINEAR_TOKEN", "first");
  setEnvVar(p, "JAROKU_MCP_LINEAR_TOKEN", "second");

  const after = readFileSync(p, "utf8");
  const occurrences = after.split("\n").filter((l) => l.startsWith("JAROKU_MCP_LINEAR_TOKEN=")).length;
  check("rewriting a key does not duplicate it", occurrences === 1, `${occurrences} lines`);
  check("...and the new value is the one kept", after.includes("JAROKU_MCP_LINEAR_TOKEN=second"));
  check("...and the old value is gone", !after.includes("first"));
  check("only one header comment is ever added",
    after.split("# MCP server credentials").length - 1 === 1);

  // Rewriting an EXISTING unrelated key must also work in place — the header block is only
  // for keys we add, and someone may have moved ours by hand.
  setEnvVar(p, "SLACK_BOT_TOKEN", "xoxb-rotated");
  const after2 = readFileSync(p, "utf8");
  check("an existing key is rewritten where it already sits",
    after2.indexOf("SLACK_BOT_TOKEN") < after2.indexOf("# MCP server credentials"));
  check("...with its new value", after2.includes("SLACK_BOT_TOKEN=xoxb-rotated"));
  check("...and no duplicate",
    after2.split("\n").filter((l) => l.startsWith("SLACK_BOT_TOKEN=")).length === 1);
}

// --- 5. values that need quoting --------------------------------------------------------
{
  // The guarantee is not a formatting choice, it is this: whatever setEnvVar ACCEPTS comes
  // back byte-identical, and whatever it refuses is not written at all. A credential quietly
  // altered on the way to disk produces a 401 with no explanation anywhere.
  const p = tmpEnv("");
  const nasty: Record<string, string> = {
    K1: "plain-token_123",
    K2: "has spaces and # a hash",
    K3: 'contains " a double quote',
    K4: "contains ' a single quote",
    K5: "back\\slash",
    K6: "sk-ant-api03-aBc_1-2.3/xyz==",
    K7: `both ' and " quotes`,
    K8: "  leading and trailing spaces  ",
    K9: "=equals=everywhere=",
    K10: "# starts with a hash",
    K11: "export looks_like_a_prefix",
    K12: "unicode ✓ ünïcödé",
  };

  const accepted: Record<string, string> = {};
  for (const [k, v] of Object.entries(nasty)) {
    if (setEnvVar(p, k, v).ok) accepted[k] = v;
    else check(`${k} was refused rather than mangled`, !readFileSync(p, "utf8").includes(`${k}=`));
  }

  for (const k of Object.keys(nasty)) delete process.env[k];
  loadRuntimeEnv(p);
  for (const [k, v] of Object.entries(accepted)) {
    check(`${k} round-trips exactly: ${JSON.stringify(v).slice(0, 30)}`,
      process.env[k] === v,
      `wrote ${JSON.stringify(v)}, read ${JSON.stringify(process.env[k])}`);
  }
  check("a plain token is left unquoted, so the file stays hand-editable",
    readFileSync(p, "utf8").includes("K1=plain-token_123"));

  // The value has to survive the loader that actually runs the agent, too. env.py is a
  // deliberate mirror of env.ts; this proves the two agree about what WE write, which is
  // the only part either of them was not tested against before.
  {
    // Loaded by file path, not as a package: importing jaroku_interceptor pulls in
    // langchain_core, and this check must not need the runtime's dependencies installed.
    const script = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("jaroku_env", ${JSON.stringify(join(process.cwd(), "..", "runtime", "jaroku_interceptor", "env.py"))})
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
_parse_line = mod._parse_line
out = {}
for line in open(${JSON.stringify(p)}, encoding="utf-8").read().splitlines():
    parsed = _parse_line(line)
    if parsed: out[parsed[0]] = parsed[1]
print(json.dumps(out))
`;
    const proc = spawnSync("python3", ["-c", script], { encoding: "utf8" });
    if (proc.status !== 0) {
      console.log(`  skip python cross-check (${(proc.stderr || "python3 unavailable").trim().split("\n").pop()})`);
    } else {
      const fromPython = JSON.parse(proc.stdout) as Record<string, string>;
      for (const [k, v] of Object.entries(accepted)) {
        check(`${k} reads identically in env.py`, fromPython[k] === v,
          `node ${JSON.stringify(v)} vs python ${JSON.stringify(fromPython[k])}`);
      }
    }
  }
  for (const k of Object.keys(nasty)) delete process.env[k];
}

// --- 6. clearing ------------------------------------------------------------------------
{
  const p = tmpEnv(ORIGINAL);
  setEnvVar(p, "JAROKU_MCP_GONE_TOKEN", "bye");
  clearEnvVar(p, "JAROKU_MCP_GONE_TOKEN");

  const after = readFileSync(p, "utf8");
  check("clearing removes the line", !after.includes("JAROKU_MCP_GONE_TOKEN"));
  check("...and the value with it", !after.includes("bye"));
  check("...and leaves everything else", after.includes("ANTHROPIC_API_KEY=sk-ant-realkey"));
  check("...and unsets it in this process", process.env["JAROKU_MCP_GONE_TOKEN"] === undefined);
  // Disconnecting a credential should be a real action, not an orphaned line in a file.
  check("clearing something absent is not an error",
    (clearEnvVar(p, "NEVER_EXISTED"), true));
}

// --- 7. the precedence footgun ----------------------------------------------------------
{
  const p = tmpEnv("");
  // Simulate a key exported in the user's shell before the server started.
  process.env["JAROKU_MCP_SHADOWED_TOKEN"] = "from-the-shell";
  const res = setEnvVar(p, "JAROKU_MCP_SHADOWED_TOKEN", "from-the-ui");

  check("the write still succeeds", res.ok);
  check("the new value takes effect immediately",
    process.env["JAROKU_MCP_SHADOWED_TOKEN"] === "from-the-ui");
  // Without this warning, the token silently reverts on the next restart, because a
  // variable already in the environment beats the file on both sides by design.
  check("...but the user is warned it will revert on restart",
    (res.warning ?? "").includes("takes precedence"), res.warning ?? "no warning");

  // Writing our own key twice is not a foreign value and must not cry wolf.
  const again = setEnvVar(p, "JAROKU_MCP_SHADOWED_TOKEN", "from-the-ui-again");
  check("rewriting our own key does not warn", again.warning === null, again.warning ?? "");
  delete process.env["JAROKU_MCP_SHADOWED_TOKEN"];
}

// --- 8. nothing hands the value back ----------------------------------------------------
{
  const p = tmpEnv("");
  const res = setEnvVar(p, "JAROKU_MCP_SECRET_TOKEN", "s3cr3t-value");
  check("the result carries no credential",
    !JSON.stringify(res).includes("s3cr3t-value"), JSON.stringify(res));
  check("the key NAME reveals nothing about the value",
    !authEnvKeyFor("secret").includes("s3cr3t"));
  delete process.env["JAROKU_MCP_SECRET_TOKEN"];
}

for (const p of paths) rmSync(p, { force: true });
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
