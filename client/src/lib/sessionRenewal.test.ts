// A session in use is renewed before it runs out, and an expiry reopens where somebody was.
//
// THE BUG. Every session ended on the hour, mid-task, because nothing renewed the token; and signing
// back in opened the personal workspace rather than the one in use, because the sign-out that the
// expiry caused forgot it.
//
//   npm run test:session-renewal

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
let refreshAnswer: { status: number; body: unknown } = { status: 200, body: {} };
const asked: { path: string; auth: string | null }[] = [];
g["fetch"] = async (url: string, init?: { headers?: Record<string, string> }) => {
  const path = new URL(url, "http://localhost").pathname;
  asked.push({ path, auth: init?.headers?.["authorization"] ?? null });
  const answer = path === "/v1/auth/refresh" ? refreshAnswer : { status: 503, body: {} };
  return {
    ok: answer.status >= 200 && answer.status < 300,
    status: answer.status,
    statusText: "",
    json: async () => answer.body,
    text: async () => JSON.stringify(answer.body),
  };
};
class SilentSocket {
  readyState = 0;
  onopen = null; onmessage = null; onclose = null; onerror = null;
  send(): void {}
  close(): void {}
}
g["WebSocket"] = SilentSocket;

const { RENEW_LEAD_S, renewNow, renewalDue } = await import("./sessionRenewal.ts");
const { storeToken, storedToken, storeWorkspace, storedWorkspace } = await import("./auth.ts");
const { useSessionStore } = await import("../store/sessionStore.ts");

const nowS = (): number => Math.floor(Date.now() / 1000);

console.log("\nwhen a session is due");
{
  check(!renewalDue(nowS() + RENEW_LEAD_S + 60, nowS()), "not while it has well over half an hour left");
  check(renewalDue(nowS() + RENEW_LEAD_S - 60, nowS()), "inside the last half hour, yes");
  check(!renewalDue(nowS() - 1, nowS()), "an expired one cannot be renewed — it proves nothing");
  check(!renewalDue(null, nowS()), "nor one with no expiry");
}

console.log("\nrenewing");
{
  storeToken("old-token");
  useSessionStore.setState({ status: "ready", expiresAt: nowS() + 600, expiring: true });
  refreshAnswer = { status: 200, body: { token: "new-token", expiresAt: nowS() + 12 * 3600 } };
  const ok = await renewNow();
  check(ok, "a session in use is renewed");
  check(asked.at(-1)?.path === "/v1/auth/refresh" && asked.at(-1)?.auth === "Bearer old-token",
    "...by presenting the token it has");
  check(storedToken() === "new-token", "...and the new token is kept where the old one was");
  check(useSessionStore.getState().expiresAt! > nowS() + 11 * 3600 && !useSessionStore.getState().expiring,
    "...with the new expiry, and no longer warned about");

  refreshAnswer = { status: 401, body: { error: "it has been a while since you signed in — sign in again" } };
  check(!(await renewNow()), "a refusal renews nothing");
  check(storedToken() === "new-token", "...and leaves the session to end with its own sentence");
}

console.log("\nan expiry reopens where somebody was");
{
  storeWorkspace("ws-cockpit-test");
  useSessionStore.getState().signOut("your session expired");
  check(storedWorkspace() === "ws-cockpit-test", "a sign-out nobody chose keeps the workspace in use");
  useSessionStore.getState().signOut();
  check(storedWorkspace() === null, "a sign-out somebody chose forgets it");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
