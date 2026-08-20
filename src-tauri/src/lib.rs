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

mod deeplink;
mod marker;
mod paths;
mod payload;
mod ports;
mod python;
mod sidecar;
mod window;

use std::collections::HashMap;
use std::path::PathBuf;

use tauri::{Manager, RunEvent};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![marker::first_launch_state, deeplink::drain_deep_links])
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

            // 1b — THE `jaroku://` SCHEME, before the window rather than after it. A URL that
            // STARTED this application is delivered during startup, and the queue that catches
            // one has to exist before anything can hand it over. See deeplink.rs on the three
            // states an application can be in when a link arrives.
            deeplink::init(&app.handle());

            // 2 — THE WINDOW, BEFORE THE BACKEND, and the ordering is the whole reason step 3
            // is asynchronous. A first launch has a payload to extract, which is a hundred
            // megabytes of copying; extracting it before the window existed would mean staring
            // at nothing for several seconds with no way to tell a slow launch from a hung one.
            // Opened first, the client's own connecting state does the explaining — a state this
            // product already has, already renders and already recovers from.
            //
            // The window is built here rather than declared in `tauri.conf.json` for a narrow
            // and load-bearing reason: a window in the configuration is created before `setup`
            // runs, and an initialisation script can only be attached at creation. That script is
            // how the resolved port reaches the bundle BEFORE its first module evaluates — see
            // window.rs, and client/src/lib/hostConfig.ts for the side that reads it.
            window::open(&app.handle(), port)?;

            // 3 — EXTRACT, THEN START. Not on the main thread: `payload::ensure` is file I/O
            // measured in a hundred megabytes on the launch after an install or an upgrade, and
            // on every other launch it is one file read and returns immediately.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let prepared = tauri::async_runtime::spawn_blocking({
                    let handle = handle.clone();
                    move || payload::ensure(&handle)
                })
                .await;

                let app_dir = match prepared {
                    Ok(Ok(Some(dir))) => dir,
                    // Development: nothing was extracted because nothing needed to be, and the
                    // working tree is what runs.
                    Ok(Ok(None)) => repo_dir(),
                    Ok(Err(err)) => return eprintln!("[jaroku] {err}"),
                    Err(err) => return eprintln!("[jaroku] the extraction task failed: {err}"),
                };

                // The environment the backend and everything it spawns will see. Assembled once,
                // here, so the variables the sidecar starts with are the same ones the Python
                // warm-up below runs against — two assemblies would be two chances to configure
                // uv one way for a run and another way for the environment that run needs.
                let mut env = environment(port);
                env.extend(python::environment());

                if let Err(err) = tauri::async_runtime::spawn_blocking({
                    let handle = handle.clone();
                    move || python::ensure(&handle)
                })
                .await
                .unwrap_or_else(|e| Err(format!("the Python extraction task failed: {e}")))
                {
                    // Reported and carried on, not fatal. Everything except running an agent
                    // works without Python, and the surface that would have to explain a refusal
                    // is the one a refusal would prevent from opening.
                    eprintln!("[jaroku] {err}");
                }

                // NOT a panic, and not a dialog. A shell that killed itself over a backend that
                // would not start would be taking down the only surface capable of explaining
                // the problem.
                let launch = sidecar::Launch { app_dir: app_dir.clone(), env: env.clone() };
                if let Err(err) = sidecar::start(&handle, launch) {
                    eprintln!("[jaroku] {err}");
                }

                // THE MARKER, once the runtime is on disk and the checkpoint directory has been
                // proved writable. Before the warm-up rather than after it, because the venv is
                // rebuildable from what was just extracted and its absence costs a slow first run
                // rather than a broken install — see marker.rs on what the file claims.
                if let Err(err) = marker::mark(&handle, &app_dir) {
                    eprintln!("[jaroku] this machine is not fully set up: {err}");
                }

                // LAST, AND DELIBERATELY AFTER THE BACKEND. Building the virtualenv is the slow
                // half of a first launch and the only half nothing needs immediately: `uv run`
                // syncs the environment itself before it runs anything, so a run started while
                // this is still going pays the build inside the run rather than failing.
                tauri::async_runtime::spawn_blocking(move || python::warm(&app_dir, &env));
            });

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

/// The repository this binary was compiled in, which is what a development run uses as its
/// `app_dir`.
///
/// THE DEVELOPMENT ANSWER IS THE POINT. Under `npm run tauri:dev` the server that runs is the
/// working tree: an edit restarts it through tsx exactly as it would in a terminal, generated
/// agents land in the `runtime/agents/` the developer can open, and the database is
/// `server/jaroku.db` with everything already in it. A development mode that ran a copy would be
/// a second environment to keep in sync, and the first bug it hid would be one that only
/// reproduces in the one nobody can attach a debugger to.
///
/// `CARGO_MANIFEST_DIR` is a compile-time constant naming `src-tauri/`, so its parent is the
/// repository root. It is read only on the development branch, where the binary and the source
/// tree are the same checkout by definition.
fn repo_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().map(PathBuf::from).unwrap_or_default()
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
