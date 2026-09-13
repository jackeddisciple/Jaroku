// No store selector may return a value it just built.
//
// THIS RULE COST A WHITE SCREEN. Zustand reads a selector through React's
// `useSyncExternalStore`, which decides "did this change?" by comparing the returned value BY
// REFERENCE. A selector that builds something — `s.notes[id] ?? []`, `s.feedback[id] ?? { up: 0 }`
// — returns a different object every call, so the answer is always "changed": React re-renders,
// calls the selector, gets another new object, and eventually gives up:
//
//   The result of getSnapshot should be cached to avoid an infinite loop
//   Maximum update depth exceeded
//
// ...and unmounts the tree. `document.body.innerText.length` goes to zero. A blank window.
//
// IT WAS FOUND BY CLICKING A CONVERSATION IN A REAL BROWSER, and it could not have been found any
// other way: the stores are correct, every unit suite passes, the wire is right, and the defect
// exists only in the render loop. Three selectors had the shape; two of them were on `TurnNotes`,
// which mounts once per turn in the action row, so opening any thread with turns in it was enough.
//
// THE FIX IS ALWAYS THE SAME: one frozen value, declared once at module scope, returned for the
// empty case. `Object.freeze` so a caller that tries to mutate the shared empty fails here rather
// than corrupting it for every other reader.
//
// WHY A SOURCE-READING SUITE. Reproducing it needs React, a DOM and a store with a missing key —
// and the property is a fact about the TEXT: a selector body that contains a literal after `??`,
// or is a literal, or ends in an array method, returns a fresh value. That is decidable here.
//
//   npm run test:selectors

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// `node:path` is not in the client's type environment — `deadControls.test.ts` resolves its own
// root the same way, from the module URL.
const SRC = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

/** Comments blanked, so a comment describing the hazard is not read as the hazard. */
function strip(text: string): string {
  const blanked = (m: string): string => m.replace(/[^\n]/g, " ");
  return text.replace(/\/\*[\s\S]*?\*\//g, blanked).replace(/^[ \t]*\/\/.*$/gm, blanked);
}

function sources(): { path: string; text: string }[] {
  return readdirSync(SRC, { recursive: true })
    .map((e) => String(e).replace(/\\/g, "/"))
    .filter((p) => /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p))
    .map((p) => ({ path: p, text: strip(readFileSync(`${SRC}/${p}`, "utf8")) }));
}

/**
 * Every `useSomethingStore((s) => …)` body in a file, by brace matching rather than by regex —
 * a selector body can contain parentheses, and a pattern that stopped at the first `)` would read
 * half of one.
 */
function selectorBodies(src: string): { line: number; body: string }[] {
  const out: { line: number; body: string }[] = [];
  for (const m of src.matchAll(/use\w*Store\(\s*\(\w*\)\s*=>\s*/g)) {
    const start = m.index! + m[0].length;
    let depth = 0;
    let j = start;
    while (j < src.length) {
      const c = src[j]!;
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) {
        if (depth === 0) break;
        depth--;
      }
      j++;
    }
    out.push({ line: src.slice(0, m.index!).split("\n").length, body: src.slice(start, j).trim() });
  }
  return out;
}

const FILES = sources();

console.log("\nevery selector returns something the store already holds");
{
  check("read the client's sources", FILES.length > 40, String(FILES.length));

  const offenders: string[] = [];
  let examined = 0;
  for (const { path, text } of FILES) {
    for (const { line, body } of selectorBodies(text)) {
      examined++;
      const one = body.replace(/\s+/g, " ");

      // A LITERAL AFTER `??` IS THE WHOLE BUG, and it is the form all three offenders took: the
      // store has no entry yet, so the fallback is constructed, and it is constructed again on
      // every call for as long as the key is missing — which is exactly while a thread is loading.
      const fallbackLiteral = /\?\?\s*(\[\s*\]|\[[^\]]*\]|\{[^}]*\})/.test(one);

      // A BODY THAT IS ITSELF A LITERAL — `(s) => ({ a: s.a, b: s.b })`. The usual Zustand advice is
      // an equality function; this codebase's rule is simpler, which is to select one field at a
      // time, so a literal body is flagged rather than blessed.
      const literalBody = /^\(?\s*[[{]/.test(one) && !/^\{\s*(const|let|return|if|for|switch)\b/.test(one);

      // AN ARRAY METHOD AT THE END returns a new array — unless what it produces is reduced to a
      // scalar, which compares by value and is therefore stable.
      const builds = /\.(filter|map|flatMap|slice|concat|sort|reduce|entries|keys|values)\(/.test(one);
      const scalar = /(\.length|\.size)\s*$/.test(one) || /^[^[{]*(===|!==|>=|<=|>|<)[^[{]*$/.test(one);

      if (fallbackLiteral || literalBody || (builds && !scalar)) {
        offenders.push(`${path}:${line} → ${one.slice(0, 88)}`);
      }
    }
  }

  check(`examined every store selector (${examined})`, examined > 20, String(examined));
  check(
    offenders.length === 0
      ? "no selector builds a fresh value"
      : `no selector builds a fresh value — ${offenders.length} found`,
    offenders.length === 0,
    offenders.join(" | "),
  );
}

// --- and the frozen empties themselves, which are the fix ------------------------------------
//
// Asserted so the fix cannot be quietly replaced by an inline literal again: the two selectors that
// took the app down now read a module-level constant, and that constant is frozen.

console.log("\nthe empty cases are one value each, and frozen");
{
  for (const [file, name] of [
    ["store/chatStore.ts", "NO_TURNS"],
    ["components/composer/TurnNotes.tsx", "NO_NOTES"],
    ["components/composer/TurnNotes.tsx", "NO_FEEDBACK"],
  ] as const) {
    const text = FILES.find((f) => f.path === file)?.text ?? "";
    check(`${name} exists in ${file}`, new RegExp(`const ${name}\\b`).test(text), file);
    check(`...and is frozen`, new RegExp(`const ${name}[^\\n]*Object\\.freeze`).test(text),
      (new RegExp(`const ${name}[^\\n]*`).exec(text) ?? [""])[0]);
  }
  // AND THE THREE PLACES THAT READ THEM. A constant nobody uses is a fix that was reverted.
  const chat = FILES.find((f) => f.path === "store/chatStore.ts")?.text ?? "";
  check("threadFor returns the shared empty",
    /state\.threads\[threadId\] \?\? NO_TURNS/.test(chat), "threadFor");
  const notes = FILES.find((f) => f.path === "components/composer/TurnNotes.tsx")?.text ?? "";
  check("the note list returns the shared empty", /s\.notes\[turnId\] \?\? NO_NOTES/.test(notes), "notes");
  check("the feedback summary returns the shared empty",
    /s\.feedback\[turnId\] \?\? NO_FEEDBACK/.test(notes), "feedback");
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
