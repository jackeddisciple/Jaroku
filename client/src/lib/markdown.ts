// Jaroku's replies as structure: the Markdown a model writes, read into blocks and inline runs.
//
// THE PRODUCT OWNER'S CALL ON 2026-09-15: a reply is headings, paragraphs, lists, tables, quotes and
// code where the content is those things, not one run of text. The model writes Markdown; this reads
// it, and `components/Markdown.tsx` draws it in the app's own type scale and palette.
//
// A PARSER OF ITS OWN RATHER THAN A PACKAGE, for the reason the icons are generated rather than
// imported: the reply is the thing on screen most, and a subset this size is a few hundred lines this
// codebase can read, test and keep. It covers what a chat answer actually uses — CommonMark's blocks,
// GitHub's tables and strikethrough — and nothing that only a document needs.
//
// IT MUST SURVIVE HALF A REPLY. The text arrives while it is being written, so every prefix of a valid
// answer is parsed too: a fence not closed yet is still code, a `**` with no partner is just two
// asterisks, and nothing here can throw or loop on input it did not expect.
//
//   npm run test:markdown

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "del"; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; children: Inline[] };

export type Align = "left" | "center" | "right" | null;

export interface ListItem {
  blocks: Block[];
}

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; inline: Inline[] }
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "code"; lang: string; text: string; closed: boolean }
  | { kind: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { kind: "rule" }
  /** A note, tip or warning set apart from the answer — see `calloutOf`. */
  | { kind: "callout"; tone: CalloutTone; title: string; blocks: Block[] };

/** The five kinds of callout, named the way GitHub's alerts name them. */
export type CalloutTone = "note" | "tip" | "important" | "warning" | "caution";

// --- blocks -------------------------------------------------------------------------------------

const isBlank = (line: string): boolean => line.trim() === "";
const indentOf = (line: string): number => line.length - line.trimStart().length;

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?: *\1){2,} *$/;
const QUOTE = /^ {0,3}>/;
const MARKER = /^( *)([-*+]|\d{1,9}[.)])(?: +(.*))?$/;

interface Marker {
  indent: number;
  ordered: boolean;
  start: number;
  /** The column the item's own text starts at, which nested lines are measured against. */
  content: number;
  text: string;
}

function listMarker(line: string): Marker | null {
  const m = MARKER.exec(line);
  if (!m) return null;
  const marker = m[2]!;
  const ordered = /\d/.test(marker);
  const indent = m[1]!.length;
  const text = m[3] ?? "";
  const gap = line.length - indent - marker.length - text.length;
  return { indent, ordered, start: ordered ? Number.parseInt(marker, 10) : 1, content: indent + marker.length + Math.max(1, gap), text };
}

/** The cells of a table row, split on pipes that are neither escaped nor inside inline code. */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  let ticks = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && s[i + 1] === "|") { cell += "|"; i++; continue; }
    if (ch === "`") ticks = ticks === 0 ? 1 : 0;
    if (ch === "|" && ticks === 0) { cells.push(cell.trim()); cell = ""; continue; }
    cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

function isDelimiterRow(line: string | undefined): boolean {
  if (line === undefined || !line.includes("-")) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : null;
}

function startsTable(lines: string[], i: number): boolean {
  return lines[i]!.includes("|") && isDelimiterRow(lines[i + 1]);
}

/** Whether line `i` opens a block of its own, and so ends the paragraph running into it. */
function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i]!;
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line)
    || listMarker(line) !== null || startsTable(lines, i);
}

function parseList(lines: string[], start: number): [Block, number] {
  const first = listMarker(lines[start]!)!;
  const items: string[][] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    const m = listMarker(line);
    if (m && m.indent === first.indent && m.ordered === first.ordered) {
      items.push([m.text]);
      i++;
      continue;
    }
    if (isBlank(line)) {
      // A blank line stays inside the list only when what follows still belongs to it — another item
      // at this depth, or something indented under the last one.
      let j = i + 1;
      while (j < lines.length && isBlank(lines[j]!)) j++;
      const next = j < lines.length ? lines[j]! : null;
      const sibling = next !== null ? listMarker(next) : null;
      if (next !== null && ((sibling && sibling.indent === first.indent && sibling.ordered === first.ordered) || indentOf(next) > first.indent)) {
        items[items.length - 1]!.push("");
        i++;
        continue;
      }
      break;
    }
    const indent = indentOf(line);
    if (indent > first.indent) {
      // Under the item: dedented to the item's own text column, so a nested list parses as a list.
      items[items.length - 1]!.push(line.slice(Math.min(indent, first.content)));
      i++;
      continue;
    }
    if (m || startsBlock(lines, i)) break;
    // A line that simply carries on the item's sentence.
    items[items.length - 1]!.push(line.trim());
    i++;
  }
  return [{ kind: "list", ordered: first.ordered, start: first.start, items: items.map((b) => ({ blocks: parseBlocks(b) })) }, i];
}

const ALERT = /^\s*\[!(note|tip|important|warning|caution)\]\s*(.*)$/i;
const LABELLED = /^\s*(?:\*\*|__)?(note|tip|important|warning|caution|heads up)(?:\*\*|__)?\s*[:.]\s*(?:\*\*|__)?\s*(.*)$/i;

/**
 * A quote that is really a callout: GitHub's `> [!WARNING]`, or a quote that opens with its own label —
 * `> **Note:** …`, `> Tip: …`. Only inside a quote, so a sentence that happens to begin "Note:" in the
 * middle of an answer stays a sentence.
 */
function calloutOf(body: string[]): Block | null {
  const first = body.findIndex((l) => l.trim() !== "");
  if (first === -1) return null;
  const alert = ALERT.exec(body[first]!);
  if (alert) {
    const rest = body.slice(first + 1);
    return { kind: "callout", tone: alert[1]!.toLowerCase() as CalloutTone, title: alert[2]!.trim(), blocks: parseBlocks(rest) };
  }
  const labelled = LABELLED.exec(body[first]!);
  if (labelled) {
    const word = labelled[1]!.toLowerCase();
    const tone: CalloutTone = word === "heads up" ? "important" : (word as CalloutTone);
    const rest = [labelled[2]!, ...body.slice(first + 1)];
    return { kind: "callout", tone, title: "", blocks: parseBlocks(rest) };
  }
  return null;
}

function parseBlocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const closing = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
      const body: string[] = [];
      let closed = false;
      i++;
      while (i < lines.length) {
        if (closing.test(lines[i]!)) { closed = true; i++; break; }
        body.push(lines[i]!);
        i++;
      }
      out.push({ kind: "code", lang: (fence[2] ?? "").toLowerCase(), text: body.join("\n"), closed });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ kind: "heading", level: heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6, inline: parseInline(heading[2] ?? "") });
      i++;
      continue;
    }

    if (RULE.test(line)) { out.push({ kind: "rule" }); i++; continue; }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        body.push(lines[i]!.replace(/^ {0,3}> ?/, ""));
        i++;
      }
      out.push(calloutOf(body) ?? { kind: "quote", blocks: parseBlocks(body) });
      continue;
    }

    if (startsTable(lines, i)) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]!).map(alignOf);
      const width = head.length;
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && !isBlank(lines[i]!) && lines[i]!.includes("|")) {
        const cells = splitRow(lines[i]!);
        rows.push(Array.from({ length: width }, (_, c) => parseInline(cells[c] ?? "")));
        i++;
      }
      out.push({
        kind: "table",
        align: Array.from({ length: width }, (_, c) => align[c] ?? null),
        head: head.map((c) => parseInline(c)),
        rows,
      });
      continue;
    }

    if (listMarker(line)) {
      const [list, next] = parseList(lines, i);
      out.push(list);
      i = next;
      continue;
    }

    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && !isBlank(lines[i]!) && !startsBlock(lines, i)) {
      para.push(lines[i]!.trim());
      i++;
    }
    out.push({ kind: "paragraph", inline: parseInline(para.join("\n")) });
  }
  return out;
}

/** A reply as blocks. Never throws; any text, whole or half-written, is some structure. */
export function parseMarkdown(src: string): Block[] {
  return parseBlocks(src.replace(/\r\n?/g, "\n").split("\n"));
}

// --- inline -------------------------------------------------------------------------------------

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|~>]/;
const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);

/** Where a `**`, `__` or `~~` run closes: the next one with something other than a space before it. */
function closeDouble(src: string, delim: string, from: number): number {
  let at = src.indexOf(delim, from);
  while (at !== -1) {
    if (at > from && !isSpace(src[at - 1]) && !(delim[0] === "_" && isWordChar(src[at + 2]))) return at;
    at = src.indexOf(delim, at + 1);
  }
  return -1;
}

/** Where a single `*` or `_` closes: not half of a double, not after a space, not inside a word for `_`. */
function closeSingle(src: string, ch: string, from: number): number {
  for (let at = from; at < src.length; at++) {
    if (src[at] === "\\") { at++; continue; }
    if (src[at] === "`") {
      const end = src.indexOf("`", at + 1);
      if (end === -1) return -1;
      at = end;
      continue;
    }
    if (src[at] !== ch) continue;
    if (src[at + 1] === ch) { at++; continue; }
    if (at === from || isSpace(src[at - 1])) continue;
    if (ch === "_" && isWordChar(src[at + 1])) continue;
    return at;
  }
  return -1;
}

const LINK = /^\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/;

/** A run of text as inline pieces: emphasis, code, links, and the text between them. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf) { out.push({ kind: "text", text: buf }); buf = ""; }
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;

    if (ch === "\\" && i + 1 < src.length && ESCAPABLE.test(src[i + 1]!)) {
      buf += src[i + 1];
      i += 2;
      continue;
    }

    if (ch === "`") {
      let n = 1;
      while (src[i + n] === "`") n++;
      const ticks = "`".repeat(n);
      const end = src.indexOf(ticks, i + n);
      if (end !== -1) {
        flush();
        const inner = src.slice(i + n, end);
        out.push({ kind: "code", text: inner.length > 2 && inner.startsWith(" ") && inner.endsWith(" ") ? inner.slice(1, -1) : inner });
        i = end + n;
        continue;
      }
      buf += ticks;
      i += n;
      continue;
    }

    if ((ch === "*" || ch === "_" || ch === "~") && src[i + 1] === ch && !isSpace(src[i + 2])) {
      const delim = ch + ch;
      const opensInWord = ch === "_" && isWordChar(src[i - 1]);
      const end = opensInWord ? -1 : closeDouble(src, delim, i + 2);
      if (end !== -1) {
        flush();
        const children = parseInline(src.slice(i + 2, end));
        out.push(ch === "~" ? { kind: "del", children } : { kind: "strong", children });
        i = end + 2;
        continue;
      }
    }

    if ((ch === "*" || ch === "_") && src[i + 1] !== ch && !isSpace(src[i + 1]) && !(ch === "_" && isWordChar(src[i - 1]))) {
      const end = closeSingle(src, ch, i + 1);
      if (end !== -1) {
        flush();
        out.push({ kind: "em", children: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }

    if (ch === "[") {
      const m = LINK.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ kind: "link", href: m[2]!, children: parseInline(m[1]!) });
        i += m[0].length;
        continue;
      }
    }

    // A BARE ADDRESS IS A LINK TOO, with its trailing punctuation left in the sentence rather than
    // swallowed into the URL — "see https://example.com." links the page, not the full stop.
    if (ch === "h" && !isWordChar(src[i - 1]) && /^https?:\/\//.test(src.slice(i, i + 8))) {
      const m = /^https?:\/\/[^\s<>()[\]`]*[^\s<>()[\]`.,;:!?'"]/.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ kind: "link", href: m[0], children: [{ kind: "text", text: m[0] }] });
        i += m[0].length;
        continue;
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}

/** The plain words of some inline pieces — what a heading or a link says, without its styling. */
export function inlineText(pieces: readonly Inline[]): string {
  return pieces.map((p) => (p.kind === "text" || p.kind === "code" ? p.text : inlineText(p.children))).join("");
}
