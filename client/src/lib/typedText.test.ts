// How fast a changed chat name types itself out.
//
//   npm run test:typed-text

import { MAX_TYPING_MS, MS_PER_CHAR, typedLength } from "./typedText.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("\na name types a character at a time");
{
  check("the first character is there at once", typedLength(8, 0) === 1, String(typedLength(8, 0)));
  check("the next arrives one step later", typedLength(8, MS_PER_CHAR) === 2, String(typedLength(8, MS_PER_CHAR)));
  check("a short name is whole after its characters' time", typedLength(8, MS_PER_CHAR * 8) === 8);
  check("...and never shows more than it has", typedLength(8, 60_000) === 8);
}

console.log("\na long name speeds up rather than dragging on");
{
  const long = 200;
  check("it is still typing part-way through", typedLength(long, MAX_TYPING_MS / 2) < long);
  check(`...and whole by ${MAX_TYPING_MS}ms`, typedLength(long, MAX_TYPING_MS) === long, String(typedLength(long, MAX_TYPING_MS)));
}

console.log("\nnothing to type is nothing shown");
{
  check("an empty name is empty", typedLength(0, 500) === 0);
  check("a clock that went backwards still shows the first character", typedLength(5, -40) === 1);
}

console.log(fail === 0 ? "\nall typed-text checks passed" : `\n${fail} typed-text check(s) FAILED`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
