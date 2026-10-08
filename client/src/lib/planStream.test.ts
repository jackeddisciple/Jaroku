// What the plan card shows while a plan streams.
//
//   npm run test:plan-stream

import { readablePlanStream } from "./planStream.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const full = `<<<PLAN section="name">>>\nCity Facts\n<<<ENDPLAN>>>\n<<<PLAN section="tools">>>\n- none\n<<<ENDPLAN>>>\n`;
const shown = readablePlanStream(full);
check("no delimiter survives", !shown.includes("<<<") && !shown.includes(">>>"), JSON.stringify(shown));
check("each section is a heading", shown.startsWith("NAME\nCity Facts") && shown.includes("TOOLS\n- none"), JSON.stringify(shown));

for (const cut of ["<", "<<", "<<<", "<<<PL", "<<<PLAN", "<<<PLAN sec", '<<<PLAN section="to', '<<<PLAN section="tools"', '<<<PLAN section="tools">', "<<<END", "<<<ENDPLAN>"]) {
  const partial = readablePlanStream(`<<<PLAN section="tools">>>\n- a — bespoke\n${cut}`);
  check(`a marker still arriving ("${cut}") is held back`, !partial.includes("<"), JSON.stringify(partial));
}
check("prose with a less-than sign is left alone", readablePlanStream("- when x < 3, retry").includes("x < 3"));

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
