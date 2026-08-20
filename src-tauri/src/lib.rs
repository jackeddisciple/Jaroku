// The desktop wrapper's entry point.
//
// WHAT THIS APP IS. A window pointed at the same React bundle `npm run build` produces, and a
// supervisor for the same Node process `cd server && npm run dev` starts. It is a host, not a
// port: no route handler, no WebSocket message shape, no RLS policy and no SecretStore
// behaviour is reachable from this crate, and none of them is changed by it. The frontend still
// talks to the backend over a localhost WebSocket exactly as it does in a browser — replacing
// that with Tauri's IPC would mean rewriting the twenty-one channels the client already speaks,
// and every message shape they carry, which is the opposite of wrapping.
//
// THE ORDER IN `setup` IS LOAD-BEARING and each step says why where it happens.

mod paths;
mod ports;
mod sidecar;
mod window;

use std::collections::HashMap;
use std::path::PathBuf;

use tauri::{Manager, RunEvent};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // 1 — THE PORT, FIRST, because everything after it is told the answer rather than
            // asked to guess. 4317 unless something already holds it; see ports.rs.
            let port = ports::first_free(ports::DEFAULT_PORT).ok_or_else(|| {
                format!(
                    "no free port between {} and {}. Something on this machine is holding the \
                     whole range, and Jaroku's backend has nowhere to listen.",
                    ports::DEFAULT_PORT,
                    ports::DEFAULT_PORT + 32
                )
            })?;
            app.manage(sidecar::Backend::new(port));

            // 2 — THE BACKEND. Started here rather than lazily on the first socket attempt: the
            // client connects as soon as it has a session, and a backend that starts in response
            // to that would make every launch begin with a failed connection and a retry.
            let launch = sidecar::Launch { app_dir: app_dir(&app.handle()), env: environment(port) };
            if let Err(err) = sidecar::start(&app.handle(), launch) {
                // NOT a panic, and not a dialog. The window opens, the socket fails to connect,
                // and the client's own disconnected state says so — which is a state this product
                // already has, already renders and already recovers from. A shell that killed
                // itself here would take the only surface capable of explaining the problem.
                eprintln!("[jaroku] {err}");
            }

            // 3 — THE WINDOW, LAST, because it is the only step that needs the answers the two
            // above produced. It is built here rather than declared in `tauri.conf.json`, and
            // the reason is narrow and load-bearing: a window declared in the configuration is
            // created before `setup` runs, and an initialisation script can only be attached at
            // creation. That script is how the resolved port reaches the bundle BEFORE its first
            // module evaluates — see window.rs, and see client/src/lib/hostConfig.ts for the
            // side that reads it.
            window::open(&app.handle(), port)?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("jaroku: the desktop shell failed to start")
        .run(|app, event| {
            // Both events, deliberately. `ExitRequested` is the window closing and is where the
            // drain has time to happen; `Exit` is the last word and catches the paths that never
            // request — a quit from the dock's menu, a session ending, an updater relaunch.
            // `stop` is idempotent: it takes the child out of its slot, so the second call finds
            // nothing and returns.
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                sidecar::stop(app);
            }
        });
}

/// The directory holding `server/` and `runtime/` as siblings.
///
/// TWO ANSWERS, AND THE DEVELOPMENT ONE IS THE POINT. Under `npm run tauri:dev` this is the
/// repository itself, so the server that runs is the working tree: an edit restarts it through
/// tsx exactly as it would in a terminal, generated agents land in the `runtime/agents/` the
/// developer can open, and the database is `server/jaroku.db` with everything already in it. A
/// development mode that ran a copy would be a second environment to keep in sync, and the first
/// bug it hid would be one that only reproduces in the one nobody can attach a debugger to.
///
/// `CARGO_MANIFEST_DIR` is a compile-time constant naming `src-tauri/`, so its parent is the
/// repository root. It is read only on the development branch, where the binary and the source
/// tree are the same checkout by definition.
fn app_dir(app: &tauri::AppHandle) -> PathBuf {
    if tauri::is_dev() {
        return PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().map(PathBuf::from).unwrap_or_default();
    }
    let _ = app;
    paths::jaroku_home().map(|home| home.join("app")).unwrap_or_default()
}

/// The variables the backend is started with.
///
/// EVERY ONE OF THESE IS ALREADY IN THE README'S CONFIGURATION TABLE. That is the rule this
/// wrapper works under: it configures Jaroku through the interface Jaroku already exposes, and
/// Jaroku never learns it is inside a desktop app. A variable that had to be invented here would
/// be a change to the server wearing a disguise.
///
/// IN DEVELOPMENT ONLY THE PORT IS SET. The developer's `server/jaroku.db`, `server/.objectkey`
/// and `runtime/.env` are the ones `npm run dev` uses, and pointing the app at a private copy of
/// each would mean the two ways of starting the same server disagreed about what data exists.
fn environment(port: u16) -> HashMap<String, String> {
    let mut env = HashMap::new();
    env.insert("JAROKU_PORT".into(), port.to_string());
    if tauri::is_dev() {
        return env;
    }

    // THE ORIGIN ALLOWLIST, WHICH IS THE ONE VARIABLE A PACKAGED BUILD CANNOT DO WITHOUT.
    //
    // WebSockets are not covered by CORS, so `auth/origin.ts` checks the `Origin` header on the
    // upgrade and the same policy answers CORS for the HTTP half — the session exchange, the
    // ticket, the export. Its development default is the Vite and relay origins, which is
    // exactly right for `npm run dev` and exactly wrong here: a packaged webview's origin is
    // `tauri://localhost` on macOS and Linux and `http://tauri.localhost` on Windows, and
    // neither is in that list. Without this the window opens, signs nobody in, and reports a
    // socket that will not connect — which looks like a broken backend and is a missing string.
    //
    // BOTH SPELLINGS ON EVERY PLATFORM, rather than one per `cfg`. They are the same
    // application on two engines, an allowlist entry costs nothing, and a `cfg` here would be a
    // build that is correct on the machine it was compiled on and silently wrong the day
    // WebView2 or WKWebView changes which one it sends. The development origins are NOT added:
    // a packaged app has no Vite, and the smallest list that works is the one to ship.
    env.insert(
        "JAROKU_ALLOWED_ORIGINS".into(),
        "tauri://localhost,http://tauri.localhost".into(),
    );

    // Packaged. The payload under `~/.jaroku/app` is rewritten by every upgrade, so nothing a
    // user would mind losing may live inside it — see payload.rs on why extraction never deletes.
    // The database and the three signing keys are exactly that kind of thing, and each already
    // has a documented variable pointing at it.
    if let Some(home) = paths::jaroku_home() {
        let keys = home.join("keys");
        let _ = std::fs::create_dir_all(&keys);
        env.insert("JAROKU_DB".into(), home.join("jaroku.db").to_string_lossy().into());
        // Not a per-launch key. `server/src/storage/presign.ts` persists it deliberately: a key
        // minted per process signs object URLs that verify on one run of the app and nowhere
        // else, so every link a previous session handed out would break on restart.
        env.insert("JAROKU_OBJECT_KEY_PATH".into(), keys.join("objectkey").to_string_lossy().into());
        env.insert("JAROKU_RUN_TOKEN_KEY_PATH".into(), keys.join("runtokenkey").to_string_lossy().into());
        // The local issuer's signing key. A desktop install has no OIDC provider configured, so
        // this is the issuer that signs the session — a real RS256 one, which is what makes the
        // packaged app exercise the same verification path a hosted deployment does rather than a
        // bypass that can silently drift.
        env.insert("JAROKU_DEV_AUTH_KEY".into(), keys.join("devauth.json").to_string_lossy().into());
    }
    env
}
