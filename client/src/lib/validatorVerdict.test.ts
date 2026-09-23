// The panel claims the validator passed a version only when it did.
//
//   npm run test:validator-verdict

import { validatorVerdict } from "./validatorVerdict.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("\nonly the two sources the validator gates are said to have passed it");
{
  check("a generation passed", validatorVerdict("generation", 3).passed);
  check("an edit passed", validatorVerdict("edit", 4).passed);
  check("...and the sentence names the version", validatorVerdict("edit", 4).sentence.startsWith("v4 passed"));
}

console.log("\n...and nothing else is");
{
  // THE BUG: a deploy version fell into "everything else" and was given the green sentence.
  const deploy = validatorVerdict("deploy", 4);
  check("a deploy version is not said to have passed", !deploy.passed);
  check("...nor does its sentence claim it", !/passed/.test(deploy.sentence), deploy.sentence);
  check("...nor its tooltip", !/through the validator/.test(deploy.short), deploy.short);
  check("an import is not", !validatorVerdict("import", 2).passed);
  const none = validatorVerdict(null, 1);
  check("nothing published is not", !none.passed);
  check("...and names no version it does not have", !/v1/.test(none.sentence + none.short));
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
