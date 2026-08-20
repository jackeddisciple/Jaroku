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
  │   ports.rs      4317, or the next free port above it                │
  │   window.rs     the window, and an init script carrying that port   │
  │   payload.rs    server/ + runtime/  →  ~/.jaroku/app                │
  │   python.rs     uv + CPython + wheels  →  ~/.jaroku/python          │
  │   sidecar.rs    node tsx server/src/index.ts, supervised            │
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

### The frontend has exactly two Tauri-aware modules

Everything else in `client/` is identical in a browser and in the app.

| Module | What it does outside a host |
|---|---|
| `client/src/lib/sessionVault.ts` | `localStorage`, byte for byte what `auth.ts` did before |
| `client/src/lib/deepLink.ts` | `onDeepLink` returns a no-op unsubscribe and nothing is ever delivered |

`client/src/lib/hostConfig.ts` is a third file added by this work and is deliberately **not** one
of them: it reads a value any host may write onto the global object before the bundle loads, it
mentions no Tauri and imports none, and absent a host it falls through to `VITE_JAROKU_WS` and
then to `ws://localhost:4317`. Both Tauri-aware modules reach the shell through `window.__TAURI__`
rather than `@tauri-apps/api`, so neither `package.json` nor a browser build gains a dependency.

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
reaches the page as `window.__JAROKU_CONFIG__.wsUrl` before its first module evaluates.

**A crashed backend is restarted three times** with 0.5s, 2s and 8s between attempts. The budget
resets once a start has stayed up for a minute. After three consecutive failures the shell stops
and says so; the window stays open and reports itself disconnected, which is the truth.

---

## Known limitations

**The Rust has never been compiled.** This is the honest headline and it is first for that reason.
There is no Rust toolchain on the machine this wrapper was written on, so `cargo check`,
`tauri dev` and `tauri build` have not run against it. Everything reachable from TypeScript and
from a shell *was* exercised — the staged payload was booted and driven through a real socket, the
bundled Python built a virtualenv with the network off and ran the fixture agent emitting
`schema_version: 1`, and two suites in CI hold the seams — but the shell's own supervision,
restart backoff, extraction, tray, menu and deep-link delivery are asserted by reading and by
structure, not by running. Treat the first `cargo check` as part of this work rather than after it.

**Consequently, three deliverables are configured and unverified**: that double-launching focuses
the existing window, that the OS credential store round-trips a token, and that a `jaroku://test`
URL reaches the page. The parsing half of the last one is verified (`test:deep-link`); the
delivery half is not.

**Shutdown is graceful on Unix and not on Windows.** `sidecar.rs` sends SIGTERM, which
`server/src/index.ts` handles by draining its trace-ingest chain before exiting. Windows has no
equivalent for a console-less child — every portable kill resolves to `TerminateProcess` — so the
drain does not run there, and the last few events of a run that was in flight at the moment of
quitting can be lost. Fixing it properly means a shutdown route on a server this wrapper is not
allowed to change.

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

**`Cargo.lock` is not committed**, because it cannot be generated without cargo. Generate and
commit it on the first machine that has a toolchain; a Rust application without one has no
reproducible build.

**`payload.rs` looks for the staged tree in two places.** `bundle.resources` accepts both an array
and a source-to-destination map, and the two put the tree in different places relative to the
resource directory. Whichever exists is used. Once a bundle has actually been built, delete the
branch that turns out to be wrong.

**Deep links on Linux depend on a desktop entry.** The `.deb` installs one and the scheme works;
an AppImage run from a download folder has not registered anything with the desktop environment,
so `jaroku://` will not reach it until the entry is installed. This is a property of AppImage
rather than of this configuration.

**The tray needs `libayatana-appindicator3` on Linux.** It is named in the `.deb`'s dependencies;
an AppImage on a machine without it gets no tray, and therefore a close button that quits.
