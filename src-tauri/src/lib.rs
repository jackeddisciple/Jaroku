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

mod clock;
mod deeplink;
mod logs;
mod marker;
mod menu;
mod paths;
mod payload;
mod ports;
mod python;
mod secrets;
mod sidecar;
mod tray;
mod tree;
mod updater;
mod window;

use std::collections::HashMap;
use std::path::PathBuf;

use tauri::{Manager, RunEvent};

pub fn run() {
    let builder = tauri::Builder::default()
        // SINGLE INSTANCE, AND IT MUST BE THE FIRST PLUGIN REGISTERED. Tauri says so, and the
        // reason is that its whole job happens before the rest of the application exists: a
        // second launch has to be detected and handed off while there is still time to exit
        // quietly rather than after a window, a webview and a second Node backend have been
        // built. That last one is the real cost here — this is not a tidiness feature. Two
        // instances would mean two supervisors racing for port 4317, the loser walking up the
        // scan to 4318, and two servers writing to one SQLite database from two processes.
        //
        // The callback runs in the ORIGINAL process, with the second one's argv. All it does is
        // bring the window forward: a `jaroku://` URL in that argv — which is how Windows and
        // Linux deliver a link to an application that was not running — is handed to the
        // deep-link plugin by this plugin's own `deep-link` feature, so there is nothing to parse
        // here and nothing to keep in step with deeplink.rs.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            window::focus_existing(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        // WINDOW GEOMETRY ACROSS LAUNCHES, and the flag list is the whole of the decision.
        //
        // POSITION, SIZE and MAXIMIZED are what somebody arranges on purpose: a Jaroku window is
        // three columns of trace, conversation and graph, and the width somebody chose for that
        // is a preference rather than an accident. Restoring it is the difference between an
        // application and a window that opens wherever it likes every morning.
        //
        // VISIBLE IS DELIBERATELY NOT IN THE LIST, and leaving it in would be a launch bug rather
        // than a preference. tray.rs makes the close button HIDE the window so a run in flight is
        // not cancelled — so "hidden" is the state this application is in every time somebody
        // closes it, and a plugin that restored visibility would faithfully reopen Jaroku
        // invisible, with a tray icon as the only evidence it had started at all. The two
        // features are one design and this is where they meet.
        //
        // DECORATIONS and FULLSCREEN are out for a smaller reason: neither is something a user
        // sets here, and a remembered fullscreen is the state that is hardest to get out of if it
        // was entered by accident.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            marker::first_launch_state,
            logs::log_path,
            deeplink::drain_deep_links,
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_delete,
        ]);

    // OFF BY DEFAULT AND BUILT ON PURPOSE. The updater needs a signing key pair to build at all —
    // the public half in the configuration, the private half signing each release — and this
    // repository has neither and must never hold the second. `--features updater` together with
    // `--config src-tauri/tauri.updater.conf.json` is what turns it on; see updater.rs.
    //
    // It REPLACES the handler above rather than adding to it, because a builder takes one. That
    // is why `with_updater` restates the six names.
    with_updater(builder)
        .setup(|app| {
            // 0 — THE LOG, BEFORE ANYTHING THAT COULD HAVE SOMETHING TO SAY.
            //
            // This is step zero rather than step one because every step below it can fail, and
            // until this line runs a failure has nowhere to go. A packaged build has no console:
            // `main.rs` asks for the windows subsystem on Windows, a `.app` launched from Finder
            // has its streams on /dev/null, and Rust's standard library reports a write to a
            // handle that does not exist as a successful write. So for the whole of this
            // wrapper's life every `eprintln!` in it — and the entire output of the Node backend
            // it forwards — was discarded in exactly the build where somebody needed it. See
            // logs.rs.
            logs::init();

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

            // 1a — THE MENU BAR, which exists on macOS and nowhere else. Before the window,
            // because on macOS the menu belongs to the APPLICATION rather than to a window and
            // is what a user sees at the top of the screen for the moment before one appears.
            // See menu.rs on why the Edit menu is load-bearing rather than conventional.
            #[cfg(target_os = "macos")]
            menu::install(app.handle())?;

            // 1b — THE `jaroku://` SCHEME, before the window rather than after it. A URL that
            // STARTED this application is delivered during startup, and the queue that catches
            // one has to exist before anything can hand it over. See deeplink.rs on the three
            // states an application can be in when a link arrives.
            deeplink::init(app.handle());

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
            window::open(app.handle(), port)?;
            logs::detail("the window is open and has been told the port");

            // 2a — THE TRAY, immediately after the window it controls. Whether the close button
            // hides or quits is decided by whether this succeeded: a window hidden with nothing
            // to bring it back is worse than a run cancelled by a quit. See tray.rs.
            if tray::install(app.handle()).unwrap_or(false) {
                tray::hide_on_close(app.handle());
                logs::detail("the tray is up, so the close button hides rather than quits");
            }

            // 3 — EXTRACT, THEN START. Not on the main thread: `payload::ensure` is file I/O
            // measured in a hundred megabytes on the launch after an install or an upgrade, and
            // on every other launch it is one file read and returns immediately.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // THE STARTUP CLOCK. Every line below carries how long it has been since the
                // window appeared, which is the number that makes an intermittent hang legible:
                // the same launch on the same machine either extracts in two seconds or takes
                // forty on a synced folder, and the difference between "slow" and "stuck" is not
                // visible in a sequence of untimed lines.
                let began = std::time::Instant::now();
                logs::detail("extracting the payload");
                let prepared = tauri::async_runtime::spawn_blocking({
                    let handle = handle.clone();
                    move || payload::ensure(&handle)
                })
                .await;
                logs::detail(format!("the payload is ready after {:?}", began.elapsed()));

                let app_dir = match prepared {
                    Ok(Ok(Some(dir))) => dir,
                    // Development: nothing was extracted because nothing needed to be, and the
                    // working tree is what runs.
                    Ok(Ok(None)) => repo_dir(),
                    Ok(Err(err)) => return logs::say(err),
                    Err(err) => return logs::say(format!("the extraction task failed: {err}")),
                };

                // The environment the backend and everything it spawns will see. Assembled once,
                // here, so the variables the sidecar starts with are the same ones the Python
                // warm-up below runs against — two assemblies would be two chances to configure
                // uv one way for a run and another way for the environment that run needs.
                let mut env = environment();
                env.extend(python::environment());
                // NAMES, NEVER VALUES, which is the same rule the server's own log sink follows —
                // this environment carries the paths to three signing keys, and a log somebody
                // attaches to a bug report is a log that leaves the machine.
                logs::detail(format!(
                    "the backend's environment: {}",
                    {
                        let mut names: Vec<&str> = env.keys().map(String::as_str).collect();
                        names.sort_unstable();
                        names.join(", ")
                    }
                ));

                logs::detail("extracting the Python runtime");
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
                    logs::say(err);
                }
                logs::detail(format!("the Python runtime is ready after {:?}", began.elapsed()));

                // NOT a panic, and not a dialog. A shell that killed itself over a backend that
                // would not start would be taking down the only surface capable of explaining
                // the problem.
                let launch = sidecar::Launch { app_dir: app_dir.clone(), env: env.clone() };
                if let Err(err) = sidecar::start(&handle, launch) {
                    logs::say(err);
                }

                // THE MARKER, once the runtime is on disk and the checkpoint directory has been
                // proved writable. Before the warm-up rather than after it, because the venv is
                // rebuildable from what was just extracted and its absence costs a slow first run
                // rather than a broken install — see marker.rs on what the file claims.
                if let Err(err) = marker::mark(&handle, &app_dir) {
                    logs::say(format!("this machine is not fully set up: {err}"));
                }

                // Whether a newer version exists, asked once and thirty seconds from now — see
                // updater.rs on why it waits rather than racing the extraction and the backend
                // for the same disk and network a first launch needs.
                #[cfg(feature = "updater")]
                updater::check_on_launch(&handle);

                logs::detail(format!("startup finished after {:?}", began.elapsed()));

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

/// The updater, folded in only when it was built.
///
/// A REBINDING RATHER THAN A `#[cfg]` INSIDE THE CHAIN, and that is not style. `generate_handler!`
/// takes a list of paths and a conditional attribute inside it is not something the macro is
/// specified to accept, and a `#[cfg]` block used as the tail expression of a `.plugin({ … })`
/// argument is two statements where one value is needed. Both of those are compile errors in the
/// configuration nobody builds by default, which is the worst place to put one — so the whole
/// registration moves here, where each branch is an ordinary expression.
///
/// The command list is spelled twice as a result. That is the cost, it is six names, and the
/// duplication is visible in one function rather than hidden in a macro.
#[cfg(feature = "updater")]
fn with_updater(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.plugin(tauri_plugin_updater::Builder::new().build()).invoke_handler(tauri::generate_handler![
        marker::first_launch_state,
        logs::log_path,
        deeplink::drain_deep_links,
        secrets::secret_get,
        secrets::secret_set,
        secrets::secret_delete,
        updater::check_for_update,
        updater::install_update,
    ])
}

#[cfg(not(feature = "updater"))]
fn with_updater(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
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
/// IN DEVELOPMENT NOTHING BUT THE PORT IS SET. The developer's `server/jaroku.db`,
/// `server/.objectkey` and `runtime/.env` are the ones `npm run dev` uses, and pointing the app at
/// a private copy of each would mean the two ways of starting the same server disagreed about what
/// data exists.
///
/// `JAROKU_PORT` IS NOT HERE, AND IT USED TO BE. It is the one variable that is not settled once:
/// `sidecar.rs` re-resolves it before every start attempt, so it is layered on at spawn time from
/// the one place that knows the current answer. A copy in this map would be the copy that goes
/// stale the first time a restart has to move.
fn environment() -> HashMap<String, String> {
    let mut env = HashMap::new();
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
    // ALL THREE SPELLINGS, and the third one is here because its absence shipped a build that
    // could not be signed into.
    //
    // WKWebView serves the app from `tauri://localhost`. WebView2 cannot use a custom scheme and
    // serves it from `tauri.localhost` over **https** — `http` only when a build opts into
    // `dangerousUseHttpScheme`, which this one does not. The first version of this line carried
    // the custom scheme and the http variant, which is every spelling except the one Windows
    // actually uses.
    //
    // WHAT THAT LOOKED LIKE, because it is worth writing down: nothing errored. The request
    // reached the server and was answered 200 — an origin that is not on the list is not refused,
    // it is answered without an `access-control-allow-origin`, and the BROWSER drops the response.
    // So `localIssuerAvailable()` saw a rejected fetch, its `catch` returned false, and the
    // sign-in screen rendered its "this server uses an external identity provider" branch, which
    // has no form in it. A packaged app that opened, looked right, and could not be signed into,
    // with a clean server log underneath it.
    //
    // Listed rather than `cfg`-ed per platform for the same reason as before: an entry costs
    // nothing, and a `cfg` is a build that is correct on the machine it was compiled on and
    // silently wrong the day an engine changes which one it sends. Which is precisely what this
    // comment is about.
    env.insert(
        "JAROKU_ALLOWED_ORIGINS".into(),
        "tauri://localhost,https://tauri.localhost,http://tauri.localhost".into(),
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
