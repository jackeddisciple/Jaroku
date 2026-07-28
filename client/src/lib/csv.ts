// Minimal RFC-4180 CSV reader for dataset import.
//
// Written out rather than split(",") because the failure mode is silent and expensive: a
// naive split mangles any input containing a comma, a quote, or a newline — which is most
// real support queries — and the result isn't an error, it's a dataset of subtly wrong
// examples that then get run against every provider at full cost.
//
// Handles: quoted fields, embedded commas/newlines, doubled quotes ("" -> "), CRLF, and a
// trailing newline. Deliberately does NOT handle: custom delimiters, comments, escapes
// other than doubled quotes.

export interface ParsedCsv {
  rows: string[][];
  /** Non-fatal notes for the user (e.g. an unterminated quote at EOF). */
  warnings: string[];
}

export function parseCsv(text: string): ParsedCsv {
  const rows: string[][] = [];
  const warnings: string[] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldWasQuoted = false;

  const endField = () => {
    row.push(field);
    field = "";
    fieldWasQuoted = false;
  };
  const endRow = () => {
    endField();
    // Skip rows that are entirely empty — a trailing newline shouldn't become an example.
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }   // escaped quote
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && field === "") { inQuotes = true; fieldWasQuoted = true; continue; }
    if (c === ",") { endField(); continue; }
    if (c === "\r") continue;                              // CRLF -> LF
    if (c === "\n") { endRow(); continue; }
    field += c;
  }
  if (inQuotes) warnings.push("a quoted field was never closed — the last row may be wrong");
  if (field !== "" || fieldWasQuoted || row.length) endRow();

  return { rows, warnings };
}

export interface ImportedExample {
  input: string;
  expected: string | null;
}

/**
 * Read a CSV into examples.
 *
 * Column resolution, in order: a header naming `input`/`expected` (any case, and
 * `prompt`/`output`/`expected_output` accepted as aliases), else the first column is the
 * input and the second — if present — the expected output. A single-column file is a
 * list of inputs with no ground truth, which is a perfectly good dataset.
 *
 * Rows with a blank input are dropped: they'd become runs with nothing to do.
 */
export function csvToExamples(text: string): { examples: ImportedExample[]; warnings: string[] } {
  const { rows, warnings } = parseCsv(text);
  if (!rows.length) return { examples: [], warnings: [...warnings, "the file has no rows"] };

  const INPUT_KEYS = ["input", "prompt", "question", "query"];
  const EXPECTED_KEYS = ["expected", "expected_output", "output", "answer"];

  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const headerInput = header.findIndex((h) => INPUT_KEYS.includes(h));
  const headerExpected = header.findIndex((h) => EXPECTED_KEYS.includes(h));
  const hasHeader = headerInput !== -1;

  const inputCol = hasHeader ? headerInput : 0;
  const expectedCol = hasHeader ? headerExpected : 1;
  const body = hasHeader ? rows.slice(1) : rows;

  const examples: ImportedExample[] = [];
  let skipped = 0;
  for (const r of body) {
    const input = (r[inputCol] ?? "").trim();
    if (!input) { skipped++; continue; }
    const expectedRaw = expectedCol >= 0 ? (r[expectedCol] ?? "").trim() : "";
    examples.push({ input, expected: expectedRaw || null });
  }
  if (skipped) warnings.push(`${skipped} row(s) skipped — no input value`);
  return { examples, warnings };
}
