// Post-generation validation. A generated project is text a model wrote; this is the gate
// that decides whether it is allowed to become a runnable agent.
//
// Runs against the STAGING directory, before the atomic swap. Any problem here means the
// staged project is discarded and whatever was previously at agents/<id>/ is untouched —
// a bad generation can never replace a working agent.
//
// These checks mirror the hard rules in prompt.ts. The prompt asks; this enforces.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import type { Manifest } from "./mcpManifest.ts";
import { LocalCodeCheckSandbox, type CodeCheckSandbox } from "./sandbox/codeCheck.ts";

/** Shared unless a caller injects its own — see codeCheck.ts's module comment on why the local
 *  path stays exactly what it was, and what a hosted implementation would replace this with. */
const defaultCodeCheckSandbox: CodeCheckSandbox = new LocalCodeCheckSandbox();

export interface ValidationResult {
  ok: boolean;
  problems: string[];
}

// EXPORTED SINCE §B.3, and the export is the point rather than a convenience. `liveDiagnostics.ts`
// runs the cheap half of this file against an unsaved buffer, 400ms after typing pauses, and it
// imports these patterns rather than restating them. Two copies of rule 3 would be two definitions
// of what "writes to stdout" means, and the day they drift the squiggle and the gate disagree —
// which is worse than having no squiggle, because a person would have learned to trust it.
//
// What is deliberately NOT shared is the DECISION. This file refuses a publish; that one annotates
// a line. §B.3.2 is explicit that a live diagnostic is advisory and changes only when a user learns
// about a problem, never what stops a bad file from being committed.
export const CONTRACT_CHECKS: Array<{ re: RegExp; missing: string }> = [
  { re: /^\s*def\s+build_graph\s*\(/m, missing: "def build_graph(llm)" },
  { re: /^\s*def\s+build_initial_state\s*\(/m, missing: "def build_initial_state(user_input)" },
];

// print(...) with no file= argument. Allows the documented print(..., file=sys.stderr).
export const BARE_PRINT = /(^|[^.\w])print\s*\((?![^)]*\bfile\s*=)/;
export const JAROKU_IMPORT = /^\s*(from|import)\s+jaroku/m;
export const MODEL_IMPORT = /^\s*from\s+langchain_(anthropic|openai)\s+import/m;
// ToolNode(...) anywhere, and whether it was given handle_tool_errors.
const TOOL_NODE = /ToolNode\s*\(/;
const TOOL_ERRORS_HANDLED = /ToolNode\s*\([^)]*handle_tool_errors\s*=\s*True/s;
const ENV_KEY = /os\.environ(?:\.get)?\s*[[(]\s*["']([A-Z0-9_]+)["']/g;

// Reviewed host-owned Python that can be in a project without the model having written it.
// Excluded from the model-output lints unconditionally rather than by the caller remembering:
// serve.py is a copied-in template that deliberately does two things a generated file may not
// — it constructs the model (it IS the injection point rule 2 exists to preserve) and it logs
// to stdout (nothing is reading a trace out there). Linting it would fail every edit made
// after an agent's first deploy, for code no model wrote.
const REVIEWED_HOST_PY = ["serve.py"];

/**
 * Every `.py` in the project, as a project-relative path with FORWARD SLASHES on every platform.
 *
 * The separator is the whole point of this comment. These paths are compared against `reviewed` —
 * the list of connector templates and host files that were copied in verbatim and must not be
 * validated as though a model had written them — and that list is built in `generator.ts` as
 * `` `tools/${c.file}` ``: a forward slash, hardcoded, on every platform. `relative()` answers with
 * the platform's own separator, so on Windows this returned `tools\postgres.py`, matched nothing in
 * `reviewed`, and every audited connector template was handed to the generated-code rules.
 *
 * What that looks like from the outside is not a path bug. It is rule 6 firing on the reviewed file
 * itself — "tools\postgres.py defines 'pg_query', which is the name of a reviewed connector tool" —
 * and the whole generation being refused and discarded. Any agent with a connector, on Windows.
 *
 * Normalised here, where the path is taken, rather than at each comparison: the same fix and the
 * same reasoning as the exemption map in `boundary.test.ts`.
 */
function pythonFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__pycache__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...pythonFiles(full, base));
    else if (entry.endsWith(".py")) out.push(relative(base, full).split(sep).join("/"));
  }
  return out;
}

/**
 * Analyze every .py file with Python's own parser: syntax, plus two defects that regexes
 * cannot see reliably and that a real generation actually produced.
 *
 *   * Calling one @tool from another. A decorated tool is a StructuredTool instance, so
 *     `other_tool(x)` raises TypeError at run time. Caught here because it is a guaranteed
 *     crash, not a style issue.
 *   * Interpolating values into SQL. Even against the read-only Postgres connector this is
 *     an injection vector: it cannot write, but a crafted input can widen a SELECT to rows
 *     the user was never meant to see.
 */
function analyzePython(
  runtimeDir: string,
  projectDir: string,
  toolNames: string[],
  reviewedFiles: string[],
  /** name -> { schema, server } for every MCP tool this agent's manifest grants. */
  mcpTools: Record<string, { schema: Record<string, unknown>; server: string }>,
  sandbox: CodeCheckSandbox = defaultCodeCheckSandbox,
): Promise<string[]> {
  const script = `
import ast, json, os, sys

root = sys.argv[1]
known_tools = set(json.loads(sys.argv[2]))
# Reviewed connector templates are copied in verbatim. They are audited once, by hand, and
# are not the model's output — linting them here only produces false positives.
reviewed = set(json.loads(sys.argv[3]))
# The agent's MCP grant, from its manifest: {name: {"schema": {...}, "server": "..."}}.
mcp_tools = json.loads(sys.argv[4])
problems = []
trees = {}
generated = {}

for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames if d != "__pycache__"]
    for name in filenames:
        if not name.endswith(".py"):
            continue
        path = os.path.join(dirpath, name)
        # FORWARD SLASHES, on every platform, for the same reason pythonFiles normalises: rel is
        # matched against "reviewed", which is built as "tools/<file>" with a hardcoded slash.
        # relpath answers with the platform separator, so on Windows nothing ever matched and
        # every audited connector template was linted as model output — which is rule 6 accusing
        # the reviewed file of shadowing its own reviewed tool, and the generation discarded.
        rel = os.path.relpath(path, root).replace(os.sep, "/")
        try:
            tree = ast.parse(open(path, encoding="utf-8").read(), filename=rel)
        except SyntaxError as e:
            problems.append(f"{rel}: syntax error line {e.lineno}: {e.msg}")
            continue
        except Exception as e:
            problems.append(f"{rel}: {type(e).__name__}: {e}")
            continue
        trees[rel] = tree
        if rel not in reviewed:
            generated[rel] = tree

def is_tool_decorated(node):
    for d in node.decorator_list:
        target = d.func if isinstance(d, ast.Call) else d
        name = getattr(target, "id", None) or getattr(target, "attr", None)
        if name == "tool":
            return True
    return False

# Every @tool defined anywhere in the project counts as a tool object.
for rel, tree in trees.items():
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and is_tool_decorated(node):
            known_tools.add(node.name)

# --- the reviewed tools must still be wired in -------------------------------------
#
# The connector template FILES are read-only, but the file that decides which tools the agent
# actually binds is not — it cannot be, because adding a bespoke tool means editing it. So the
# read-only flag protected the body of pg_query while leaving the line that exports it editable:
# drop the name from TOOLS, or shadow it with a same-named function elsewhere, and the agent
# silently loses a reviewed tool while its metadata, its plan card and its sidebar all still
# advertise the connector. The audit guarantee has to cover the wiring, not just the source.
reviewed_names = set(json.loads(sys.argv[2]))

# Names mentioned anywhere in a "TOOLS = <expr>" assignment, following one level of local
# variable so "TOOLS = CONNECTOR_TOOLS + [mine]" is understood.
#
# Computed unconditionally, because this describes what TOOLS binds and has nothing to do
# with connectors specifically — the MCP checks below need exactly the same answer.
wired, aliases = set(), {}
for rel, tree in trees.items():
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for tgt in node.targets:
                if isinstance(tgt, ast.Name):
                    aliases.setdefault(tgt.id, []).append(node.value)

def collect(expr, depth=0):
    for n in ast.walk(expr):
        if isinstance(n, ast.Name):
            wired.add(n.id)
            if depth < 1:
                for sub in aliases.get(n.id, []):
                    if sub is not expr:
                        collect(sub, depth + 1)

for expr in aliases.get("TOOLS", []):
    collect(expr)

if reviewed_names:
    # A tool defined outside its own reviewed file, under a reviewed name, is a shadow.
    for rel, tree in generated.items():
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in reviewed_names:
                problems.append(
                    f"{rel}:{node.lineno} defines '{node.name}', which is the name of a reviewed "
                    "connector tool — the agent would bind this instead of the audited one (rule 6)"
                )

    if aliases.get("TOOLS"):
        for name in sorted(reviewed_names - wired):
            problems.append(
                f"'{name}' is a reviewed connector tool for this agent but is no longer in TOOLS "
                "— the agent advertises the connector and cannot call it (rule 6)"
            )

# --- MCP: the manifest is the grant, and the schema is the contract ------------------
#
# Three checks, none of which the connector path needed because a connector's parameters were
# only ever a display string. A discovered MCP tool carries a real JSON Schema, so a bad call
# can be caught before the project is written rather than at runtime against someone else's
# server.
if mcp_tools:
    mcp_names = set(mcp_tools)

    # 1. WIRING. The bridge exposes MCP_TOOLS as a list, so unlike a connector there is no
    #    per-name symbol to look for — the whole grant is wired in or none of it is. An agent
    #    whose metadata advertises MCP tools it cannot call is the same lie the reviewed-tool
    #    wiring check exists to prevent.
    if aliases.get("TOOLS") and "MCP_TOOLS" not in wired:
        problems.append(
            "this agent is scoped to MCP tools (" + ", ".join(sorted(mcp_names)) +
            ") but MCP_TOOLS is not in TOOLS — it advertises them and cannot call them (rule 12)"
        )

    for rel, tree in generated.items():
        for node in ast.walk(tree):
            # 2. SHADOWING. A generated function under a granted tool's name would be bound
            #    instead of the real one, silently.
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in mcp_names:
                problems.append(
                    f"{rel}:{node.lineno} defines '{node.name}', which is the name of an MCP tool "
                    "this agent is scoped to — the agent would bind this instead of the real one (rule 12)"
                )

            # 3. ARGUMENTS. Only a literal dict passed to .invoke()/.ainvoke() can be checked
            #    statically. A dict built at runtime is left to the bridge's own check, which
            #    runs on every call — this catches the mistake early, it does not replace it.
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr in ("invoke", "ainvoke")
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id in mcp_names
                and node.args
                and isinstance(node.args[0], ast.Dict)
            ):
                tool_name = node.func.value.id
                schema = mcp_tools[tool_name].get("schema") or {}
                properties = schema.get("properties")
                required = schema.get("required")
                keys = []
                literal_keys = True
                for k in node.args[0].keys:
                    if isinstance(k, ast.Constant) and isinstance(k.value, str):
                        keys.append(k.value)
                    else:
                        literal_keys = False
                if literal_keys:
                    if isinstance(required, list):
                        missing = sorted(k for k in required if isinstance(k, str) and k not in keys)
                        if missing:
                            problems.append(
                                f"{rel}:{node.lineno} calls the MCP tool '{tool_name}' without its "
                                f"required argument(s): {', '.join(missing)} "
                                f"(the {mcp_tools[tool_name].get('server')} server declares them required)"
                            )
                    # Only when the server declared a property list. Silence about parameters
                    # is not a statement that none are allowed.
                    if isinstance(properties, dict) and properties:
                        unknown = sorted(k for k in keys if k not in properties)
                        if unknown:
                            problems.append(
                                f"{rel}:{node.lineno} passes {', '.join(unknown)} to the MCP tool "
                                f"'{tool_name}', which does not accept "
                                f"{'them' if len(unknown) > 1 else 'it'}. It accepts: "
                                f"{', '.join(sorted(properties))}"
                            )


def looks_like_sql(text):
    """Require actual query shape, not just a keyword.

    Error messages routinely mention SELECT or WHERE ("only SELECT queries are allowed",
    "narrow the WHERE clause"), so a bare keyword match flags reviewed, correct code. A
    real query pairs a verb with its clause.
    """
    t = " ".join(text.lower().split())
    return (
        ("select " in t and " from " in t)
        or "insert into" in t
        or "delete from" in t
        or ("update " in t and " set " in t)
    )

for rel, tree in generated.items():
    for node in ast.walk(tree):
        # tool called as a plain function
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            if node.func.id in known_tools:
                problems.append(
                    f"{rel}:{node.lineno} calls the tool '{node.func.id}()' directly — "
                    "a @tool is a StructuredTool object and is not callable (rule 9)"
                )
        # SQL assembled by interpolation
        if isinstance(node, ast.JoinedStr):
            literal = "".join(
                v.value.lower() for v in node.values if isinstance(v, ast.Constant) and isinstance(v.value, str)
            )
            if looks_like_sql(literal) and any(
                isinstance(v, ast.FormattedValue) for v in node.values
            ):
                problems.append(
                    f"{rel}:{node.lineno} builds SQL with an f-string — injection risk, "
                    "use a static query instead (rule 10)"
                )

print(json.dumps(problems))
`.trim();

  return sandbox
    .run({
      runtimeDir,
      args: ["-c", script, projectDir, JSON.stringify(toolNames), JSON.stringify(reviewedFiles), JSON.stringify(mcpTools)],
      // No timeout existed here before this commit — AST-walking our own script over a staged
      // project is near-instant, so this is a defensive ceiling rather than a behaviour change
      // anything legitimate could ever reach.
      timeoutMs: 30_000,
    })
    .then(({ stdout, stderr, spawnError, timedOut }) => {
      if (spawnError) return [`could not run the syntax check: ${spawnError}`];
      // Fail CLOSED. This used to read `out.trim() || "[]"`, which turned a crashed analysis
      // into an empty problem list — so a project whose static checks never ran was reported
      // as clean, and the import check then executed it. A check that cannot run is not a
      // check that passed.
      const text = stdout.trim();
      if (!text) {
        return [
          `the static analysis did not run${timedOut ? " (timed out)" : ""}` +
            (stderr.trim() ? `: ${stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300)}` : ""),
        ];
      }
      try {
        return JSON.parse(text) as string[];
      } catch {
        return [`syntax check failed to report: ${stderr.slice(0, 300)}`];
      }
    });
}

/**
 * Actually import the staged project, exactly as jaroku_runner will at run time.
 *
 * ast.parse only proves the file PARSES. A real generation shipped
 * `class AgentState(StateGraph.__bases__[0] ...)` — syntactically valid, but
 * "TypeError: Cannot inherit from plain Generic" the moment the module is imported, so
 * every run died at step 0 while validation had waved it through. Importing is the only
 * honest check for that class of defect (bad base classes, top-level exceptions, names
 * imported but never defined). Post-import we also verify the contract symbols are the
 * right kind of thing, mirroring jaroku_runner/contract.py.
 *
 * The import executes the project's top-level code — the same code the runner would
 * execute seconds later — inside the same uv venv, with stdout captured so a violation
 * of rule 3 at import time surfaces here instead of corrupting the event stream.
 */
function importCheck(
  runtimeDir: string,
  projectDir: string,
  sandbox: CodeCheckSandbox = defaultCodeCheckSandbox,
): Promise<string[]> {
  const script = `
import contextlib, importlib, io, json, os, sys, traceback

parent, module_name = sys.argv[1], sys.argv[2]
sys.path.insert(0, parent)
project_root = os.path.join(parent, module_name)
problems = []
buf = io.StringIO()
try:
    with contextlib.redirect_stdout(buf):
        mod = importlib.import_module(module_name + ".agent")
except BaseException as exc:
    loc = ""
    for frame in traceback.extract_tb(exc.__traceback__):
        if frame.filename.startswith(project_root):
            loc = f" ({os.path.relpath(frame.filename, project_root)}:{frame.lineno})"
    problems.append(
        f"the project fails to import{loc}: {type(exc).__name__}: {exc} — "
        "emit only final, working code (rule 11)"
    )
else:
    if not isinstance(getattr(mod, "TOOLS", None), (list, tuple)):
        problems.append("after import, TOOLS is missing or not a list")
    if not callable(getattr(mod, "build_graph", None)):
        problems.append("after import, build_graph is missing or not callable")
    if not callable(getattr(mod, "build_initial_state", None)):
        problems.append("after import, build_initial_state is missing or not callable")
out = buf.getvalue().strip()
if out:
    problems.append("importing the project wrote to stdout (rule 3): " + out[:120])
print(json.dumps(problems))
`.trim();

  return sandbox
    .run({
      runtimeDir,
      args: ["-c", script, dirname(projectDir), basename(projectDir)],
      // Top-level code can loop forever; a hung import must reject, not hang validation.
      timeoutMs: 20_000,
    })
    .then(({ stdout, stderr, spawnError, timedOut }) => {
      if (spawnError) return [`could not run the import check: ${spawnError}`];
      if (timedOut) return ["the project's import timed out after 20s — top-level code must not block"];
      try {
        return JSON.parse(stdout.trim() || "[]") as string[];
      } catch {
        return [`import check failed to report: ${stderr.slice(0, 300)}`];
      }
    });
}

/**
 * The manifest flattened to what the AST pass needs: name -> schema + which server.
 *
 * Null-prototype, because the keys are tool names an unreviewed server chose. On a normal
 * object literal `out["__proto__"] = …` reassigns the prototype and leaves no own property, so
 * that tool would silently drop out of the argument checks — and if it were the only one, the
 * serialised map would be `{}` and the Python side's `if mcp_tools:` would skip the wiring
 * check as well. mcpClient now refuses the name outright; this makes the map safe regardless of
 * what reaches it.
 */
function mcpToolMap(manifest?: Manifest): Record<string, { schema: Record<string, unknown>; server: string }> {
  const out: Record<string, { schema: Record<string, unknown>; server: string }> =
    Object.create(null);
  for (const server of manifest?.servers ?? []) {
    for (const tool of server.tools) {
      out[tool.name] = { schema: tool.input_schema, server: server.id };
    }
  }
  return out;
}

export async function validateProject(
  projectDir: string,
  opts: {
    runtimeDir: string;
    connectorFiles: string[];
    connectorToolNames?: string[];
    /**
     * The agent's MCP manifest, when it has one.
     *
     * Drives three checks a connector never needed, because a connector's parameters are a
     * display string while a discovered MCP tool carries a real JSON Schema — so a wrong
     * call can be caught before the project is written rather than at runtime against a
     * third party's server.
     */
    mcpTools?: Manifest;
    /**
     * Require ToolNode(..., handle_tool_errors=True) (rule 7).
     *
     * The connector templates raise when they cannot do their job, so the trace can show a failed
     * step instead of a green one containing an error. Without this argument on the tool node, that
     * raise ends the whole run — so the two halves have to ship together, and this is the half a
     * model could forget.
     *
     * Set on generation, where the project is being written fresh. On an edit it is set only when
     * the agent ALREADY had it, which makes this a don't-regress check: agents generated before
     * the templates started raising still have swallowing copies of those templates, are
     * internally consistent, and must stay editable.
     */
    requireToolErrorHandling?: boolean;
  },
): Promise<ValidationResult> {
  const problems: string[] = [];

  const agentPath = join(projectDir, "agent.py");
  if (!existsSync(agentPath)) {
    return { ok: false, problems: ["agent.py was not generated"] };
  }
  const agentSrc = readFileSync(agentPath, "utf8");

  // --- the contract ---------------------------------------------------------
  for (const { re, missing } of CONTRACT_CHECKS) {
    if (!re.test(agentSrc)) problems.push(`agent.py is missing ${missing}`);
  }
  if (opts.requireToolErrorHandling && TOOL_NODE.test(agentSrc) && !TOOL_ERRORS_HANDLED.test(agentSrc)) {
    problems.push(
      "agent.py builds ToolNode without handle_tool_errors=True — a tool that raises would end " +
        "the run instead of being reported to the model as a failed call (rule 7)",
    );
  }
  // TOOLS may be imported from .tools rather than defined inline.
  if (!/\bTOOLS\b/.test(agentSrc)) problems.push("agent.py never references TOOLS");

  // --- hard rules, across every generated file ------------------------------
  const reviewed = [...opts.connectorFiles, ...REVIEWED_HOST_PY];
  const generated = pythonFiles(projectDir).filter((f) => !reviewed.includes(f));
  for (const rel of generated) {
    const src = readFileSync(join(projectDir, rel), "utf8");

    if (JAROKU_IMPORT.test(src)) {
      problems.push(`${rel} imports jaroku — generated agents must not (rule 1)`);
    }
    if (MODEL_IMPORT.test(src)) {
      problems.push(`${rel} constructs a model — llm is injected into build_graph (rule 2)`);
    }
    src.split("\n").forEach((line, i) => {
      if (BARE_PRINT.test(line)) {
        problems.push(`${rel}:${i + 1} writes to stdout via print() (rule 3): ${line.trim()}`);
      }
    });
  }

  // --- secrets declared where the user can find them ------------------------
  const envExamplePath = join(projectDir, ".env.example");
  const envExample = existsSync(envExamplePath) ? readFileSync(envExamplePath, "utf8") : "";
  const referenced = new Set<string>();
  for (const rel of generated) {
    const src = readFileSync(join(projectDir, rel), "utf8");
    for (const m of src.matchAll(ENV_KEY)) referenced.add(m[1]!);
  }
  for (const key of referenced) {
    // JAROKU_* are host-supplied, not user-supplied secrets.
    if (key.startsWith("JAROKU_")) continue;
    if (!envExample.includes(key)) {
      problems.push(`${key} is read from the environment but is not in .env.example (rule 4)`);
    }
  }

  // --- parse + AST-level defects -------------------------------------------
  problems.push(
    ...(await analyzePython(
      opts.runtimeDir,
      projectDir,
      opts.connectorToolNames ?? [],
      reviewed,
      mcpToolMap(opts.mcpTools),
    )),
  );

  // --- the project must actually import -------------------------------------
  // Only reached when every cheaper check passed: we never execute code that is
  // already known to be bad, and a syntax error isn't reported twice.
  if (problems.length === 0) {
    problems.push(...(await importCheck(opts.runtimeDir, projectDir)));
  }

  return { ok: problems.length === 0, problems };
}
