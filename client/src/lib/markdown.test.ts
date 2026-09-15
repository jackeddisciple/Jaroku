// How a reply's Markdown is read: which blocks, which inline pieces, and what half a reply becomes.
//
//   npm run test:markdown

import { inlineText, parseInline, parseMarkdown, splitRow, type Block, type Inline } from "./markdown.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const kinds = (blocks: Block[]): string => blocks.map((b) => b.kind).join(",");
const show = (v: unknown): string => JSON.stringify(v);

console.log("\nheadings, paragraphs and rules");
{
  const b = parseMarkdown("## The Problem\n\nFirst line of a paragraph\nand its second line.\n\n---\n\n### Backend");
  check("a heading, a paragraph, a rule, a subheading", kinds(b) === "heading,paragraph,rule,heading", kinds(b));
  const h = b[0] as Extract<Block, { kind: "heading" }>;
  check("## is level 2, with its words", h.level === 2 && inlineText(h.inline) === "The Problem", show(h));
  const p = b[1] as Extract<Block, { kind: "paragraph" }>;
  check("a paragraph keeps its line break", inlineText(p.inline) === "First line of a paragraph\nand its second line.", show(p.inline));
  check("### is level 3", (b[3] as Extract<Block, { kind: "heading" }>).level === 3);
  check("a lone # with nothing after it is still a heading, empty", kinds(parseMarkdown("#")) === "heading");
}

console.log("\nlists, numbered lists and nesting");
{
  const bullets = parseMarkdown("The main reasons are:\n- TypeScript gives typing\n- FastAPI is fast\n- PostgreSQL is reliable");
  check("a sentence then a bullet list", kinds(bullets) === "paragraph,list", kinds(bullets));
  const list = bullets[1] as Extract<Block, { kind: "list" }>;
  check("three unordered items", !list.ordered && list.items.length === 3, show(list));

  const steps = parseMarkdown("1. mkdir my-project\n2. cd my-project\n3. npm init -y");
  const ol = steps[0] as Extract<Block, { kind: "list" }>;
  check("a numbered list, starting at 1, three steps", ol.kind === "list" && ol.ordered && ol.start === 1 && ol.items.length === 3, show(ol));
  check("a list may start elsewhere", (parseMarkdown("4. four\n5. five")[0] as Extract<Block, { kind: "list" }>).start === 4);

  const nested = parseMarkdown("- Frontend\n  - React\n  - Vite\n- Backend\n    - FastAPI");
  const top = nested[0] as Extract<Block, { kind: "list" }>;
  check("two top-level items", top.items.length === 2, show(top));
  const firstChild = top.items[0]!.blocks.find((x) => x.kind === "list") as Extract<Block, { kind: "list" }> | undefined;
  check("the first carries a nested list of two", firstChild?.items.length === 2, show(top.items[0]));
  const secondChild = top.items[1]!.blocks.find((x) => x.kind === "list") as Extract<Block, { kind: "list" }> | undefined;
  check("four spaces of indent nest as well as two", secondChild?.items.length === 1, show(top.items[1]));

  const loose = parseMarkdown("- one\n\n- two\n\nAfter the list.");
  check("a blank line between items keeps one list, and a paragraph after ends it",
    kinds(loose) === "list,paragraph" && (loose[0] as Extract<Block, { kind: "list" }>).items.length === 2, kinds(loose));
  check("a number inside a sentence is not a list", kinds(parseMarkdown("It shipped in 2024. Then it grew.")) === "paragraph");
}

console.log("\nquotes, code and tables");
{
  const q = parseMarkdown("> This is an important distinction.\n> It spans two lines.");
  check("a quote holds a paragraph", q[0]?.kind === "quote" && kinds((q[0] as Extract<Block, { kind: "quote" }>).blocks) === "paragraph", show(q));

  const code = parseMarkdown("Run this:\n\n```bash\nnpm install\nnpm run dev\n```\n\nThen open it.");
  check("a paragraph, a code block, a paragraph", kinds(code) === "paragraph,code,paragraph", kinds(code));
  const c = code[1] as Extract<Block, { kind: "code" }>;
  check("the block knows its language and keeps its lines", c.lang === "bash" && c.text === "npm install\nnpm run dev" && c.closed, show(c));
  check("Markdown inside a code block is left alone",
    (parseMarkdown("```\n# not a heading\n- not a list\n```")[0] as Extract<Block, { kind: "code" }>).text === "# not a heading\n- not a list");

  const table = parseMarkdown("| Option | Speed | Complexity |\n|:--|:-:|--:|\n| Redis | High | Low |\n| PostgreSQL | Medium |");
  const t = table[0] as Extract<Block, { kind: "table" }>;
  check("a table, with its header", t.kind === "table" && t.head.map(inlineText).join("/") === "Option/Speed/Complexity", show(t));
  check("...its alignment", t.align.join(",") === "left,center,right", t.align.join(","));
  check("...and a short row padded to the header's width", t.rows.length === 2 && t.rows[1]!.length === 3, show(t.rows));
  check("a pipe inside code does not split a cell", splitRow("| `a | b` | c |").length === 2, show(splitRow("| `a | b` | c |")));
  check("a line with a pipe and no delimiter under it is a paragraph", kinds(parseMarkdown("a | b\nc | d")) === "paragraph");
}

console.log("\ninline pieces");
{
  const has = (pieces: Inline[], kind: Inline["kind"]): boolean =>
    pieces.some((p) => p.kind === kind || ("children" in p && has(p.children, kind)));
  check("**bold**", has(parseInline("Use **PostgreSQL**, not MongoDB."), "strong"));
  check("*italic* and _italic_", has(parseInline("an *important* note"), "em") && has(parseInline("an _important_ note"), "em"));
  check("~~struck~~", has(parseInline("~~old~~ new"), "del"));
  const code = parseInline("run `npm install` then set `PORT`");
  check("`inline code`, twice", code.filter((p) => p.kind === "code").length === 2, show(code));
  check("snake_case_names stay words", !has(parseInline("set my_env_var and use_state here"), "em"), show(parseInline("set my_env_var and use_state here")));
  check("2 * 3 * 4 is arithmetic, not italic", !has(parseInline("2 * 3 * 4"), "em"));
  const link = parseInline("see [the docs](https://example.com/docs) for more");
  const l = link.find((p) => p.kind === "link") as Extract<Inline, { kind: "link" }> | undefined;
  check("[text](url) is a link with its text", l?.href === "https://example.com/docs" && inlineText(l.children) === "the docs", show(link));
  check("an escaped asterisk is an asterisk", inlineText(parseInline("\\*not italic\\*")) === "*not italic*");
  check("**bold with `code` inside**", has(parseInline("**run `ls` now**"), "code"));
}

console.log("\nhalf a reply is still something");
{
  const open = parseMarkdown("Here is the code:\n\n```python\ndef hello():\n    print(\"Hel");
  const block = open[1] as Extract<Block, { kind: "code" }>;
  check("a fence not closed yet is still code, marked open", block?.kind === "code" && !block.closed && block.text.endsWith("print(\"Hel"), show(open));
  check("an unpaired ** is just asterisks", inlineText(parseInline("this is **not closed")) === "this is **not closed");
  check("an unpaired backtick is just a backtick", inlineText(parseInline("call `useState")) === "call `useState");
  check("a table with only its header so far is a paragraph", kinds(parseMarkdown("| a | b |")) === "paragraph");
  check("a bare list marker is an empty item", kinds(parseMarkdown("- first\n-")) === "list");
  check("nothing at all is no blocks", parseMarkdown("").length === 0 && parseMarkdown("\n\n  \n").length === 0);
}

console.log("\ncallouts");
{
  const alert = parseMarkdown("> [!WARNING]\n> Don't expose API keys in client-side code.");
  const a = alert[0] as Extract<Block, { kind: "callout" }>;
  check("> [!WARNING] is a warning callout", a?.kind === "callout" && a.tone === "warning", show(alert));
  check("...holding its sentence", a?.kind === "callout" && kinds(a.blocks) === "paragraph", show(a));
  const titled = parseMarkdown("> [!TIP] Faster installs\n> Use npm ci in CI.") [0] as Extract<Block, { kind: "callout" }>;
  check("a title after the marker is kept", titled?.title === "Faster installs", show(titled));
  const note = parseMarkdown("> **Note:** keep secrets out of the client.")[0] as Extract<Block, { kind: "callout" }>;
  check("> **Note:** is a note, and the label leaves the text", note?.kind === "callout" && note.tone === "note"
    && inlineText((note.blocks[0] as Extract<Block, { kind: "paragraph" }>).inline) === "keep secrets out of the client.", show(note));
  check("> Caution: is a caution", (parseMarkdown("> Caution: this deletes data")[0] as Extract<Block, { kind: "callout" }>)?.tone === "caution");
  check("an ordinary quote stays a quote", parseMarkdown("> This is an important distinction.")[0]?.kind === "quote");
  check("\"Note:\" outside a quote is just a sentence", parseMarkdown("Note: this is prose.")[0]?.kind === "paragraph");
}

console.log("\nlinks a reply contains");
{
  const bare = parseInline("see https://www.postgresql.org/docs/current. Then continue");
  const link = bare.find((p) => p.kind === "link") as Extract<Inline, { kind: "link" }> | undefined;
  check("a bare address is a link", link?.href === "https://www.postgresql.org/docs/current", show(bare));
  check("...and the full stop after it stays in the sentence", inlineText(bare).endsWith("current. Then continue"), inlineText(bare));
  check("an address inside inline code is code, not a link",
    parseInline("run `curl https://example.com/api`").every((p) => p.kind !== "link"));
  check("a word that merely contains http is not a link", parseInline("the xhttps://thing").every((p) => p.kind !== "link"));
  check("[text](url) still wins over the bare address inside it",
    parseInline("[docs](https://example.com)").filter((p) => p.kind === "link").length === 1);
}

console.log("\nmathematics");
{
  const inlineMath = (src: string) => parseInline(src).filter((p) => p.kind === "math").map((p) => (p as Extract<Inline, { kind: "math" }>).tex);
  check("$x^2$ is inline maths", show(inlineMath("the square $x^2$ grows")) === show(["x^2"]), show(parseInline("the square $x^2$ grows")));
  check("\\( … \\) is inline maths", show(inlineMath("so \\(a + b\\) holds")) === show(["a + b"]));
  check("$5 and $10 are money", inlineMath("between $5 and $10").length === 0, show(parseInline("between $5 and $10")));
  check("$5-$10 is money", inlineMath("costs $5-$10 a month").length === 0, show(parseInline("costs $5-$10 a month")));
  check("an escaped dollar is a dollar", inlineText(parseInline("\\$x$")) === "$x$" && inlineMath("\\$x$").length === 0, show(parseInline("\\$x$")));
  check("a dollar inside inline code is code", inlineMath("run `echo $HOME$`").length === 0);
  check("inline maths reads as its TeX in plain text", inlineText(parseInline("so $n^2$ steps")) === "so n^2 steps");

  const block = parseMarkdown("The area is\n\n$$\nA = \\pi r^2\n$$\n\nfor a circle.");
  check("$$ on their own lines are a maths block", kinds(block) === "paragraph,math,paragraph", show(block));
  const m = block[1] as Extract<Block, { kind: "math" }>;
  check("...holding the TeX between them, closed", m?.tex === "A = \\pi r^2" && m.closed, show(m));
  const one = parseMarkdown("$$E = mc^2$$")[0] as Extract<Block, { kind: "math" }>;
  check("$$ … $$ on one line is a maths block", one?.kind === "math" && one.tex === "E = mc^2" && one.closed, show(one));
  const bracket = parseMarkdown("\\[\nx = 1\n\\]")[0] as Extract<Block, { kind: "math" }>;
  check("\\[ … \\] is a maths block", bracket?.kind === "math" && bracket.tex === "x = 1" && bracket.closed, show(bracket));
  const half = parseMarkdown("$$\n\\frac{a}{")[0] as Extract<Block, { kind: "math" }>;
  check("a maths block still streaming is open", half?.kind === "math" && !half.closed, show(half));
  check("a paragraph ends where a maths block starts", kinds(parseMarkdown("Consider\n$$x$$")) === "paragraph,math", show(parseMarkdown("Consider\n$$x$$")));
}

console.log(fail === 0 ? "\nall markdown checks passed" : `\n${fail} markdown check(s) FAILED`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
