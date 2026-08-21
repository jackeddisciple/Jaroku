// What this machine still needs before Jaroku can run anything, said out loud while it happens.
//
// THE SHELL ALREADY DID ALL OF THIS. Extracting the payload, extracting the Python runtime,
// building the virtualenv and proving the checkpoint directory writable have been the first
// thirty seconds of a packaged launch since the wrapper shipped. What they have never had is an
// AUDIENCE: every one of them ran inside a spawned task, wrote to a log the user does not know
// exists, and reached the page as the one fact `status.rs` was written to fix — a socket that had
// not opened yet. So a first launch was a window with a spinner in it for half a minute, and a
// first launch that FAILED was the same window with the same spinner forever.
//
// So this is the step model, and it is deliberately not a percentage. §2.1's screen names four
// things in order and marks each one done, in-flight or pending, because "installing runtime
// dependencies" is a sentence somebody can act on and "43%" is not. The four are the
// specification's own, mapped onto what this shell actually does:
//
//   storage       `~/.jaroku` exists and the application payload is extracted into it.
//   python        the bundled interpreter is on disk AND STARTS — proved by running it, not by
//                 finding the file, because a half-extracted interpreter is a file that exists.
//   dependencies  `uv sync --frozen` against the pinned lock. The one step that may need network.
//   checkpoints   the SQLite checkpoint directory exists and accepts a write.
//
// WHY THE MARKER MOVED. It used to be written after the Python extraction and before the venv was
// built, on the reasoning that a venv is rebuildable and its absence costs a slow first run rather
// than a broken install. That reasoning is sound and it is not what §2.2 asks for: "The marker
// file is NOT written on incomplete first-run. User must complete first-run to proceed." A marker
// written over a failed dependency install is a machine that never shows the screen that could
// explain itself again — which is precisely the failure this whole module exists to end. So the
// marker is written HERE, once, after all four steps have actually succeeded.
//
// AND THE BACKEND STILL STARTS IN THE MIDDLE OF IT, unchanged. `lib.rs` starts the sidecar as soon
// as the Python environment variables are settled, which is after step 2 and before step 3 — so
// the slow step runs against a backend that is already listening, and somebody who reaches the
// sign-in screen is not waiting on a virtualenv to talk to a server. Nothing about that ordering
// changed; what changed is that the steps around it now say what they are.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::{logs, marker, paths, python, window};

/// The event the page listens for. Colon-separated for the reason `deeplink::EVENT` is: it must
/// never be mistaken for one of the `jaroku.*` browser-storage keys `test:reset` audits by prefix.
pub const EVENT: &str = "jaroku:first-run";

/// The four steps, in the order §2.1 draws them. Spelled here and asserted against the client's
/// own list by `test:desktop-contract` — a step renamed on one side of that seam is a row that
/// silently never leaves "pending", which looks exactly like a launch that hung.
pub const STEPS: [(&str, &str); 4] = [
    ("storage", "App storage"),
    ("python", "Python runtime"),
    ("dependencies", "Runtime dependencies"),
    ("checkpoints", "Checkpoint database"),
];

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum State {
    /// Not started. The static `○` in §2.1's screen.
    Pending,
    /// Happening now. The one row carrying `stream-pulse`, and there is never more than one.
    Running,
    /// Finished. The static `✓`.
    Done,
    /// Finished badly. `message` on the progress below says which step and why.
    Failed,
}

#[derive(Serialize, Clone)]
pub struct Step {
    pub id: &'static str,
    pub label: &'static str,
    pub state: State,
    /// One short line under the row while it is happening or after it failed — the interpreter's
    /// version, the package uv is currently unpacking, the reason it stopped. Never a stack trace:
    /// this is a line on a screen, and the whole story is in the log the failure screen offers.
    pub detail: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct Progress {
    /// Whether the page should show any of this AT ALL.
    ///
    /// FALSE ON EVERY LAUNCH AFTER THE FIRST, decided once from the marker file before any step
    /// runs — not from whether the steps happen to be complete right now. The steps still run on
    /// every launch (an upgrade re-extracts, `uv sync` re-syncs), and a page that rendered them
    /// because they were briefly in flight would show a returning user a setup screen for a
    /// machine that was set up months ago.
    pub required: bool,
    pub steps: Vec<Step>,
    /// True once all four have succeeded AND the marker is on disk. §2.1's screen 3.
    pub complete: bool,
    /// The failure, when there is one. One sentence, safe to render.
    pub message: Option<String>,
    /// Whether the failure looks like an absent network rather than a broken machine.
    ///
    /// A SEPARATE FLAG RATHER THAN A MESSAGE THE CLIENT MATCHES ON, because §2.2 asks for a
    /// different screen — "You're offline", a retry, and no scary error text — and a client
    /// deciding that by reading substrings out of uv's stderr would be a client that shows the
    /// wrong screen the day uv rewords itself.
    pub offline: bool,
    /// Where the whole story is, for the failure screen's "Get help". Offered, never printed.
    #[serde(rename = "logPath")]
    pub log_path: Option<String>,
}

impl Progress {
    fn fresh(required: bool) -> Self {
        Progress {
            required,
            steps: STEPS
                .iter()
                .map(|(id, label)| Step { id, label, state: State::Pending, detail: None })
                .collect(),
            complete: false,
            message: None,
            offline: false,
            log_path: logs::path().map(|p| p.to_string_lossy().into_owned()),
        }
    }
}

/// The last thing said, so a page that mounts afterwards can be told it.
///
/// The same shape `status::Latest` takes and for the same reason: this settles during startup,
/// which is before React has mounted anything, so a page that only subscribed would miss the
/// whole sequence on precisely the launches it exists for.
pub struct Latest(Mutex<Progress>);

/// What one run of the sequence needs. Assembled by `lib.rs`, handed here, and kept so a retry
/// can run the same sequence again without `lib.rs` having to hold it.
#[derive(Clone)]
pub struct Inputs {
    pub app_dir: PathBuf,
    pub env: HashMap<String, String>,
}

pub struct Held(Mutex<Option<Inputs>>);

pub fn init(app: &AppHandle) {
    // READ ONCE, HERE, BEFORE ANYTHING RUNS. See `Progress::required`.
    let required = !marker::first_launch_state().initialized;
    app.manage(Latest(Mutex::new(Progress::fresh(required))));
    app.manage(Held(Mutex::new(None)));
    if required {
        logs::say("this machine has not been set up yet — running first-run");
    }
}

/// Record and emit. Every mutation of the progress goes through here, so the log and the page can
/// never disagree about what happened.
fn publish(app: &AppHandle, mutate: impl FnOnce(&mut Progress)) {
    let Some(latest) = app.try_state::<Latest>() else { return };
    let snapshot = {
        let Ok(mut slot) = latest.0.lock() else { return };
        mutate(&mut slot);
        slot.clone()
    };
    let _ = app.emit(EVENT, snapshot);
}

fn set(app: &AppHandle, id: &str, state: State, detail: Option<String>) {
    publish(app, |p| {
        if let Some(step) = p.steps.iter_mut().find(|s| s.id == id) {
            step.state = state;
            // A detail is REPLACED ONLY BY ANOTHER ONE. `uv` goes quiet for whole seconds between
            // lines, and clearing the row every time nothing new arrived would make the screen
            // flicker between "unpacking langgraph" and nothing at all.
            if detail.is_some() {
                step.detail = detail;
            }
        }
    });
}

fn fail(app: &AppHandle, id: &str, message: impl Into<String>, offline: bool) {
    let message = message.into();
    logs::say(format!("first-run step {id} failed: {message}"));
    set(app, id, State::Failed, Some(message.clone()));
    publish(app, |p| {
        p.message = Some(message);
        p.offline = offline;
        p.complete = false;
    });
}

/// Whether a failure from `uv` reads as an absent network rather than a broken machine.
///
/// A HEURISTIC, AND IT IS ONE ON PURPOSE. There is no way to ask uv "was that the network"; what
/// there is, is its own vocabulary for the case. Getting it wrong in either direction costs a
/// wrong sentence on a screen that offers Retry either way — which is the right size of
/// consequence for a guess, and a great deal better than showing somebody on a train a stack
/// trace about SSL handshakes.
fn looks_offline(output: &str) -> bool {
    let text = output.to_ascii_lowercase();
    [
        "failed to fetch",
        "no such host",
        "dns error",
        "network",
        "connection refused",
        "connection reset",
        "timed out",
        "temporary failure in name resolution",
        "could not resolve",
        "offline",
        "os error 11001", // Windows: WSAHOST_NOT_FOUND, which is what an unplugged cable looks like
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

/// Run the four steps, then write the marker if every one of them succeeded.
///
/// BLOCKING, and called from a blocking task. Every step here is process spawning and file I/O
/// measured in tens of megabytes; making it async would buy nothing and would put a several-second
/// `uv sync` on the runtime's cooperative scheduler.
///
/// Returns whether the machine is now set up. `lib.rs` ignores it — the page is the audience — and
/// the retry command below uses it to decide what to say in the log.
pub fn run(app: &AppHandle, inputs: &Inputs) -> bool {
    // STEP 1 IS ALREADY DONE BY THE TIME THIS IS CALLED, and saying so rather than re-doing it is
    // the honest shape. `lib.rs` extracts the payload before it can know where `app_dir` is, and
    // `app_dir` is what every step below needs — so the sequence cannot start before that
    // finished. What is checked here is the half `payload::ensure` does not: that `~/.jaroku`
    // itself exists and is the directory everything else is about to be written into.
    set(app, "storage", State::Running, None);
    match ensure_home() {
        Ok(home) => set(app, "storage", State::Done, Some(home.to_string_lossy().into_owned())),
        Err(err) => {
            // §2.1: "Cannot fail unless the disk is unwritable — surface as a hard error."
            fail(app, "storage", err, false);
            return false;
        }
    }

    set(app, "python", State::Running, None);
    match python::probe(&inputs.env) {
        Ok(Some(version)) => set(app, "python", State::Done, Some(format!("Python {version} detected"))),
        // No bundled runtime in this build, and no uv on the machine's own PATH either. NOT a
        // failure of first-run: the product's whole surface except running an agent works without
        // it, and a machine held at a setup screen over a feature it has not reached yet is a
        // machine nobody can sign into. Said, and moved past.
        Ok(None) => set(app, "python", State::Done, Some("using the toolchain on this machine".into())),
        Err(err) => {
            fail(app, "python", err, false);
            return false;
        }
    }

    set(app, "dependencies", State::Running, None);
    match python::sync(&inputs.app_dir, &inputs.env, &mut |line| {
        set(app, "dependencies", State::Running, Some(line.to_owned()));
    }) {
        Ok(()) => set(app, "dependencies", State::Done, Some("the pinned environment is ready".into())),
        Err(err) => {
            // §2.2's whole point: this is the one step that may need the network, and an absent
            // network is not an error worth frightening anybody with.
            let offline = looks_offline(&err);
            fail(
                app,
                "dependencies",
                if offline { "this step needs the internet, and there is none right now".to_string() } else { err },
                offline,
            );
            return false;
        }
    }

    set(app, "checkpoints", State::Running, None);
    // The write-and-remove probe and the marker write, in that order, in one call — see marker.rs
    // on why a directory that exists and refuses writes is the case that passes `create_dir_all`
    // and fails everything after it.
    match marker::mark(app, &inputs.app_dir) {
        Ok(()) => set(app, "checkpoints", State::Done, None),
        Err(err) => {
            fail(app, "checkpoints", err, false);
            return false;
        }
    }

    publish(app, |p| {
        p.complete = true;
        p.message = None;
        p.offline = false;
    });
    logs::detail("first-run finished; this machine is set up");
    true
}

/// `~/.jaroku`, proved to exist and to accept a write.
///
/// The probe rather than `create_dir_all` alone, for marker.rs's reason one directory down: a home
/// on a network share that has gone away, a read-only profile and a full disk all let the create
/// succeed and fail everything afterwards, one debugging session at a time.
fn ensure_home() -> Result<PathBuf, String> {
    let home = paths::jaroku_home()
        .ok_or("this machine will not say where your home directory is, so Jaroku has nowhere to keep its files")?;
    std::fs::create_dir_all(&home).map_err(|e| format!("could not create {}: {e}", home.display()))?;
    let probe = home.join(".writable");
    std::fs::write(&probe, b"").map_err(|e| format!("{} is not writable: {e}", home.display()))?;
    let _ = std::fs::remove_file(&probe);
    Ok(home)
}

/// Keep what a retry would need. Called by `lib.rs` once the payload and the environment settle.
pub fn hold(app: &AppHandle, inputs: Inputs) {
    if let Some(held) = app.try_state::<Held>() {
        if let Ok(mut slot) = held.0.lock() {
            *slot = Some(inputs);
        }
    }
}

/// What the shell last said. For a page that was not there when it said it.
#[tauri::command]
pub fn first_run_progress(latest: tauri::State<'_, Latest>) -> Option<Progress> {
    latest.0.lock().ok().map(|p| p.clone())
}

/// Run the four steps again, from the top.
///
/// §2.3: "First-run must be atomic: either fully complete (marker written) or fully retry-able
/// from the start." Every step here is idempotent — an extraction that already matches its stamp
/// returns immediately, `uv sync` against a current environment is a no-op, and the marker is
/// rewritten rather than appended — so retrying from the top costs seconds on the steps that
/// already passed and is the only shape that can recover a machine that failed halfway.
///
/// Returns an error the page renders when there is nothing to retry WITH, which is the case where
/// the payload itself never extracted. That is a relaunch rather than a retry, and saying so is
/// better than a button that silently does nothing.
#[tauri::command]
pub async fn retry_first_run(app: AppHandle) -> Result<(), String> {
    let Some(inputs) = app.try_state::<Held>().and_then(|h| h.0.lock().ok().and_then(|s| s.clone())) else {
        return Err("this launch never got far enough to retry — quit Jaroku and open it again".into());
    };
    logs::say("retrying first-run");
    // Reset to pending before anything runs, so the screen visibly starts over rather than
    // appearing to resume from wherever it broke.
    publish(&app, |p| {
        for step in &mut p.steps {
            step.state = State::Pending;
            step.detail = None;
        }
        p.message = None;
        p.offline = false;
        p.complete = false;
    });
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run(&handle, &inputs);
    })
    .await
    .map_err(|e| format!("the retry task failed: {e}"))
}

/// Close the application, from §2.3's third button.
///
/// A COMMAND RATHER THAN `window.close()`, because tray.rs makes the close button HIDE the window
/// so a run in flight is not cancelled — which is right everywhere except here, where the person
/// pressing Quit has been told the app cannot set itself up and hiding it would leave a tray icon
/// as the only evidence anything is running.
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    logs::say("quitting at the user's request from the first-run screen");
    app.exit(0);
}

/// Bring the main window forward. `window::focus_existing`'s one caller from the page.
///
/// Here rather than in window.rs because the case it exists for is this screen's: a first launch
/// where somebody clicked a magic link in a browser while the setup screen was still going, so the
/// app has a callback queued and needs to be the thing in front of them when it is spent.
#[tauri::command]
pub fn focus_window(app: AppHandle) {
    window::focus_existing(&app);
}

/// Whether the whole sequence has already been done on this machine. Used by nothing in Rust; it
/// is the parameter `lib.rs` passes to decide how loud to be about a failure on a launch where
/// there is nothing on screen waiting for one.
pub fn required(app: &AppHandle) -> bool {
    app.try_state::<Latest>()
        .and_then(|l| l.0.lock().ok().map(|p| p.required))
        .unwrap_or(false)
}

/// Where the payload extracted to, for the log line that names it.
pub fn describe(dir: &Path) -> String {
    dir.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_four_steps_are_the_four_the_specification_draws() {
        // Spelled as literals rather than read from STEPS, so the suite fails if somebody edits
        // the constant — which would be editing what the first-run screen claims to have done.
        let ids: Vec<&str> = STEPS.iter().map(|(id, _)| *id).collect();
        assert_eq!(ids, vec!["storage", "python", "dependencies", "checkpoints"]);
    }

    #[test]
    fn an_absent_network_is_told_apart_from_a_broken_machine() {
        // The vocabulary uv and the platform actually use. Each of these is a first-run that must
        // show "You're offline" and a retry, never a stack trace about SSL handshakes.
        assert!(looks_offline("error: Failed to fetch: `https://pypi.org/simple/langgraph/`"));
        assert!(looks_offline("failed to lookup address information: Temporary failure in name resolution"));
        assert!(looks_offline("Caused by: tcp connect error: Connection refused (os error 111)"));
        assert!(looks_offline("os error 11001"), "the Windows spelling of an unresolvable host");
    }

    #[test]
    fn a_real_failure_is_not_dressed_up_as_an_absent_network() {
        // The other direction, which costs more when it is wrong: telling somebody with a full
        // disk or a corrupted lock file that they are offline sends them to reset their router.
        assert!(!looks_offline("error: No space left on device (os error 28)"));
        assert!(!looks_offline("error: The lockfile at `uv.lock` needs to be updated"));
        assert!(!looks_offline("Permission denied (os error 13)"));
        assert!(!looks_offline(""));
    }
}
