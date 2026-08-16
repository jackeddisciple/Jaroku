// The validator, running on a buffer nobody has saved yet.
//
// §B.3's premise: the eleven hard rules and the AST checks on top of them already exist as static
// analysis, and today they run ONCE, at commit or generation time, and report failure as a block of
// text. Nothing about them requires that. The cheap half is cheap enough to run on pause, which
// turns "you will find out at commit" into "you can see it as you type" — without touching what
// gates a commit.
//
// THE RULES ARE IMPORTED, NEVER RESTATED. `validator.ts` exports its patterns for this file, and
// the AST script below is the same script's relevant half. That is the single most important
// property here: a squiggle that said something the gate does not say, or stayed silent about
// something the gate refuses, would be worse than no squiggle at all — because a person would have
// learned to trust it, and would then be surprised at the moment it costs the most.
//
// WHAT RUNS LIVE AND WHAT DOES NOT, from §B.3.1's table:
//
//   regex rules (1-3, bare print)                near-zero    live, 400ms after typing pauses
//   AST structural checks (rules 9, 10)          cheap        live, same debounce
//   contract checks (build_graph, TOOLS)         cheap        live
//   sandboxed import, 20s timeout                expensive    COMMIT TIME ONLY
//
// The import check is exactly the one v0.1.0's changelog calls out as catching what AST parsing
// alone cannot — `class AgentState(StateGraph.__bases__[0] …)`, syntactically valid, fails on
// import. Running it on every keystroke would be slow AND would quietly change the ordering
// principle §3/§4 states out loud: cheapest checks first, import only reached once everything
// cheaper has passed. So it is absent here, and its absence is the design.
//
// EVERY DIAGNOSTIC IS ADVISORY. Nothing in this file blocks typing, saving, or staging a file
// mid-edit — the file might be half-written, and a linter that fought a person mid-sentence is a
// linter they turn off. What blocks is exactly what blocked before this existed: Commit & Push, and
// the ✦ generate path for a hand-staged subset, both of which route through the real validator.

import { BARE_PRINT, CONTRACT_CHECKS, JAROKU_IMPORT, MODEL_IMPORT } from "./validator.ts";
import { LocalCodeCheckSandbox, type CodeCheckSandbox } from "./sandbox/codeCheck.ts";

/** Shared unless a caller injects its own — the same arrangement `validator.ts` makes. */
const defaultCodeCheckSandbox: CodeCheckSandbox = new LocalCodeCheckSandbox();

/**
 * One squiggle.
 *
 * `line` IS ONE-BASED because that is what an editor shows, matching `scan.ts`'s ScanHit and every
 * problem string the real validator emits. `column` is one-based for the same reason and is
 * optional: a rule about a whole file — "agent.py never references TOOLS" — has no column, and
 * pointing at character 1 would draw a squiggle under an unrelated token.
 */
export interface Diagnostic {
  path: string;
  line: number;
  column?: number;
  endColumn?: number;
  /**
   * The rule number, when the check is one of the eleven, so the panel can render "rule 10" exactly
   * as §B.3's mock does. Null for the contract checks, which are not numbered rules — they are the
   * contract, and calling them rule 12 would invent a number the prompt does not use.
   */
  rule: number | null;
  message: string;
  /**
   * ALWAYS `"warning"`, and it is a field rather than a constant so the type says so at every call
   * site. §B.3.2: a live diagnostic is advisory. There is no `"error"` here because there is no
   * severity at which this surface stops something, and offering one would be the first step to a
   * second gate that disagrees with the real one.
   */
  severity: "warning";
}

/** How long after the last keystroke the cheap checks run. §B.3.1's number, named once. */
export const DEBOUNCE_MS = 400;

/**
 * The largest buffer this will analyse.
 *
 * `projectFs` caps a project file at 200 KB, so this is the same ceiling stated where the work
 * happens. A buffer over it gets no diagnostics rather than a slow editor — and gets them again at
 * commit time from the real validator, which has a budget for it.
 */
const MAX_SOURCE_BYTES = 200_000;

/**
 * The regex half. Pure, synchronous, and the same three patterns the gate uses.
 *
 * PER LINE FOR `print`, WHOLE-FILE FOR THE IMPORTS, matching `validateProject` exactly: rule 3 is
 * about a statement and wants the line it is on, while rules 1 and 2 are about a file importing
 * something and the useful location is the import itself. Finding that line here rather than
 * reporting line 1 is the one thing this adds over the gate's own output, and it is what makes a
 * squiggle possible at all.
 */
export function regexDiagnostics(path: string, source: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const lines = source.split("\n");

  for (const [i, line] of lines.entries()) {
    if (BARE_PRINT.test(line)) {
      const at = line.indexOf("print");
      out.push({
        path,
        line: i + 1,
        ...(at >= 0 ? { column: at + 1, endColumn: at + 6 } : {}),
        rule: 3,
        message: "writes to stdout via print() — the trace is the output channel (rule 3)",
        severity: "warning",
      });
    }
    // Matched per line so the squiggle lands on the import, not on the file. The patterns are
    // anchored with `^` under /m, which is per-line behaviour applied to a single line here.
    if (JAROKU_IMPORT.test(line)) {
      out.push({
        path,
        line: i + 1,
        column: 1,
        endColumn: line.length + 1,
        rule: 1,
        message: "imports jaroku — a generated agent must not (rule 1)",
        severity: "warning",
      });
    }
    if (MODEL_IMPORT.test(line)) {
      out.push({
        path,
        line: i + 1,
        column: 1,
        endColumn: line.length + 1,
        rule: 2,
        message: "constructs a model — llm is injected into build_graph (rule 2)",
        severity: "warning",
      });
    }
  }
  return out;
}

/**
 * The contract half: the two functions and the one name `agent.py` has to have.
 *
 * ONLY FOR `agent.py`, because the contract is about that file and nothing else. Running it against
 * `tools/weather.py` would report a missing `build_graph` on every tool module in the project,
 * which is the false-positive-trains-people-to-ignore-it failure `mcpImpact.ts` names at length in
 * a different context.
 *
 * REPORTED AT LINE 1 WITH NO COLUMN, because "this file is missing something" is not about a
 * location. The panel renders it in the PROBLEMS list and draws nothing in the gutter.
 */
export function contractDiagnostics(path: string, source: string): Diagnostic[] {
  if (!/(^|\/)agent\.py$/.test(path)) return [];
  const out: Diagnostic[] = [];
  for (const { re, missing } of CONTRACT_CHECKS) {
    if (!re.test(source)) {
      out.push({ path, line: 1, rule: null, message: `missing ${missing}`, severity: "warning" });
    }
  }
  if (!/\bTOOLS\b/.test(source)) {
    out.push({ path, line: 1, rule: null, message: "never references TOOLS", severity: "warning" });
  }
  return out;
}

/**
 * The AST half: one buffer, Python's own parser, the two rules a regex cannot see.
 *
 * THE SAME TWO CHECKS `analyzePython` RUNS, narrowed to one file. Rule 9 — calling a decorated
 * `@tool` as a plain function, which raises TypeError at run time because it is a StructuredTool
 * instance — and rule 10, SQL assembled by interpolation. Both are genuine crashes or genuine
 * injection vectors rather than style, which is why they are worth a subprocess on a pause.
 *
 * `looks_like_sql` IS THE GATE'S OWN, CHARACTER FOR CHARACTER, and that matters more here than in
 * the gate: an error message that mentions SELECT and WHERE is common in this codebase's own
 * connector templates, and a live checker that flagged one would put a permanent squiggle under
 * correct code somebody cannot remove.
 *
 * A SYNTAX ERROR IS A DIAGNOSTIC, NOT A FAILURE, and it is the most common state this function will
 * ever see: somebody typing `def get_weather(` has an unparseable file for the next four seconds.
 * It is reported at its own line and the two AST checks simply produce nothing, because there is no
 * tree to walk — which is the honest answer rather than silence.
 *
 * KNOWN TOOL NAMES ARE PASSED IN rather than discovered, because rule 9 needs to know what is a
 * tool and the answer lives across the project — `tools/__init__.py`'s TOOLS list, the connector
 * catalogue, the MCP manifest. A caller that knows none of them still gets rule 10 and every
 * `@tool` defined in this buffer, which is most of the value.
 */
export async function astDiagnostics(
  path: string,
  source: string,
  opts: {
    runtimeDir: string;
    /** Tool names from elsewhere in the project. `@tool`s in this buffer are added to them. */
    knownTools?: readonly string[];
    sandbox?: CodeCheckSandbox;
  },
): Promise<Diagnostic[]> {
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) return [];

  const script = `
import ast, json, sys

src = sys.stdin.read()
rel = sys.argv[1]
known_tools = set(json.loads(sys.argv[2]))
out = []

try:
    tree = ast.parse(src, filename=rel)
except SyntaxError as e:
    print(json.dumps([{
        "line": e.lineno or 1,
        "column": e.offset,
        "rule": None,
        "message": "syntax error: " + (e.msg or "invalid syntax"),
    }]))
    raise SystemExit(0)
except Exception as e:
    print(json.dumps([]))
    raise SystemExit(0)

def is_tool_decorated(node):
    for d in node.decorator_list:
        target = d.func if isinstance(d, ast.Call) else d
        name = getattr(target, "id", None) or getattr(target, "attr", None)
        if name == "tool":
            return True
    return False

# Every @tool defined in THIS buffer counts too, so a file that defines two tools and calls one
# from the other is caught without the caller having to know either name.
for node in ast.walk(tree):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and is_tool_decorated(node):
        known_tools.add(node.name)

def looks_like_sql(text):
    """The gate's own predicate, unchanged. A bare keyword match flags error messages —
    'only SELECT queries are allowed' — which in this codebase are reviewed, correct code."""
    t = " ".join(text.lower().split())
    return (
        ("select " in t and " from " in t)
        or "insert into" in t
        or "delete from" in t
        or ("update " in t and " set " in t)
    )

for node in ast.walk(tree):
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
        if node.func.id in known_tools:
            out.append({
                "line": node.lineno,
                "column": node.col_offset + 1,
                "rule": 9,
                "message": "calls the tool '" + node.func.id + "()' directly — a @tool is a StructuredTool object and is not callable (rule 9)",
            })
    if isinstance(node, ast.JoinedStr):
        literal = "".join(
            v.value.lower() for v in node.values if isinstance(v, ast.Constant) and isinstance(v.value, str)
        )
        if looks_like_sql(literal) and any(isinstance(v, ast.FormattedValue) for v in node.values):
            out.append({
                "line": node.lineno,
                "column": node.col_offset + 1,
                "rule": 10,
                "message": "builds SQL with an f-string — injection risk, use a static query instead (rule 10)",
            })

print(json.dumps(out))
`.trim();

  const sandbox = opts.sandbox ?? defaultCodeCheckSandbox;
  const { stdout, spawnError, timedOut } = await sandbox.run({
    runtimeDir: opts.runtimeDir,
    args: ["-c", script, path, JSON.stringify([...(opts.knownTools ?? [])])],
    stdin: source,
    // A tenth of the gate's ceiling. This walks one buffer rather than a project, and a live check
    // that took three seconds would report on text the user has already replaced — which is worse
    // than reporting nothing, because it would be wrong rather than merely late.
    timeoutMs: 3_000,
  });

  // FAILS SILENT, WHICH IS THE OPPOSITE OF WHAT `validateProject` DOES, and the difference is the
  // whole reason both exist. The gate fails CLOSED because a check that could not run is not a
  // check that passed, and letting a project through on a crashed analysis is how bad code ships.
  // This one gates nothing: an unavailable sandbox means no squiggle, the editor stays responsive,
  // and the real validator asks the same question with a real budget the moment somebody commits.
  if (spawnError || timedOut) return [];
  const text = stdout.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as { line: number; column?: number | null; rule: number | null; message: string }[];
    return parsed.map((d) => ({
      path,
      line: Math.max(1, Number(d.line) || 1),
      ...(typeof d.column === "number" && d.column > 0 ? { column: d.column } : {}),
      rule: typeof d.rule === "number" ? d.rule : null,
      message: String(d.message),
      severity: "warning" as const,
    }));
  } catch {
    return [];
  }
}

/**
 * Everything that runs live, for one buffer, sorted the way a PROBLEMS list reads.
 *
 * THE CHEAP CHECKS ARE NOT GATED ON THE EXPENSIVE ONE, unlike `validateProject`, and that inversion
 * is deliberate. The gate runs the import check only once everything cheaper has passed, because
 * executing code already known to be bad is wasteful and reports the same defect twice. Here there
 * is no expensive check to protect, and a syntax error must not suppress the rule-3 squiggle three
 * lines above it — a person fixing one problem should be able to see the others.
 *
 * SORTED BY LINE THEN COLUMN, so a rescan of an unchanged buffer produces an identical list and the
 * PROBLEMS panel does not churn. Same reasoning `scan.ts` gives for sorting its hits.
 */
export async function liveDiagnostics(
  path: string,
  source: string,
  opts: { runtimeDir: string; knownTools?: readonly string[]; sandbox?: CodeCheckSandbox },
): Promise<Diagnostic[]> {
  const cheap = [...regexDiagnostics(path, source), ...contractDiagnostics(path, source)];
  const ast = path.endsWith(".py") ? await astDiagnostics(path, source, opts) : [];
  return [...cheap, ...ast].sort((a, b) =>
    a.line === b.line ? (a.column ?? 0) - (b.column ?? 0) : a.line - b.line,
  );
}
