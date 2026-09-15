// What a reply's code block is called, which ones are commands, and that highlighting really happens.
//
//   npm run test:highlight

import { codeLanguage, highlightCode, isCommandBlock, languageLabel } from "./highlight.ts";

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

console.log(fail === 0 ? "\nall highlight checks passed" : `\n${fail} highlight check(s) FAILED`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
