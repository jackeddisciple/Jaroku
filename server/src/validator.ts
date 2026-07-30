// Post-generation validation. A generated project is text a model wrote; this is the gate
// that decides whether it is allowed to become a runnable agent.
//
// Runs against the STAGING directory, before the atomic swap. Any problem here means the
// staged project is discarded and whatever was previously at agents/<id>/ is untouched —
// a bad generation can never replace a working agent.
//
// These checks mirror the hard rules in prompt.ts. The prompt asks; this enforces.

import { spawn } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

export interface ValidationResult {
  ok: boolean;
  problems: string[];
}

const CONTRACT_CHECKS: Array<{ re: RegExp; missing: string }> = [
  { re: /^\s*def\s+build_graph\s*\(/m, missing: "def build_graph(llm)" },
  { re: /^\s*def\s+build_initial_state\s*\(/m, missing: "def build_initial_state(user_input)" },
];

// print(...) with no file= argument. Allows the documented print(..., file=sys.stderr).
const BARE_PRINT = /(^|[^.\w])print\s*\((?![^)]*\bfile\s*=)/;
const JAROKU_IMPORT = /^\s*(from|import)\s+jaroku/m;
const MODEL_IMPORT = /^\s*from\s+langchain_(anthropic|openai)\s+import/m;
// ToolNode(...) anywhere, and whether it was given handle_tool_errors.
const TOOL_NODE = /ToolNode\s*\(/;
const TOOL_ERRORS_HANDLED = /ToolNode\s*\([^)]*handle_tool_errors\s*=\s*True/s;
const ENV_KEY = /os\.environ(?:\.get)?\s*[[(]\s*["']([A-Z0-9_]+)["']/g;

function pythonFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__pycache__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...pythonFiles(full, base));
    else if (entry.endsWith(".py")) out.push(relative(base, full));
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
): Promise<string[]> {
  const script = `
import ast, json, os, sys

root = sys.argv[1]
known_tools = set(json.loads(sys.argv[2]))
# Reviewed connector templates are copied in verbatim. They are audited once, by hand, and
# are not the model's output — linting them here only produces false positives.
reviewed = set(json.loads(sys.argv[3]))
problems = []
trees = {}
generated = {}

for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames if d != "__pycache__"]
    for name in filenames:
        if not name.endswith(".py"):
            continue
        path = os.path.join(dirpath, name)
        rel = os.path.relpath(path, root)
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

  return new Promise((resolve) => {
    const child = spawn(
      "uv",
      ["run", "python", "-c", script, projectDir, JSON.stringify(toolNames), JSON.stringify(reviewedFiles)],
      {
        cwd: runtimeDir,
        env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}` },
      },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve([`could not run the syntax check: ${e.message}`]));
    child.on("exit", () => {
      try {
        resolve(JSON.parse(out.trim() || "[]"));
      } catch {
        resolve([`syntax check failed to report: ${err.slice(0, 300)}`]);
      }
    });
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
function importCheck(runtimeDir: string, projectDir: string): Promise<string[]> {
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

  return new Promise((resolve) => {
    const child = spawn(
      "uv",
      ["run", "python", "-c", script, dirname(projectDir), basename(projectDir)],
      {
        cwd: runtimeDir,
        env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}` },
      },
    );
    // Top-level code can loop forever; a hung import must reject, not hang validation.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(["the project's import timed out after 20s — top-level code must not block"]);
    }, 20_000);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve([`could not run the import check: ${e.message}`]);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out.trim() || "[]"));
      } catch {
        resolve([`import check failed to report: ${err.slice(0, 300)}`]);
      }
    });
  });
}

export async function validateProject(
  projectDir: string,
  opts: {
    runtimeDir: string;
    connectorFiles: string[];
    connectorToolNames?: string[];
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
  const generated = pythonFiles(projectDir).filter((f) => !opts.connectorFiles.includes(f));
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
      opts.connectorFiles,
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
