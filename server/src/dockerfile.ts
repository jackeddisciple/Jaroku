// Deploy artifact synthesis — jaroku.json in, three files out. Pure: no I/O, no clock, no
// randomness, so what an image will contain is a value you can assert on in a test rather
// than a side effect you have to go and read off a disk.
//
// The three files, and why each exists:
//
//   Dockerfile      packages the project to run as a long-lived service
//   .dockerignore   keeps .env — and everything else that is not the project — out of the
//                   build context. This is the file that makes "no secret is ever baked into
//                   an image" a property rather than an intention.
//   pyproject.toml  the project's own dependency manifest. example_agent has carried one
//                   since the beginning with a comment promising the project is "export-
//                   ready: copy this directory out of Jaroku and it is a standalone uv/pip
//                   project" — and no GENERATED agent has ever had one. Writing it here
//                   makes that promise true for all of them, which is why deploy tooling
//                   strengthens portability instead of costing it.
//
// One layout fact everything below is built around: the project is put on sys.path, never
// pip-installed. runtime/pyproject.toml's hatch config does not package `agents`, so a naive
// `pip install .` produces an image where jaroku_runner imports fine and every agent fails to
// load. Copying the directory to /app/<agent_id>/ and running `python -m <agent_id>.serve`
// from /app is also what keeps the project's own relative imports (`from .tools import TOOLS`)
// and mcp_bridge.py's `__file__.parent.parent / "mcp_tools.json"` resolving exactly as they do
// locally.
//
// AND THE SAME TRICK, ONCE MORE, FOR JAROKU'S OWN CODE. The image now carries the interceptor
// and the runner (see VENDORED_RUNTIME_DIR), because serve.py starts a real `python -m
// jaroku_runner` rather than invoking a graph itself. They are vendored INSIDE the project, in
// a dot-directory, and reached through PYTHONPATH rather than by a second COPY or a `mv`:
//
//   * A dot-directory is invisible to `listProjectFiles`, which skips anything starting with a
//     dot. That is what keeps fifteen files of Jaroku's own source out of the user's file
//     browser and out of the version this deploy publishes — they are a build input, rebuilt
//     from the current runtime/ on every deploy, not part of anybody's agent.
//   * PYTHONPATH rather than a second COPY, because the build context IS the project directory:
//     a COPY of the packages plus the existing `COPY .` would put both in the image twice, and
//     a `RUN mv` to undo that writes them into a fresh layer, which costs the same bytes. One
//     copy, one environment variable, and `python -m jaroku_runner` resolves.

import type { Connector } from "./connectors.ts";
import { pipRequires } from "./connectors.ts";

/** Pinned rather than :latest — an image that builds today must build the same way tomorrow. */
const UV_IMAGE = "ghcr.io/astral-sh/uv:0.5.11";
/** Matches runtime/.python-version and pyproject.toml's requires-python. */
const PYTHON_IMAGE = "python:3.12-slim";

const BASE_REQUIRES = ["langgraph>=0.2.0", "langchain-core>=0.3.0"];

/**
 * The project-relative directory Jaroku's own reviewed packages are vendored into, and the
 * files that go in it. Named here rather than in deployArtifacts.ts because the Dockerfile's
 * PYTHONPATH and the vendoring step have to agree, and two spellings of the same path is how
 * an image builds cleanly and then cannot import the runner it was built to run.
 *
 * pricing.json is in the list for a reason that is easy to miss: `jaroku_interceptor/pricing.py`
 * resolves it as `__file__.parent.parent / "pricing.json"`, so shipping the package without the
 * table beside it does not fail — it degrades to "every model is unpriced", which is a deployed
 * run whose every step reports a null cost. That is the exact failure §7's cost rule exists to
 * prevent, arriving silently, through an omission nothing would have flagged.
 */
export const VENDORED_RUNTIME_DIR = ".jaroku";
export const VENDORED_RUNTIME_ENTRIES = ["jaroku_interceptor", "jaroku_runner", "pricing.json"];

/**
 * What the vendored runner adds to the image's dependency closure, over what a project already
 * installs to run its own graph.
 *
 * ONE PACKAGE, and it is a runtime import rather than an import-time one, which is why it has
 * to be worked out rather than read off the import list: `jaroku_runner/debug.py` imports
 * `langgraph.checkpoint.sqlite` inside `_open_saver`, at the moment a run starts. Without it the
 * image builds, the container starts, `/health` answers, and the first `POST /run` fails on an
 * ImportError several frames into a run — which is the shape of failure this whole section of
 * the spec is about. The sandbox image gets it from `uv sync --extra hosted`; a synthesised
 * image has no lock to sync from and names it.
 *
 * NOT the postgres checkpointer and NOT psycopg. `JAROKU_CHECKPOINTER` is unset in a deployed
 * container, debug.py's own error names the extra if anybody sets it, and installing psycopg's
 * binary wheel into every deployed agent would be tens of megabytes for a code path that a
 * deploy never takes. Same judgement `deployRequires` already makes about the connectors extra.
 */
const RUNNER_REQUIRES = ["langgraph-checkpoint-sqlite>=2.0.0"];

const PROVIDER_REQUIRES: Record<string, string> = {
  anthropic: "langchain-anthropic>=0.3.0",
  openai: "langchain-openai>=0.2.0",
};

/** The MCP bridge's own dependency, from runtime/pyproject.toml's `connectors` extra. */
const MCP_REQUIRES = "mcp>=1.9.0";

/**
 * What a dependency is allowed to look like: a PEP 508 name, optional extras, optional
 * version specifiers. Nothing else — no spaces, no quotes, no shell.
 *
 * The requirements are interpolated into a `RUN uv pip install "…"` line, which is a shell
 * command that runs as root while an image is built. A value containing a double quote closes
 * the string and everything after it is a command; a value containing a newline ends the
 * instruction and starts a new one. They come from a catalog we control today, which is
 * exactly the argument that stops being true the first time somebody adds a connector.
 */
const SAFE_REQUIREMENT =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._-]+\])?(\s*(==|>=|<=|~=|!=|<|>)\s*[A-Za-z0-9._*+!-]+)?(\s*,\s*(==|>=|<=|~=|!=|<|>)\s*[A-Za-z0-9._*+!-]+)*$/;

export function isSafeRequirement(requirement: string): boolean {
  return SAFE_REQUIREMENT.test(requirement);
}

export interface ArtifactInput {
  agentId: string;
  /** The agent's own metadata. `connectors` and `mcp_servers` decide the dependency set. */
  connectors: string[];
  hasMcpTools: boolean;
  /** What the deployed instance will run on. Decides which provider SDK is installed. */
  provider: string;
  description?: string;
}

export interface DeployArtifacts {
  /** Project-relative path -> contents. Exactly the set projectFs.DEPLOY_ARTIFACTS names. */
  files: Record<string, string>;
  /** The computed dependency list, exposed so a caller can show it before building. */
  requires: string[];
}

/**
 * Everything a deployed image installs, in a stable order: base LangGraph, the one provider
 * SDK it will actually use, each selected connector's requirements, and the MCP client if the
 * agent has a manifest.
 *
 * Deliberately NOT the whole `connectors` extra. An agent with one Postgres tool installing
 * the Google API client is size and attack surface for code it cannot reach.
 */
export function deployRequires(
  input: Pick<ArtifactInput, "connectors" | "hasMcpTools" | "provider">,
  catalog: Connector[],
): string[] {
  const selected = catalog.filter((c) => input.connectors.includes(c.id));
  const out = [...BASE_REQUIRES, ...RUNNER_REQUIRES];

  const provider = PROVIDER_REQUIRES[input.provider];
  // An unknown provider contributes nothing rather than guessing at a package name. serve.py
  // refuses to start on one anyway, so the deploy is already going to be stopped upstream —
  // this just declines to make up a dependency on the way there.
  if (provider) out.push(provider);

  for (const req of pipRequires(selected)) if (!out.includes(req)) out.push(req);
  if (input.hasMcpTools && !out.includes(MCP_REQUIRES)) out.push(MCP_REQUIRES);

  // Refused rather than escaped. A requirement that needs escaping to be safe here is not a
  // requirement — it is a mistake in the catalog, and installing a mangled version of it
  // would be worse than saying so.
  const unsafe = out.filter((r) => !isSafeRequirement(r));
  if (unsafe.length) {
    throw new Error(
      `refusing to build an image from ${unsafe.length} malformed requirement(s): ` +
        `${unsafe.map((r) => JSON.stringify(r)).join(", ")}. ` +
        `Check pip_requires in runtime/tool_templates/catalog.json.`,
    );
  }
  return out;
}

function renderDockerfile(input: ArtifactInput, requires: string[]): string {
  const installArgs = requires.map((r) => `      "${r}"`).join(" \\\n");
  return `# Generated by Jaroku for the agent "${input.agentId}". Host-owned: regenerated on
# every deploy, so edit the agent rather than this file.
#
# The project is put on sys.path, not pip-installed. Jaroku's runtime package does not ship
# \`agents\` in its wheel, so installing would produce an image in which the agent cannot be
# imported at all. Copying the directory and running it as a package also keeps its relative
# imports and its mcp_tools.json lookup resolving exactly as they do locally.
FROM ${PYTHON_IMAGE}

# uv rather than pip: same resolver the project is developed against, and much faster.
COPY --from=${UV_IMAGE} /uv /usr/local/bin/uv

WORKDIR /app

# Dependencies as their own layer, so editing the agent does not reinstall the world.
RUN uv pip install --system --no-cache \\
${installArgs}

# The build context is the project directory; .dockerignore keeps .env out of it. This also
# carries ${VENDORED_RUNTIME_DIR}/, which holds Jaroku's own reviewed packages — the interceptor and the
# runner — vendored into the project at deploy time exactly as serve.py and the connector
# templates already are.
COPY . /app/${input.agentId}/

# PYTHONPATH is what makes \`python -m jaroku_runner\` resolve from /app without a second copy of
# it in the image. serve.py starts that as a subprocess per request and it inherits this.
#
# JAROKU_MCP_CONFIRM=require: no Jaroku session is watching out here unless a dispatch says
# otherwise, and a high-impact tool must not run because nobody could be asked. Fail closed.
ENV PYTHONUNBUFFERED=1 \\
    PYTHONDONTWRITEBYTECODE=1 \\
    PORT=8080 \\
    PYTHONPATH=/app/${input.agentId}/${VENDORED_RUNTIME_DIR} \\
    JAROKU_MCP_CONFIRM=require

# Nothing here needs root, and a compromised agent should not have it.
RUN useradd --uid 10001 --create-home app && chown -R app /app
USER app

EXPOSE 8080
CMD ["python", "-m", "${input.agentId}.serve"]
`;
}

function renderDockerignore(): string {
  return `# Generated by Jaroku. Host-owned: regenerated on every deploy.
#
# The first line is the one that matters. Secrets reach a deployed agent as environment
# variables set on the host, never baked into a layer — and an image layer is forever, so a
# key that lands in one is a key that has to be rotated, not deleted. Everything else here is
# ordinary noise that would only make the build slower.
.env
.env.*
!.env.example

#
# ${VENDORED_RUNTIME_DIR}/ IS DELIBERATELY NOT LISTED. It holds the interceptor and the runner, and the
# image needs both — it is the one dot-directory here that is cargo rather than noise.
__pycache__/
**/__pycache__/
*.py[cod]
**/*.py[cod]
.venv/
venv/
.pytest_cache/
.mypy_cache/
.ruff_cache/

.git/
.gitignore
.DS_Store

# Jaroku's own working directories, if a project is ever built from inside the checkout.
.checkpoints/
.staging/
.history/
`;
}

function renderPyproject(input: ArtifactInput, requires: string[]): string {
  // Hyphens, because a PyPI project name may not contain underscores by convention, while the
  // agent id (a Python package name) must not contain hyphens. Both spellings are correct in
  // their own place; this is the one point they meet.
  const projectName = input.agentId.replace(/_/g, "-");
  const description = (input.description ?? "").trim().replace(/\s+/g, " ").slice(0, 200);
  const deps = requires.map((r) => `    "${r}",`).join("\n");
  return `# Generated by Jaroku for the agent "${input.agentId}". Host-owned: regenerated on
# every deploy, so edit the agent rather than this file.
#
# This is what makes the project standalone. Copy this directory out of Jaroku and it is an
# ordinary uv/pip project: \`uv sync\` then \`python -m ${input.agentId}.serve\` from the
# directory above, or \`docker build .\`. Jaroku itself runs the agent in its shared runtime
# venv and does not read this file.
[project]
name = "${projectName}"
version = "0.1.0"
${description ? `description = ${JSON.stringify(description)}\n` : ""}requires-python = ">=3.12"
dependencies = [
${deps}
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
`;
}

/**
 * The three synthesised artifacts. serve.py is not here: it is a reviewed template copied
 * byte-for-byte, never rendered, for the same reason connector templates are not generated.
 */
export function buildArtifacts(input: ArtifactInput, catalog: Connector[]): DeployArtifacts {
  const requires = deployRequires(input, catalog);
  return {
    requires,
    files: {
      Dockerfile: renderDockerfile(input, requires),
      ".dockerignore": renderDockerignore(),
      "pyproject.toml": renderPyproject(input, requires),
    },
  };
}
