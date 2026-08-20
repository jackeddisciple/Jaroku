// What the desktop shell's supervisor has to get right, and what happened when it did not.
//
// WHY THIS SUITE IS IN THE SERVER PACKAGE AND NOT IN RUST. The crate has unit tests for all of
// this and they are better tests — they call the real functions. They also do not run in CI, and
// cannot cheaply: `tauri-build` needs the staged Node sidecar to exist, which is ninety megabytes
// that `git ls-files` does not track. So the crate's suite is what somebody runs before a release
// and this is what runs on every push, in the same idiom as `test:desktop-contract`: read the Rust
// as text, and separately prove the platform behaviour the Rust is written against.
//
// THE BUG IT EXISTS FOR was the largest single cause of the desktop app freezing, and none of the
// three languages involved could see it.
//
//   `wsRelay.ts` calls `http.listen(port)` with no host, which is Node binding the WILDCARD.
//   `ports.rs` proved a port free by binding `127.0.0.1`. On Windows those are not the same
//   claim — a bind naming one specific address succeeds while a wildcard bind holds the same
//   port — so the probe reported 4317 free while a previous session's backend was listening on
//   it. The shell then handed the new backend a port it could not have, `listen` threw
//   EADDRINUSE with no error handler, the process exited, and the supervisor re-used the SAME
//   port on all three restarts. A window with no backend behind it and, until this pass, nothing
//   written down anywhere.
//
// The half below that binds real sockets is what makes this a proof rather than a spelling check:
// it demonstrates the platform behaviour on whatever platform CI is running, and it fails if a
// future runtime ever makes the loopback probe sufficient.
//
//   npm run test:desktop-supervisor

import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts: string[]): string => readFileSync(join(REPO, ...parts), "utf8");
const portsRs = read("src-tauri", "src", "ports.rs");
const sidecarRs = read("src-tauri", "src", "sidecar.rs");
const relayTs = read("server", "src", "wsRelay.ts");

/** Listen exactly the way the relay listens, and answer the port it got. */
function listenLikeTheRelay(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => res.end());
    server.on("error", reject);
    // `listen(port)` with no host — and 0 so the kernel picks a free one. This is the exact call
    // shape `wsRelay.ts` uses, which is the whole point: the probe has to match what THIS does.
    server.listen(0, () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

/** Can this address:port be bound? Answers the error code rather than throwing. */
function bind(host: string | undefined, port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.on("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? "EUNKNOWN"));
    const done = (): void => {
      probe.close(() => resolve(null));
    };
    if (host === undefined) probe.listen(port, done);
    else probe.listen(port, host, done);
  });
}

/** Does anything accept a connection here? The half a bind probe structurally cannot see. */
function answers(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: 250 });
    const settle = (value: boolean): void => {
      socket.destroy();
      resolve(value);
    };
    socket.on("connect", () => settle(true));
    socket.on("error", () => settle(false));
    socket.on("timeout", () => settle(false));
  });
}

console.log("\nthe relay still binds the way this suite assumes");
{
  // If this ever stops being true the rest of the suite is asserting the wrong thing, so it is
  // checked rather than assumed — the same reason `test:desktop-contract` reads `npm run dev`'s
  // script rather than trusting that it is still `tsx src/index.ts`.
  check(
    /this\.http\.listen\(opts\.port,/.test(relayTs),
    "wsRelay.ts calls listen with a port and no host, which is a wildcard bind",
  );
}

console.log("\nthe platform behaviour the probe is written against");
{
  const { server, port } = await listenLikeTheRelay();

  const wildcard = await bind(undefined, port);
  check(wildcard === "EADDRINUSE", "a second wildcard bind on the same port is refused", `${wildcard}`);

  const loopback = await bind("127.0.0.1", port);
  if (process.platform === "win32") {
    // THE TRAP, DEMONSTRATED. This is not a bug in Node or in Rust — Windows only refuses two
    // binds that name the same address unless somebody asked for exclusivity — and it is exactly
    // why a probe that bound loopback reported a held port free.
    check(
      loopback === null,
      "on Windows a loopback bind SUCCEEDS while a wildcard listener holds the port, which is the trap",
      `${loopback}`,
    );
  } else {
    check(
      loopback === "EADDRINUSE" || loopback === null,
      "on this platform the loopback bind answers definitively either way",
      `${loopback}`,
    );
  }

  // And the half that is true everywhere: something is listening, so something answers.
  check(await answers("127.0.0.1", port), "the listener accepts a connection on loopback");

  await new Promise<void>((resolve) => server.close(() => resolve()));
  check((await bind(undefined, port)) === null, "...and the port is bindable again once it closes");
}

console.log("\nso the probe asks the question the backend asks");
{
  check(
    /Ipv6Addr::UNSPECIFIED/.test(portsRs) && /Ipv4Addr::UNSPECIFIED/.test(portsRs),
    "ports.rs binds both wildcards rather than a specific address",
  );
  check(
    !/TcpListener::bind\(SocketAddrV4::new\(Ipv4Addr::LOCALHOST/.test(portsRs),
    "...and no longer proves a port free by binding loopback, which was the bug",
  );
  check(
    /ErrorKind::AddrInUse => return false/.test(portsRs),
    "only AddrInUse counts as taken, so a machine with no IPv6 does not walk the scan on every launch",
  );
  check(
    /fn answered_by_something/.test(portsRs) && /connect_timeout/.test(portsRs),
    "...and it also asks whether anything answers, which a bind probe cannot see",
  );
}

console.log("\nand the supervisor asks it again on every attempt");
{
  // THE OTHER HALF OF THE SAME FREEZE. `ports.rs` says losing the probe-to-bind race costs one
  // restart because "a restart re-runs this". It did not: the port was baked into the launch
  // environment once, so one lost race was three identical failures and then a dead app.
  check(
    /fn resolve_port\(app: &AppHandle\) -> bool/.test(sidecarRs),
    "sidecar.rs resolves the port per attempt",
  );
  // Structural rather than a distance between two strings: the claim is that the call is inside
  // the loop, and the first draft of this line expressed that as "within 600 characters of it",
  // which a comment one sentence longer would have broken. The suite would then have gone green
  // on a supervisor that had moved the call back out.
  const supervise = sidecarRs.slice(sidecarRs.indexOf("async fn supervise"), sidecarRs.indexOf("fn resolve_port"));
  const loopAt = supervise.indexOf("\n    loop {");
  const resolveAt = supervise.indexOf("if !resolve_port(&app)");
  check(
    loopAt !== -1 && resolveAt > loopAt,
    "...inside the supervision loop, so a restart re-runs it rather than re-using the old answer",
    `loop at ${loopAt}, call at ${resolveAt}`,
  );
  check(
    /env\.insert\("JAROKU_PORT"\.into\(\), app\.state::<Backend>\(\)\.port\(\)\.to_string\(\)\)/.test(sidecarRs),
    "...and the spawn takes the port from that one authority rather than from a cached environment",
  );
  const libRs = read("src-tauri", "src", "lib.rs");
  check(
    !/env\.insert\("JAROKU_PORT"/.test(libRs),
    "...which is why the launch environment no longer carries a port of its own",
  );
}

console.log("\nand the backend it is replacing is actually gone");
{
  // The process the shell holds is tsx's launcher, not the server. Killing it left a backend
  // running with the port bound — which is what there was for the probe above to trip over.
  check(/tree::adopt\(child\.pid\(\)\)/.test(sidecarRs), "every spawned backend is bound to this application");
  check(
    /tree::terminate\(\);[\s\S]{0,400}?let wait = BACKOFF/.test(sidecarRs),
    "...and anything left of the previous generation is ended before the next one starts",
  );
  check(/tree::terminate\(\);/.test(sidecarRs.slice(sidecarRs.indexOf("pub fn stop"))), "...and on the way out");

  const treeRs = read("src-tauri", "src", "tree.rs");
  check(
    /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/.test(treeRs),
    "the Windows path is a job object with kill-on-close, so a crash cannot leave one behind either",
  );
  // The Unix path depends on tsx relaying signals to the process it launched. That is a fact
  // about a dependency, so it is checked in the dependency rather than believed — a tsx that
  // stopped relaying would silently reintroduce the orphan on macOS and Linux.
  const tsxCli = read("server", "node_modules", "tsx", "dist", "cli.mjs");
  check(
    /process\.on\("SIGINT",\s*\w+\),\s*process\.on\("SIGTERM",\s*\w+\)/.test(tsxCli),
    "tsx relays SIGINT and SIGTERM to its child, which is what the Unix path relies on",
  );
  check(/SIGKILL/.test(tsxCli), "...and escalates, so a server that ignores the signal still goes");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
