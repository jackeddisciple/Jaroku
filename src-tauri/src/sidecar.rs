// The Node backend, as a supervised child of the desktop shell.
//
// WHAT IS SPAWNED IS WHAT `npm run dev` SPAWNS. `server/package.json`'s dev script is
// `tsx src/index.ts`, and that is exactly what the argument vector below says — the same tsx, the
// same entry file, the same `runtime/` beside the same `server/`. There is no packaged or bundled
// or transpiled second copy of the server, because a second copy is a thing that behaves
// differently on the day it matters and nobody can reproduce in a terminal.
//
// The one thing this adds is ENVIRONMENT, and every variable it sets is one `server/src/index.ts`
// already reads and documents. That is the whole shape of the adaptation: the wrapper configures
// Jaroku through the interface Jaroku already exposes, and Jaroku does not learn that it is
// inside a desktop app.
//
// CRASH RECOVERY. A backend that exits when nobody asked it to is restarted, three times, with a
// growing wait between attempts. The budget RESETS once a start has stayed up for a while — see
// HEALTHY_AFTER — because "three restarts ever" would spend the whole allowance on three crashes
// in a fortnight and leave a user who has had the app open for a week with a dead backend and no
// second chance. What is deliberately NOT here is an unbounded restart loop: a backend that
// cannot bind, cannot open its database or cannot parse its own environment fails identically
// every time, and a loop around it is a busy wait that hides the error it should be surfacing.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// The sidecar's name in `tauri.conf.json`'s `bundle.externalBin`. Tauri appends the target
/// triple to it on disk; this is the name without one.
const SIDECAR: &str = "jaroku-node";

/// How many consecutive failed starts before the shell gives up and says so.
const MAX_RESTARTS: u32 = 3;

/// The waits between those attempts. Three entries for three restarts, growing, and short enough
/// that a transient port collision is invisible to somebody watching the window.
const BACKOFF: [Duration; MAX_RESTARTS as usize] =
    [Duration::from_millis(500), Duration::from_secs(2), Duration::from_secs(8)];

/// How long a start has to survive before the restart budget is handed back. Longer than the
/// server's own boot — database open, migrations, the object store, the first sweep — so a
/// backend that dies during boot never looks healthy on the way past.
const HEALTHY_AFTER: Duration = Duration::from_secs(60);

/// How long a shutdown waits for the backend to drain before it stops asking politely.
///
/// The server's SIGINT/SIGTERM handler drains its trace-ingest chain with its own two-second
/// ceiling and then exits: events already read off a run's stdout are events the user watched
/// happen, and closing the database out from under the last few loses the end of a trace that
/// visibly ran. Three seconds is that two plus room for the exit itself.
const DRAIN_GRACE: Duration = Duration::from_secs(3);

pub struct Backend {
    child: Mutex<Option<CommandChild>>,
    /// Set before a deliberate stop, and read by the supervisor to tell "we quit it" from "it
    /// died". Without this every clean shutdown would look like a crash and be restarted into
    /// the closing application.
    stopping: AtomicBool,
    port: AtomicU16,
}

impl Backend {
    pub fn new(port: u16) -> Self {
        Self { child: Mutex::new(None), stopping: AtomicBool::new(false), port: AtomicU16::new(port) }
    }

    /// The port the backend was told to listen on. Read by the webview's runtime configuration
    /// and by anything that needs to talk to it, so there is one answer rather than two defaults.
    pub fn port(&self) -> u16 {
        self.port.load(Ordering::SeqCst)
    }

    pub fn set_port(&self, port: u16) {
        self.port.store(port, Ordering::SeqCst);
    }
}

/// Everything the backend needs to know, assembled once and re-used by every restart.
#[derive(Clone)]
pub struct Launch {
    /// The directory holding `server/` and `runtime/` as siblings.
    ///
    /// IN DEVELOPMENT THIS IS THE REPOSITORY ITSELF, which is what makes `npm run tauri:dev` an
    /// actual development loop: the server that runs is the working tree, an edit to it restarts
    /// through tsx exactly as it would in a terminal, and generated agents land in the
    /// `runtime/agents/` the developer can look at. In a packaged app it is the extracted payload
    /// under `~/.jaroku/app`, for the reason payload.rs gives at length.
    pub app_dir: PathBuf,
    /// Variables layered over the inherited environment. Every one is documented in the README's
    /// configuration table; none is invented here.
    pub env: HashMap<String, String>,
}

impl Launch {
    fn tsx(&self) -> PathBuf {
        self.app_dir.join("server").join("node_modules").join("tsx").join("dist").join("cli.mjs")
    }

    fn entry(&self) -> PathBuf {
        self.app_dir.join("server").join("src").join("index.ts")
    }

    /// Whether the payload this launch points at is actually there.
    ///
    /// Checked before the first spawn rather than after it, because a missing tsx surfaces as
    /// Node's `Cannot find module` on stderr of a process that then exits 1 — which the
    /// supervisor would read as a crash and dutifully retry three times, turning one clear
    /// sentence into thirty seconds and three copies of a confusing one.
    pub fn missing(&self) -> Option<PathBuf> {
        [self.tsx(), self.entry()].into_iter().find(|p| !p.exists())
    }
}

/// Start the backend and keep it started. Returns once the first spawn has been attempted; the
/// supervision runs on the async runtime for the life of the application.
pub fn start(app: &AppHandle, launch: Launch) -> Result<(), String> {
    if let Some(missing) = launch.missing() {
        return Err(format!(
            "the Node backend is not where the desktop shell expected it: {} is missing",
            missing.display()
        ));
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move { supervise(handle, launch).await });
    Ok(())
}

async fn supervise(app: AppHandle, launch: Launch) {
    let mut failures: u32 = 0;

    loop {
        let started = Instant::now();
        match spawn_once(&app, &launch) {
            Err(err) => {
                // A spawn that never produced a process. Counted the same as a crash: the causes
                // overlap almost entirely (a missing binary, a directory that vanished, a machine
                // out of file handles) and splitting the budget in two would give a failing app
                // six attempts where the comment above promises three.
                eprintln!("[jaroku] the backend could not be started: {err}");
            }
            Ok(mut events) => {
                while let Some(event) = events.recv().await {
                    match event {
                        // The backend's own logging, forwarded rather than swallowed. `npm run
                        // dev` puts these lines in a terminal and half of Jaroku's operational
                        // documentation is about reading them — the boot line naming the
                        // database, the object store, the run sandbox and the workspace this
                        // process acts in. An app that ate them would be strictly harder to
                        // support than the terminal it replaces.
                        CommandEvent::Stdout(line) => print!("{}", String::from_utf8_lossy(&line)),
                        CommandEvent::Stderr(line) => eprint!("{}", String::from_utf8_lossy(&line)),
                        CommandEvent::Error(err) => eprintln!("[jaroku] backend error: {err}"),
                        CommandEvent::Terminated(status) => {
                            app.state::<Backend>().child.lock().ok().and_then(|mut c| c.take());
                            eprintln!(
                                "[jaroku] the backend exited (code {:?}, signal {:?})",
                                status.code, status.signal
                            );
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }

        if app.state::<Backend>().stopping.load(Ordering::SeqCst) {
            return; // We asked it to stop. Restarting into a closing application is not recovery.
        }

        // The budget comes back once a start has proved it can stay up. See HEALTHY_AFTER.
        if started.elapsed() >= HEALTHY_AFTER {
            failures = 0;
        }

        if failures >= MAX_RESTARTS {
            eprintln!(
                "[jaroku] the backend has failed {MAX_RESTARTS} times in a row and will not be \
                 restarted again. The window stays open and will report itself disconnected, which \
                 is the truth; the reason is in the lines above this one."
            );
            return;
        }

        let wait = BACKOFF[failures as usize];
        failures += 1;
        eprintln!("[jaroku] restarting the backend in {:?} (attempt {failures} of {MAX_RESTARTS})", wait);
        tokio::time::sleep(wait).await;
    }
}

fn spawn_once(
    app: &AppHandle,
    launch: &Launch,
) -> Result<tauri::async_runtime::Receiver<CommandEvent>, String> {
    let command = app
        .shell()
        .sidecar(SIDECAR)
        .map_err(|e| e.to_string())?
        .current_dir(&launch.app_dir)
        .envs(launch.env.clone())
        .args([
            // tsx by path rather than by name. `npm run dev` reaches it through node_modules/.bin,
            // which is a shell shim this process has no shell to run — and on Windows that shim is
            // a .cmd file, which is the difference between a working spawn and ENOENT.
            launch.tsx().to_string_lossy().to_string(),
            launch.entry().to_string_lossy().to_string(),
        ]);

    let (events, child) = command.spawn().map_err(|e| e.to_string())?;
    if let Ok(mut slot) = app.state::<Backend>().child.lock() {
        *slot = Some(child);
    }
    Ok(events)
}

/// Ask the backend to stop, give it time to drain, and then insist.
///
/// THE TWO PLATFORMS DO NOT GET THE SAME TREATMENT, and the difference is recorded rather than
/// hidden. On Unix this sends SIGTERM, which is the signal `server/src/index.ts` installs a
/// handler for: pools stop, the ingest chain drains, the store closes, the process exits itself.
/// On Windows there is no equivalent — a console-less child cannot be sent a control event and
/// `TerminateProcess` is what any kill resolves to — so the drain does not run there, and the
/// consequence is that the last few events of a run that was in flight at the moment of quitting
/// can be lost. That is a real limitation, it is in docs/tauri.md, and it is not one this wrapper
/// can fix without adding a shutdown route to a server it is not allowed to change.
pub fn stop(app: &AppHandle) {
    let state = app.state::<Backend>();
    state.stopping.store(true, Ordering::SeqCst);

    let child = match state.child.lock() {
        Ok(mut slot) => slot.take(),
        Err(_) => return,
    };
    let Some(child) = child else { return };

    #[cfg(unix)]
    {
        let pid = child.pid() as i32;
        // Safety: `kill` with a pid this process spawned and a signal number that is always
        // valid. The worst outcome of a stale pid is ESRCH, which is ignored below.
        let asked = unsafe { libc::kill(pid, libc::SIGTERM) } == 0;
        if asked {
            let deadline = Instant::now() + DRAIN_GRACE;
            while Instant::now() < deadline {
                // Signal 0 tests for existence without delivering anything. A process that has
                // exited answers ESRCH, which is the whole test.
                if unsafe { libc::kill(pid, 0) } != 0 {
                    return; // It drained and left on its own, which is the good path.
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }

    // Windows always, and Unix only when the polite request went unanswered.
    let _ = child.kill();
}
