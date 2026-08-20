# Jaroku as a desktop application

Jaroku is a Node server, a React client and a Python runtime. This document is about the fourth
thing: a Tauri v2 shell that starts the first, displays the second, carries the third, and adds
nothing to any of them.

**The rule the whole wrapper is written under is that it adapts to Jaroku and never the reverse.**
No route handler, WebSocket message shape, RLS policy, migration, `SecretStore` behaviour or event
in `schema/events.md` was changed to accommodate it. Every variable the shell sets is one the
README's configuration table already documents, and `npm run test:desktop-contract` asserts that
mechanically by searching the server's own source for each of them — a variable invented in the
wrapper would be a change to the server wearing a disguise, and it would be invisible in review.

`cd server && npm run dev` and `cd client && npm run dev` are untouched and remain the development
path. Nothing under `server/` or `client/` imports from `src-tauri/`, and no npm script in either
package produces anything the shell needs.

---

## Architecture

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │  Tauri shell  (src-tauri/, Rust)                                    │
  │                                                                     │
  │   logs.rs       everything said  →  ~/.jaroku/logs/desktop.log      │
  │   ports.rs      4317, or the next free port above it                │
  │   window.rs     the window, and an init script carrying that port   │
  │   payload.rs    server/ + runtime/  →  ~/.jaroku/app                │
  │   python.rs     uv + CPython + wheels  →  ~/.jaroku/python          │
  │   sidecar.rs    node tsx server/src/index.ts, supervised            │
  │   tree.rs       …and everything it spawns, ended with it            │
  │   status.rs     what the shell is doing  →  the page                │
  │   deeplink.rs   jaroku://  →  an event, or a queue                  │
  │   secrets.rs    the session token  →  the OS credential store       │
  └───────────────────────────┬─────────────────────────────────────────┘
                              │ spawn, with an environment
                              ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │  Node backend  —  the SAME process `npm run dev` starts             │
  │  HTTP + WebSocket on localhost:<port>                               │
  └───────────────────────────┬─────────────────────────────────────────┘
                              │ localhost WebSocket, unchanged
                              ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │  React client  —  the SAME bundle `npm run build` produces          │
  └─────────────────────────────────────────────────────────────────────┘
```

### The connection is still a WebSocket

The client speaks twenty-one channels to the relay and every one of them has a message shape the
server and the browser both know. Replacing that with Tauri's IPC would mean rewriting all of it,
so it was not replaced: in the packaged app the page opens `ws://localhost:<port>` exactly as it
does in a browser, gets there through the same three-request exchange — token, session, ticket —
and the relay cannot tell the difference. `npm run test:desktop-smoke` proves that by spawning the
real server and driving the whole exchange over a real socket.

### The frontend has exactly three Tauri-aware modules

Everything else in `client/` is identical in a browser and in the app.

| Module | What it does outside a host |
|---|---|
| `client/src/lib/sessionVault.ts` | `localStorage`, byte for byte what `auth.ts` did before |
| `client/src/lib/deepLink.ts` | `onDeepLink` returns a no-op unsubscribe and nothing is ever delivered |
| `client/src/lib/hostBackend.ts` | `onBackendStatus` returns a no-op unsubscribe and no status ever arrives |

`client/src/lib/hostConfig.ts` is a fourth file and is deliberately **not** one of them: it reads a
value any host may write onto the global object before the bundle loads, it mentions no Tauri and
imports none, and absent a host it falls through to `VITE_JAROKU_WS` and then to
`ws://localhost:4317`. All three Tauri-aware modules reach the shell through `window.__TAURI__`
rather than `@tauri-apps/api`, so neither `package.json` nor a browser build gains a dependency.

`hostConfig`'s value is a **seed rather than a constant**. A host that merely serves a page can
freeze the address it serves it at; a host that supervises the backend cannot, because a restart
that finds the old port taken has to move. So the injected object stays frozen and a correction
arrives beside it on every backend status, through the same validation — and both readers,
the socket and every HTTP surface, resolve per call rather than at module load.

### Where things live at runtime

`~/.jaroku` on macOS and Linux, `%APPDATA%\jaroku` on Windows. Not Tauri's own `app_data_dir()`,
which on macOS contains the bundle identifier — renaming the bundle would strand a user's
extracted runtime somewhere they will never look, and the app would re-extract several hundred
megabytes and call itself freshly installed.

| Path | What |
|---|---|
| `app/` | the extracted payload: `server/` and `runtime/` as siblings |
| `python/` | the bundled uv, a standalone CPython, and a wheel cache |
| `venv/` | the virtualenv `uv sync` builds from the two above |
| `keys/` | the object-signing, run-token and local-issuer keys |
| `jaroku.db` | the database, deliberately outside `app/` — see below |
| `app-initialized` | the first-launch marker |
| `logs/desktop.log` | what the shell and the backend said, with one rolled backup beside it |

**The payload is extracted rather than run in place** because all three bundles are read-only in
normal use — Program Files, a signed `.app`, an AppImage's mount — and Jaroku writes inside
`runtime/` constantly: `.objects/` is the local object store, `.checkpoints/` holds a database per
run, `agents/` is where a generated project is materialised, and `.env` is what the dotenv secret
store *is*. `server/` moves with it because `index.ts` derives `RUNTIME_DIR` from its own location
and no variable separates the two.

**Extraction never deletes.** It writes the payload's own files over whatever is there and touches
nothing else, because the same directory holds somebody's generated agents. The database and the
three signing keys live *outside* `app/` for the same reason: that directory is rewritten by every
upgrade.

### The Python runtime

The server spawns `uv run python -m jaroku_runner <agent>`, resolving `uv` from `PATH` — that line
predates this work and did not change. The shell puts the bundled uv first on `PATH` and sets four
`UV_*` variables, and every existing spawn resolves to the bundled toolchain with no server code
aware of it. `UV_MANAGED_PYTHON=1` is the load-bearing one: without it uv may satisfy
`requires-python = ">=3.12"` from whatever Python the machine happens to have, which is the
external dependency the bundle exists to remove.

`UV_OFFLINE` is deliberately **not** set. The wheel cache means an ordinary first launch needs no
network; forcing offline would turn a cache miss — a connector extra installed later, a lock file
that moved — from a download into a refusal.

---

## Running it

### Development

Nothing changed. Two terminals, exactly as the README describes:

```bash
cd server && npm run dev     # :4317
cd client && npm run dev     # :5173
```

To run the same thing inside the desktop shell:

```bash
npm install          # once, at the repository root — installs the Tauri CLI only
npm run tauri:dev
```

`tauri:dev` starts Vite itself (`beforeDevCommand`) and the shell starts the backend. **In
development the shell runs the working tree**: `app_dir` is the repository, so the server that
runs is `server/src/index.ts` on disk, generated agents land in the `runtime/agents/` you can
open, the database is `server/jaroku.db` with everything already in it, and your own `uv` is used
rather than a bundled one. Nothing is extracted and nothing is copied. Only `JAROKU_PORT` is set.

### Packaged

```bash
npm run tauri:build
```

which is `tauri:payload && tauri:python && tauri build`. The two staging scripts are what turn a
checkout into a bundle:

| Script | What it stages | Into |
|---|---|---|
| `npm run tauri:payload` | the Node runtime as a sidecar; every file `git ls-files` reports under `server/` and `runtime/`; `server/node_modules` | `src-tauri/binaries/`, `src-tauri/resources/app/` |
| `npm run tauri:python` | the uv binary, a standalone CPython, and the wheels `runtime/uv.lock` pins | `src-tauri/resources/python/` |
| `npm run tauri:icons` | the icon set, rendered from `client/public/favicon.svg` | `src-tauri/icons/` |

`server/node_modules` must be installed first (`cd server && npm ci`) — the bundle ships the
dependency tree rather than resolving one at install time, and `tsx` is in it because the packaged
app runs the same `tsx src/index.ts` command `npm run dev` does.

The payload is **what the repository tracks**, not a curated list. A curated list is the one that
breaks the first time somebody adds a file the server reads at runtime, because a missing file is
invisible in every environment that has a checkout. What is excluded needed no rule of its own:
everything gitignored, which is exactly the object store, the checkpoints, generated agents,
`runtime/.venv`, the three signing keys and `runtime/.env`.

### Building for each platform

Tauri does not cross-compile the bundles; each is built on its own platform. `bundle.targets` in
`src-tauri/tauri.conf.json` lists all five and each host builds the ones that apply to it.

| Platform | Produces | Notes |
|---|---|---|
| macOS | `Jaroku.app`, `Jaroku_0.3.3_<arch>.dmg` | `minimumSystemVersion: 11.0`. Build on the architecture you are shipping, or pass `--target aarch64-apple-darwin` / `x86_64-apple-darwin` |
| Windows | `Jaroku_0.3.3_x64-setup.exe` (NSIS) | `installMode: currentUser`, so no administrator prompt. WebView2's bootstrapper is embedded rather than downloaded |
| Linux | `jaroku_0.3.3_amd64.deb`, `Jaroku_0.3.3_amd64.AppImage` | `.deb` depends on `libwebkit2gtk-4.1-0`, `libgtk-3-0`, `libayatana-appindicator3-1` |

Artefacts land in `src-tauri/target/release/bundle/`.

**The staging scripts are host-specific.** They copy the build machine's Node and uv and download
a CPython for its platform, so a bundle built on macOS carries a macOS Python. Cross-building the
Rust without re-staging produces a bundle whose runtime is for the wrong operating system.

---

## Code signing

Nothing in this repository is signed and no certificate belongs in it. Both platforms read their
credentials from the environment, which is where they belong: an identity written into a tracked
file is one that is wrong on every machine but the one it was written on.

### macOS

`src-tauri/tauri.conf.json` leaves `bundle.macOS.signingIdentity` as `null`, which makes Tauri read
`APPLE_SIGNING_IDENTITY`.

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_CERTIFICATE="$(base64 -i certificate.p12)"   # CI only
export APPLE_CERTIFICATE_PASSWORD="…"                      # CI only

# Notarisation, which is a separate step from signing:
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="TEAMID"

npm run tauri:build
```

`src-tauri/entitlements.plist` is already wired in and is what makes a notarised build work at all.
Read its comment before changing it: the bundle contains a Node runtime and a CPython that loads
wheels signed by nobody, so `allow-jit`, `allow-unsigned-executable-memory` and
`disable-library-validation` are requirements rather than precautions.

**The copied Node binary has to be signed with the rest of the bundle.** Tauri signs external
binaries it knows about, and `binaries/jaroku-node-<triple>` is declared in `bundle.externalBin`,
so it is one of them. The CPython under `~/.jaroku/python` is *not* in the bundle — it is extracted
at runtime — and is therefore not covered by the signature. It runs because it was never quarantined.

### Windows

Set `bundle.windows.certificateThumbprint` to your certificate's SHA-1 thumbprint, or supply it
through `TAURI_WINDOWS_SIGNTOOL_PATH` and the standard signtool environment. `digestAlgorithm` and
`timestampUrl` are already set to `sha256` and DigiCert's timestamp server.

### Linux

Neither the `.deb` nor the AppImage is signed. If you publish through a repository, sign it there.

---

## The auto-updater

Off by default, and it cannot be otherwise: the updater needs a signing key pair to build, the
public half goes in the configuration and the private half signs each release. This repository has
neither and must never hold the second.

```bash
npx tauri signer generate -w ~/.tauri/jaroku.key      # once, and keep the private half safe
```

Then edit `src-tauri/tauri.updater.conf.json` — the endpoint and the public key are the only two
values in it — and build with both flags:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/jaroku.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="…"

npm run tauri:payload && npm run tauri:python
npx tauri build --features updater --config src-tauri/tauri.updater.conf.json
```

**The placeholder endpoint is under `.invalid`**, which RFC 2606 reserves so that it can never
resolve. A plausible hostname would be a domain somebody could register, and an unconfigured build
reaching for a stranger's server is the whole of a supply-chain compromise. `test:desktop-contract`
asserts that the placeholder stays under `.invalid` and that the default configuration carries no
updater at all.

A build with the feature checks once, thirty seconds after launch, and **says so rather than
installing**. Downloading and restarting out from under somebody watching a run stream is not
something to do without asking, and the surface that would ask belongs to a specification this
work is not. `install_update` is the call that surface makes.

---

## Behaviour worth knowing about

**Closing the window does not quit.** It hides, and the tray brings it back. A run takes minutes,
an eval fans a dataset across providers and takes longer, and all of it happens inside the backend
this shell supervises — a close that ended the process would cancel work somebody started and is
paying a provider for, silently. Quit is the last item in the tray menu on every platform, and ⌘Q
on macOS. **If the session cannot provide a tray** — a Linux desktop with no StatusNotifier host —
the close button is left alone and quits, because a hidden window with nothing to restore it is
worse than a cancelled run. The reason is printed at startup when that happens.

**The window remembers its position, size and maximised state** and deliberately not its
visibility, which would faithfully reopen Jaroku invisible every time.

**A second launch focuses the first.** Two instances would race for port 4317 and write one SQLite
database from two processes.

**The port is 4317 unless something holds it**, and then the next free one above. The resolved port
reaches the page as `window.__JAROKU_CONFIG__.wsUrl` before its first module evaluates, and is
re-resolved before every start attempt — preferring the one already in force, so an ordinary
restart moves nothing. "Holds it" means what the backend means by it: `is_free` binds both
wildcards, the way `http.listen(port)` does, and then asks whether anything answers on either
loopback. A probe that bound `127.0.0.1` reported a port free that a wildcard listener was already
holding, which is a bind Windows permits and was the largest single cause of the freezes this
wrapper had.

**A crashed backend is restarted three times** with 0.5s, 2s and 8s between attempts. The budget
resets once a start has stayed up for a minute. After three consecutive failures the shell stops
and **tells the page**, which renders the reason, the log's path and a retry rather than a
connection strip that will never connect.

**Quitting ends the backend and everything it spawned.** The process the shell holds is tsx's
launcher, not the server — tsx re-executes Node with its own loader as a child — so a kill of the
child left the real backend running with the port bound and the database open, and the next launch
found 4317 taken by a Jaroku nobody could see. On Windows the sidecar is bound to a job object
with kill-on-close, which also covers the shell being killed from Task Manager. On macOS and Linux
`SIGTERM` reaches the server through tsx's own signal relay and the drain runs as it always did.

**Everything the shell and the backend say goes to `~/.jaroku/logs/desktop.log`.** That is where
to look first when a launch goes wrong; see below.

---

## When a launch goes wrong

**Read `~/.jaroku/logs/desktop.log`** — `%APPDATA%\jaroku\logs\desktop.log` on Windows. It carries
the shell's own decisions and the whole of the backend's stdout and stderr, timestamped to the
millisecond, in every build. The boot lines naming the database, the object store, the origin
allowlist and the listening port are all in it, exactly as `npm run dev` prints them.

For a startup ordering problem — the class of bug where something is not ready yet — set

```bash
JAROKU_DESKTOP_DEBUG=1
```

before launching. That adds the verbose half: the port probe's answer, every supervision
transition, the argument vector and pid of each spawn, the names of the environment the backend is
given, and a millisecond clock on each startup step measured from the window appearing. It is off
in a release build and on in a debug one. It is a variable the shell **reads**; it is never put
into the backend's environment, and `test:desktop-contract` asserts that.

The window says which failure it is. `backend stopped` in the status strip, or a panel on the
sign-in screen carrying the shell's own sentence and the log's path, means the supervisor has
given up — quitting from the tray and reopening starts it over. `disconnected` means the ordinary
retry loop, which recovers on its own.

---

## Distribution

**There is no landing page and none is needed.** GitHub Releases is a download page: four
artefacts, a description, and a URL you can send to a tester. `.github/workflows/release.yml`
builds all four and attaches them.

```bash
git tag v0.3.4 && git push origin v0.3.4     # cuts a release
# or run the workflow by hand from the Actions tab to test the pipeline without a tag
```

It publishes as a **draft**. Three of four platforms succeeding is exactly the case where an
automatic publish is worst, so somebody presses the button after checking all four arrived.

| Runner | Produces | For |
|---|---|---|
| `macos-14` | `.dmg`, `.app` | Apple silicon |
| `macos-13` | `.dmg`, `.app` | Intel Macs |
| `ubuntu-22.04` | `.deb`, `.AppImage` | Debian/Ubuntu, and everything else |
| `windows-latest` | `-setup.exe` (NSIS) | Windows, per-user, no administrator |

Two of those rows are decisions rather than defaults. **Ubuntu is pinned to 22.04** because the
Node binary this bundle ships is dynamically linked against the build machine's glibc, which
therefore becomes the application's floor — `ubuntu-latest` is 24.04 and would produce an
AppImage that refuses to start on Debian 12. And there are **two macOS runners rather than one
universal binary**, because a universal build needs a universal Node to sit beside the universal
Rust binary and the Node release channel does not publish one.

### When the landing page is the only front door

A landing page is a front door, not a file server: the bytes still need an origin, and GitHub
Releases is a good one — CDN-backed, free, 2 GB per asset, and it never appears in the user's
journey if your buttons link straight at it. Nobody browses to a repository; they click Download
on your site and a file arrives.

**Every artefact is therefore published twice.** Tauri names its output after the version —
`Jaroku_0.3.3_aarch64.dmg` — which is right for an archive and useless for a button, because
every release would break every link on the site. The workflow uploads a second copy under a name
that never changes, so a download button can point at one URL for the life of the product:

| Button | URL |
|---|---|
| macOS (Apple silicon) | `…/releases/latest/download/Jaroku-macos-arm64.dmg` |
| macOS (Intel) | `…/releases/latest/download/Jaroku-macos-intel.dmg` |
| Windows | `…/releases/latest/download/Jaroku-windows-x64-setup.exe` |
| Linux (AppImage) | `…/releases/latest/download/Jaroku-linux-x86_64.AppImage` |
| Linux (Debian/Ubuntu) | `…/releases/latest/download/Jaroku-linux-amd64.deb` |

all prefixed `https://github.com/jackeddisciple/Jaroku`. The versioned originals stay beside them,
which is what somebody wants when they need a specific release rather than the current one.

**Put a redirect on your own domain in front of those.** `jaroku.dev/download/mac-arm` →  `302` →
the GitHub URL costs one route and buys three things the direct link cannot: the address stays
yours if the origin ever moves, the analytics are yours, and one `/download` route can read the
`User-Agent` and pick the platform so the page needs a single button instead of five. Serving the
files yourself is the other option — R2 charges nothing for egress — and it costs about 1.6 GB of
storage per release, which is worth knowing before it is four releases old.

**The updater endpoint belongs on that domain too.** `src-tauri/tauri.updater.conf.json` holds a
`.invalid` placeholder precisely so it cannot resolve until somebody decides; a landing page means
that decision is made, and the value becomes something like
`https://jaroku.dev/updates/{{target}}/{{arch}}/{{current_version}}`. That endpoint answers either
`204 No Content` or the small JSON manifest Tauri's updater expects — it can be a static file per
target, regenerated on release, rather than a service.

### Getting it onto a tester's machine

**The one-line install is the path to send people**, and on macOS it is the only free one that
ends in a working application:

```
curl -fsSL https://raw.githubusercontent.com/jackeddisciple/Jaroku/main/scripts/install.sh | sh
```

It resolves the latest release, picks the asset for the architecture it is running on, and
installs — `/Applications` on macOS, `~/.local/bin` on Linux.

**Why a browser download is worse than a curl one on macOS.** A browser attaches
`com.apple.quarantine` to what it downloads, and Gatekeeper refuses to open a quarantined app
signed by no certificate. `curl` attaches nothing — the attribute exists to mark files that
arrived through a program acting on a web page's behalf, and a person typing a command is not
that. Same bytes, and only one of the two opens on a double-click afterwards.

**Ad-hoc signing is what makes the unsigned build runnable at all.** An arm64 Mach-O binary must
carry a signature to execute; Apple silicon has no unsigned execution path. Without one, an
M-series Mac reports *"Jaroku is damaged and can't be opened"* — which reads as a corrupt
download rather than a policy decision. The release workflow signs with the ad-hoc identity `-`,
which satisfies the loader without satisfying Gatekeeper: the app runs, and the warnings remain.

By hand, per platform:

- **macOS** — right-click → *Open* the first time. A plain double-click offers no way through.
- **Windows** — SmartScreen warns that the publisher is unknown: *More info* → *Run anyway*.
- **Linux** — `chmod +x` the AppImage.

### The only way to a true double-click on macOS

There isn't a free one, and it is worth being plain about that rather than working around it
forever. Zero-warning installation on macOS requires **the Apple Developer Program, $99/year**:

1. Enrol at [developer.apple.com](https://developer.apple.com/programs/) — approval usually
   takes a day or two.
2. Create a **Developer ID Application** certificate (not "Mac App Distribution" — that one is
   for the App Store and cannot sign a directly-distributed app).
3. Add `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
   `APPLE_PASSWORD` (an app-specific password) and `APPLE_TEAM_ID` to the repository's Actions
   secrets, and set them on the `tauri-action` step in place of the ad-hoc `-`.

Everything else is already in place: `entitlements.plist` carries the four the hardened runtime
needs for a bundled Node and CPython, and Tauri notarises automatically once those variables are
present. After that a tester downloads the `.dmg` in a browser, double-clicks, drags to
Applications, and it opens — no terminal, no right-click, no instructions.

Windows has an equivalent: an OV or EV code-signing certificate removes the SmartScreen warning,
though only an EV one removes it immediately.

### The download is smaller than the install

**78 MB for the Windows installer, which expands to 365 MB on disk.** The payload is a Node
runtime, a `node_modules` tree, a standalone CPython and every wheel `runtime/uv.lock` pins —
source-heavy, and NSIS's LZMA compresses it about 4.5:1. Expect the other platforms to land in
the same range.

That 365 MB is the price of the decision that a user installs nothing: no Python, no uv, no
`pip install`, no version conflict with whatever else is on their machine. The number worth
quoting to a tester is the download, not the install.

## What has been run, and what has not

**The distinction this section is for**: `tauri dev` short-circuits three of the shell's biggest
code paths, because in development the working tree *is* the payload. So "the app runs" and "the
bundle works" are different claims, and only the first has been earned.

### Verified by running it (Windows, rustc 1.97.1)

- `cargo check` and a full `cargo build` — **no errors, no warnings**. `Cargo.lock` is committed.
- The window opens, titled `Jaroku`.
- The Node sidecar spawns and the relay answers: `[relay] http+ws listening on http://localhost:4317`,
  `/healthz` → `{"ok":true}`.
- Development runs the **working tree**: the boot line names `server\jaroku.db` and
  `runtime\.objects`, not a copy.
- `jaroku://` registers at runtime, and a URL fired from the operating system arrives:
  `Start-Process "jaroku://test"` → `[jaroku] received jaroku://test/`. Windows appends the
  trailing slash; the parser reads it as `action=test, path=[]`.
- **Single instance**: one `jaroku.exe` before a second launch, one after.
- `marker::mark` wrote `%APPDATA%\jarokupp-initialized` — `{"at":"…Z","version":"0.3.3"}` — after
  creating `runtime/.checkpoints` and proving it writable. That also exercises `paths::jaroku_home()`
  on Windows and the hand-written UTC arithmetic in `marker.rs`.
- The tray was created; a failure would have logged and left the close button quitting.

### Verified in the packaged app (Windows, installed from the NSIS build)

This is the half `tauri dev` cannot reach, and all of it ran:

- **The installer** — `Jaroku_0.3.3_x64-setup.exe`, 78 MB, per-user, no administrator prompt. It
  installs to `%LOCALAPPDATA%\Jaroku` with `jaroku.exe`, `jaroku-node.exe` (the sidecar, renamed
  by Tauri from its target-triple name) and both resource trees intact.
- **Extraction ran.** `payload::ensure` wrote `%APPDATA%\jarokupp` with `server/` and `runtime/`
  as siblings and stamped it; `python::ensure` wrote `%APPDATA%\jaroku\python`.
- **`python::warm` built the virtualenv** at `%APPDATA%\jarokuenv` from the bundled wheel
  cache — no pip, no system Python, nothing installed by the user.
- **The packaged origin allowlist is the one in use.** The boot line reads
  `[auth] origin allowlist: tauri://localhost, http://tauri.localhost`, not `(development
  default)`. That is the gap found by hand before any bundle existed, now closed by one.
- **Every path moved to its packaged location**: the database at `%APPDATA%\jaroku\jaroku.db`,
  the local issuer's key under `keys/`, the object store and checkpoints inside the extracted
  payload.
- **An agent ran end to end.** Signing in through the local issuer from the `tauri://localhost`
  origin, opening a socket with a ticket, and dispatching `{ cmd: "run", agentId: "example_agent" }`
  produced **30 steps across all four types** — `state_update`, `llm_call`, `router`, `tool_call`
  — persisted at `schema_version: 1`, through a Python the user never installed.
- **Tenancy held in the fresh install.** A new account's personal workspace was empty; the agent
  was visible only in the workspace that owns it.
- **Signing in through the window**, typed into the form rather than posted by a script, and then
  a prompt sent through the composer.

### Three bugs a packaged build found that no suite could

None of these is in the wrapper. All three are cases the desktop app reaches and a browser never
does, which is the argument for shipping one at all.

1. **The startup run has emitted nothing since v0.2.17.** `jaroku_runner` honours
   `JAROKU_RUN_ID`; the hand-written fixture minted its own, so the control plane's run-id
   reconciliation dropped every event of the boot run. Reproduces under `npm run dev` too.
2. **The first prompt in a new workspace was invisible.** A conversation is keyed by thread and
   the first prompt names no session, so the server minted one; the store filed the turns under
   it and the screen went on reading `pending`. A plan card and a refusal were equally invisible.
   A fresh install makes it certain, because there is no key, so the plan always fails.
3. **The sign-in screen treated "not listening yet" as "no local issuer"** and rendered a branch
   with no form on it. Only reachable because the shell opens the window before the backend.

The first two are Jaroku's and are fixed here; the third is the wrapper's and is fixed in
`localIssuerAvailable`. What they share is that every suite was green throughout — the failures
lived in the wiring between a shell, a browser engine and a server, which is precisely where no
unit test looks.

### Not run yet

**Only Windows.** macOS and Linux have not been built or launched. That means the macOS menu bar,
the entitlements, the `.dmg`, the `.deb`, the AppImage, and SIGTERM shutdown are all unexercised —
and SIGTERM is the one that only *exists* off Windows.

**The credential store round trip.** `secrets.rs` compiles and its allowlist is unit-tested, but
nobody has signed in *through the window*, so no token has been written to Windows Credential
Manager by the app itself. The client half is covered by `test:session-vault`, which proves the
token never reaches `localStorage` when a host is present.

**`cargo test` needs the app stopped.** The build script copies the sidecar into `target/debug/`,
and Windows locks a running executable's file — so `cargo test` fails with `PermissionDenied`
while `tauri dev` is up. Stop the app first.

**The updater** has never been built or pointed at an endpoint, by design: it needs a signing key
pair that must not exist in this repository.

## Known limitations

**Shutdown is graceful on Unix and not on Windows.** `sidecar.rs` sends SIGTERM, which tsx relays
to the server and `server/src/index.ts` handles by draining its trace-ingest chain before exiting.
Windows has no equivalent for a console-less child — every portable kill resolves to
`TerminateProcess` — so the drain does not run there, and the last few events of a run that was in
flight at the moment of quitting can be lost. Fixing it properly means a shutdown route on a
server this wrapper is not allowed to change.

What *is* fixed is that the backend now actually stops. It did not before: the kill reached tsx's
launcher and the server it had spawned went on running, which is the wrapper's own bug rather than
the platform's. See `src/tree.rs`.

**The bundled uv reaches an agent run through a workaround, not through the obvious PATH.**
`processManager.ts` and `sandbox/codeCheck.ts` spawn uv with `/opt/homebrew/bin:` prepended to
`PATH`, which is a `:` separator and a macOS path — on Windows that corrupts the first entry
rather than adding one, and the first entry is the one this shell just added. `python.rs` puts a
sacrificial entry in front of its own so the real one survives intact, and says so where it does
it. The two-line fix belongs in the server; it is written up in
`docs/tauri-stabilization-report.md` and has not been made.

**The first launch is slow and large.** Roughly 85 MB of payload and 180 MB of Python runtime are
copied out of the bundle, and then `uv sync` builds a virtualenv. The window opens first and the
client's own connecting state covers it; the venv build runs *after* the backend is up, because
`uv run` syncs the environment itself and a run started meanwhile pays the build inside the run
rather than failing. There are no first-run screens — those belong to the onboarding
specification, and this work provides only the marker they will read.

**A developer build inherits the build machine's runtimes.** `prepare-payload.mjs` copies
`process.execPath` and `prepare-python.mjs` copies whichever `uv` is on `PATH`. A release should
pin both with `JAROKU_NODE_BINARY` and `JAROKU_UV_BINARY`; the versions actually used are written
into `payload.json` and `python.json` so an installed app can be asked rather than guessed at. On
Linux the copied Node is linked against the build machine's glibc, which becomes the app's floor.

**`payload.rs` looks for the staged tree in two places.** `bundle.resources` accepts both an array
and a source-to-destination map, and the two put the tree in different places relative to the
resource directory. Whichever exists is used. An installed NSIS build resolves to
`resource_dir()/resources/app`, so the array form — the one this configuration uses — is the live
branch. The other is kept until a macOS and a Linux bundle have been installed and looked at.

**Symlinks in the staged trees are not extracted.** `mirror()` walks with `file_type()` and copies
files and directories only, deliberately — following a link out of the payload is how an extractor
writes outside the directory it was given. The staged Python tree contains one: uv's
`cpython-3.12-…` alias pointing at the versioned interpreter directory. It does not arrive, and
nothing needs it — uv resolves the versioned directory and the venv builds without it. Worth
knowing before somebody goes looking for a missing alias.

**Deep links on Linux depend on a desktop entry.** The `.deb` installs one and the scheme works;
an AppImage run from a download folder has not registered anything with the desktop environment,
so `jaroku://` will not reach it until the entry is installed. This is a property of AppImage
rather than of this configuration.

**The tray needs `libayatana-appindicator3` on Linux.** It is named in the `.deb`'s dependencies;
an AppImage on a machine without it gets no tray, and therefore a close button that quits.
