// A shared job link, from the clipboard to the job.
//
// THE BUG. The Cockpit's "copy" control put `jaroku://open?workspace=…&resource=work%2F<id>` on the
// clipboard and opening it did nothing: the link parsed and nothing received it. "Paste a failed job
// to a teammate", the reason the address exists, led nowhere — and the copy said nothing either.
//
// So: the shape reads back, a link to a job in this workspace opens it, a link to another workspace
// the person belongs to switches there first, and a link to one they are not in says so.
//
//   npm run test:work-link

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const g = globalThis as unknown as Record<string, unknown>;
const store = new Map<string, string>();
g["localStorage"] = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
g["window"] = { location: { search: "", href: "http://localhost/", origin: "http://localhost" }, history: { replaceState() {} } };
g["fetch"] = async () => ({ ok: false, status: 503, statusText: "offline", text: async () => "{}", json: async () => ({}) });
class SilentSocket {
  readyState = 0;
  onopen = null; onmessage = null; onclose = null; onerror = null;
  send(): void {}
  close(): void {}
}
g["WebSocket"] = SilentSocket;

const { workLink, parseWorkLink, openWorkLink } = await import("./workLink.ts");
const { seed } = await import("./testRender.ts");
const { useSessionStore } = await import("../store/sessionStore.ts");
const { useUiStore } = await import("../store/uiStore.ts");
const { useWorkStore } = await import("../store/workStore.ts");

const WORKSPACES = [
  { id: "ws-a", slug: "a", name: "Alpha", kind: "team", role: "owner", plan: { id: "free", label: "Free" } },
  { id: "ws-b", slug: "b", name: "Beta", kind: "team", role: "member", plan: { id: "free", label: "Free" } },
];
seed(useSessionStore, {
  status: "ready",
  user: { id: "u1", email: "a@b.c", displayName: "A", onboarded: true, onboardingStep: 5, isAdmin: false, adminMode: false },
  workspaceId: "ws-a",
  workspaces: WORKSPACES,
  switching: null,
  switchError: null,
});

console.log("\nthe address reads back");
{
  const link = workLink("ws-a", "1a2b3c4d-0000-4000-8000-000000000000");
  check(JSON.stringify(parseWorkLink(link)) === JSON.stringify({ workspaceId: "ws-a", itemId: "1a2b3c4d-0000-4000-8000-000000000000" }),
    "a copied link names its workspace and its job");
  check(parseWorkLink("jaroku://open?workspace=ws-a&resource=thread%2Fx") === null, "...and a link to anything else is not a job");
}

console.log("\nopening one");
{
  openWorkLink({ workspaceId: "ws-a", itemId: "job-here" });
  check(useUiStore.getState().navView === "work", "a job in this workspace opens the Cockpit");
  check(useWorkStore.getState().openingId === "job-here", "...on that job");

  openWorkLink({ workspaceId: "ws-elsewhere", itemId: "job-there" });
  check(/not a member/.test(JSON.stringify(useUiStore.getState())), "a job in a workspace the person is not in says so");
  check(useSessionStore.getState().workspaceId === "ws-a", "...and goes nowhere");

  openWorkLink({ workspaceId: "ws-b", itemId: "job-in-b" });
  check(useSessionStore.getState().switching?.to === "ws-b", "a job in another of the person's workspaces switches there first");
  check(useUiStore.getState().cockpitItemIntent === "job-in-b", "...and opens the job once it has");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
