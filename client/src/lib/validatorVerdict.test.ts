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

console.log("\na restore is the version it copied, and says so");
{
  // THE BUG: a restore published as `import`, so restoring a version that had passed the validator
  // said it "was published as-is". It carries the copied source now, and names the version.
  const restored = validatorVerdict("generation", 5, 1);
  check("restoring a version that passed keeps the pass", restored.passed);
  check("...and says it is a restore of that version", restored.sentence.startsWith("v5 restores v1"), restored.sentence);
  check("...in the tooltip too", /Restores v1/.test(restored.short), restored.short);
  check("restoring an import is still not a pass", !validatorVerdict("import", 5, 2).passed);
  check("restoring a deploy version is not one either", !validatorVerdict("deploy", 5, 4).passed);
  check("a version that restored nothing reads as before",
    validatorVerdict("edit", 5, null).sentence === "v5 passed the validator when it was published.");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
