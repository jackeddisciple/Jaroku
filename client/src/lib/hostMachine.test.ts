// What a host may say this computer is called, and how often the page asks.
//
//   npm run test:host-machine

import { MACHINE_NAME_MAX, __forgetMachineName, cleanMachineName, readMachineName } from "./hostMachine.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A shell whose `machine_name` answers with `answer` after a moment, counting how often it is asked. */
function installHost(answer: () => Promise<unknown>): { calls: () => number } {
  let n = 0;
  (globalThis as Record<string, unknown>).__TAURI__ = {
    core: {
      invoke: async (cmd: string) => {
        if (cmd !== "machine_name") return null;
        n++;
        await sleep(10);
        return answer();
      },
    },
  };
  __forgetMachineName();
  return { calls: () => n };
}

console.log("\na browser has no machine to name");
{
  delete (globalThis as Record<string, unknown>).__TAURI__;
  __forgetMachineName();
  check("with no host the name is null", (await readMachineName()) === null);
}

console.log("\nthe name is the one the shell gave");
{
  installHost(async () => "Adarsh’s MacBook Air");
  check("a plain name comes through as it was given", (await readMachineName()) === "Adarsh’s MacBook Air");
}

console.log("\na burst of asks is one question");
{
  const host = installHost(async () => "Studio");
  const [a, b, c] = await Promise.all([readMachineName(), readMachineName(), readMachineName()]);
  check("three asks at once reach the shell once", host.calls() === 1, String(host.calls()));
  check("...and all three get its answer", a === "Studio" && b === "Studio" && c === "Studio");
  await readMachineName();
  check("a later ask is answered from memory", host.calls() === 1, String(host.calls()));
}

console.log("\nan answer that is not a name leaves the header empty");
{
  for (const bad of [42, null, {}, "", "   ", ""]) {
    installHost(async () => bad);
    check(`${JSON.stringify(bad)} is no name`, (await readMachineName()) === null);
  }
  check("control characters are dropped", cleanMachineName("MacBook") === "MacBook");
  check("a long name is capped", cleanMachineName("a".repeat(200))?.length === MACHINE_NAME_MAX);
}

console.log("\na failed ask is forgotten, so the next one tries again");
{
  let first = true;
  const host = installHost(async () => {
    if (first) { first = false; throw new Error("command machine_name not found"); }
    return "Studio";
  });
  check("the failure reads as no name", (await readMachineName()) === null);
  check("...and the next ask reaches the shell again", (await readMachineName()) === "Studio" && host.calls() === 2,
    String(host.calls()));
}

console.log(fail === 0 ? "\nall host-machine checks passed" : `\n${fail} host-machine check(s) FAILED`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
