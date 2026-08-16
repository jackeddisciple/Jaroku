// What changed, at the agent's level rather than the text's.
//
// §3.7 was right to refuse a merge editor. This is the other lever available: make the DETECTION
// that precedes any merge decision describe the agent rather than the file. "tools/weather.py +18
// −4" tells somebody a file moved; "tool removed: gmail_search" tells them what their agent can no
// longer do.
//
// NO NEW STATIC ANALYSIS IS WRITTEN, and §B.7.1 is emphatic about it. The Agent diff mode parses
// both trees through the SAME AST paths the validator already runs — the `TOOLS = …` tracing that
// follows local-variable assignment (v0.2.0), the `@tool` discovery the rule-9 check already does,
// the manifest read `mcpManifest.ts` already owns — and diffs the structured result rather than the
// text. What is new is the diffing, which is a set comparison.
//
// AND THE BOUNDARY, WHICH IS PERMANENT. §B.7.3: semantic diff is presentation. It is not becoming a
// "semantic merge" that recombines structured facts from both sides into a new file without
// producing code that passes through the real validator. That tool — resolve two agents' worth of
// tool lists and graph edges automatically — is precisely the class of thing §3.7 declined to build
// once, for a reason that applies here without modification: it could produce an agent nobody
// validated. Nothing in this file returns a file, and nothing calls it that writes one.
//
// THE GRAPH IS READ STATICALLY AND NOT BY INTROSPECTION, which is the one place this differs from
// v0.1.1's graph view. That view builds the compiled graph by importing the project, which is
// correct for showing what an agent IS and impossible for showing what a commit CHANGED: the other
// side of the diff is a tree on GitHub that this machine has never run and must not. So edges come
// from `add_edge` / `add_conditional_edges` calls in the AST — a weaker reading, which will miss an
// edge assembled in a loop, and the honest one for a surface whose entire job is to describe a
// difference between two things it is not going to execute.

import { LocalCodeCheckSandbox, type CodeCheckSandbox } from "./sandbox/codeCheck.ts";
import { MANIFEST_FILE } from "./mcpManifest.ts";
import type { McpImpact } from "./mcpStore.ts";
import type { StoredFile } from "./storage/projectStore.ts";

/** One agent's structure, as far as static analysis can see it. */
export interface AgentShape {
  /** `@tool` functions plus whatever `TOOLS = …` names, by name. */
  tools: string[];
  /** `name: type` from the state TypedDict / dataclass, as written. */
  stateFields: { name: string; type: string }[];
  /** `from → to`, including conditional edges, as written. */
  graphEdges: { from: string; to: string; conditional: boolean }[];
  /** `server/tool` refs the manifest grants. The MCP GRANT, which §B.7.2 puts first. */
  mcpTools: string[];
  /** Set when the tree could not be parsed. Every list above is empty when this is present. */
  error?: string;
}

export type SemanticChangeKind =
  | "mcp_grant_widened"
  | "mcp_grant_narrowed"
  | "tool_added"
  | "tool_removed"
  | "state_field_added"
  | "state_field_removed"
  | "state_field_retyped"
  | "graph_edge_added"
  | "graph_edge_removed";

/**
 * One line of the Agent diff.
 *
 * `verb` AND `object` RATHER THAN A SENTENCE, because §B.7.1 requires these to render through
 * `ActionRow.tsx` — the same narrative-line vocabulary as everything else in the app, so "tool
 * added" here reads exactly like "tool added" would in a plan card (v0.1.10). A pre-composed
 * sentence would be a second vocabulary in the same product.
 */
export interface SemanticChange {
  kind: SemanticChangeKind;
  verb: string;
  object: string;
  /** The extra clause, when there is one: an old type, an impact classification. */
  detail?: string;
  /**
   * Whether this line renders in the warning tone — §B.7.2's widened MCP grant, and only that.
   *
   * ONE ROW TYPE CAN CARRY IT AND NO OTHER. A tool being removed is a change somebody made; a
   * grant widening is a capability the agent did not have before, arriving from a commit that may
   * not be theirs. Marking anything else would dilute the one line that has to be read.
   */
  warn?: boolean;
}

const CHECK_TIMEOUT_MS = 15_000;

const defaultCodeCheckSandbox: CodeCheckSandbox = new LocalCodeCheckSandbox();

/**
 * Read one tree's structure.
 *
 * TAKES FILES RATHER THAN A DIRECTORY, because the whole point is that one of the two sides is a
 * tree fetched from GitHub that was never materialised here. The Python below reads a JSON map of
 * path → source from stdin, which is also why there is no path traversal to worry about: nothing is
 * opened.
 *
 * NEVER REJECTS. A tree that does not parse is a real state — somebody's branch is mid-edit — and a
 * semantic diff that threw would take the whole diff card down with it rather than falling back to
 * the line diff beside it. The error comes back on the shape.
 */
export async function readShape(
  files: readonly StoredFile[],
  opts: { runtimeDir: string; sandbox?: CodeCheckSandbox } ,
): Promise<AgentShape> {
  const python = Object.fromEntries(
    files.filter((f) => f.path.endsWith(".py")).map((f) => [f.path, f.content]),
  );
  const manifest = files.find((f) => f.path === MANIFEST_FILE);

  const script = `
import ast, json, sys

sources = json.loads(sys.stdin.read())
tools, state_fields, edges, problems = set(), {}, set(), []

trees = {}
for rel, src in sources.items():
    try:
        trees[rel] = ast.parse(src, filename=rel)
    except SyntaxError as e:
        problems.append(rel + ": syntax error line " + str(e.lineno or 0))
    except Exception as e:
        problems.append(rel + ": " + type(e).__name__)

def is_tool_decorated(node):
    for d in node.decorator_list:
        target = d.func if isinstance(d, ast.Call) else d
        name = getattr(target, "id", None) or getattr(target, "attr", None)
        if name == "tool":
            return True
    return False

# THE VALIDATOR'S OWN TOOLS = <expr> TRACING, following one level of local variable so
# "TOOLS = CONNECTOR_TOOLS + [mine]" is understood. Lifted from analyzePython rather than
# reinvented: a second reading of what TOOLS binds would eventually disagree with the gate's.
aliases = {}
for rel, tree in trees.items():
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and is_tool_decorated(node):
            tools.add(node.name)
        if isinstance(node, ast.Assign):
            for tgt in node.targets:
                if isinstance(tgt, ast.Name):
                    aliases.setdefault(tgt.id, []).append(node.value)

wired = set()
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
# A name in TOOLS that is not a decorated function here is still a tool this agent binds — a
# reviewed connector's, or one imported from elsewhere. MCP_TOOLS is the bridge's list rather
# than a tool, and the manifest is the honest source for what it contains.
for name in wired:
    if name not in ("TOOLS", "MCP_TOOLS") and not name.isupper():
        tools.add(name)

# --- the state's shape ---------------------------------------------------------------
#
# A TypedDict or a dataclass, by its annotated assignments. Read from any class whose body is
# annotations, rather than from a name — an agent's state class is conventionally AgentState
# and nothing enforces that, and a diff that only understood one name would report a renamed
# class as every field being removed and re-added.
for rel, tree in trees.items():
    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef):
            continue
        for item in node.body:
            if isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name):
                try:
                    state_fields[item.target.id] = ast.unparse(item.annotation)
                except Exception:
                    state_fields[item.target.id] = "?"

# --- the graph's edges ---------------------------------------------------------------
#
# STATICALLY, from add_edge / add_conditional_edges, rather than by importing and compiling.
# The other side of a semantic diff is a tree from GitHub this machine has never run and must
# not — see the module header on why that makes this the honest reading rather than a weaker one.
def literal(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return "?"

for rel, tree in trees.items():
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
            continue
        if node.func.attr == "add_edge" and len(node.args) >= 2:
            edges.add((literal(node.args[0]), literal(node.args[1]), False))
        elif node.func.attr == "add_conditional_edges" and node.args:
            source = literal(node.args[0])
            # The mapping, when there is a literal one. Its VALUES are the targets; a router
            # function passed without a map has targets nothing static can name.
            targets = []
            for arg in node.args[1:]:
                if isinstance(arg, ast.Dict):
                    targets.extend(literal(v) for v in arg.values)
            for kw in node.keywords:
                if isinstance(kw.value, ast.Dict):
                    targets.extend(literal(v) for v in kw.value.values)
            if targets:
                for t in targets:
                    edges.add((source, t, True))
            else:
                edges.add((source, "?", True))

print(json.dumps({
    "tools": sorted(tools),
    "state": [{"name": k, "type": v} for k, v in sorted(state_fields.items())],
    "edges": [{"from": a, "to": b, "conditional": c} for a, b, c in sorted(edges)],
    "problems": problems,
}))
`.trim();

  const sandbox = opts.sandbox ?? defaultCodeCheckSandbox;
  const { stdout, spawnError, timedOut } = await sandbox.run({
    runtimeDir: opts.runtimeDir,
    args: ["-c", script],
    stdin: JSON.stringify(python),
    timeoutMs: CHECK_TIMEOUT_MS,
  });

  const mcpTools = readManifestGrant(manifest);
  if (spawnError || timedOut) {
    return { tools: [], stateFields: [], graphEdges: [], mcpTools, error: spawnError ?? "the analysis timed out" };
  }
  try {
    const parsed = JSON.parse(stdout.trim()) as {
      tools: string[];
      state: { name: string; type: string }[];
      edges: { from: string; to: string; conditional: boolean }[];
      problems: string[];
    };
    return {
      tools: parsed.tools,
      stateFields: parsed.state,
      graphEdges: parsed.edges,
      mcpTools,
      // A tree that half-parses still produces a shape, and the problem rides alongside it. Losing
      // four correct rows because a fifth file is mid-edit would be the surface refusing to be
      // useful at exactly the moment somebody is looking at a branch in progress.
      ...(parsed.problems.length ? { error: parsed.problems[0] } : {}),
    };
  } catch {
    return { tools: [], stateFields: [], graphEdges: [], mcpTools, error: "the analysis did not report" };
  }
}

/**
 * The manifest's grant, as `server/tool` refs.
 *
 * READ HERE RATHER THAN IN PYTHON because it is JSON and this is TypeScript, and because
 * `mcpManifest.ts` already owns what the file means. What matters for the diff is only the SET of
 * granted refs — §B.7.2's question is whether the grant widened, not what a tool's schema says.
 */
function readManifestGrant(manifest: StoredFile | undefined): string[] {
  if (!manifest) return [];
  try {
    const parsed = JSON.parse(manifest.content) as { servers?: { id?: unknown; tools?: unknown[] }[] };
    const out: string[] = [];
    for (const server of parsed.servers ?? []) {
      const id = typeof server.id === "string" ? server.id : "?";
      for (const tool of server.tools ?? []) {
        const name = (tool as { name?: unknown })?.name;
        if (typeof name === "string") out.push(`${id}/${name}`);
      }
    }
    return [...new Set(out)].sort();
  } catch {
    // A manifest that does not parse grants nothing that can be named. Reporting the whole grant as
    // removed would be worse than reporting none of it: the first is a claim, the second is silence.
    return [];
  }
}

/**
 * Two shapes in, §B.7's rows out.
 *
 * THE MCP GRANT LINE ALWAYS COMES FIRST — §B.7.2, and it is the strongest ordering rule in this
 * file. Whatever else a commit changes, if it widens what `mcp_tools.json` grants, that line renders
 * first and in the warning tone. A semantic diff that buried this fact under an alphabetically
 * sorted list would be actively worse than the plain line-diff it replaces, because a person
 * skimming it would have been told they were reading a summary.
 *
 * THE IMPACT CLASSIFICATION IS LOOKED UP, NEVER COMPUTED. `impactOf` is the stored classification
 * from `mcpStore` (v0.2.0/v0.2.1). §B.7.2 is explicit that this mirrors the McpImpact ratchet: a
 * classification may only be RAISED, never lowered, by an untrusted signal — and here the untrusted
 * signal is "an external commit changed the manifest". Classifying the newly granted tool here,
 * from its name, would be exactly that untrusted signal deciding its own impact.
 */
export function diffShapes(
  before: AgentShape,
  after: AgentShape,
  impactOf?: (ref: string) => McpImpact | undefined,
): SemanticChange[] {
  const rows: SemanticChange[] = [];

  // --- §B.7.2: the grant, first ------------------------------------------------------
  const grantBefore = new Set(before.mcpTools);
  const grantAfter = new Set(after.mcpTools);
  const granted = [...grantAfter].filter((t) => !grantBefore.has(t)).sort();
  const revoked = [...grantBefore].filter((t) => !grantAfter.has(t)).sort();

  if (granted.length > 0) {
    // ONE ROW FOR THE WHOLE WIDENING rather than one per tool, because the fact somebody has to
    // read is that the grant widened — and three rows saying it three times is three chances to
    // skim past the first.
    const worst = granted
      .map((ref) => impactOf?.(ref))
      .some((impact) => impact === undefined || impact === "high");
    rows.push({
      kind: "mcp_grant_widened",
      verb: "MCP grant widened",
      object: granted.map((t) => `+ ${t.split("/").pop()}`).join(", "),
      // An UNKNOWN classification reads as high, which is `mcpImpact.classify`'s own step 4 and the
      // same fail-toward-the-expensive-answer rule: a tool this workspace has never discovered is
      // one nobody, including us, knows the impact of.
      detail: worst ? "high-impact" : "low-impact",
      warn: true,
    });
  }
  if (revoked.length > 0) {
    // NOT A WARNING. A narrowing grant is the agent being able to do less, which is the direction
    // nobody needs to be alerted about — and marking it would train people to skim the tone.
    rows.push({
      kind: "mcp_grant_narrowed",
      verb: "MCP grant narrowed",
      object: revoked.map((t) => `− ${t.split("/").pop()}`).join(", "),
    });
  }

  // --- tools -------------------------------------------------------------------------
  const toolsBefore = new Set(before.tools);
  const toolsAfter = new Set(after.tools);
  for (const name of [...toolsAfter].filter((t) => !toolsBefore.has(t)).sort()) {
    rows.push({ kind: "tool_added", verb: "tool added", object: name });
  }
  for (const name of [...toolsBefore].filter((t) => !toolsAfter.has(t)).sort()) {
    rows.push({ kind: "tool_removed", verb: "tool removed", object: name });
  }

  // --- state -------------------------------------------------------------------------
  const stateBefore = new Map(before.stateFields.map((f) => [f.name, f.type]));
  const stateAfter = new Map(after.stateFields.map((f) => [f.name, f.type]));
  for (const [name, type] of stateAfter) {
    if (!stateBefore.has(name)) {
      rows.push({ kind: "state_field_added", verb: "state field added", object: `${name}: ${type}` });
    } else if (stateBefore.get(name) !== type) {
      // RETYPED IS ITS OWN KIND rather than a removal plus an addition, because it is one thing
      // that happened and because the old type is the useful half — `int` to `str` is a migration,
      // `int` to `int | None` is a nullability change, and two rows would say neither.
      rows.push({
        kind: "state_field_retyped",
        verb: "state field retyped",
        object: `${name}: ${type}`,
        detail: `was ${stateBefore.get(name)}`,
      });
    }
  }
  for (const name of [...stateBefore.keys()].filter((n) => !stateAfter.has(n)).sort()) {
    rows.push({ kind: "state_field_removed", verb: "state field removed", object: name });
  }

  // --- the graph ---------------------------------------------------------------------
  const key = (e: { from: string; to: string }): string => `${e.from}→${e.to}`;
  const edgesBefore = new Map(before.graphEdges.map((e) => [key(e), e]));
  const edgesAfter = new Map(after.graphEdges.map((e) => [key(e), e]));
  for (const [k, e] of [...edgesAfter].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!edgesBefore.has(k)) {
      rows.push({
        kind: "graph_edge_added",
        verb: "graph edge added",
        object: k,
        ...(e.conditional ? { detail: "conditional" } : {}),
      });
    }
  }
  for (const [k, e] of [...edgesBefore].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!edgesAfter.has(k)) {
      rows.push({
        kind: "graph_edge_removed",
        verb: "graph edge removed",
        object: k,
        ...(e.conditional ? { detail: "conditional" } : {}),
      });
    }
  }

  return rows;
}

/**
 * §B.7.3's one-line summary for a file in §3.7's Overlapping list.
 *
 * "both sides added a tool", "you renamed a state field, they added one" — the sentences §B.7.3
 * asks for, so the diverged-conflict view can render a semantic delta beside a bare filename. This
 * improves exactly the case §3.7 said its handoff-not-merge approach was aiming to make legible,
 * and it changes nothing about that approach: the panel still only detects and hands off.
 *
 * EMPTY WHEN THERE IS NOTHING STRUCTURAL, which is a real answer — two sides that both edited a
 * docstring have overlapped in the text and not in the agent, and saying so is more useful than
 * inventing a summary of a whitespace change.
 */
export function summariseChanges(rows: readonly SemanticChange[]): string {
  if (rows.length === 0) return "";
  // The warning row leads if there is one, for the same reason it leads the list.
  const lead = rows.find((r) => r.warn) ?? rows[0]!;
  const rest = rows.length - 1;
  const head = `${lead.verb} ${lead.object}`;
  return rest > 0 ? `${head}, and ${rest} more` : head;
}
