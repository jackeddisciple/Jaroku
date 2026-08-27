// What is actually inside a synthesised deploy image — the suite §5 asks for.
//
//   npm run test:deploy-image
//
// Every assertion here is about a failure that a build would NOT catch. An image missing the
// runner builds cleanly, starts cleanly, answers /health, and fails on the first request with
// an ImportError several frames deep. An image missing `langgraph-checkpoint-sqlite` does the
// same, a little later. An image missing `pricing.json` does not fail at all — it reports every
// step's cost as null, forever, which is the one outcome §7's cost rule is written to prevent.
//
// So this reads the synthesised artifacts and the staged directory rather than building
// anything: what an image will contain is a value dockerfile.ts computes, and staging is where
// the vendoring lands. Neither needs Docker, which this machine does not have and CI does not
// want on the server job.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildArtifacts, deployRequires, VENDORED_RUNTIME_DIR, VENDORED_RUNTIME_ENTRIES } from "./dockerfile.ts";
import { writeDeployArtifacts } from "./deployArtifacts.ts";
import { loadConnectors } from "./connectors.ts";
import { listProjectFiles, DEPLOY_ARTIFACTS } from "./projectFs.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL_RUNTIME = join(REPO, "runtime");
const catalog = loadConnectors(REAL_RUNTIME);

// --- the Dockerfile itself ------------------------------------------------------------

{
  const { files, requires } = buildArtifacts(
    { agentId: "a_test_agent", connectors: [], hasMcpTools: false, provider: "anthropic" },
    catalog,
  );
  const dockerfile = files["Dockerfile"]!;

  // The runner is reached through PYTHONPATH rather than a second COPY — see dockerfile.ts on
  // why. What matters to a reader here is only that the path it names and the path the
  // vendoring writes to are the same string, which is what a constant shared by both buys.
  check(
    "the image puts the vendored runtime on PYTHONPATH",
    dockerfile.includes(`PYTHONPATH=/app/a_test_agent/${VENDORED_RUNTIME_DIR}`),
    dockerfile.split("\n").filter((l) => l.includes("PYTHONPATH")).join(" | "),
  );
  check(
    "...and the vendored directory rides in on the project's own COPY",
    /COPY \. \/app\/a_test_agent\//.test(dockerfile),
  );
  check(
    "the container still runs serve.py as the project's own module",
    dockerfile.includes('CMD ["python", "-m", "a_test_agent.serve"]'),
  );

  // THE DEPENDENCY CLOSURE. `debug.py` imports the sqlite checkpointer at run time, not import
  // time, so nothing about the image's build would ever surface its absence.
  check(
    "the closure includes the checkpointer the runner opens per run",
    requires.some((r) => r.startsWith("langgraph-checkpoint-sqlite")),
    requires.join(", "),
  );
  check(
    "...and every requirement lands in the install line",
    requires.every((r) => dockerfile.includes(`"${r}"`)),
  );
  // AND WHAT IT DOES NOT PULL IN. psycopg's binary wheel is tens of megabytes for a code path a
  // deploy never takes: JAROKU_CHECKPOINTER is unset out there and debug.py names the extra by
  // hand if anybody sets it.
  check(
    "the postgres checkpointer and psycopg stay out of a deployed image",
    !requires.some((r) => r.startsWith("langgraph-checkpoint-postgres") || r.startsWith("psycopg")),
    requires.join(", "),
  );
  check(
    "the vendored directory is not ignored out of the build context",
    !files[".dockerignore"]!.split("\n").some((l) => l.trim() === `${VENDORED_RUNTIME_DIR}/`),
  );
  check(
    "pyproject.toml declares the same closure the image installs",
    requires.every((r) => files["pyproject.toml"]!.includes(`"${r}",`)),
  );
}

{
  // The refusal §5 says stays. A malformed requirement is refused outright rather than escaped
  // into a `RUN uv pip install` line that runs as root while the image is built.
  let refused = false;
  try {
    deployRequires({ connectors: ["evil"], hasMcpTools: false, provider: "anthropic" }, [
      { id: "evil", pip_requires: ['x"; rm -rf /'] } as never,
    ]);
  } catch { refused = true; }
  check("a requirement that would break out of the Dockerfile is still refused outright", refused);
}

// --- the vendoring, against a real project on disk ------------------------------------

const scratch = mkdtempSync(join(tmpdir(), "jaroku-deploy-image-"));
const runtimeDir = join(scratch, "runtime");
const agentId = "a_vendoring_agent";
const projectDir = join(runtimeDir, "agents", agentId);

/** A minimal but real project directory, plus the pieces `writeDeployArtifacts` reads. */
function seedProject(): void {
  rmSync(runtimeDir, { recursive: true, force: true });
  mkdirSync(join(projectDir, "tools"), { recursive: true });
  writeFileSync(join(projectDir, "agent.py"), "TOOLS = []\n", "utf8");
  writeFileSync(join(projectDir, "__init__.py"), "", "utf8");
  writeFileSync(join(projectDir, "jaroku.json"), JSON.stringify({ connectors: [] }), "utf8");
  // The reviewed templates the writer copies, and the real runtime packages it vendors. Copied
  // from the checkout rather than faked: the point of the assertion below is that the BYTES
  // match, which a stub would make vacuous.
  mkdirSync(join(runtimeDir, "tool_templates"), { recursive: true });
  writeFileSync(
    join(runtimeDir, "tool_templates", "serve.py"),
    readFileSync(join(REAL_RUNTIME, "tool_templates", "serve.py"), "utf8"),
    "utf8",
  );
  writeFileSync(
    join(runtimeDir, "tool_templates", "catalog.json"),
    readFileSync(join(REAL_RUNTIME, "tool_templates", "catalog.json"), "utf8"),
    "utf8",
  );
}

seedProject();
// The interceptor, the runner and the pricing table come from the real checkout, since the
// whole question is whether the real ones arrive intact.
for (const entry of VENDORED_RUNTIME_ENTRIES) {
  const from = join(REAL_RUNTIME, entry);
  const to = join(runtimeDir, entry);
  const { cpSync } = await import("node:fs");
  cpSync(from, to, { recursive: true, filter: (src) => !src.includes("__pycache__") });
}

{
  const written = writeDeployArtifacts({ runtimeDir, agentId, provider: "anthropic" });

  check(
    "the interceptor and the runner land in the project's build context",
    existsSync(join(projectDir, VENDORED_RUNTIME_DIR, "jaroku_runner", "__main__.py")) &&
      existsSync(join(projectDir, VENDORED_RUNTIME_DIR, "jaroku_interceptor", "callback.py")),
  );
  // THE ONE THAT FAILS SILENTLY IN PRODUCTION. pricing.py resolves the table as
  // `__file__.parent.parent / "pricing.json"`, so without it beside the package every model is
  // unpriced and every deployed step reports a null cost — no error, no warning, a whole
  // deployed agent whose spend is unknown.
  check(
    "...and so does the pricing table the interceptor resolves beside them",
    existsSync(join(projectDir, VENDORED_RUNTIME_DIR, "pricing.json")),
  );
  check(
    "the runner arrives byte-for-byte, not rendered",
    readFileSync(join(projectDir, VENDORED_RUNTIME_DIR, "jaroku_runner", "__main__.py"), "utf8") ===
      readFileSync(join(REAL_RUNTIME, "jaroku_runner", "__main__.py"), "utf8"),
  );
  check(
    "compiled bytecode from this machine's interpreter is filtered out",
    !existsSync(join(projectDir, VENDORED_RUNTIME_DIR, "jaroku_runner", "__pycache__")),
  );
  check(
    "the deploy reports what it vendored and what it cost",
    written.vendored.length > 10 && written.vendoredBytes > 0 &&
      written.vendored.every((p) => p.startsWith(`${VENDORED_RUNTIME_DIR}/`)),
    `${written.vendored.length} file(s), ${written.vendoredBytes} bytes`,
  );

  // A DOT-DIRECTORY, AND THAT IS THE WHOLE REASON IT IS ONE. `listProjectFiles` skips anything
  // starting with a dot, so fifteen files of Jaroku's own source stay out of the user's file
  // browser and out of the version this deploy publishes. Put them at the project root instead
  // and every agent's file list grows Jaroku's runtime.
  const listed = listProjectFiles(projectDir, []).map((f) => f.path);
  check(
    "none of the vendored runtime shows up as the user's project files",
    !listed.some((p) => p.startsWith(`${VENDORED_RUNTIME_DIR}/`)),
    listed.filter((p) => p.startsWith(".")).join(", "),
  );
  check(
    "the four deploy artifacts are still exactly what is written",
    [...DEPLOY_ARTIFACTS].sort().join(",") === written.paths.join(","),
  );
}

{
  // ALL-OR-NOTHING, WITH TWO MORE DIRECTORIES IN IT. §5 is explicit that the property must
  // hold, so it is exercised the only way it can be: make the write fail, and prove the project
  // is byte-identical afterwards — including having no half-vendored runtime in it.
  seedProject();
  const before = listProjectFiles(projectDir, []).map((f) => `${f.path}:${f.content.length}`).join("|");
  let refused = false;
  try {
    // No runtime packages to vendor this time — seedProject() does not copy them.
    writeDeployArtifacts({ runtimeDir: join(scratch, "runtime-missing"), agentId, provider: "anthropic" });
  } catch { refused = true; }
  try {
    writeDeployArtifacts({ runtimeDir, agentId, provider: "anthropic" });
  } catch { refused = true; }
  const after = listProjectFiles(projectDir, []).map((f) => `${f.path}:${f.content.length}`).join("|");
  check("a deploy that cannot vendor the runtime refuses rather than shipping without it", refused);
  check("...and leaves the project exactly as it was", before === after, `${before}\n  vs\n  ${after}`);
  check(
    "...with no half-written vendored directory left behind",
    !existsSync(join(projectDir, VENDORED_RUNTIME_DIR)),
  );
  check(
    "...and no staging directory orphaned",
    !existsSync(join(runtimeDir, "agents", ".staging", `${agentId}__deploy`)),
  );
}

rmSync(scratch, { recursive: true, force: true });
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
