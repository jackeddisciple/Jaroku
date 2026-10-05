// A server that hangs is a dropped connection, not a connected one.
//
// THE BUG. With the backend frozen, the Cockpit showed "connected" for over a minute: refresh stayed
// enabled, nothing was said, and a dispatch sat at "Sending…" until the server woke and ran the
// buffered job for real. A hung process keeps its TCP connections open, so the socket never closed
// and nothing here could tell. The heartbeat is what can: an open socket pings, any frame answers,
// and a ping left unanswered too long is a drop — the socket is abandoned and the ordinary
// reconnect, with its "Reconnecting…", takes over.
//
// THE CLOCK AND THE TIMERS ARE THE SUITE'S. The interval is captured rather than waited on, and
// `Date.now` is moved by hand, so "twenty-six seconds of silence" costs nothing to assert.
//
//   npm run test:socket-heartbeat

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  accept(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  /** A frame from the server. */
  deliver(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  /**
   * A HUNG SERVER NEVER ANSWERS THE CLOSE, so the close event never comes. That is the case the
   * heartbeat exists for, and a fake that fired `onclose` here would hide whether it was handled.
   */
  close(): void {
    this.closed = true;
  }
  send(data: string): void {
    this.sent.push(data);
  }
}

const g = globalThis as unknown as Record<string, unknown>;
const store = new Map<string, string>();
g["localStorage"] = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
g["window"] = { location: { search: "", href: "http://localhost/", origin: "http://localhost" }, history: { replaceState() {} } };
g["WebSocket"] = FakeSocket;
g["fetch"] = async (url: string): Promise<unknown> => {
  const path = new URL(url, "http://localhost").pathname;
  if (path === "/v1/auth/session") {
    return {
      ok: true,
      json: async () => ({
        user: { id: "u1", email: "a@b.c", displayName: "A", onboarded: true, onboardingStep: 5, isAdmin: false, adminMode: false },
        workspaces: [{ id: "ws-a", slug: "a", name: "Alpha", kind: "team", role: "owner", plan: { id: "free", label: "Free" } }],
        defaultWorkspaceId: "ws-a",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
    };
  }
  if (path === "/v1/ws-ticket") return { ok: true, json: async () => ({ ticket: "t", workspaceId: "ws-a", role: "owner" }) };
  return { ok: true, json: async () => ({}) };
};

// THE HEARTBEAT'S INTERVAL, CAPTURED. Every other interval is left to run as it would.
const realSetInterval = globalThis.setInterval;
const intervals: { fn: () => void; ms: number }[] = [];
g["setInterval"] = ((fn: () => void, ms: number) => {
  intervals.push({ fn, ms });
  return realSetInterval(() => {}, 1 << 30);
}) as unknown;
let offset = 0;
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + offset;

const { storeToken } = await import("./auth.ts");
const { useTraceStore } = await import("../store/traceStore.ts");
const { useUiStore } = await import("../store/uiStore.ts");
const { startSocket, stopSocket } = await import("./socket.ts");

storeToken("a-token");
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Connect, accept, and return the socket and its heartbeat tick. */
async function connected(): Promise<{ socket: FakeSocket; tick: () => void }> {
  intervals.length = 0;
  startSocket();
  for (let i = 0; i < 20 && FakeSocket.all.length === 0; i++) await settle();
  const socket = FakeSocket.all.at(-1)!;
  socket.accept();
  const beat = intervals.filter((i) => i.ms === 10_000).at(-1);
  return { socket, tick: () => beat?.fn() };
}

console.log("\na server that answers stays connected");
{
  const { socket, tick } = await connected();
  check(useTraceStore.getState().connection === "open", "the socket opens");
  tick();
  check(socket.sent.some((s) => JSON.parse(s).cmd === "ping"), "an open socket pings");
  socket.deliver({ channel: "heartbeat", type: "pong" });
  offset += 26_000;
  tick();
  check(useTraceStore.getState().connection === "open", "...and an answered ping keeps it connected, however long the quiet");
  check(!socket.closed, "...without closing anything");
  stopSocket();
  FakeSocket.all.length = 0;
}

console.log("\na server that stops answering is a dropped connection");
{
  const { socket, tick } = await connected();
  tick();
  offset += 10_000;
  tick();
  check(useTraceStore.getState().connection === "open", "a ping unanswered for ten seconds is not yet a drop");
  offset += 16_000;
  tick();
  check(useTraceStore.getState().connection === "closed", "unanswered past the limit, the connection is dropped");
  check(socket.closed, "...the hung socket is abandoned");
  check(socket.onclose === null && socket.onmessage === null,
    "...and detached, so its server waking later cannot apply frames to a dead connection");
  check(/Reconnecting/.test(JSON.stringify(useUiStore.getState())), "...and the ordinary reconnect takes over, and says so");
  stopSocket();
}

Date.now = realNow;
console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
