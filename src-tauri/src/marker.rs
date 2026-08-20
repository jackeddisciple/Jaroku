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
use tauri::{AppHandle, Manager};

use crate::paths;

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
        "at": now(),
    });
    fs::write(&path, format!("{body}\n")).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// A UTC timestamp with no dependency on a date crate.
///
/// Seconds since the epoch turned into `YYYY-MM-DDTHH:MM:SSZ` by hand. That is more arithmetic
/// than a crate would need, and it is the whole of what the field is for — a line in a support
/// conversation. A dependency whose only reader is a string nothing parses is a dependency that
/// costs more than it carries.
fn now() -> String {
    format_at(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
    )
}

/// Split out from `now` so the arithmetic can be asserted against dates somebody can check by
/// eye, which is the only way a hand-written calendar is worth having.
fn format_at(secs: i64) -> String {
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (hour, minute, second) = (rest / 3600, (rest % 3600) / 60, rest % 60);

    // Civil-from-days, Howard Hinnant's algorithm, with the era shifted so 1970-01-01 is day 0.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{year:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}Z")
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

#[cfg(test)]
mod tests {
    use super::now;

    #[test]
    fn the_epoch_formats_as_the_day_unix_time_starts() {
        // Not a tautology: this is the one date where every term in the civil-from-days
        // arithmetic is at a boundary, which is where an off-by-one in the era shift shows up.
        assert_eq!(super::format_at(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn a_leap_day_is_the_leap_day_and_not_the_first_of_march() {
        assert_eq!(super::format_at(1_709_164_800), "2024-02-29T00:00:00Z");
    }

    #[test]
    fn the_clock_is_read_rather_than_hardcoded() {
        assert!(now().ends_with('Z') && now().len() == 20);
    }
}
