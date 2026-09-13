// The subscription rows over a real socket, against the real relay.
//
// The pure derivation is covered in status.test.ts. What is only true once a relay is involved is
// the SCOPE: these rows describe the machine holding one connection, so they must reach that
// connection and no other. A workspace broadcast would put one person's laptop state into their
// colleague's browser, and the failure would look like a feature — "it already knows I have codex"
// — right up until it says that to somebody who does not.
//
// It also asserts the property that makes believing the shell safe at all: a client may report
// anything it likes, and a gated provider still comes back refused. Nothing on this wire can
// promote a provider Anthropic or Meta has not sanctioned.
//
//   npm run test:provider-auth-relay

import WebSocket from "ws";

import { openTestSqlite } from "../db/testDb.ts";
import { newRequestId, systemContextFor, type TenantContext } from "../db/tenant.ts";
import { TraceStore } from "../store.ts";
import { WsRelay } from "../wsRelay.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else { failures++; console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const db = await openTestSqlite();
const store = new TraceStore(db);
const WS = "11111111-1111-4111-8111-111111111111";
const ctx: TenantContext = systemContextFor(WS, newRequestId());

const PORT = 4519;
const relay = new WsRelay({
  port: PORT,
  store,
  clientHtmlPath: "/dev/null",
  contextFor: () => ({ ...ctx, role: "owner" as const }),
  listProviders: () => ({ providers: [], ownKeyForPlatform: false, models: [] }),
});

interface Client {
  send: (o: unknown) => void;
  want: (pred: (m: any) => boolean, label: string) => Promise<any>;
  inbox: any[];
  close: () => void;
}

async function connect(): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const inbox: any[] = [];
  ws.on("message", (d) => { try { inbox.push(JSON.parse(d.toString())); } catch { /* ignore */ } });
  await new Promise((r) => ws.once("open", r));
  return {
    inbox,
    close: () => ws.close(),
    send: (o) => ws.send(JSON.stringify(o)),
    want: async (pred, label) => {
      for (let i = 0; i < 100; i++) {
        const hit = inbox.find(pred);
        if (hit) return hit;
        await sleep(50);
      }
      throw new Error(`timeout: ${label}`);
    },
  };
}

const isSubs = (m: any): boolean => m?.channel === "providers" && m?.type === "subscriptions";
const rowFor = (m: any, provider: string): any => m.subscriptions.find((r: any) => r.provider === provider);

const a = await connect();
await sleep(150);
const b = await connect();

console.log("\nevery socket is told on frame one, before it asks");
{
  const first = await a.want(isSubs, "a's opening subscriptions");
  check(Array.isArray(first.subscriptions), "the rows arrive unprompted");
  check(first.subscriptions.length === 3, "one per provider", String(first.subscriptions.length));
  check(first.subscriptions.every((r: any) => r.connected === false), "nothing is connected before anything reports");
  // A browser tab has no CLI to sign in with, and its rows say so rather than going missing.
  check(first.subscriptions.every((r: any) => r.host === null), "...and no machine has reported");
  check((rowFor(first, "meta").reason?.length ?? 0) > 40, "a gated row explains itself on frame one");
}

console.log("\na machine reports, and only its own socket learns");
{
  a.inbox.length = 0;
  b.inbox.length = 0;
  a.send({
    cmd: "reportProviderHost",
    hosts: [{ provider: "openai", installed: true, version: "0.9.1", signedIn: true, account: "dev@example.com" }],
  });
  const after = await a.want(isSubs, "a's updated subscriptions");
  check(rowFor(after, "openai").connected === true, "the reporting socket sees its provider connect");
  check(rowFor(after, "openai").host?.account === "dev@example.com", "...and which account it is");
  check(typeof rowFor(after, "openai").host?.observedAt === "string", "...and when we looked");

  // THE SCOPE ASSERTION. B is the same workspace and learned nothing, because B is a different
  // machine. If these rows were broadcast this would be a row saying B has codex signed in.
  await sleep(300);
  check(!b.inbox.some(isSubs), "the other socket in the same workspace is told nothing");
}

console.log("\nno report can promote a provider its owner has not sanctioned");
{
  a.inbox.length = 0;
  a.send({
    cmd: "reportProviderHost",
    hosts: [
      { provider: "anthropic", installed: true, signedIn: true, account: "someone@example.com" },
      { provider: "meta", installed: true, signedIn: true, account: "someone@example.com" },
    ],
  });
  const after = await a.want(isSubs, "a's gated report");
  // The client claimed BOTH are installed and signed in. Claude is permitted, so it connects;
  // Muse Spark has no documented third-party mechanism, so it does not — however it is reported.
  // That asymmetry from one identical claim is the property: the machine never overrules the
  // provider, and a client cannot talk its way into a provider by asserting harder.
  check(rowFor(after, "anthropic").connected === true, "Claude connects, being permitted and signed in");
  check(rowFor(after, "meta").connected === false, "Muse Spark stays refused however it is reported");
  check(rowFor(after, "meta").host?.signedIn === true, "...while still reporting honestly what is installed");
  check(rowFor(after, "meta").supported === false, "...and saying no official mechanism exists");
  // Chat is not the only thing a provider can be for: Muse Spark is refused here and remains a
  // first-class runtime provider, which is the whole of the separation.
  check(rowFor(after, "meta").runtimeApiSupported === true, "...and still runs agents on an API key");
  // And the separation holds in the other direction: gating Chat never touches agent runtime.
  check(after.subscriptions.every((r: any) => r.runtimeApiSupported === true), "...and every provider still runs agents on an API key");
  // The previous report is replaced, not merged — a snapshot, like every other channel here.
  check(rowFor(after, "openai").connected === false, "a report replaces the last one rather than merging");
}

console.log("\nmalformed reports are dropped rather than stored");
{
  a.inbox.length = 0;
  a.send({
    cmd: "reportProviderHost",
    hosts: [
      { provider: "not-a-provider", installed: true, signedIn: true },
      { provider: "openai", installed: true, signedIn: "yes-please" },
    ],
  });
  const after = await a.want(isSubs, "a's malformed report");
  check(after.subscriptions.length === 3, "an invented provider does not become a row", String(after.subscriptions.length));
  check(!after.subscriptions.some((r: any) => r.provider === "not-a-provider"), "...at all");
  // `signedIn` is compared to true rather than coerced, so a truthy string is not a sign-in.
  check(rowFor(after, "openai").connected === false, "a non-boolean sign-in is not a sign-in");
}

console.log("\nrows carry no credential, because there is none to carry");
{
  const m = await a.want(isSubs, "any subscriptions message");
  // AN ALLOWLIST OF FIELDS RATHER THAN A SEARCH FOR SUSPICIOUS STRINGS, because the rows quote the
  // providers: Meta's gated reason contains the words "set META_API_KEY instead", which is its own
  // documentation and the most useful thing that row can say. A scan for credential-looking text
  // flags that and misses the actual risk, which is a FIELD appearing here that could hold one.
  const ROW_FIELDS = [
    "provider", "label", "available", "supported", "requiresApproval", "runtimeApiSupported",
    "reason", "citation", "unblock", "effortParam", "effortLevels",
    "binary", "loginCommand", "credentialPath", "host", "connected",
  ].sort().join(",");
  const HOST_FIELDS = ["installed", "version", "signedIn", "account", "observedAt"].sort().join(",");
  const rows: any[] = m.subscriptions;
  check(rows.every((r) => Object.keys(r).sort().join(",") === ROW_FIELDS), "a row carries exactly the fields it should",
    Object.keys(rows[0]).sort().join(","));
  check(rows.filter((r) => r.host).every((r) => Object.keys(r.host).sort().join(",") === HOST_FIELDS),
    "...and a machine report carries exactly the facts it should");
  // The path is named so the product can tell somebody where their sign-in lives; it is never read.
  check(rowFor(m, "openai").credentialPath === "~/.codex/auth.json", "...though the row says where the provider keeps it");
}

a.close();
b.close();
await relay.close();
await db.close?.();

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
