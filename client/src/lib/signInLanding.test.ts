// Signing in somewhere other than the workspace the tab was filled for empties the tab.
//
// THE BUG. After a sign-in the open conversation was asked for four times under the personal
// workspace and answered 404 each time: the tab still held a conversation from the workspace it had
// been in, and the session had landed in another. Landing elsewhere is a switch, and is now treated
// as one — the workspace's stores are emptied before anything asks for what they held.
//
//   npm run test:sign-in-landing

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
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(): void {}
  close(): void {}
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
const ticketsFor: string[] = [];
g["fetch"] = async (url: string, init?: { body?: string }): Promise<unknown> => {
  const path = new URL(url, "http://localhost").pathname;
  if (path === "/v1/auth/session") {
    return {
      ok: true,
      json: async () => ({
        user: { id: "u1", email: "a@b.c", displayName: "A", onboarded: true, onboardingStep: 5, isAdmin: false, adminMode: false },
        workspaces: [{ id: "ws-personal", slug: "p", name: "Personal", kind: "personal", role: "owner", plan: { id: "free", label: "Free" } }],
        defaultWorkspaceId: "ws-personal",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
    };
  }
  if (path === "/v1/ws-ticket") {
    const asked = JSON.parse(init?.body ?? "{}").workspaceId ?? "";
    ticketsFor.push(asked);
    return { ok: true, json: async () => ({ ticket: "t", workspaceId: asked, role: "owner" }) };
  }
  return { ok: false, status: 404, statusText: "missing", json: async () => ({}), text: async () => "{}" };
};

const { storeToken, storeWorkspace } = await import("./auth.ts");
const { useThreadStore } = await import("../store/threadStore.ts");
const { startSocket, stopSocket } = await import("./socket.ts");
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

console.log("\na sign-in that lands in another workspace");
{
  storeToken("a-token");
  // The tab was last in a workspace this account has since left, with a conversation of it open.
  storeWorkspace("ws-left");
  useThreadStore.setState({ activeThreadId: "conv-of-ws-left" } as never);
  startSocket();
  for (let i = 0; i < 40 && FakeSocket.all.length === 0; i++) await settle();
  check(ticketsFor.at(-1) === "ws-personal", "it lands in a workspace the account is in");
  check(useThreadStore.getState().activeThreadId == null,
    "...and the other workspace's open conversation is gone, so nothing asks for it here");
  stopSocket();
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
