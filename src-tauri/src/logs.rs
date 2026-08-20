// A log file, because a packaged application has no stdout to print to.
//
// THE BUG THIS MODULE EXISTS FOR. Every diagnostic this crate emitted went through `eprintln!`,
// and `sidecar.rs` forwarded the whole of the Node backend's stdout and stderr the same way, with
// a comment about how half of Jaroku's operational documentation is about reading those lines. In
// a terminal that is true. In the build people actually run it is not: `main.rs` sets
// `windows_subsystem = "windows"` for release, which means a packaged Windows app has NO CONSOLE,
// and Rust's standard library treats a write to a null standard handle as a successful write of
// every byte — so the lines were not lost loudly, they were discarded silently. macOS is the same
// story by a different route: a `.app` launched from Finder has its standard streams on
// /dev/null. So a backend that could not bind its port, could not find its payload or died on
// boot produced exactly what a healthy one did, which from the window is indistinguishable from a
// hang. That is the "it just freezes and there is nothing to look at" case, and this file is the
// whole of the answer to it.
//
// SO EVERY LINE GOES TWO PLACES. `~/.jaroku/logs/desktop.log`, always, which is the copy that
// survives a packaged launch; and standard error, which is where a developer running
// `npm run tauri:dev` already looks and must keep finding them. Neither is a fallback for the
// other — a developer with a terminal still wants the file when they come back to a launch that
// went wrong an hour ago.
//
// NOTHING HERE MAY EVER FAIL LOUDLY. A logger that can panic is a logger that turns a diagnostic
// into an outage, and this one runs on the startup path of an application whose whole problem was
// startup. Every error is dropped: a full disk, a read-only home, a file somebody has open with a
// lock on it. The `eprintln!` half still happens, and the application still starts.
//
// WHAT IS AND IS NOT WRITTEN. `say` is the record: the shell's decisions, the backend's own
// output, every failure. It is unconditional, because the questions this log is asked are always
// asked after the fact. `detail` is the verbose half added to find intermittent races — the port
// probe's answer per port, every supervision transition, the exact argument vector — and it is
// OFF in a release build unless `JAROKU_DESKTOP_DEBUG` is set. On in a debug build, where the
// person reading it is the person who caused it.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use crate::clock;
use crate::paths;

/// The environment variable that turns the verbose half on in a release build.
///
/// READ AND NEVER SET, which is why this is not a variable the wrapper is inventing for the
/// server: nothing downstream sees it, `sidecar.rs` does not put it in the child's environment,
/// and `test:desktop-contract`'s rule — every variable the shell SETS is one the server reads —
/// is untouched by a variable the shell only reads.
const DEBUG_ENV: &str = "JAROKU_DESKTOP_DEBUG";

/// How large the log may get before it is rolled aside. Two files of this at most, so the ceiling
/// on what this costs a user's disk is sixteen megabytes and is not a function of how long they
/// leave the application open.
const MAX_BYTES: u64 = 8 * 1024 * 1024;

/// The open file, or `None` when this machine would not give us one. Behind a mutex because the
/// supervisor's task, the extraction task and the main thread all write.
static SINK: OnceLock<Mutex<Option<File>>> = OnceLock::new();

/// Whether the verbose half is recorded. Resolved once — an environment variable that changed
/// under a running process would make one launch's log two different logs.
static VERBOSE: OnceLock<bool> = OnceLock::new();

/// `~/.jaroku/logs/desktop.log`, or `None` on a machine that will not say where home is.
///
/// Beside the database and the keys rather than inside `app/`, for the same reason they are:
/// `app/` is rewritten wholesale by every upgrade, and a log an upgrade deletes is a log that is
/// empty in precisely the situation — "it broke after I updated" — it exists for.
pub fn path() -> Option<PathBuf> {
    paths::jaroku_home().map(|home| home.join("logs").join("desktop.log"))
}

/// Open the log, rolling the previous one aside when it has grown past its ceiling.
///
/// Called once, first thing in `setup`, before anything that could want to say something. A
/// second call is harmless and does nothing: the sink is a `OnceLock`.
pub fn init() {
    SINK.get_or_init(|| Mutex::new(open()));
    say(format!(
        "jaroku {} starting - {} build, verbose {}, log at {}",
        env!("CARGO_PKG_VERSION"),
        if tauri::is_dev() { "development" } else { "packaged" },
        if verbose() { "on" } else { "off" },
        path().map(|p| p.display().to_string()).unwrap_or_else(|| "nowhere".into()),
    ));
}

fn open() -> Option<File> {
    let path = path()?;
    let parent = path.parent()?;
    fs::create_dir_all(parent).ok()?;

    // ROLLED RATHER THAN TRUNCATED. A launch that goes wrong is very often the launch after one
    // that went wrong, and truncating on open would delete the evidence at the exact moment
    // somebody went looking for it. One backup: `desktop.log.1` is replaced, never accumulated,
    // because a directory of numbered logs is a feature with a retention policy and this is a
    // file somebody attaches to a bug report.
    if fs::metadata(&path).map(|m| m.len() >= MAX_BYTES).unwrap_or(false) {
        let _ = fs::rename(&path, path.with_extension("log.1"));
    }
    OpenOptions::new().create(true).append(true).open(&path).ok()
}

/// Whether the verbose half is being recorded.
pub fn verbose() -> bool {
    *VERBOSE.get_or_init(|| {
        // A debug build is somebody standing in front of the application on purpose. A release
        // build is somebody using it, and gets the record without the commentary unless they ask.
        cfg!(debug_assertions)
            || std::env::var_os(DEBUG_ENV).is_some_and(|v| !v.is_empty() && v != "0")
    })
}

/// Record a line. Always, in every build.
pub fn say(line: impl AsRef<str>) {
    write_line("jaroku", line.as_ref());
}

/// Record a line only when the verbose half is on. See the header on what belongs here.
pub fn detail(line: impl AsRef<str>) {
    if verbose() {
        write_line("debug", line.as_ref());
    }
}

/// Record a line that came from somewhere else, verbatim, under its own tag.
///
/// The backend's own output arrives here. It is NOT reformatted, because the boot line naming the
/// database, the object store and the workspace is a line this project's documentation quotes,
/// and a log that paraphrased it would be a log somebody could not search for what they were told
/// to search for. The tag and the timestamp go in front; everything after them is the source's.
pub fn from(tag: &str, line: &str) {
    // The plugin hands over one line at a time, and whether the terminator comes with it is an
    // implementation detail of a crate this one does not own. Trimmed and re-added, so the file
    // holds exactly one newline per line either way.
    let text = line.trim_end_matches(['\r', '\n']);
    if text.is_empty() {
        return;
    }
    write_line(tag, text);
}

fn write_line(tag: &str, line: &str) {
    let text = format!("{} [{tag}] {line}", clock::stamp());

    // Standard error first, because in development it is the one somebody is watching and a lock
    // on the file must not be able to delay it. Discarded by the operating system in a packaged
    // build, which is the whole reason the lines below exist.
    eprintln!("{text}");

    let Some(sink) = SINK.get() else { return };
    let Ok(mut guard) = sink.lock() else { return };
    let Some(file) = guard.as_mut() else { return };
    // Both results dropped deliberately. See the header: nothing in this module is allowed to
    // turn a diagnostic into a failure.
    let _ = writeln!(file, "{text}");
    let _ = file.flush();
}

/// Where the log is, for a surface that offers to show it. `None` on a machine with no home.
///
/// A command rather than a value injected into the page, for the reason `first_launch_state` is
/// one: the answer depends on the machine rather than on the build, and a page told at load time
/// would be a page holding a path nothing ever checked.
#[tauri::command]
pub fn log_path() -> Option<String> {
    path().map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_log_sits_beside_the_database_rather_than_inside_the_payload() {
        let Some(path) = path() else { return }; // A machine with no home says so elsewhere.
        let Some(home) = paths::jaroku_home() else { return };
        assert!(path.starts_with(&home), "{}", path.display());
        assert!(
            !path.starts_with(home.join("app")),
            "the payload directory is rewritten by every upgrade, which would delete the log \
             covering the upgrade",
        );
    }

    #[test]
    fn the_backup_replaces_rather_than_accumulates() {
        // `with_extension("log.1")` on `desktop.log` has to produce `desktop.log.1` and not
        // `desktop.log.1.1` or `desktop.1`. One backup is the whole retention policy, and the
        // arithmetic that makes it one is this call.
        let rolled = PathBuf::from("/tmp/desktop.log").with_extension("log.1");
        assert_eq!(rolled.file_name().unwrap(), "desktop.log.1");
    }
}
