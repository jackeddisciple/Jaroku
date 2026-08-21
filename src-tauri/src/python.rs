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
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

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

/// Where the bundled uv is, or `None` when this build carries no runtime.
///
/// Split out because three things need it now rather than one: the version probe, the sync, and
/// the sync's own decision about whether there is anything to sync WITH. A fourth copy of
/// `install.join("bin").join(if cfg!(windows) { "uv.exe" } else { "uv" })` is a fourth place that
/// stops being true the day the layout moves.
fn uv_binary() -> Option<PathBuf> {
    let install = install_dir()?;
    let uv = install.join("bin").join(if cfg!(windows) { "uv.exe" } else { "uv" });
    uv.is_file().then_some(uv)
}

/// Which Python is going to run agents, proved by RUNNING IT.
///
/// §2.1's second step is "Python runtime detection", and the thing worth detecting is not that a
/// file is present. A half-extracted interpreter is a file that is present; a bundle interrupted
/// by a full disk leaves one, and so does an antivirus that quarantined a shared library out of
/// the middle of it. Both pass `is_file()` and both fail the first agent run with a message about
/// a missing DLL. So this spawns it and reads what it says.
///
/// THREE ANSWERS, AND THE MIDDLE ONE IS NOT A FAILURE:
///
///   `Ok(Some(version))`  a runtime is here and it starts. The string goes on the screen.
///   `Ok(None)`           this build carries none, and none was configured. Everything except
///                        running an agent works — which is the whole product up to and including
///                        signing in — so holding somebody at a setup screen over it would be
///                        refusing them a surface they have not reached yet. `ensure` already
///                        takes exactly this position and says so.
///   `Err(message)`       a runtime is here and it does NOT start. That is a broken install, it
///                        will not fix itself, and it is worth stopping for.
pub fn probe(env: &HashMap<String, String>) -> Result<Option<String>, String> {
    if tauri::is_dev() {
        // Development uses the developer's own toolchain, as `ensure` does and for its reason.
        return Ok(None);
    }
    let Some(uv) = uv_binary() else { return Ok(None) };

    // `uv python find` rather than `--version` on the interpreter directly, because the question
    // is which interpreter UV will choose — and `UV_MANAGED_PYTHON` plus `UV_PYTHON_INSTALL_DIR`
    // are what make that answer the bundled one. Asking the file we expect it to pick would prove
    // the file starts and prove nothing about the choice.
    let mut find = Command::new(&uv);
    find.args(["python", "find"]);
    for (key, value) in env {
        find.env(key, value);
    }
    let found = find
        .output()
        .map_err(|e| format!("the bundled uv would not start: {e}"))?;
    if !found.status.success() {
        let detail = String::from_utf8_lossy(&found.stderr);
        return Err(format!(
            "the bundled Python runtime is on this machine but uv cannot use it: {}",
            first_line(&detail).unwrap_or_else(|| format!("uv exited {}", found.status)),
        ));
    }
    let interpreter = String::from_utf8_lossy(&found.stdout).trim().to_owned();
    if interpreter.is_empty() {
        return Err("uv found no Python interpreter to run agents with".into());
    }

    // AND NOW ACTUALLY START IT. Everything above proves uv can name a file.
    let started = Command::new(&interpreter)
        .arg("--version")
        .output()
        .map_err(|e| format!("the bundled Python interpreter would not start: {e}"))?;
    if !started.status.success() {
        return Err(format!("the bundled Python interpreter exited {}", started.status));
    }
    // `python --version` writes to stdout on 3.4+ and to stderr before it; both are read because
    // the cost is one `or_else` and the alternative is a version that reads as empty on a runtime
    // somebody pinned deliberately.
    let spoken = String::from_utf8_lossy(&started.stdout);
    let fallback = String::from_utf8_lossy(&started.stderr);
    let text = if spoken.trim().is_empty() { fallback } else { spoken };
    Ok(Some(
        text.trim().trim_start_matches("Python").trim().to_owned(),
    ))
}

/// Build `~/.jaroku/venv` from the lock file, reporting each line uv writes.
///
/// AN OPTIMISATION RATHER THAN A PREREQUISITE, AND STILL ONE. `uv run` syncs the project
/// environment itself before it runs anything, so an agent started before this finishes still
/// works — it just pays the build inside the first run instead of before it, and uv's own lock on
/// the environment is what makes the two safe to overlap. What changed is who is told: §2.1 shows
/// this step on screen with uv's output under it, so a launch that sits here for twenty seconds is
/// visibly downloading `langgraph` rather than visibly stuck.
///
/// `on_line` IS CALLED FROM THIS THREAD, synchronously, as each line is read. That keeps the whole
/// function blocking and single-threaded, which is what the caller wants — it is already inside a
/// blocking task — and it means the screen's detail row is never ahead of or behind the process.
///
/// Returns the combined output on failure rather than a tidy message, because the caller has to
/// look at it: telling an offline first launch apart from a full disk is done by reading what uv
/// said, and a message this function had already summarised would have thrown that away.
pub fn sync(
    app_dir: &Path,
    env: &HashMap<String, String>,
    on_line: &mut dyn FnMut(&str),
) -> Result<(), String> {
    if tauri::is_dev() {
        return Ok(());
    }
    let runtime = app_dir.join("runtime");
    if !runtime.join("uv.lock").is_file() {
        // Nothing pinned to install. Same position as `probe`'s `Ok(None)`: not a failure, because
        // there is nothing here that could succeed.
        return Ok(());
    }
    let Some(uv) = uv_binary() else { return Ok(()) };

    // `--frozen`, so a launch can never silently re-resolve the lock file the release was built
    // and tested against. A resolution that differs from `uv.lock` is a different set of
    // dependencies than the one this build's Python was verified on, and doing that quietly on a
    // user's machine is how "it works on the release build" stops being a true sentence.
    let mut command = Command::new(uv);
    command
        .args(["sync", "--frozen"])
        .current_dir(&runtime)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in env {
        command.env(key, value);
    }

    let mut child = command.spawn().map_err(|e| format!("could not start uv: {e}"))?;
    // BOTH PIPES, AND STDERR IS THE ONE THAT MATTERS. uv writes its progress — "Resolved 84
    // packages", "Prepared 12 packages", "Installed langgraph" — to stderr, and its stdout is
    // usually empty. Reading only stdout would produce a screen that says a step is running and
    // never says anything else, which is the failure this whole module is about.
    //
    // Read serially rather than on two threads: stdout is drained first and is nearly always
    // empty and immediately closed, so there is no deadlock to arrange around, and one thread
    // keeps `on_line` free of any synchronisation it would otherwise need.
    let mut collected = String::new();
    if let Some(out) = child.stdout.take() {
        drain(out, on_line, &mut collected);
    }
    if let Some(err) = child.stderr.take() {
        drain(err, on_line, &mut collected);
    }

    match child.wait() {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => {
            logs::say(format!("preparing the Python environment exited {status}"));
            Err(if collected.trim().is_empty() {
                format!("preparing the Python environment exited {status}")
            } else {
                collected
            })
        }
        Err(err) => Err(format!("preparing the Python environment failed: {err}")),
    }
}

/// Read a pipe to its end, offering each non-empty line and keeping the whole of it.
///
/// The lines go to the screen and the whole goes to the caller, because the two are used for
/// different things: one line is what somebody reads while they wait, and the whole is what tells
/// an absent network apart from a full disk. Capped, because this string is held in memory and a
/// `uv sync` that has decided to narrate every wheel in a large lock file should not be able to
/// grow it without limit.
fn drain(pipe: impl std::io::Read, on_line: &mut dyn FnMut(&str), collected: &mut String) {
    const MAX: usize = 64 * 1024;
    for line in BufReader::new(pipe).lines().map_while(Result::ok) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if collected.len() < MAX {
            collected.push_str(trimmed);
            collected.push('\n');
        }
        on_line(trimmed);
    }
}

/// The first non-empty line of some output, for a message that goes on a screen.
fn first_line(text: &str) -> Option<String> {
    text.lines().map(str::trim).find(|l| !l.is_empty()).map(str::to_owned)
}
