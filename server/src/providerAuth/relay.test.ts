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
// promote a provider its owner has not sanctioned — Muse Spark, today.
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
const waitFor = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 60 && !cond(); i++) await sleep(50);
};

const db = await openTestSqlite();
const store = new TraceStore(db);
const WS = "11111111-1111-4111-8111-111111111111";
const ctx: TenantContext = systemContextFor(WS, newRequestId());

const PORT = 4519;
/** What the relay handed on to the app, so a refusal can be told apart from a forward. */
const forwarded: any[] = [];
const relay = new WsRelay({
  port: PORT,
  store,
  onCommand: (cmd: any) => { forwarded.push(cmd); },
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

  // AND THIS SERVER'S HALF OF THE HANDSHAKE, on every providers snapshot — on connect, on asking, and on
  // a broadcast. A server that predates subscription Chat never sends it, and the app says so.
  const opening = await a.want((m) => m?.channel === "providers" && m?.type === "providers", "a's opening providers");
  check(opening.subscriptionChat === true, "the providers snapshot says this server runs Chat on a subscription");
  a.inbox.length = 0;
  a.send({ cmd: "listProviders" });
  const asked = await a.want((m) => m?.channel === "providers" && m?.type === "providers", "a's providers on asking");
  check(asked.subscriptionChat === true, "...when asked for again");
  a.inbox.length = 0;
  relay.broadcastProviders(ctx, { type: "providers", providers: [], ownKeyForPlatform: false, models: [] });
  const broadcast = await a.want((m) => m?.channel === "providers" && m?.type === "providers", "a broadcast providers snapshot");
  check(broadcast.subscriptionChat === true, "...and on a broadcast, which is how a key change reaches every tab");
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

console.log("\nthe shell's own sentence reaches the row, bounded");
{
  // IT USED TO STOP AT THE PAGE. The shell writes "signed in with API credentials rather than a
  // ChatGPT plan" and the page parsed it, then left it out of this report — so the row guessed.
  a.inbox.length = 0;
  const note = "Codex is signed in with API credentials rather than a ChatGPT plan. Chat runs on your subscription, so it needs `codex login` with your ChatGPT account.";
  a.send({
    cmd: "reportProviderHost",
    hosts: [{ provider: "openai", installed: true, signedIn: false, account: null, authMode: "apikey", note }],
  });
  const after = await a.want(isSubs, "a's report with a note");
  check(rowFor(after, "openai").host?.note === note, "the note arrives verbatim", String(rowFor(after, "openai").host?.note));
  check(rowFor(after, "openai").host?.authMode === "apikey", "...beside the mode it explains");
  check(rowFor(after, "openai").connected === false, "...and changes nothing about the verdict");

  a.inbox.length = 0;
  a.send({ cmd: "reportProviderHost", hosts: [{ provider: "openai", installed: true, signedIn: false, note: "x".repeat(5000), authMode: 42 }] });
  const bounded = await a.want(isSubs, "a's oversized note");
  check((rowFor(bounded, "openai").host?.note ?? "").length === 400, "an oversized note is cut to a sentence's length",
    String((rowFor(bounded, "openai").host?.note ?? "").length));
  check(rowFor(bounded, "openai").host?.authMode === null, "...and a mode that is not a string is dropped");
}

console.log("\nrows carry no credential, because there is none to carry");
{
  const m = await a.want(isSubs, "any subscriptions message");
  // AN ALLOWLIST OF FIELDS RATHER THAN A SEARCH FOR SUSPICIOUS STRINGS, because the rows quote the
  // providers: Meta's gated reason contains the words "set META_API_KEY instead", which is its own
  // documentation and the most useful thing that row can say. A scan for credential-looking text
  // flags that and misses the actual risk, which is a FIELD appearing here that could hold one.
  const ROW_FIELDS = [
    "provider", "label", "planLabel", "available", "supported", "requiresApproval", "runtimeApiSupported",
    "reason", "citation", "unblock", "effortParam", "effortLevels",
    "binary", "loginCommand", "credentialPath", "host", "connected",
  ].sort().join(",");
  const HOST_FIELDS = ["installed", "version", "signedIn", "account", "authMode", "note", "observedAt"].sort().join(",");
  const rows: any[] = m.subscriptions;
  check(rows.every((r) => Object.keys(r).sort().join(",") === ROW_FIELDS), "a row carries exactly the fields it should",
    Object.keys(rows[0]).sort().join(","));
  check(rows.filter((r) => r.host).every((r) => Object.keys(r.host).sort().join(",") === HOST_FIELDS),
    "...and a machine report carries exactly the facts it should");
  // The path is named so the product can tell somebody where their sign-in lives; it is never read.
  check(rowFor(m, "openai").credentialPath === "~/.codex/auth.json", "...though the row says where the provider keeps it");
}

console.log("\na subscription turn is taken only on a plan this machine reported");
{
  // THE RELAY IS WHERE THE SOCKET IS, so it is the one place that can ask whether the machine at the
  // other end said this plan was signed in. Past it, a chat naming a plan — or a record filed under
  // the `subscription` route — is only the client's word.
  const c = await connect();
  await c.want(isSubs, "c's opening subscriptions");
  const chat = { cmd: "chat", message: "hi", subscription: { provider: "openai", model: null, effort: null } };
  forwarded.length = 0;
  c.send(chat);
  const refused = await c.want((m) => m?.channel === "reply" && m?.type === "error", "a refusal for a plan nobody reported");
  check(!forwarded.some((f) => f.cmd === "chat"), "a chat on a plan this socket never reported is not forwarded");
  check(typeof refused.message === "string" && refused.message.length > 0, "...and the socket is told why", String(refused.message));

  c.inbox.length = 0;
  c.send({ cmd: "reportProviderHost", hosts: [{ provider: "openai", installed: true, version: "0.9.1", signedIn: true, account: null }] });
  await c.want((m) => isSubs(m) && rowFor(m, "openai").connected === true, "c's rows once openai is signed in");
  c.send(chat);
  await waitFor(() => forwarded.some((f) => f.cmd === "chat"));
  check(forwarded.some((f) => f.cmd === "chat" && f.subscription?.provider === "openai"), "once the machine reports it signed in, the chat goes through");
  // AND ONE PLAN THIS MACHINE REPORTED IS NOT EVERY PLAN.
  forwarded.length = 0;
  c.send({ ...chat, subscription: { provider: "anthropic", model: null, effort: null } });
  await c.want((m) => m?.channel === "reply" && m?.type === "error", "a refusal for the plan it did not report");
  check(!forwarded.some((f) => f.cmd === "chat"), "...while one on a plan it never reported still is not");

  // THE OLDER RECORD PATH filed a turn under the `subscription` route on the client's word alone.
  forwarded.length = 0;
  c.send({ cmd: "recordChatTurn", question: "q", answer: "a", provider: "anthropic" });
  c.send({ cmd: "recordChatTurn", question: "q", answer: "a", provider: "openai" });
  await waitFor(() => forwarded.some((f) => f.cmd === "recordChatTurn"));
  await sleep(150);
  const records = forwarded.filter((f) => f.cmd === "recordChatTurn");
  check(records.length === 1 && records[0].provider === "openai", "a record is kept only for the plan this machine reported",
    JSON.stringify(records));
  // A SETTLE NAMES A RUN, and the server hands a run to no socket but the one it was handed to.
  forwarded.length = 0;
  c.send({ cmd: "recordChatTurn", runId: "run-1", answer: "a", provider: "anthropic" });
  await waitFor(() => forwarded.some((f) => f.cmd === "recordChatTurn"));
  check(forwarded.some((f) => f.cmd === "recordChatTurn" && f.runId === "run-1"), "a settle is forwarded for the registry to judge");

  // AND AN EDIT-AND-FORK, whose answer is a chat turn like any other.
  c.inbox.length = 0;
  forwarded.length = 0;
  c.send({ cmd: "editTurn", threadId: "t-1", turnId: "i-1", message: "m", subscription: { provider: "anthropic", model: null, effort: null } });
  await c.want((m) => m?.channel === "reply" && m?.type === "error", "a refusal for a fork on a plan it did not report");
  check(!forwarded.some((f) => f.cmd === "editTurn"), "a fork on a plan this machine never reported is not forwarded");
  c.send({ cmd: "editTurn", threadId: "t-1", turnId: "i-1", message: "m", subscription: { provider: "openai", model: null, effort: null } });
  await waitFor(() => forwarded.some((f) => f.cmd === "editTurn"));
  check(forwarded.some((f) => f.cmd === "editTurn" && f.subscription?.provider === "openai"), "...and one on the plan it did report is");
  c.close();
}

a.close();
b.close();
await relay.close();
await db.close?.();

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
