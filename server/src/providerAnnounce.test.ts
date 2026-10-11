// A provider key saved, rotated or revoked in Secrets reaches every open app at once.
//
// What it exists to stop: Run deciding from a provider snapshot that only arrives when the socket
// connects — so after adding ANTHROPIC_API_KEY, Run kept sending people back to Secrets until they
// restarted the app.
//
//   npm run test:provider-announce

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { providerKeyAnnouncer } from "./providerAnnounce.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

console.log("§1 a provider key's name announces; any other name does not");
{
  const sent: string[] = [];
  const announce = providerKeyAnnouncer<string>(async (ctx) => void sent.push(ctx));
  await announce("ws-a", "ANTHROPIC_API_KEY");
  await announce("ws-b", "OPENAI_API_KEY");
  await announce("ws-c", "STRIPE_API_KEY");
  await announce("ws-d", "ANTHROPIC");
  check(sent.join(",") === "ws-a,ws-b", `only the provider keys' workspaces are told (${sent.join(",")})`);
}

console.log("\n§2 a broadcast that fails does not fail the write");
{
  const warned: string[] = [];
  const announce = providerKeyAnnouncer<string>(async () => { throw new Error("socket gone"); }, (l) => void warned.push(l));
  let threw = false;
  try {
    await announce("ws-a", "ANTHROPIC_API_KEY");
  } catch {
    threw = true;
  }
  check(!threw, "the error is caught");
  check(warned.length === 1 && warned[0]!.includes("ANTHROPIC_API_KEY") && warned[0]!.includes("socket gone"), "and said in the log");
}

console.log("\n§3 the Secrets routes announce after every write");
{
  const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
  const store = source.match(/\n {2}store: async \(caller, input\) => \{[\s\S]*?\n {2}\},/)?.[0] ?? "";
  const revoke = source.match(/\n {2}revoke: async \(caller, name\) => \{[\s\S]*?\n {2}\},/)?.[0] ?? "";
  check(/secretsManager\.store\([\s\S]*announceProviderKeyChange\(caller\.ctx, input\.name\)/.test(store), "store announces, after the write and only when it succeeded");
  check(/if \(result\.ok\) await announceProviderKeyChange/.test(store), "...gated on the write having succeeded");
  check(/secretsManager\.revoke\([\s\S]*announceProviderKeyChange\(caller\.ctx, name\)/.test(revoke), "revoke announces, after the write");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
