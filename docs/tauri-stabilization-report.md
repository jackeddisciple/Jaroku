# The desktop wrapper, stabilised

A pass over the Tauri shell with no new features in it. The brief was that the packaged app
freezes in many places, inconsistently, and that the wrap might be incomplete in ways nobody had
enumerated. This is what was actually wrong, what caused each freeze, what changed, and what is
still owed.

**The headline.** There was one freeze with five contributing causes, and they compose into
exactly the "sometimes it works" shape the report described. The chain is:

1. **Quitting Jaroku on Windows did not stop the backend.** The process the shell holds is tsx's
   launcher; the server is the child it spawns, and killing a process does not kill its children.
2. **So the next launch often found port 4317 held** by the previous session's server, which was
   still listening and still holding the database.
3. **The port probe could not see it.** It bound `127.0.0.1`; Node binds the wildcard, and Windows
   lets both succeed. The port was reported free when it was not.
4. **The backend was then handed a port it could not bind**, threw `EADDRINUSE` from a `listen`
   with no error handler, and exited — three times, because the supervisor re-used the same port
   on every restart.
5. **None of that was visible.** Every diagnostic went to a standard stream a packaged Windows app
   does not have, and the window rendered `disconnected — retrying` because "the socket did not
   open" is the only thing the page could observe.

The orphan from (1) dies on its own eventually — its stdout pipe is gone, so the next line it
writes takes it down — which is why a slow relaunch worked and a fast one did not. That is the
whole of the intermittency.

Beside that chain, three independent defects were found: four HTTP surfaces in the client that
never consulted the host's port at all; a `PATH` bug that has meant the bundled Python toolchain
has never been reachable from an agent run on Windows; and a packaging hole where `tauri build`
run on its own ships whatever was staged last — which is how the bundle built during this pass
came to carry a `runtime/test_agent` from before that morning's fix, with a symptom that looked
exactly like a bug somebody had already closed.

---

## Phase 1 — is the wrap actually complete?

| # | Check | Verdict | Evidence |
|---|---|---|---|
| 1 | Node backend starts as a sidecar; its output is captured | **FAIL** | Sidecar spawns correctly (three-process tree observed). Its stdout/stderr were forwarded with `print!`/`eprint!` into a stream that does not exist in a packaged build |
| 2 | Frontend loads from the bundle, not a dev URL | **PASS** | `frontendDist: ../client/dist`, assets embedded in the binary; `devUrl` is only read by `tauri dev`. The installed tree has no `dist` because there is nothing to serve |
| 3 | WebSocket connects on the right port with real retry logic | **PARTIAL FAIL** | Socket reconnection is sound (exponential backoff, jitter, generation guard). The port it connects to could be wrong, and four HTTP surfaces ignored the host entirely |
| 4 | Python runtime reachable from the bundled app | **FAIL** | uv, CPython and the wheel cache extract correctly and the venv builds — but the bundled `uv` is not on `PATH` by the time the server spawns it |
| 5 | File-system paths correct for a packaged app | **PASS** | Every path verified on disk in the installed app |
| 6 | Permissions / entitlements | **NOT APPLICABLE HERE / UNVERIFIED** | Windows imposes no sandbox on a per-user NSIS install. macOS entitlements exist and remain unexercised |
| 7 | Tauri v2 capabilities | **PASS** | `core:default` + `deep-link:default` is the complete set the webview needs |
| 8 | Single-instance behaviour and zombie processes | **FAIL** | Single-instance works. Zombie sidecars were the root of the whole problem |

### 1. The sidecar — spawned correctly, and completely silent

The spawn works. `Get-CimInstance Win32_Process` on a running packaged app:

```
jaroku.exe        pid 14892
 └─ jaroku-node.exe  …\tsx\dist\cli.mjs  …\server\src\index.ts    pid 12016
      └─ jaroku-node.exe  --import …\loader.mjs  …\src\index.ts    pid 15732   ← listening on 4317
```

The capture was the failure. `sidecar.rs` forwarded every line with `print!`/`eprint!`, and
`main.rs` sets `windows_subsystem = "windows"` for release — so a packaged Windows app has no
console, `GetStdHandle` returns null, and Rust's standard library reports a write to that handle as
a *successful* write of every byte. The lines were not lost loudly; they were discarded silently. A
macOS `.app` launched from Finder has the same streams on `/dev/null`.

Confirmed by absence: no log file existed anywhere under `%APPDATA%\jaroku` or
`%LOCALAPPDATA%\Jaroku` before this pass, and a deliberately-broken launch produced nothing at all
on disk. A backend that could not bind its port failed three times into nothing.

**Fixed** — see [Fix 1](#fix-1--a-log-file).

### 2. The frontend is bundled

`tauri.conf.json` has `build.frontendDist = "../client/dist"`, which Tauri embeds into the
executable at compile time. `devUrl` (`http://localhost:5173`) is read only by `tauri dev`. The
installed tree confirms it — `%LOCALAPPDATA%\Jaroku\resources` holds `app/` and `python/` and no
frontend at all, because there is nothing to serve from disk.

The CSP already admits moved ports (`ws://localhost:*`, `http://localhost:*`), so a port change
does not need a configuration change. No dev-server dependency exists in a packaged build.

### 3. The socket — good retry logic, pointed at a number that could be wrong

The reconnection logic in `client/src/lib/socket.ts` is genuinely careful and needed nothing: a
full `token → session → ticket → socket` exchange on every attempt, exponential backoff capped at
15s with jitter, `attempt` reset only by a socket that actually *opens*, a generation counter that
prevents an orphaned timer from opening a second socket beside a live one, and a hard distinction
between "retry" and "you are not allowed".

Two things were wrong around it.

**The port could be wrong**, per the chain at the top.

**`client/src/lib/http.ts` computed its own origin and never asked `hostConfig`.** It read
`VITE_JAROKU_WS` and fell back to `ws://localhost:4317`. `auth.ts` — which owns the socket URL and
the sign-in exchange — reads the host's value correctly. So on any launch where the shell moved the
port, the socket and the whole auth exchange went to the real backend while everything routed
through `apiRequest` went to port 4317: nothing at all, or, worse, whatever else was holding it. A
window that signed in, connected, streamed a run, and then failed at four specific surfaces for no
visible reason.

Those four, exactly: the **Secrets** group and its elevation (`lib/secrets.ts` → `SecretsGate`,
`SecretsList`, `SecretsPanel`), the **workspace export**, the **workspace deletion** and the
**billing checkout** (`lib/workspaceApi.ts` → `WorkspacePanel`, `UsagePanel`). Everything else in
the product is a socket command and was never affected, which is why the symptom was so localised
and so hard to attribute.

**Fixed** — see [Fix 5](#fix-5--one-origin-resolved-per-call).

### 4. Python — extracted correctly, and not on `PATH` where it matters

Extraction and the venv build both work, verified on disk:

```
%APPDATA%\jaroku\python\bin\uv.exe
%APPDATA%\jaroku\python\interpreters\cpython-3.12.13-windows-x86_64-none\
%APPDATA%\jaroku\venv\{Lib,Scripts,pyvenv.cfg}
```

But `server/src/processManager.ts` and `server/src/sandbox/codeCheck.ts` both spawn uv with

```ts
PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}`
```

That prepends an entry on macOS. On Windows the separator is `;`, so it does not prepend an entry —
it glues `/opt/homebrew/bin:` onto the front of whatever the first entry is, and the first entry is
precisely the one `python.rs` had just added. Measured rather than reasoned about:

```
what the shell set               -> uv: uv 0.12.3 (…x86_64-pc-windows-msvc)
what processManager spawns with  -> uv: ENOENT
```

This machine has uv installed globally, further down the user's own `PATH`, so agent runs silently
used the machine's toolchain — which is the exact external dependency the bundle exists to remove.
On a machine without uv, an agent run fails outright.

**This is server code, not wrapper code**, so it is reported rather than changed — see
[What needs your decision](#what-needs-your-decision). The wrapper absorbs it in the meantime;
see [Fix 6](#fix-6--the-bundled-uv-survives-the-servers-path-prepend).

### 5. Paths are correct

Every packaged path was verified on the installed app rather than read from source:

| What | Where | Verified |
|---|---|---|
| payload | `%APPDATA%\jaroku\app\{server,runtime}` | present, stamp matches the bundle's byte for byte |
| Python | `%APPDATA%\jaroku\python\{bin,interpreters,cache}` | present |
| venv | `%APPDATA%\jaroku\venv` | built from the bundled cache |
| database | `%APPDATA%\jaroku\jaroku.db` | present, plus `-wal` and `-shm` |
| signing keys | `%APPDATA%\jaroku\keys` | present |
| marker | `%APPDATA%\jaroku\app-initialized` | `{"at":"2026-08-20T18:51:29Z","version":"0.3.3"}` |

`payload.rs`'s two-candidate search resolves to `resource_dir()/resources/app`, which is where the
NSIS bundle actually puts it. One small thing was found and is not a freeze: `mirror()` skips
symlinks by design, and the staged Python tree contains one — uv's `cpython-3.12-…` alias pointing
at the versioned directory. It is not extracted, and nothing needs it: uv resolves the versioned
directory directly and the venv built without it.

### 6. Permissions and entitlements

Not applicable on the platform this was reproduced on, and stated rather than glossed. A per-user
NSIS install to `%LOCALAPPDATA%` is not sandboxed; Windows imposes no file, network or
process-spawn restrictions on it. Checked rather than assumed: the Windows Application event log
across the whole window in which the failures were deliberately reproduced contains **nothing**
mentioning Jaroku. Every failure reproduced here was explained by the application's own code, and
none of them needed an OS-level denial to happen.

One adjacent thing was checked because it produces the same complaint — "the app opens and there
is nothing there". `tauri-plugin-window-state` restores a saved position, and a window restored
onto a monitor that has since been unplugged is invisible with no way back. Version 2.4.1 guards
it: `lib.rs` walks `available_monitors()` and only restores a position that `intersects` one.
Not a defect here.

`src-tauri/entitlements.plist` carries the four the hardened runtime needs for a bundled Node and a
CPython loading unsigned wheels, and its reasoning is sound. **It has never been exercised**: no
macOS build has been made. See [Still owed](#still-owed).

### 7. Capabilities are complete

`src-tauri/capabilities/default.json` grants `core:default` and `deep-link:default` to the `main`
window, and that is the complete set. `core:default` includes `core:event:default`, which is what
`listen` needs and what both the deep-link listener and the new backend-status listener use.
Commands the application defines itself (`generate_handler!`) are not gated by the ACL — the
generated `gen/schemas/acl-manifests.json` contains manifests for `core`, `deep-link`, `shell` and
`window-state` and none for this crate's own commands, which is why `secret_get`/`secret_set` have
always worked from the page.

The webview is granted **no shell permission at all**, deliberately, so nothing the page can say
reaches a process spawn. That constraint was kept: the failure panel added in this pass shows the
log's path and offers to copy it rather than opening it, because opening it would need a permission
this application should not grant its own webview.

### 8. Zombie sidecars — the root of everything

The most important finding. Demonstrated:

```
kill jaroku.exe (Task Manager / a crash)
  → both jaroku-node processes still alive
  → port 4317 still bound
  → GET /healthz → 200 {"ok":true}
```

`CommandChild::kill()` is `TerminateProcess` on the direct child, which is tsx's launcher rather
than the server. On Windows that is also what `stop()` does on the *graceful* path — there is no
SIGTERM for a console-less child — so **every quit left the backend running**, not only every
crash. On macOS and Linux this does not happen: `stop()` sends SIGTERM and tsx's CLI relays
`SIGINT`/`SIGTERM` to its child and escalates to `SIGKILL` after five seconds (checked in
`tsx/dist/cli.mjs` rather than assumed).

**Fixed** — see [Fix 3](#fix-3--kill-the-process-tree-not-the-process).

---

## Phase 2 — the reproduction

There was no clean reproduction to start from, so one was built. It is two commands.

**Reproducing the freeze deterministically:**

```powershell
# Hold 4317 the way a stale Jaroku backend holds it — Node's default bind is the wildcard.
node -e "require('http').createServer((q,s)=>s.end()).listen(4317)"
Start-Process "$env:LOCALAPPDATA\Jaroku\jaroku.exe"
```

Before this pass, that produced: `jaroku.exe` running, **no `jaroku-node.exe` at all**, nothing
listening on 4318, the window open and looking normal, and the page repeatedly POSTing
`/v1/auth/session` at the foreign listener on 4317. Three restarts had already failed and the
supervisor had given up, silently, within 15 seconds. Nothing was written anywhere.

**Reproducing the zombie:**

```powershell
Stop-Process -Name jaroku -Force      # or quit from the tray; on Windows both did this
Get-Process jaroku-node                # both still running
Get-NetTCPConnection -LocalPort 4317   # still bound
```

### The instrumentation

Structured, timestamped logging was added at every boundary that can hang, and it is what turned
the rest of this into an afternoon rather than a week. It goes to `~/.jaroku/logs/desktop.log`
(`%APPDATA%\jaroku\logs\desktop.log` on Windows), always, in every build.

Two levels. **The record** is unconditional — every decision, every failure, and the whole of the
backend's own stdout and stderr with the two streams kept distinguishable. **The detail** is the
verbose half added for this pass: the port probe's answer, each supervision transition, the exact
argument vector and pid, the names (never the values) of the environment the backend is given, and
a millisecond clock on every startup step. It is **off in a release build** unless
`JAROKU_DESKTOP_DEBUG=1` is set, and on in a debug build. `test:desktop-contract` asserts both
halves of that gate, and asserts that the flag never reaches a child process — so it is a variable
the shell reads, never one it invents for the server.

A real launch, from the file:

```
…T20:20:58.690Z [jaroku]  jaroku 0.3.3 starting - packaged build, verbose off, log at …
…T20:21:44.104Z [backend] [server] database: sqlite (…\jaroku.db)
…T20:21:45.313Z [backend] [auth] origin allowlist: tauri://localhost, https://tauri.localhost, …
…T20:21:45.347Z [backend] [relay] http+ws listening on http://localhost:4317
```

### Where the freezes were, and how often

| Flow | Before | After |
|---|---|---|
| Launch → main screen | Dead **whenever anything held 4317**; that was routine, because quitting left a backend behind | No longer reachable: the probe sees the conflict and the port moves |
| Launch → main screen, fast relaunch | Intermittent — the orphan dies on its next write to a closed pipe, so a slow relaunch worked and a fast one did not | Deterministic: nothing is left behind to race |
| Sign-in | Dead-ended permanently when the check ran against a foreign listener or timed out — the screen rendered a branch with no form on it | The host's verdict outranks the check, and both branches offer a retry |
| Secrets, export, checkout, workspace deletion | Wrong origin on any launch where the port moved | One origin, resolved per call |
| Agent run (Python) | Ran on the machine's uv, or failed with ENOENT where there was none | Bundled uv resolves |
| Quit | Left a backend running every time on Windows | Whole tree ends |

The pattern that made it hard to characterise is the one Phase 2 predicted: it is a startup
ordering race, it is worse on a cold start, and quitting-and-relaunching *sometimes* fixed it —
because quitting is what created the condition, and whether the relaunch was fast enough decided
whether it hit.

---

## Phase 3 — what changed, and why

### Fix 1 — a log file

`src-tauri/src/logs.rs`, `src-tauri/src/clock.rs`.

Every line goes two places: the file, always, and standard error, which is where a developer
running `npm run tauri:dev` already looks. The file rolls at 8 MiB with exactly one backup, so the
ceiling on what it costs a user's disk is 16 MiB and not a function of uptime. It lives beside the
database rather than inside `app/`, because `app/` is rewritten by every upgrade and a log an
upgrade deletes is empty in precisely the "it broke after I updated" case it exists for. Nothing in
the module can fail loudly — every error is dropped, because a logger that panics turns a
diagnostic into an outage on the startup path of an application whose whole problem was startup.

`clock.rs` exists because `marker.rs` already had a hand-written UTC formatter and the log needed
the same calendar with milliseconds. One implementation, two callers; the tests moved with the
code.

### Fix 2 — the port probe asks the question the backend asks

`src-tauri/src/ports.rs`.

`is_free` now binds **both wildcards** (`[::]` and `0.0.0.0`) rather than `127.0.0.1`, and treats
only `AddrInUse` as a conflict — any other error means the machine does not offer that address
family, which is a statement about the machine rather than about the port. It then asks whether
anything **answers** on either loopback, which is the half a bind probe structurally cannot see: a
listener bound to loopback alone does not stop a wildcard bind on Windows, and something already
answering on the port is the case that matters however it got there.

The regression test binds a port the way the backend binds one and asserts the probe sees it. It
fails against the old implementation.

### Fix 3 — kill the process tree, not the process

`src-tauri/src/tree.rs`, wired into `sidecar.rs`.

On Windows the sidecar is assigned to a **job object** with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
immediately after spawn. A job is the operating system's own name for "this process and its
descendants": everything the child goes on to spawn joins it, `TerminateJobObject` ends the whole
set, and kill-on-close means the set dies with the handle — so an orphan cannot outlive the shell
even when the shell is killed from Task Manager and never runs a line of shutdown code. That last
property is why this is a job and not a walk of the process table: a tree-kill only helps on the
paths where our own code still runs, and the paths where it does not are the ones that were leaving
the orphans.

The supervisor also terminates the job *before* each restart, so a launcher that died without
taking its server with it cannot leave a backend holding the port the replacement is about to ask
for.

Off Windows this is deliberately nothing: `stop()` sends SIGTERM, tsx relays it, and the server's
own handler drains the ingest chain.

### Fix 4 — the port is resolved per attempt

`src-tauri/src/sidecar.rs`.

`ports.rs` claimed that losing the probe-to-bind race "costs one restart rather than a dead app"
because "a restart re-runs this". It did not: `JAROKU_PORT` was baked into the launch environment
once and every restart re-used it, so one lost race was three identical failures. The port now
lives on `Backend` as the single authority, is re-resolved before every attempt *preferring the one
already in force* — so an ordinary restart moves nothing and the page's socket URL stays the one it
was told — and a move is announced to the page rather than silently stranding it.

`JAROKU_PORT` moved out of `lib.rs`'s environment map as a result, and `test:desktop-contract` was
extended to read both files so its "every variable the shell sets is one the server reads" rule did
not quietly stop covering the port.

### Fix 5 — one origin, resolved per call

`client/src/lib/auth.ts`, `client/src/lib/http.ts`, `client/src/lib/hostConfig.ts`.

`http.ts` no longer computes its own origin; both halves of the client resolve through `apiBase()`
in `auth.ts`, which reads the host first. And both are now **functions rather than module-level
constants**, which is a correctness change rather than a style one: a supervised backend can move
while the page is open, and a value captured at load time is a value that goes stale.

`hostConfig.ts` gained the ability to take a correction — the injected `window.__JAROKU_CONFIG__`
is a seed rather than a constant now — through the same validation the injection goes through. The
frozen object itself is untouched.

`test:host-config` gained the cross-module regression test: a host that moves the port has to move
the socket **and** every HTTP surface, and it asserts both.

### Fix 6 — the bundled uv survives the server's PATH prepend

`src-tauri/src/python.rs`.

On Windows the shell now puts a sacrificial entry in front of its own bin directory, so the
`/opt/homebrew/bin:` the server glues on absorbs the sacrificial one and the real entry survives
intact as a standalone element. The sacrificial entry is the install directory itself — a real
directory containing no executables, so it is inert whichever way it is read.

This is a workaround for a server bug and says so at the code. `test:desktop-contract` simulates
the composition of the two files and asserts both directions: that the obvious PATH does *not*
survive, and that the one the shell builds does.

### Fix 7 — a window that cannot reach its backend says so

`src-tauri/src/status.rs`, `client/src/lib/hostBackend.ts`, `client/src/store/hostStore.ts`,
`client/src/components/BackendFailure.tsx`, and the two surfaces that render it.

This is the one piece of new UI in the pass, and it is the piece Phase 3 asked for by name. Five
different failures reached the page as one fact — the socket did not open — so it rendered
`disconnected — retrying`, correctly describing what *it* was doing and never mentioning that
nothing was going to answer.

The shell now emits four phases: `preparing`, `started`, `restarting`, `failed`. Only `failed`
changes what the page renders, because the other three are all "wait", which is what the app does
anyway. `started` is deliberately not called `ready`: this shell does not know when the relay is
listening, the page already answers that question, and a phase that lies for a second on every
launch is worse than one that claims less.

There is a command beside the event, because the shell settles its status during startup — before
React has mounted — so on exactly the launches this exists for an event alone reaches nobody. The
subscription attaches the listener first and discards the snapshot if a live event beat it, which
closes the opposite hole.

Every status carries the current socket URL, so a moved port corrects itself by the fact of the
status arriving.

On screen: the status strip says `backend stopped` in red instead of `disconnected`, and the
sign-in screen renders the shell's own sentence, the log's path, a copy button and **Start it
again**, instead of the external-identity-provider branch that has no form on it. In a browser
none of this ever renders, because nothing there sets a host status.

The retry is a real restart rather than a re-check. The supervisor stops after three consecutive
failures on purpose — a backend that cannot bind or cannot open its database fails identically
every time, and a loop around it is a busy wait that hides the error — but the condition is often
transient in a way the shell cannot see, so the person watching gets to decide. `restart_backend`
refuses while a start is already in flight, because two supervisors would be two backends racing
for one port and writing one SQLite database, which is what the single-instance plugin exists
upstream to prevent.

### Fix 9 — a bundle cannot be built from a payload nobody re-staged

`src-tauri/tauri.conf.json`.

Found by reading the log of the app this pass built. Every event of its boot run was dropped, with
the runner minting its own id instead of honouring `JAROKU_RUN_ID` — a bug fixed that morning in
the working tree. The bundle carried a `runtime/test_agent` from before the fix, because
`tauri build` knows nothing about the staging scripts: only the `tauri:build` npm script chains
them, so a build run any other way silently packages whatever `src-tauri/resources/app` last
contained.

`beforeBuildCommand` stages the payload now, so the build cannot ship a stale one. The Python
runtime stays an explicit step — it moves only when `runtime/uv.lock` or the uv binary does, and
staging it copies an interpreter and resolves a lock file. `release.yml` still runs both by name,
which is what makes a failure say which half broke.

Worth stating plainly: this one was **not** a wrapper defect and it produced a symptom
indistinguishable from one. It is the reason a packaged build is worth reading the log of rather
than trusting.

### Fix 8 — the sign-in check is no longer a dead end

`client/src/components/SignIn.tsx`.

`localIssuerAvailable()` retries a *refused* request for about ninety seconds and then answers.
Both of its answers were terminal, because the check ran once at mount: a launch slower than the
budget, or one where something else was answering on the port, rendered "this server verifies
tokens against an external identity provider" — a confident, wrong, dead-ended answer — and stayed
there. The check can now be re-run, from a button in that branch and from the failure panel.

---

## What needs your decision

**`server/src/processManager.ts:76` and `server/src/sandbox/codeCheck.ts:88` are wrong on Windows.**

```ts
PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}`
```

Two problems in one line: the separator is hardcoded to `:`, and the path is macOS-specific. On
Windows this corrupts the first entry of `PATH` rather than prepending to it. The fix is small —
use `node:path`'s `delimiter`, and skip the Homebrew entry off macOS:

```ts
import { delimiter } from "node:path";
const extra = process.platform === "darwin" ? ["/opt/homebrew/bin"] : [];
PATH: [...extra, process.env.PATH ?? ""].join(delimiter)
```

I have not made that change, per the working agreement: it is server code, the evidence that the
server is at fault is genuine, and the rule was to report before changing. The wrapper works around
it today, and the workaround is documented at its own code and pinned by a test — but the
workaround is load-bearing until the two lines are fixed, and it should not be.

**`explain` on an agent that is not in the database crashes the backend.** Found during the parity
pass and reproduced in `npm run dev`, so it is Jaroku's rather than the wrapper's:

```
[unhandledRejection] TypeError: Cannot read properties of undefined (reading 'kind')
    at buildExplainContext (server/src/index.ts:8612:15)
```

An unhandled rejection ends the process, so one bad `explain` takes the whole server down —
in a browser that is a dead tab until somebody restarts a terminal. Not touched here.

**Two smaller things I noticed and did not act on**, because they are server decisions rather than
wrapper ones. `server/src/wsRelay.ts:2810` calls `this.http.listen(opts.port, …)` with no `error`
handler, so a port conflict surfaces as an uncaught exception rather than a message — everything
in this pass makes that unreachable from the desktop app, and it is still the reason the original
failure was so opaque; a one-line `this.http.on("error", …)` would turn it into a sentence. And it
binds the wildcard rather than loopback, which means the backend a desktop user starts is
reachable from their network.

---

## Phase 4 — parity with `npm run dev`

Done as a pass rather than assumed. The same script drives both targets, differing only in the
port it talks to and the `Origin` it sends — `tauri://localhost` for the packaged app,
`http://localhost:5173` for a browser — because that header is the one thing the server treats
differently between them, and it is where the previous release's sign-in bug lived.

### The desktop app, against a real installed bundle

Installed build, `%LOCALAPPDATA%\Jaroku`, payload extracted to `%APPDATA%\jaroku`.

| Flow | Result |
|---|---|
| Launch → main screen | Window at 3.1s, extraction 21.6s (upgrade) or 8ms (ordinary), backend listening |
| CORS from the packaged origin | `access-control-allow-origin: tauri://localhost` on every request |
| Sign-in — token, session, ticket | All three, `adarsh@jaroku.test`, 2 workspaces |
| Socket opens, first snapshot unbidden | 8 channels: history, agents, mcp, providers, deploy, threads, inbox, members |
| Threads / Agents / Inbox / Activity | All four answered |
| Code / Graph / Trace / Evals / MCP / Providers / Deploy | All seven answered |
| Running an agent, Trace updating live | 17 frames — `run_start`, 15 × `step`, `run_end` — in 3.2s |
| The graph, introspected through the bundled Python | Answered in ~4s, a real `uv run` |
| Composer → a question streamed back | `reply` frames |
| The boot run the README promises | 13 steps persisted |

### The same script against `npm run dev`

`cd server && npm run dev`, origin `http://localhost:5173`, development allowlist. **Every flow
above passed identically**, with the same channel set, the same live trace delivery and the same
streamed reply. The only differences are the two that are supposed to differ: the database
(`server/jaroku.db` rather than `%APPDATA%\jaroku\jaroku.db`) and the origin the server names
back. Nothing behaved differently because it was inside a window.

**And one thing behaved better inside it.** Both targets hit the same server crash during the
composer flow:

```
[unhandledRejection] TypeError: Cannot read properties of undefined (reading 'kind')
    at buildExplainContext (server/src/index.ts:8612:15)
    at explainAgent (server/src/index.ts:8648:23)
```

Asking `explain` about an agent that is on disk but not in the database takes the whole Node
process down. It is Jaroku's bug rather than the wrapper's — it reproduces in `npm run dev`
exactly as it does in the app, which is how it was attributed — and it is noted below rather than
fixed here. What the two runs did about it differed completely:

- **`npm run dev`**: the process exited. The terminal shows the stack. Somebody has to notice and
  restart it.
- **The desktop app**: the supervisor saw the exit, ended the process tree, re-resolved the port,
  restarted, and the backend was serving again **five seconds later** — with every step of it
  timestamped in the log. Before this pass the same event would have left the window saying
  `disconnected — retrying` while a launcher process quietly held the port the restart needed.

That is the clearest single answer to "is the desktop app as reliable as the web version": on the
one unplanned crash that happened during the parity pass, it recovered and the browser did not.

### The desktop-specific failure paths, which have no web counterpart

| Scenario | Before | After |
|---|---|---|
| Kill `jaroku.exe` | Both node processes survived, port bound, `/healthz` still 200 | Nothing survives, port released, `/healthz` refused |
| Launch with a wildcard listener on 4317 | No backend at all; three silent failures; the page hammered the foreign listener | `port 4317 is already in use, so the backend gets 4318`; backend on 4318; the webview followed; the foreign listener received nothing |
| Backend killed four times in a row | Window said `disconnected — retrying`, forever | Three restarts at 0.5s/2s/8s, then a panel naming the reason, the log's path and a way to start it again |
| A backend that crashed on its own | Same, and invisible | Caught live during this pass: exit → tree ended → port re-resolved → restarted → serving again in 5s, every step logged |

The failure panel was photographed rather than reasoned about. It renders the shell's own
sentence, the log's path, **Start it again** and **Copy log path** — and it arrived as a *live*
event on a page that had mounted while the backend was still healthy, which is what proves the
event path rather than only the snapshot one.

---

## Still owed

Stated plainly rather than implied.

- **Only Windows.** macOS and Linux have not been built or launched in this pass either. The job
  object is a Windows-only code path and its Unix counterpart — SIGTERM relayed by tsx — was
  verified by reading `tsx/dist/cli.mjs`, not by running it. The macOS menu bar, the entitlements,
  the `.dmg`, the `.deb` and the AppImage remain unexercised.
- **The credential-store round trip** still has not been driven end to end by hand under the new
  build.
- **The first-launch path was not re-exercised from empty.** `%APPDATA%\jaroku` already existed on
  this machine. The *upgrade* path was exercised for real — a changed payload stamp, 21.6 seconds
  of re-extraction, the new tree in place and the boot run correct afterwards — but a launch from
  nothing, which also builds the virtualenv, has not been watched. That is the one case where the
  new `preparing` phase matters most.
- **The graceful quit path was exercised by killing the shell rather than by pressing Quit in the
  tray.** Both reach the same code on Windows (`TerminateProcess` and then the job), and the job's
  kill-on-close covers the harsher of the two, so the weaker path is the one that was tested — but
  nobody has clicked the tray item.
- **The failure panel's "Start it again" was built and typechecked but not pressed.** The panel
  itself was photographed rendering in the packaged app, and `restart_backend` is asserted on both
  sides of its seam by `test:desktop-contract` — but nobody has clicked the button and watched a
  backend come back from it.
- **The window was checked by screenshot rather than driven.** Every flow in the parity table was
  driven over a real socket against the packaged backend, which proves the backend half and the
  protocol half. What a person clicking through the four tabs sees was not walked by hand.
- **`server/src/wsRelay.ts` binds the wildcard**, so a desktop user's backend is reachable from
  their network. Out of scope here and worth a decision.
