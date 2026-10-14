// Code in a reply, highlighted: which language a fence names, what to call it, and its coloured HTML.
//
// THE SAME HIGHLIGHTER AND THEME AS THE CODE PANE — shiki, with the product's own code theme
// (`codeTheme.ts`, the palette in `CODE`) — so a snippet in a reply and the file it came from are
// coloured the same way. It loads lazily, once, with no grammars at all, and
// takes each language the first time a reply uses it: a chat answer can be in any of forty languages,
// and paying for all of them on the first render would put the cost on every reply that has no code.
//
// A COMMAND IS CODE THE PERSON RUNS. A shell fence is labelled "Terminal" rather than "bash", because
// what it tells somebody is where it goes — the difference between reading a block and pasting it.
//
//   npm run test:highlight

import { CODE_THEME, CODE_THEME_NAME } from "./codeTheme.ts";

const THEME = CODE_THEME_NAME;

/** The names a model writes on a fence, mapped to the grammar shiki knows them by. */
const ALIASES: Readonly<Record<string, string>> = {
  sh: "bash", shell: "bash", zsh: "bash", console: "bash", terminal: "bash", shellscript: "bash",
  ps: "powershell", ps1: "powershell", pwsh: "powershell", cmd: "bat", batch: "bat",
  js: "javascript", mjs: "javascript", cjs: "javascript", node: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript",
  py: "python", python3: "python",
  yml: "yaml", env: "dotenv", md: "markdown", rs: "rust", golang: "go",
  "c++": "cpp", cc: "cpp", "c#": "csharp", cs: "csharp", kt: "kotlin", rb: "ruby",
  htm: "html", dockerfile: "docker", tf: "hcl", terraform: "hcl", gql: "graphql", sqlite: "sql",
  postgres: "sql", postgresql: "sql", mysql: "sql", jsonl: "json",
};

/** The grammars a reply may be highlighted with, each loaded only when first needed. */
const SUPPORTED: ReadonlySet<string> = new Set([
  "bash", "powershell", "bat", "javascript", "typescript", "jsx", "tsx", "json", "jsonc", "python",
  "yaml", "toml", "ini", "sql", "dotenv", "markdown", "html", "css", "scss", "xml", "diff", "go", "rust",
  "java", "kotlin", "swift", "ruby", "php", "c", "cpp", "csharp", "docker", "graphql", "hcl", "prisma",
  "lua", "r", "dart", "elixir", "scala", "vue", "svelte",
]);

const COMMANDS: ReadonlySet<string> = new Set(["bash", "powershell", "bat"]);

const NAMES: Readonly<Record<string, string>> = {
  javascript: "JavaScript", typescript: "TypeScript", jsx: "JSX", tsx: "TSX", json: "JSON", jsonc: "JSON",
  python: "Python", yaml: "YAML", toml: "TOML", ini: "INI", sql: "SQL", dotenv: ".env", markdown: "Markdown",
  html: "HTML", css: "CSS", scss: "SCSS", xml: "XML", diff: "Diff", go: "Go", rust: "Rust", java: "Java",
  kotlin: "Kotlin", swift: "Swift", ruby: "Ruby", php: "PHP", c: "C", cpp: "C++", csharp: "C#",
  docker: "Dockerfile", graphql: "GraphQL", hcl: "HCL", prisma: "Prisma", lua: "Lua", r: "R", dart: "Dart",
  elixir: "Elixir", scala: "Scala", vue: "Vue", svelte: "Svelte",
};

/** The grammar a fence's language names, or null when there is none to use. */
export function codeLanguage(lang: string): string | null {
  const key = lang.trim().toLowerCase();
  if (!key) return null;
  const name = ALIASES[key] ?? key;
  return SUPPORTED.has(name) ? name : null;
}

/** Whether a block is a command the person is meant to run, rather than code they read. */
export function isCommandBlock(lang: string): boolean {
  const name = codeLanguage(lang);
  return name !== null && COMMANDS.has(name);
}

/** What the block's header calls it: "Terminal" for a command, the language's own name, or "Code". */
export function languageLabel(lang: string): string {
  if (isCommandBlock(lang)) return "Terminal";
  const name = codeLanguage(lang);
  if (name) return NAMES[name] ?? name;
  const raw = lang.trim();
  return raw ? raw : "Code";
}

/** One coloured run of a line, as shiki tokenises it. `fontStyle` is shiki's bit set: 1 italic, 2 bold, 4 underline. */
export type CodeToken = { content: string; color?: string; fontStyle?: number };

type Highlighter = {
  codeToHtml: (code: string, opts: { lang: string; theme: string }) => string;
  codeToTokens: (code: string, opts: { lang: string; theme: string }) => { tokens: CodeToken[][] };
  loadLanguage: (...langs: string[]) => Promise<void>;
  getLoadedLanguages: () => string[];
};

let highlighter: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighter) {
    highlighter = import("shiki").then((shiki) =>
      shiki.createHighlighter({ themes: [CODE_THEME], langs: [] }),
    ) as unknown as Promise<Highlighter>;
  }
  return highlighter;
}

/**
 * A block's code as highlighted HTML, or null — for a language with no grammar, or when highlighting
 * fails for any reason. Null always means "show it as plain text", never an error on screen.
 */
export async function highlightCode(code: string, lang: string): Promise<string | null> {
  const name = codeLanguage(lang);
  if (!name) return null;
  try {
    const h = await getHighlighter();
    if (!h.getLoadedLanguages().includes(name)) await h.loadLanguage(name);
    return h.codeToHtml(code, { lang: name, theme: THEME });
  } catch {
    return null;
  }
}

/**
 * A file's grammar, from its name: its extension through the same aliases a fence uses (`.py` is
 * Python, `.ts` TypeScript), or the whole name for the files that are named for what they are
 * (`.env`, `Dockerfile`). Null when there is no grammar for it.
 */
export function languageForPath(path: string): string | null {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return codeLanguage(dot > 0 ? name.slice(dot + 1) : dot === 0 ? name.slice(1) : name);
}

/**
 * Code as lines of coloured runs, in the product's theme — what a surface that lays out its own lines
 * (a diff) colours them with. Null as `highlightCode` is null: no grammar, or anything going wrong.
 */
export async function highlightTokens(code: string, lang: string): Promise<CodeToken[][] | null> {
  const name = codeLanguage(lang);
  if (!name) return null;
  try {
    const h = await getHighlighter();
    if (!h.getLoadedLanguages().includes(name)) await h.loadLanguage(name);
    return h.codeToTokens(code, { lang: name, theme: THEME }).tokens;
  } catch {
    return null;
  }
}

/** A run's colour and style, as an inline style. */
export function codeTokenStyle(t: CodeToken): { color?: string; fontStyle?: string; fontWeight?: number } | undefined {
  if (!t.color && !t.fontStyle) return undefined;
  const style = t.fontStyle ?? 0;
  return { color: t.color, fontStyle: style & 1 ? "italic" : undefined, fontWeight: style & 2 ? 600 : undefined };
}
