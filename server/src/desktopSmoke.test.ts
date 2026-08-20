// The desktop wrapper's smoke test: start the backend the way the shell starts it, and get a
// socket open through the whole exchange a packaged app performs.
//
// WHAT MAKES THIS DIFFERENT FROM EVERY OTHER SUITE HERE. The rest of the server's suites build
// the pieces they need in-process — `acceptance.test.ts` constructs a `Router` and a `WsRelay`
// and drives them directly, which is the right shape for asserting behaviour. This one spawns
// `server/src/index.ts` AS A SUBPROCESS, with the argument vector and the environment
// `src-tauri/src/sidecar.rs` uses, and then talks to it over a real port. That is the only way to
// find the class of failure this wrapper can actually have: not "the relay is wrong" but "the
// thing the shell starts is not the thing that works".
//
// It found one already. The environment the shell sets includes `JAROKU_ALLOWED_ORIGINS`, and it
// is there because booting the staged payload and looking at the boot line showed the development
// default to be the Vite and relay origins — while a packaged webview's origin is
// `tauri://localhost`. Nothing typechecks that. The symptom would have been a window that opens,
// looks right, and never connects.
//
// WHAT IT CANNOT COVER, said plainly. The Rust half is not exercised: there is no compiler on the
// machine this was written on, so the shell's own supervision, its restart backoff and its
// extraction are asserted structurally in `test:desktop-contract` and by reading, not by running.
// What IS run here is everything the shell talks to — which is the half where a mistake is
// silent.
//
//   npm run test:desktop-smoke

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

// ACROSS THE PACKAGE BOUNDARY, DELIBERATELY. This is the module the shell hands a `jaroku://` URL
// to, and asserting the hand-crafted link against a copy of its rules would assert that two
// things written from one idea agree. It imports nothing, so there is no client dependency tree
// to drag in — the same reason `fixtures/redis/mockRedis.ts` runs the real Lua rather than a
// paraphrase of it.
import { parseDeepLink } from "../../client/src/lib/deepLink.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The origins `lib.rs` actually sets, read from it rather than restated. See the header. */
function packagedOrigins(): string {
  const source = readFileSync(join(REPO, "src-tauri", "src", "lib.rs"), "utf8");
  const found = /"JAROKU_ALLOWED_ORIGINS"\.into\(\),\s*\n?\s*"([^"]+)"/.exec(source);
  if (!found?.[1]) throw new Error("lib.rs no longer sets JAROKU_ALLOWED_ORIGINS in a shape this suite can read");
  return found[1];
}

/** A port nothing holds, found the way ports.rs finds one: by binding and letting go. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const scratch = mkdtempSync(join(tmpdir(), "jaroku-desktop-"));
const port = await freePort();
const origins = packagedOrigins();
const ORIGIN = origins.split(",")[0]!;
let child: ChildProcess | null = null;

try {
  console.log("\nthe backend, started the way the sidecar starts it");
  {
    // THE ARGUMENT VECTOR IS sidecar.rs's, spelled once here and asserted against the Rust in
    // test:desktop-contract. Node, then tsx by path, then index.ts — no npm, no shell, no
    // node_modules/.bin shim, because a GUI process has no shell to run one and on Windows that
    // shim is a .cmd file.
    const args = [
      join(REPO, "server", "node_modules", "tsx", "dist", "cli.mjs"),
      join(REPO, "server", "src", "index.ts"),
    ];
    child = spawn(process.execPath, args, {
      cwd: REPO,
      env: {
        ...process.env,
        JAROKU_PORT: String(port),
        JAROKU_ALLOWED_ORIGINS: origins,
        JAROKU_DB: join(scratch, "jaroku.db"),
        JAROKU_OBJECT_KEY_PATH: join(scratch, "objectkey"),
        JAROKU_RUN_TOKEN_KEY_PATH: join(scratch, "runtokenkey"),
        JAROKU_DEV_AUTH_KEY: join(scratch, "devauth.json"),
        // No startup run. This suite is about the shell reaching the server, and a real agent
        // run would drag `uv` and a Python environment into a test that is not about either.
        JAROKU_NO_AUTORUN: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const log: string[] = [];
    child.stdout?.on("data", (d: Buffer) => log.push(d.toString()));
    child.stderr?.on("data", (d: Buffer) => log.push(d.toString()));
    child.on("error", (err) => log.push(`spawn error: ${err.message}`));

    // A generous deadline, because the first boot against an empty database applies fifty-one
    // migrations. A short one would make this suite flaky on a cold CI runner, and a flaky suite
    // is one somebody switches off.
    const deadline = Date.now() + 120_000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      if (child.exitCode !== null) break;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        ready = res.ok;
      } catch {
        await sleep(400);
      }
    }
    check(ready, "the backend comes up and answers /healthz", ready ? "" : log.join("").slice(-600));
    if (!ready) throw new Error("the backend never became ready; nothing below can be asserted");

    const boot = log.join("");
    check(boot.includes(`listening on http://localhost:${port}`), "...on the port the shell chose, not on its default");
    check(
      boot.includes("origin allowlist:") && !boot.includes("origin allowlist (development default)"),
      "...with the packaged origin allowlist rather than the development one",
    );
  }

  console.log("\nthe three-request exchange a packaged webview performs");
  const base = `http://127.0.0.1:${port}`;
  const post = async (path: string, body: unknown, token?: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  let token = "";
  let workspaceId = "";
  {
    const res = await post("/v1/auth/dev-login", { email: "smoke@jaroku.test" });
    check(res.ok, "the local issuer mints a token for a request from the packaged origin", String(res.status));
    check(
      res.headers.get("access-control-allow-origin") === ORIGIN,
      "...and CORS names that origin back, which is what lets the webview read the response",
      String(res.headers.get("access-control-allow-origin")),
    );
    token = ((await res.json()) as { token: string }).token;
    check(typeof token === "string" && token.length > 0, "...carrying a token");
  }
  {
    const res = await post("/v1/auth/session", {}, token);
    check(res.ok, "the session resolves to an account and its workspaces", String(res.status));
    const session = (await res.json()) as { workspaces: { id: string }[]; defaultWorkspaceId: string };
    workspaceId = session.defaultWorkspaceId;
    check(session.workspaces.some((w) => w.id === workspaceId), "...including the default one it names");
  }

  console.log("\nthe socket, which is the connection this wrapper deliberately did not replace");
  {
    const res = await post("/v1/ws-ticket", { workspaceId }, token);
    check(res.ok, "a single-use ticket is issued", String(res.status));
    const { ticket } = (await res.json()) as { ticket: string };

    const ws = new WebSocket(`ws://127.0.0.1:${port}/?ticket=${encodeURIComponent(ticket)}`, {
      headers: { origin: ORIGIN },
    });
    const first = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 20_000);
      ws.on("message", (data) => {
        clearTimeout(timer);
        resolve(data.toString());
      });
      ws.on("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
      ws.on("close", () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
    check(first !== null, "the socket opens and the server pushes its first snapshot unbidden");
    if (first) {
      const message = JSON.parse(first) as { channel?: string };
      check(typeof message.channel === "string", "...as a channelled message, which is the protocol as it was", first.slice(0, 120));
    }
    ws.close();
  }
  {
    // THE OTHER DIRECTION, so the assertion above cannot pass on a server that admits everybody.
    // Without this, an allowlist accidentally set to "*" would look identical from up here.
    const res = await post("/v1/ws-ticket", { workspaceId }, token);
    const { ticket } = (await res.json()) as { ticket: string };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?ticket=${encodeURIComponent(ticket)}`, {
      headers: { origin: "http://evil.example" },
    });
    const refused = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      ws.on("open", () => {
        clearTimeout(timer);
        resolve(false);
      });
      ws.on("error", () => {
        clearTimeout(timer);
        resolve(true);
      });
      ws.on("unexpected-response", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    check(refused, "a socket from an origin the shell did not list is refused");
    ws.close();
  }

  console.log("\nthe hand-crafted jaroku://test link, through the module the shell hands one to");
  {
    const link = parseDeepLink("jaroku://test");
    check(link !== null, "jaroku://test is understood");
    check(link?.action === "test", "...as the test action");
    check(parseDeepLink("myapp://test") === null, "...while another application's scheme is not");
  }

  console.log("\nshutting the backend down the way the shell does");
  {
    const exited = new Promise<number | null>((resolve) => child!.on("exit", (code) => resolve(code)));
    // SIGTERM is what sidecar.rs sends on Unix, and it is the signal index.ts installs a handler
    // for. Node maps it to a terminate on Windows, so this asserts "it goes away" on that
    // platform and "it drains and goes away" everywhere else — which is the asymmetry sidecar.rs
    // documents rather than papers over.
    child!.kill("SIGTERM");
    const code = await Promise.race([exited, sleep(15_000).then(() => "timeout" as const)]);
    check(code !== "timeout", "the backend exits when it is asked to", String(code));
  }
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
