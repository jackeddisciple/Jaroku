// What a reply's code block is called, which ones are commands, and that highlighting really happens.
//
//   npm run test:highlight

import { codeLanguage, highlightCode, isCommandBlock, languageLabel } from "./highlight.ts";
import { CODE } from "./tokens.ts";
import { CODE_THEME_NAME } from "./codeTheme.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("\nthe names a model writes on a fence");
{
  check("ts is TypeScript", codeLanguage("ts") === "typescript" && languageLabel("ts") === "TypeScript");
  check("py is Python", codeLanguage("PY") === "python" && languageLabel("py") === "Python");
  check("env is a .env file", codeLanguage("env") === "dotenv" && languageLabel("env") === ".env");
  check("a language with no grammar keeps its own name", codeLanguage("brainfuck") === null && languageLabel("brainfuck") === "brainfuck");
  check("a fence with no language is Code", codeLanguage("") === null && languageLabel("") === "Code");
}

console.log("\ncommands are labelled for where they go");
{
  for (const lang of ["bash", "sh", "zsh", "shell", "console", "powershell", "cmd"]) {
    check(`${lang} is a command, labelled Terminal`, isCommandBlock(lang) && languageLabel(lang) === "Terminal", languageLabel(lang));
  }
  check("python is code, not a command", !isCommandBlock("python"));
  check("a fence with no language is not a command", !isCommandBlock(""));
}

console.log("\nhighlighting");
{
  const html = await highlightCode("def hello():\n    print(\"Hello\")", "python");
  check("a Python block comes back as highlighted HTML", typeof html === "string" && html.includes("<pre") && html.includes("hello"), String(html).slice(0, 80));
  check("...with colour in it", typeof html === "string" && /color:#[0-9a-fA-F]{3,8}/.test(html));
  const shell = await highlightCode("npm install\nnpm run dev", "sh");
  check("a shell block, by its alias", typeof shell === "string" && shell.includes("npm"), String(shell).slice(0, 80));
  check("a language with no grammar is plain text", (await highlightCode("+++", "brainfuck")) === null);
  const escaped = await highlightCode("<script>alert(1)</script>", "html");
  check("code is escaped, never markup", typeof escaped === "string" && !escaped.includes("<script>"), String(escaped).slice(0, 120));
}

console.log("\nthe product's palette, token by token");
{
  // Each word below, in the colour the palette gives its kind — read out of shiki's own markup.
  const colourOf = (html: string, word: string): string | null => {
    const m = new RegExp(`<span style="color:(#[0-9A-Fa-f]{6})[^"]*">[^<]*${word.replace(/[()]/g, "\\$&")}`).exec(html);
    return m ? m[1]!.toUpperCase() : null;
  };
  const ts = (await highlightCode(
    "import { Component } from 'react';\nclass HomePage extends Component {\n  name: string = 'Hello world';\n  validateForm() { return this.email.trim() + 100; } // a comment\n}",
    "ts",
  )) ?? "";
  const want: [string, string, string][] = [
    ["import", CODE.keyword, "a keyword"],
    ["return", CODE.keyword, "...another"],
    ["Hello world", CODE.string, "a string"],
    ["validateForm", CODE.function, "a function"],
    ["trim", CODE.function, "a method"],
    ["email", CODE.variable, "a property"],
    ["HomePage", CODE.type, "a class"],
    ["string", CODE.type, "a type"],
    ["100", CODE.number, "a number"],
    ["a comment", CODE.comment, "a comment"],
  ];
  for (const [word, colour, what] of want) {
    check(`${what} (${word}) is ${colour}`, colourOf(ts, word) === colour.toUpperCase(), String(colourOf(ts, word)));
  }
  check("a comment is italic as well", /font-style:italic[^>]*>[^<]*a comment/.test(ts));
  const json = (await highlightCode('{"must_haves": ["Python", 5], "ok": true}', "json")) ?? "";
  check("a JSON key is a property", colourOf(json, "must_haves") === CODE.variable.toUpperCase(), String(colourOf(json, "must_haves")));
  check("...its values strings and numbers", colourOf(json, "Python") === CODE.string.toUpperCase() && colourOf(json, "5") === CODE.number.toUpperCase());
  // THE CODE PANE ASKS FOR THE SAME THEME, by name — its own highlighter, the same colours.
  const viewer = readFileSync(fileURLToPath(new URL("../components/CodeViewer.tsx", import.meta.url)), "utf8");
  check("the code pane is drawn in the same theme", viewer.includes(`const THEME = "${CODE_THEME_NAME}"`) && viewer.includes("CODE_THEME"));
  check("no background of its own is written into the markup",
    !/background-color:(?!transparent)/.test(ts), ts.match(/background-color:[^;"]*/)?.[0] ?? "");
}

console.log(fail === 0 ? "\nall highlight checks passed" : `\n${fail} highlight check(s) FAILED`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
