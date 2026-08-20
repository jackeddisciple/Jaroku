// The first-launch marker: `~/.jaroku/app-initialized`, or `%APPDATA%\jaroku\app-initialized`.
//
// WHAT IT MEANS, PRECISELY, because a marker that means something vague is a marker whose absence
// nobody can act on. It is written only after BOTH of these have actually happened on this
// machine, at this version:
//
//   1. the bundled Python runtime is extracted — uv, the interpreter and the wheel cache are on
//      disk where python.rs points at them;
//   2. the checkpoint directory exists and can be written to.
//
// The second is checked by writing a file and removing it, rather than by calling `create_dir_all`
// and assuming. `runtime/.checkpoints` is where the SQLite checkpointer puts one database per run,
// which is what pause, resume and branching are — and a directory that exists and refuses writes
// (a read-only home, a full disk, a synced folder mid-conflict) is the case where creating it
// succeeds and everything afterwards fails one debug session at a time.
//
// WHAT IT DOES NOT MEAN. It says nothing about whether a person has been through onboarding —
// that is `users.onboarded_at` on the server, reported as `user.onboarded`, and the README already
// argues at length why it belongs to the account rather than to the machine. This marker is about
// the MACHINE: whether the things a first launch has to unpack are unpacked. The two questions
// look similar and have different right answers, and conflating them is how a returning user on a
// second device gets walked through a welcome screen for a product they use daily.
//
// THE FIRST-RUN SCREENS ARE NOT BUILT HERE, deliberately: they belong to the onboarding
// specification. What is here is the fact they will read, and a command to read it with.

use std::fs;
use std::path::Path;

use serde::Serialize;
use tauri::AppHandle;

use crate::{clock, paths};

/// What the marker holds, and what the command answers with.
///
/// A JSON object rather than an empty file. The empty file answers "has this machine been set up"
/// and nothing else; this also answers "at which version", which is the question asked during
/// every support conversation that starts with an upgrade — and it costs the same write.
#[derive(Serialize, Clone, Default)]
pub struct Initialised {
    /// Whether the marker is present AND readable. False covers both "never launched" and "the
    /// marker is there but is not something this version understands".
    pub initialized: bool,
    /// The app version that wrote it, when there is one.
    pub version: Option<String>,
    /// When, as an RFC-3339-ish UTC string from the system clock. Informational only: nothing
    /// branches on it, because a clock that has been wound back should not un-initialise an app.
    pub at: Option<String>,
}

fn read() -> Initialised {
    let Some(path) = paths::marker_file() else { return Initialised::default() };
    let Ok(text) = fs::read_to_string(&path) else { return Initialised::default() };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        // Present but unreadable. Reported as NOT initialised, so the next launch redoes the work
        // — which is idempotent — rather than trusting a file it cannot parse.
        return Initialised::default();
    };
    Initialised {
        initialized: true,
        version: value.get("version").and_then(|v| v.as_str()).map(str::to_owned),
        at: value.get("at").and_then(|v| v.as_str()).map(str::to_owned),
    }
}

/// Prove the checkpoint directory is usable, then write the marker.
///
/// Called after the Python runtime is extracted and before the marker means anything. Errors are
/// returned rather than logged here, so the caller decides how loud to be — and the caller carries
/// on, because everything except pausing and branching a run works without this.
pub fn mark(app: &AppHandle, app_dir: &Path) -> Result<(), String> {
    let checkpoints = app_dir.join("runtime").join(".checkpoints");
    fs::create_dir_all(&checkpoints).map_err(|e| format!("could not create {}: {e}", checkpoints.display()))?;

    // The write-and-remove probe. See the header: a directory that exists and refuses writes is
    // the case that passes `create_dir_all` and fails everything after it.
    let probe = checkpoints.join(".writable");
    fs::write(&probe, b"").map_err(|e| format!("{} is not writable: {e}", checkpoints.display()))?;
    let _ = fs::remove_file(&probe);

    let path = paths::marker_file().ok_or("no home directory, so the marker has nowhere to go")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    let body = serde_json::json!({
        "version": app.package_info().version.to_string(),
        "at": clock::now(),
    });
    fs::write(&path, format!("{body}\n")).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// Whether this machine has been set up, for the onboarding specification to read.
///
/// A command rather than something injected into the page like the backend's port, because unlike
/// the port this is a fact that CHANGES during a session: a first launch answers false and then
/// true a few seconds later, and a value frozen onto `window` at page load would be the first of
/// those forever.
#[tauri::command]
pub fn first_launch_state() -> Initialised {
    read()
}
