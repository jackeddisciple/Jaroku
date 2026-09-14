// What a host may say about the provider CLIs on this machine, and how often the page asks it.
//
// TWO PROPERTIES, AND BOTH FAIL WHILE LOOKING LIKE THEY WORK. A half-parsed report that claimed a
// sign-in would put a provider in the model menu that cannot answer. And a probe is several process
// spawns: the page asks on connect, on mount and from a Check again pressed twice, and the desktop
// log showed fifteen probes in a minute, six of them 316ms apart.
//
//   npm run test:host-providers

import { hasHost, readHostProviders } from "./hostProviders.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A shell whose `provider_hosts` takes a moment and answers `answer`, counting how often it is asked. */
function installHost(answer: unknown, delayMs = 20): { calls: () => number } {
  let n = 0;
  (globalThis as Record<string, unknown>).__TAURI__ = {
    core: {
      invoke: async (cmd: string) => {
        if (cmd !== "provider_hosts") return null;
        n++;
        await sleep(delayMs);
        return answer;
      },
    },
  };
  return { calls: () => n };
}

const ROW = {
  provider: "openai", installed: true, version: "codex-cli 0.154.0", signedIn: true,
  account: "someone@example.com", authMode: "chatgpt", note: null,
};

console.log("\na burst of asks is one probe");
{
  const host = installHost([ROW]);
  const [a, b, c] = await Promise.all([readHostProviders(), readHostProviders(), readHostProviders()]);
  check("three asks while one probe runs spawn it once", host.calls() === 1, String(host.calls()));
  check("...and all three get its answer", a.length === 1 && a === b && b === c);
  await readHostProviders();
  check("an ask after it settled probes again", host.calls() === 2, String(host.calls()));
}

console.log("\nevery row is validated, not trusted");
{
  installHost([ROW, { provider: "", installed: true }, { provider: "anthropic", installed: "yes", signedIn: "true" }, null, 42]);
  const rows = await readHostProviders();
  check("an unnamed or malformed row is dropped", rows.length === 2, JSON.stringify(rows));
  const claude = rows.find((r) => r.provider === "anthropic");
  check("...and a truthy string is not a sign-in", claude?.signedIn === false && claude?.installed === false, JSON.stringify(claude));
  check("the shell's sentence and mode survive as they came", rows[0]?.authMode === "chatgpt" && rows[0]?.note === null);
}

console.log("\na host that errors, or is not there, is an empty answer");
{
  (globalThis as Record<string, unknown>).__TAURI__ = {
    core: { invoke: async () => { throw new Error("command not found"); } },
  };
  check("a rejected probe is an empty list", (await readHostProviders()).length === 0);
  delete (globalThis as Record<string, unknown>).__TAURI__;
  check("no host at all is an empty list", (await readHostProviders()).length === 0);
  check("...and says there is none", hasHost() === false);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
