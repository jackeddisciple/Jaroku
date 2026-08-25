// §14.1's `test:workspace-switch` — the teardown and rebuild §5 calls the hardest section it has.
//
// WHAT IS BEING ASSERTED, AND WHY IT CANNOT BE ASSERTED BY LOOKING. §5.2 states the ordering
// requirement in one sentence: "Step 2 (close old socket) must happen BEFORE step 5 (open new
// socket). Two simultaneous sockets would both try to update stores, and broadcasts from the old
// workspace would land in the new workspace's view." Reading `switchWorkspace` tells you the calls
// are in that order today. It does not tell you that a reconnect timer armed before the switch
// cannot fire during it, that a ticket fetched for A cannot open a socket for B, or that the
// stores were emptied before the new socket had anywhere to put anything — all of which are
// orderings between an await and a timer, and all of which have been wrong here before.
//
// SO THE SOCKET AND THE NETWORK ARE FAKES THAT RECORD. Every `fetch` is answered from a script and
// logged; every `WebSocket` is an object that remembers whether it was opened and closed and in
// what order relative to the others. The assertions are then about the TRANSCRIPT, which is the
// only thing that can distinguish "closed then opened" from "opened then closed" after the fact.
//
// THE LOAD-BEARING ASSERTION IS THE LAST ONE IN EACH BLOCK: nothing from workspace A survives into
// workspace B. That is a cross-tenant leak in the UI, it is the failure `store/reset.ts` exists
// for, and it is the one a screenshot of a working switch does not rule out — the stores look
// empty because the new snapshot has replaced what was on screen, not because anything cleared.
//
//   npm run test:workspace-switch

import { seed } from "./testRender.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

// --- the fakes, installed before anything imports the socket ----------------------------------

/** Everything that happened, in the order it happened. The transcript the assertions read. */
const log: string[] = [];

interface Scripted {
  /**
   * The one workspace `POST /v1/ws-ticket` refuses, and with what. Null while it refuses nobody.
   *
   * IT NAMES A WORKSPACE BECAUSE A REFUSAL IS ABOUT ONE. This started as a flag — refuse the next
   * ticket, whichever it is for — and a fixture shaped that way cannot express §5.2's case at all.
   * The revert opens a socket on the workspace it came FROM, so a route that refuses everything
   * answers 403 for that one too and the session signs out. Which is correct behaviour: a ticket
   * refused for the workspace you are already in is a membership that ended under you. It is just
   * not what "the target refuses" means, and a fixture that cannot tell those apart tests neither.
   */
  refuse: { workspaceId: string; status: number; message: string } | null;
}
const script: Scripted = { refuse: null };

class FakeSocket {
  static open: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    log.push(`socket.new ${new URL(url).searchParams.get("ticket")}`);
    FakeSocket.open.push(this);
  }
  /** The handshake succeeding. Called by the suite, so the moment it happens is a decision. */
  accept(): void {
    this.readyState = 1;
    log.push("socket.open");
    this.onopen?.();
  }
  /** The handshake being refused: a close with no open before it. §5.2's other failure. */
  refuse(code = 1006): void {
    this.readyState = 3;
    log.push("socket.refused");
    this.onclose?.({ code });
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    log.push("socket.close");
    this.onclose?.({ code: 1000 });
  }
  send(): void {
    /* nothing here reads what a switch sends */
  }
}

const g = globalThis as unknown as {
  WebSocket: unknown;
  fetch: unknown;
  localStorage: unknown;
  window: unknown;
};

// A LOCAL STORAGE, because `sessionVault` writes the remembered workspace through one and the
// switch's whole job includes remembering where it went. A Map is the whole of what it needs.
const store = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
g.window = { location: { search: "", href: "http://localhost/", origin: "http://localhost" }, history: { replaceState() {} } };
g.WebSocket = FakeSocket;

const WORKSPACES = [
  { id: "ws-a", slug: "a", name: "Alpha", kind: "team", role: "owner", plan: { id: "free", label: "Free" } },
  { id: "ws-b", slug: "b", name: "Beta", kind: "team", role: "member", plan: { id: "free", label: "Free" } },
];

g.fetch = async (url: string, init?: { body?: string }): Promise<unknown> => {
  const path = new URL(url, "http://localhost").pathname;
  const body = init?.body ? (JSON.parse(init.body) as { workspaceId?: string }) : {};
  if (path === "/v1/auth/session") {
    log.push("http.session");
    return {
      ok: true,
      json: async () => ({
        user: { id: "u1", email: "a@b.c", displayName: "A", onboarded: true, onboardingStep: 5, isAdmin: false, adminMode: false },
        workspaces: WORKSPACES,
        defaultWorkspaceId: "ws-a",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
    };
  }
  if (path === "/v1/ws-ticket") {
    log.push(`http.ticket ${body.workspaceId ?? "default"}`);
    // The workspace asked for. The real route issues a ticket for whatever the caller names and
    // 403s the ones they are not a member of, so echoing the request back is what makes a refusal
    // of one workspace distinguishable from a route that is refusing everybody.
    const id = body.workspaceId ?? "ws-a";
    if (script.refuse?.workspaceId === id) {
      const { status, message } = script.refuse;
      return {
        ok: false,
        status,
        statusText: message,
        text: async () => JSON.stringify({ error: { message } }),
      };
    }
    return { ok: true, json: async () => ({ ticket: `ticket-for-${id}`, workspaceId: id, role: "owner" }) };
  }
  log.push(`http.other ${path}`);
  return { ok: true, json: async () => ({}) };
};

// Imported AFTER the fakes: `socket.ts` reads `WebSocket` per call, but `sessionVault` decides
// whether it is in a browser at module load, and the stores it pulls in read `localStorage`.
const { storeToken } = await import("./auth.ts");
const { useSessionStore } = await import("../store/sessionStore.ts");
const { useBuildStore } = await import("../store/buildStore.ts");
const { useThreadStore } = await import("../store/threadStore.ts");
const { useMemberStore } = await import("../store/memberStore.ts");
const { WORKSPACE_STORES } = await import("../store/reset.ts");
const { switchWorkspace, stopSocket } = await import("./socket.ts");

storeToken("a-token");

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Put workspace A's data into the stores, so there is something for a leak to leak. */
function fillWithAlpha(): void {
  useBuildStore.setState({ agents: [{ agent_id: "alpha-only-agent", name: "alpha_only_agent" }] as never });
  useThreadStore.setState({ threads: [{ id: "alpha-thread", title: "Alpha's private thread" }] as never });
  useMemberStore.setState({ members: [{ user_id: "u9", email: "alpha-person@example.com", display_name: null, role: "member", workspace_id: "ws-a", created_at: "" }], loaded: true });
}

/** Every workspace store, serialised. What a leak would show up in. */
function everything(): string {
  return Object.entries(WORKSPACE_STORES)
    .map(([name, s]) => `${name}:${JSON.stringify((s as unknown as { getState?: () => unknown }).getState?.() ?? {})}`)
    .join("|");
}

// --- the transition ---------------------------------------------------------------------------

console.log("\n§5.1 — in order");
{
  seed(useSessionStore, {
    status: "ready",
    user: { id: "u1", email: "a@b.c", displayName: "A", onboarded: true, onboardingStep: 5, isAdmin: false, adminMode: false },
    workspaceId: "ws-a",
    workspaces: WORKSPACES,
    switching: null,
    switchError: null,
  });
  fillWithAlpha();
  const before = everything();
  check(before.includes("alpha-only-agent"), "workspace A's data is in the stores to begin with");

  // The socket this tab already has. Registered by hand rather than by connecting, because what is
  // being asserted is what the SWITCH does to it.
  const oldSocket = new FakeSocket("ws://localhost/?ticket=ticket-for-ws-a");
  oldSocket.accept();
  // `startSocket` is what would have produced it; the switch's `stopSocket` closes whatever is
  // held, so the module needs to be holding this one.
  log.length = 0;
  FakeSocket.open.length = 0;

  script.refuse = null;
  switchWorkspace("ws-b");

  // STEP 1 — LOCKED, SYNCHRONOUSLY. Everything below this line is awaited; if the lock were set
  // after the first await, the frame in between would render a working application over stores
  // that have already been emptied.
  const locked = useSessionStore.getState().switching;
  check(locked?.to === "ws-b" && locked?.from === "ws-a", "the lock names where it is going and where it came from");
  check(locked?.name === "Beta", "...and what to call it while it waits");
  check(useSessionStore.getState().workspaceId === "ws-b", "the workspace id moves at once, so no header names the wrong tenant");

  // STEP 3 — EMPTIED, ALSO SYNCHRONOUSLY, AND BEFORE ANY TICKET IS ASKED FOR.
  const after = everything();
  check(!after.includes("alpha-only-agent"), "every store is emptied before anything is requested");
  check(!after.includes("Alpha's private thread"), "...including the threads");
  check(!after.includes("alpha-person@example.com"), "...and the member list, which is the most person-identifying of them");

  await settle();
  await settle();

  // STEPS 4 AND 5 — the ticket is for B, and the socket carries THAT ticket.
  check(log.includes("http.ticket ws-b"), `a ticket is requested for the target (${log.join(" ")})`);
  const opened = log.find((l) => l.startsWith("socket.new"));
  check(opened === "socket.new ticket-for-ws-b", `the new socket carries the new ticket (${opened})`);

  // §5.2's ORDERING, read off the transcript rather than off the source.
  const closedAt = log.indexOf("socket.close");
  const openedAt = log.findIndex((l) => l.startsWith("socket.new"));
  check(
    closedAt === -1 || closedAt < openedAt,
    `the old socket is closed before the new one is opened (${log.join(" ")})`,
  );
  check(FakeSocket.open.length === 1, `exactly one socket exists during the switch (${FakeSocket.open.length})`);

  // STEP 7 — unlocked when the handshake is accepted, and not before.
  check(useSessionStore.getState().switching !== null, "still locked while the handshake is outstanding");
  FakeSocket.open[0]!.accept();
  await settle();
  check(useSessionStore.getState().switching === null, "unlocked once the socket opens");
  check(useSessionStore.getState().switchError === null, "...with nothing to report");
  check(useSessionStore.getState().status === "ready", "...and the session is usable again");
  check(!everything().includes("alpha-only-agent"), "and no data from workspace A survived the switch");
}

console.log("\n§5.2 — a ticket the target refuses");
{
  stopSocket();
  log.length = 0;
  FakeSocket.open.length = 0;
  seed(useSessionStore, { workspaceId: "ws-a", workspaces: WORKSPACES, switching: null, switchError: null, status: "ready" });

  // A 403: this account is not a member of B any more. `AuthFailure` marks it NOT retryable, and
  // not-retryable used to mean `signOut` — so being refused entry to B ended the session in A.
  script.refuse = { workspaceId: "ws-b", status: 403, message: "you are not a member of that workspace" };
  switchWorkspace("ws-b");
  await settle();
  await settle();
  await settle();

  const state = useSessionStore.getState();
  check(state.status !== "signed_out", `a refused switch does not sign anybody out (${state.status})`);
  check(state.workspaceId === "ws-a", `...and puts them back where they were (${state.workspaceId})`);
  check(state.switching === null, "the lock is released");
  check(/not a member/.test(state.switchError ?? ""), `...and the switcher is told why (${state.switchError})`);
}

console.log("\n§5.2 — a handshake that closes before it opens");
{
  stopSocket();
  log.length = 0;
  FakeSocket.open.length = 0;
  seed(useSessionStore, { workspaceId: "ws-a", workspaces: WORKSPACES, switching: null, switchError: null, status: "ready" });

  script.refuse = null;
  switchWorkspace("ws-b");
  await settle();
  await settle();
  check(FakeSocket.open.length >= 1, "a socket was opened for the target");
  // THE RELAY REFUSING AN UPGRADE looks like a close with no open before it — a revoked ticket, a
  // membership that ended between the ticket and the handshake, an Origin the relay does not allow.
  FakeSocket.open[0]!.refuse();
  await settle();
  await settle();

  const state = useSessionStore.getState();
  check(state.workspaceId === "ws-a", `a refused handshake reverts too (${state.workspaceId})`);
  check(state.switching === null, "...releasing the lock");
  check((state.switchError ?? "").length > 0, `...and saying so (${state.switchError})`);
}

console.log("\nwhat a switch declines to start");
{
  stopSocket();
  seed(useSessionStore, { workspaceId: "ws-a", workspaces: WORKSPACES, switching: null, switchError: null, status: "ready" });

  switchWorkspace("ws-a");
  check(useSessionStore.getState().switching === null, "switching to the workspace you are in does nothing");

  switchWorkspace("ws-nonexistent");
  check(
    useSessionStore.getState().switching === null,
    "...and neither does one this session has no membership for",
  );
  check(useSessionStore.getState().workspaceId === "ws-a", "...leaving the tab where it was");

  // TWO OVERLAPPING SWITCHES. The second would tear down and rebuild while the first was still in
  // flight, and its `from` would be a workspace with no socket — so a failure would revert to a
  // blank.
  script.refuse = null;
  switchWorkspace("ws-b");
  const first = useSessionStore.getState().switching;
  switchWorkspace("ws-a");
  const still = useSessionStore.getState().switching;
  check(still?.to === first?.to, "a second switch while one is in flight is declined");
  stopSocket();
}

console.log("\nsigning out mid-switch");
{
  log.length = 0;
  FakeSocket.open.length = 0;
  seed(useSessionStore, { workspaceId: "ws-a", workspaces: WORKSPACES, switching: null, switchError: null, status: "ready" });
  script.refuse = null;
  switchWorkspace("ws-b");
  check(useSessionStore.getState().switching !== null, "a switch is in flight");
  useSessionStore.getState().signOut("token expired");
  // THE LOCK IS A FULL-SCREEN SCRIM. Left set, it would sit over the sign-in screen reading
  // "Switching to Beta…" and swallowing every click on the form underneath it.
  check(useSessionStore.getState().switching === null, "signing out clears the lock");
  stopSocket();
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
