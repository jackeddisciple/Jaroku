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
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::{logs, ports, tree};

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
///
/// `cfg(unix)` because there is nothing to wait for anywhere else. Windows has no SIGTERM for a
/// console-less child, so `stop` has nothing to ask politely and no grace period to observe —
/// and the compiler said so, as an unused-constant warning on the one platform where the
/// asymmetry this crate documents is not a comment but a missing code path.
#[cfg(unix)]
const DRAIN_GRACE: Duration = Duration::from_secs(3);

/// What the shell holds on to about the running backend.
///
/// THE PORT IS IN HERE NOW, AND AN EARLIER DRAFT WAS RIGHT TO ASK WHY. The argument for leaving
/// it out was that a third copy of one decision is a third thing that can disagree — the backend
/// reads it from `JAROKU_PORT`, the page reads it from the initialisation script, and a field
/// here would be a value nothing imports.
///
/// What that argument missed is that the port is not a decision taken once. `ports.rs` proves a
/// port free and then hands it to a process that binds it a moment later, and in that gap it can
/// be lost — and it WAS lost, routinely, to the backend the previous session left running. The
/// supervisor re-used the same number on all three restarts, so one lost race was three identical
/// failures and then a dead app. Re-resolving means the port can change between attempts, which
/// means there has to be somewhere it lives that both the next attempt and the page can read.
/// This is that place, it is the ONE authority, and the other two are told rather than asked.
pub struct Backend {
    child: Mutex<Option<CommandChild>>,
    /// Set before a deliberate stop, and read by the supervisor to tell "we quit it" from "it
    /// died". Without this every clean shutdown would look like a crash and be restarted into
    /// the closing application.
    stopping: AtomicBool,
    /// The port the backend is on, and therefore the port the page has been told about.
    port: AtomicU16,
}

impl Backend {
    pub fn new(port: u16) -> Self {
        Self { child: Mutex::new(None), stopping: AtomicBool::new(false), port: AtomicU16::new(port) }
    }

    /// The port in force. Read by `status.rs` when it tells the page where to connect.
    pub fn port(&self) -> u16 {
        self.port.load(Ordering::SeqCst)
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
    ///
    /// `JAROKU_PORT` IS DELIBERATELY NOT ONE OF THEM. It is added per attempt from `Backend`, for
    /// the reason that struct gives: a port baked in here is a port every restart re-uses, which
    /// is what turned one lost race into three identical failures.
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
        // THE PORT, RE-RESOLVED BEFORE EVERY ATTEMPT INCLUDING THE FIRST. `ports.rs` says the
        // window between proving a port free and a child binding it cannot be closed portably,
        // and that what makes losing that race survivable is one restart rather than a dead app.
        // This is where that stopped being a claim. `first_free` prefers the port already in
        // force, so the ordinary restart keeps the number the page was told and nothing else has
        // to happen; only a port that has genuinely been taken moves, and that move is announced.
        if !resolve_port(&app) {
            logs::say("there is no port for the backend to listen on");
        }
        match spawn_once(&app, &launch) {
            Err(err) => {
                // A spawn that never produced a process. Counted the same as a crash: the causes
                // overlap almost entirely (a missing binary, a directory that vanished, a machine
                // out of file handles) and splitting the budget in two would give a failing app
                // six attempts where the comment above promises three.
                logs::say(format!("the backend could not be started: {err}"));
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
                        //
                        // AND FOR MOST OF THIS WRAPPER'S LIFE IT DID EAT THEM. These two arms
                        // were `print!` and `eprint!`, which in the only build anybody installs
                        // write to a standard handle that does not exist — see logs.rs. So a
                        // backend that could not bind its port said so, three times, into
                        // nothing. The tags are `backend` and `backend!` so the two streams stay
                        // distinguishable in one file: Jaroku puts real errors on stderr and its
                        // ordinary boot narration on stdout, and losing that split would mean
                        // reading tone to find failures.
                        CommandEvent::Stdout(line) => logs::from("backend", &String::from_utf8_lossy(&line)),
                        CommandEvent::Stderr(line) => logs::from("backend!", &String::from_utf8_lossy(&line)),
                        CommandEvent::Error(err) => logs::say(format!("backend error: {err}")),
                        CommandEvent::Terminated(status) => {
                            // `let _ =` because the taken child is deliberately dropped here: the
                            // process is already gone, and what this line is for is emptying the
                            // slot so `stop` does not later try to signal a pid nobody owns.
                            let _ = app.state::<Backend>().child.lock().ok().and_then(|mut c| c.take());
                            logs::say(format!(
                                "the backend exited (code {:?}, signal {:?}) after {:?}",
                                status.code,
                                status.signal,
                                started.elapsed(),
                            ));
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
            logs::say(format!(
                "the backend has failed {MAX_RESTARTS} times in a row and will not be restarted \
                 again. The window stays open and will report itself disconnected, which is the \
                 truth; the reason is in the lines above this one."
            ));
            return;
        }

        // ANYTHING LEFT OF THE GENERATION THAT JUST DIED, ENDED BEFORE THE NEXT ONE IS STARTED.
        // The process the supervisor watches is tsx's launcher, and the launcher exiting does not
        // mean the server it spawned exited — a crash in the launcher, or a kill that only
        // reached it, leaves a backend holding the port the replacement is about to ask for. This
        // runs before the backoff rather than after it, so the wait is also the operating system's
        // chance to release the port.
        tree::terminate();

        let wait = BACKOFF[failures as usize];
        failures += 1;
        logs::say(format!("restarting the backend in {wait:?} (attempt {failures} of {MAX_RESTARTS})"));
        tokio::time::sleep(wait).await;
    }
}

/// Settle which port this attempt gets, and answer whether there is one at all.
///
/// PREFERRING THE PORT ALREADY IN FORCE is what makes this cheap and invisible on the ordinary
/// restart: a backend that crashed on a bug releases its port on the way out, so the probe finds
/// it free and nothing moves. The page's socket URL, the log lines somebody is reading and the
/// number in the README all stay the one they were.
fn resolve_port(app: &AppHandle) -> bool {
    let state = app.state::<Backend>();
    let current = state.port();
    let Some(resolved) = ports::first_free(current) else { return false };
    if resolved != current {
        // SAID OUT LOUD, because a moved port is the difference between "the backend is down" and
        // "the backend is one port up", and those look identical from a window that cannot
        // connect. `status.rs` carries the same fact to the page.
        logs::say(format!("the backend moves from port {current} to {resolved}"));
        state.port.store(resolved, Ordering::SeqCst);
    }
    true
}

fn spawn_once(
    app: &AppHandle,
    launch: &Launch,
) -> Result<tauri::async_runtime::Receiver<CommandEvent>, String> {
    // THE ONE VARIABLE THAT IS NOT IN `Launch.env`. Everything else about a launch is fixed for
    // the life of the application; the port is settled per attempt, so it is layered on here
    // rather than baked in there.
    let mut env = launch.env.clone();
    env.insert("JAROKU_PORT".into(), app.state::<Backend>().port().to_string());

    let command = app
        .shell()
        .sidecar(SIDECAR)
        .map_err(|e| e.to_string())?
        .current_dir(&launch.app_dir)
        .envs(env)
        .args([
            // tsx by path rather than by name. `npm run dev` reaches it through node_modules/.bin,
            // which is a shell shim this process has no shell to run — and on Windows that shim is
            // a .cmd file, which is the difference between a working spawn and ENOENT.
            launch.tsx().to_string_lossy().to_string(),
            launch.entry().to_string_lossy().to_string(),
        ]);

    let (events, child) = command.spawn().map_err(|e| e.to_string())?;
    // BOUND TO THIS APPLICATION BEFORE ANYTHING ELSE HAPPENS. The process just spawned is tsx's
    // launcher, not the server; the server is the child it is about to create. Adopting the
    // launcher now is what puts that child in the same group, which is what makes quitting — and
    // crashing — actually end the backend. See tree.rs.
    tree::adopt(child.pid());
    // THE ARGUMENT VECTOR AND THE PID, RECORDED. Two of the three failures a packaged build
    // actually has are visible in this one line: a payload extracted somewhere other than where
    // the launch points, and a port the backend was told to take that it cannot have. Neither is
    // deducible from "the window says disconnected".
    logs::detail(format!(
        "spawned the backend as pid {} in {} — {} {}",
        child.pid(),
        launch.app_dir.display(),
        launch.tsx().display(),
        launch.entry().display(),
    ));
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
/// It reaches the real server rather than tsx's launcher because tsx relays `SIGINT` and `SIGTERM`
/// to its child and escalates after five seconds — which is a fact about a dependency and is
/// therefore checked in `tsx/dist/cli.mjs` rather than believed.
///
/// On Windows there is no equivalent — a console-less child cannot be sent a control event and
/// `TerminateProcess` is what any kill resolves to — so the drain does not run there, and the
/// consequence is that the last few events of a run in flight at the moment of quitting can be
/// lost. That is a real limitation and it is in docs/tauri.md.
///
/// WHAT IS NEW HERE IS THAT IT NOW ENDS THE RIGHT PROCESS. `child` is tsx's launcher; the server
/// is its child, and killing the launcher used to leave the server running with the port bound
/// and the database open, which is how the next launch found 4317 taken. `tree::terminate` ends
/// the group instead — see tree.rs for why this is a job object rather than a walk of the process
/// table.
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
    // AND EVERYTHING IT SPAWNED. On Windows this is the line that actually ends the server; on
    // every other platform it is nothing at all, because the signal above reached it.
    tree::terminate();
}
