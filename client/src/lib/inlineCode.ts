// Finding the code inside a sentence.
//
// The panel already draws a hard line between prose and code: Inter for explanation, JetBrains Mono
// for anything that is literally an identifier (tool names, state fields, file paths, diff hunks).
// That line held everywhere the two were in separate slots — and broke the moment they shared a
// sentence. `pg_query` in a tool row was a monospace name; the same `pg_query` two lines below, in
// "pg_query is read-only and takes a static SQL string", was an ordinary word. Same thing, two
// appearances, no way to tell they were the same thing.
//
// So prose gets tokenized before it is rendered, and the identifiers inside it are marked. What
// counts as an identifier comes from two places:
//
//   1. The plan's own vocabulary — its tool names and state field names are exact strings we
//      already have, so matching them is recognition, not guessing.
//   2. Shape — backticks, snake_case, PascalCase, foo(), file paths, SQL statement keywords, and
//      "rule E1" references. These catch what the plan never names, like a LIMIT clause.
//
// The one rule that keeps this from becoming noise is in `isIdentifierShaped`: a vocabulary term
// only qualifies if it *looks* like code. A state field genuinely called `messages` is a real
// identifier, but chipping every "messages" in every sentence would decorate ordinary English and
// make the distinction meaningless. Precision here is worth more than coverage.
//
// Pure and dependency-free, so it can be tested directly (inlineCode.test.ts) and so the trace
// panel could eventually mark identifiers in step descriptions without pulling in a component.

export interface Segment {
  text: string;
  /** True if this run is an identifier and should be rendered as a code chip. */
  code: boolean;
}

/** Backticked spans. The model marked these itself, so they win over every other rule. */
const BACKTICK = /`([^`\n]+)`/g;
/** snake_case — the dominant identifier shape in a Python agent. */
const SNAKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
/** A call, written out: `search_gmail()`. */
const CALL = /\b[A-Za-z_][A-Za-z0-9_]*\(\)/g;
/** PascalCase with at least two humps: MessagesState, but not Gmail or Postgres. */
const PASCAL = /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g;
/** A file path or filename, by extension. */
const PATH = /\b[\w./-]*\w\.(?:py|ts|tsx|js|jsx|json|md|sql|txt|ya?ml|toml|env|cfg)\b/g;
/** "rule E1" / "rules E1" — the id is the identifier; the word "rule" is prose. */
const RULE = /\brules?\s+([A-Z]\d+)\b/g;
/**
 * SQL statement keywords, spelled in caps.
 *
 * Only the keywords that name a clause, and only when capitalised — a plan saying "the query is
 * limited to 20 rows" is prose, while "add a LIMIT clause" is naming a piece of SQL.
 */
const SQL =
  /\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE|LIMIT|OFFSET|ORDER BY|GROUP BY|HAVING|JOIN|DISTINCT|RETURNING|COMMIT|ROLLBACK)\b/g;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a known name is worth marking when it appears in a sentence.
 *
 * Requires a `_`, a `.`, a digit, or an interior capital — the shapes English words do not have.
 * This is what stops a state field named `messages` or `notes` from chipping every ordinary use of
 * the word. Those fields are still monospace where they are *listed*; it is only in flowing prose,
 * where the word is doing double duty, that the plain ones stay plain.
 */
function isIdentifierShaped(term: string): boolean {
  return /[_.]/.test(term) || /\d/.test(term) || /[a-z][A-Z]/.test(term) || /\(\)$/.test(term);
}

/**
 * Split prose into plain and code runs.
 *
 * `vocabulary` is the plan's own tool and state names. Precedence runs top to bottom — an earlier
 * rule claims its span and later rules cannot overlap it — so a backticked `pg_query` is claimed
 * once, not chipped twice by the backtick rule and the snake_case rule.
 */
export function segmentProse(text: string, vocabulary: readonly string[] = []): Segment[] {
  if (!text) return [];

  type Claim = { start: number; end: number; text: string };
  const claims: Claim[] = [];

  const claim = (start: number, end: number, inner: string) => {
    if (start < 0 || end > text.length || start >= end) return;
    if (claims.some((c) => start < c.end && end > c.start)) return;
    claims.push({ start, end, text: inner });
  };

  const scan = (re: RegExp, pick: (m: RegExpExecArray) => [number, number, string] | null) => {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const hit = pick(m);
      if (hit) claim(hit[0], hit[1], hit[2]);
    }
  };

  // 1. What the model marked itself.
  scan(BACKTICK, (m) => (m[1] ? [m.index, m.index + m[0].length, m[1]] : null));

  // 2. What the plan named. Longest first, so `current_order_id` isn't pre-empted by `current_order`.
  for (const term of [...vocabulary].filter(isIdentifierShaped).sort((a, b) => b.length - a.length)) {
    const head = /^\w/.test(term) ? "\\b" : "";
    const tail = /\w$/.test(term) ? "\\b" : "";
    scan(new RegExp(`${head}${escape(term)}${tail}`, "g"), (m) => [m.index, m.index + m[0].length, m[0]]);
  }

  // 3. What looks like code.
  scan(RULE, (m) => {
    const id = m[1];
    if (!id) return null;
    const at = m.index + m[0].indexOf(id);
    return [at, at + id.length, id];
  });
  for (const re of [PATH, CALL, SNAKE, PASCAL, SQL]) {
    scan(re, (m) => [m.index, m.index + m[0].length, m[0]]);
  }

  claims.sort((a, b) => a.start - b.start);

  const out: Segment[] = [];
  let at = 0;
  for (const c of claims) {
    if (c.start > at) out.push({ text: text.slice(at, c.start), code: false });
    out.push({ text: c.text, code: true });
    at = c.end;
  }
  if (at < text.length) out.push({ text: text.slice(at), code: false });
  return out;
}
