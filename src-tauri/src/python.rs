// The Python runtime, extracted and pointed at.
//
// WHAT JAROKU ACTUALLY DOES, which is the constraint everything here is shaped by:
// `server/src/processManager.ts` runs `spawn("uv", ["run", "python", "-m", "jaroku_runner", id])`
// with `cwd` set to `runtime/`, and `sandbox/codeCheck.ts` spawns the same binary for the import
// check and for graph introspection. Both find uv on `PATH`, and both already prepend
// `/opt/homebrew/bin` to it because uv lives in Homebrew's bin and a GUI process does not inherit
// a shell's rc.
//
// SO THE INJECTION POINT IS `PATH`, AND THERE IS NOTHING TO CHANGE IN THE SERVER. The
// specification for this work assumed the backend takes a configurable path to Python; it does
// not, and it does not need to — putting the bundled uv first on `PATH` makes every existing
// spawn resolve to it, on all three platforms, with no line of server code aware that anything
// is different. That is a better answer than the one the specification imagined, and it is the
// one that satisfies its actual rule: the wrap adapts to Jaroku.
//
// THE FOUR `UV_*` VARIABLES BESIDE IT are what stop uv reaching for the user's machine:
//
//   UV_PYTHON_INSTALL_DIR   the interpreter that shipped with the app, rather than one uv would
//                           download on first use
//   UV_MANAGED_PYTHON       and only that one — without it uv is entitled to satisfy
//                           `requires-python = ">=3.12"` from whatever Python happens to be on
//                           PATH, which is precisely the external dependency this bundle exists
//                           to remove
//   UV_CACHE_DIR            the wheels for everything `runtime/uv.lock` pins, so building the
//                           environment needs no network
//   UV_PROJECT_ENVIRONMENT  `~/.jaroku/venv`, which is where the specification asks for it and
//                           which is deliberately NOT `runtime/.venv` — that directory lives
//                           inside the payload, and the payload is rewritten by every upgrade
//
// It is deliberately NOT `UV_OFFLINE`. The cache makes the ordinary first launch need no
// network; forcing offline would turn "this wheel is not cached" — a connector extra somebody
// installs later, a lock file that moved — from a download into a refusal, and would make the
// bundle's convenience into a restriction.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::{AppHandle, Manager};

use crate::{logs, paths, payload};

const STAMP: &str = "python.json";

fn staged(app: &AppHandle) -> Option<PathBuf> {
    let root = app.path().resource_dir().ok()?;
    // Both candidates, for the reason payload.rs gives: `bundle.resources` puts the tree in
    // different places depending on which of its two accepted shapes was used.
    [root.join("resources").join("python"), root.join("python")]
        .into_iter()
        .find(|dir| dir.join(STAMP).is_file())
}

/// Where the extracted runtime lives. A sibling of `venv` rather than inside it: the venv is
/// disposable and can be rebuilt from these three directories, and putting the inputs inside the
/// output would make deleting a broken environment delete the means of repairing it.
fn install_dir() -> Option<PathBuf> {
    paths::jaroku_home().map(|home| home.join("python"))
}

/// Extract the bundled uv, interpreter and wheel cache.
///
/// Runs before the backend is started rather than after, even though it is the slower of the
/// two: `PATH` has to be valid by the time anything can ask for a run, and a window that came up
/// and then failed its first run with "uv: not found" would be a worse launch than one that took
/// a few more seconds to appear.
pub fn ensure(app: &AppHandle) -> Result<(), String> {
    if tauri::is_dev() {
        // Development uses the developer's own uv, exactly as `npm run dev` does. A desktop shell
        // that quietly substituted a bundled interpreter would mean the environment a developer
        // debugs an agent in is not the environment they built it in.
        return Ok(());
    }
    let Some(from) = staged(app) else {
        // Not fatal, and not silent. A build assembled without `npm run tauri:python` still runs
        // the whole product for anybody who has uv installed, which is every developer — so this
        // says what is missing and carries on rather than refusing to start.
        logs::say("this build carries no Python runtime; agent runs will need uv on PATH");
        return Ok(());
    };
    let to = install_dir().ok_or("no home directory, so there is nowhere to extract the Python runtime")?;

    if payload::same_stamp(&from, &to, STAMP) {
        return Ok(());
    }
    std::fs::create_dir_all(&to).map_err(|e| format!("could not create {}: {e}", to.display()))?;
    let _ = std::fs::remove_file(to.join(STAMP));
    payload::mirror(&from, &to).map_err(|e| format!("could not extract the Python runtime: {e}"))?;
    Ok(())
}

/// The variables that make every existing `spawn("uv", …)` in the server resolve to the bundled
/// one. Empty in development, where the developer's own toolchain is the right one.
pub fn environment() -> HashMap<String, String> {
    let mut env = HashMap::new();
    if tauri::is_dev() {
        return env;
    }
    // `paths::venv_dir()` rather than `home.join("venv")`. The compiler found this: `venv_dir`
    // was written, exported and never called, which meant the venv's location existed in two
    // places — and two places that compute one path are two places that can disagree about it
    // after somebody moves it in one of them.
    let (Some(install), Some(venv)) = (install_dir(), paths::venv_dir()) else {
        return env;
    };

    // PREPENDED, never replacing. A user's own PATH is how a generated agent's tool finds `git`,
    // `psql` or anything else it shells out to, and a desktop app that emptied it would break
    // agents that work in a terminal. First is enough: it decides which uv wins and changes
    // nothing else.
    let separator = if cfg!(windows) { ";" } else { ":" };
    let existing = std::env::var("PATH").unwrap_or_default();
    let bin = install.join("bin");

    // AND ON WINDOWS THERE IS A SACRIFICIAL ENTRY IN FRONT OF IT, which is not a trick for its
    // own sake and is the smallest correct thing this crate can do about a bug in the code it
    // wraps.
    //
    // `processManager.ts` and `sandbox/codeCheck.ts` both spawn uv with
    // `PATH: \`/opt/homebrew/bin:${process.env.PATH ?? ""}\``. That is right on macOS, where uv
    // lives in Homebrew's bin and `:` is the separator. On Windows the separator is `;`, so the
    // template does not prepend an entry — it GLUES `/opt/homebrew/bin:` onto the front of
    // whatever the first entry happens to be, and the first entry is the one this function just
    // put there. `C:\…\jaroku\python\bin` becomes `/opt/homebrew/bin:C:\…\jaroku\python\bin`,
    // which is not a directory, and the bundled toolchain is gone from the search.
    //
    // Measured rather than reasoned about: spawning `uv` with the PATH this function returns
    // resolves the bundled binary; spawning it with the PATH `processManager.ts` builds from that
    // same value answers ENOENT. What saved the machine this was found on is that it had uv
    // installed anyway, further down the user's own PATH — so the bundle silently ran the
    // machine's toolchain, which is the exact external dependency the bundle exists to remove,
    // and on a machine without uv a run fails outright.
    //
    // THE REAL FIX IS TWO LINES OF SERVER CODE and it is not this crate's to make; it is written
    // up in docs/tauri-stabilization-report.md. What is here is the wrapper adapting, which is
    // the rule this whole wrapper works under: an entry that exists only to absorb the glue, so
    // the entry after it — the one that matters — survives intact. `install` itself is used for
    // it because it is a real directory containing no executables, so the sacrificial entry is
    // inert whichever way it is read.
    let path = if cfg!(windows) {
        format!("{}{separator}{}{separator}{existing}", install.display(), bin.display())
    } else {
        format!("{}{separator}{existing}", bin.display())
    };
    env.insert("PATH".into(), path);

    env.insert("UV_PYTHON_INSTALL_DIR".into(), install.join("interpreters").to_string_lossy().into());
    env.insert("UV_CACHE_DIR".into(), install.join("cache").to_string_lossy().into());
    env.insert("UV_MANAGED_PYTHON".into(), "1".into());
    env.insert("UV_PROJECT_ENVIRONMENT".into(), venv.to_string_lossy().into());
    env
}

/// Build `~/.jaroku/venv` from the lock file, once.
///
/// AN OPTIMISATION RATHER THAN A PREREQUISITE, which is why it runs after the backend is already
/// up and why its failure is reported and not acted on. `uv run` syncs the project environment
/// itself before it runs anything, so an agent started before this finishes still works — it just
/// pays the build inside the first run instead of before it, and uv's own lock on the environment
/// is what makes the two safe to overlap. Doing it here means the pause lands on a launch nobody
/// is watching rather than on the first trace somebody is.
pub fn warm(app_dir: &Path, env: &HashMap<String, String>) {
    if tauri::is_dev() {
        return;
    }
    let runtime = app_dir.join("runtime");
    if !runtime.join("uv.lock").is_file() {
        return;
    }
    let Some(install) = install_dir() else { return };
    let uv = install.join("bin").join(if cfg!(windows) { "uv.exe" } else { "uv" });
    if !uv.is_file() {
        return;
    }

    // `--frozen`, so a launch can never silently re-resolve the lock file the release was built
    // and tested against. A resolution that differs from `uv.lock` is a different set of
    // dependencies than the one this build's Python was verified on, and doing that quietly on a
    // user's machine is how "it works on the release build" stops being a true sentence.
    let mut command = Command::new(uv);
    command.args(["sync", "--frozen"]).current_dir(&runtime);
    for (key, value) in env {
        command.env(key, value);
    }
    match command.status() {
        Ok(status) if status.success() => {}
        Ok(status) => logs::say(format!("preparing the Python environment exited {status}")),
        Err(err) => logs::say(format!("preparing the Python environment failed: {err}")),
    }
}
