// Running the server's Python on this machine: an agent's code checks, and its runs.
//
// THE BACKEND THE SHIPPED APP TALKS TO HAS NO PYTHON, AND IS NOT MEANT TO. `jaroku-api` is a
// multi-tenant control plane holding a database, a KMS key and every workspace's secrets, and the
// code a generation produces is model-written — so "no generated code executes on the control
// plane" is a rule, not a gap. Until this module the consequence was that nothing executed
// anywhere: a generation was written and then failed its own import check with `spawn uv ENOENT`,
// and Run, the Graph tab and evals could not start at all.
//
// SO THE CODE RUNS HERE, on the machine of the person who asked for it, with the uv, CPython and
// pinned dependencies this bundle already carries. The server stays the orchestrator — it decides
// what to check or run, holds the run's row and its trace, and hands one execution to the app that
// asked — and this module is the hands. A run's trace does not come back through here at all: the
// runner pushes it to the server over HTTPS with a run-scoped token (`jaroku_runner/
// controlplane_http.py`), exactly as a hosted sandbox would, so a socket blip does not lose steps.
//
// WHAT THE PAGE MAY ASK FOR IS NARROW ON PURPOSE. The program is always the bundled `uv run python`
// in the extracted runtime — never another binary — and the first argument must be `-m` or `-c`.
// The environment is cleared and rebuilt from an allowlist, so nothing this app inherited (in
// development, a developer's whole shell, API keys included) reaches a run unasked. Files are
// written only under this execution's own directory, by relative paths with no `..` in them.
//
// THE TREE DIES TOGETHER. `uv run` starts Python as a child, and a run may start more; each
// execution gets its own process group (a job-object-free `taskkill /T` on Windows), so Stop, a
// timeout and quitting the app end all of it rather than the launcher alone.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::{logs, paths, payload, python};

/// What a running execution says, and how it ends.
pub const EVENT: &str = "jaroku:exec";
/// The host's readiness changed. The page re-reports it to the server.
pub const HOST_EVENT: &str = "jaroku:exec-host";

/// The protocol this shell speaks. The server refuses to hand an execution to an app that reports
/// an older one, with a sentence saying to update — see `server/src/sandbox/desktopExec.ts`.
pub const PROTOCOL: u32 = 1;

/// The most either stream may produce before the execution is killed. Matches the server's own
/// ceiling for a code check (`codeCheck.ts`'s MAX_OUTPUT_BYTES): `print("x" * 10**10)` is one of
/// the cases its escape suite names, and a page holding gigabytes of it is a hung window.
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
/// A generated project is source, not data. 32 MB decoded is room for a large one many times over.
const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;
const MAX_FILES: usize = 4000;
/// No execution outlives this, whatever it asked for. An eval's run has its own deadline below it.
const MAX_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);
/// How many executions may be in flight at once: a fan-out of runs plus the checks around them.
const MAX_RUNNING: usize = 24;
/// Replaced, in arguments and environment values, by this execution's own directory — where the
/// files it was given were written. The server cannot know a path on this machine, so it says this.
const EXEC_DIR_TOKEN: &str = "{{EXEC_DIR}}";
/// How long a run's local checkpoints are kept before a launch sweeps them.
const CHECKPOINT_RETENTION: Duration = Duration::from_secs(30 * 24 * 60 * 60);

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExecFile {
    path: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    b64: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExecRequest {
    exec_id: String,
    /// Arguments to `python`, starting with `-m` or `-c`.
    args: Vec<String>,
    #[serde(default)]
    env: HashMap<String, String>,
    #[serde(default)]
    stdin: Option<String>,
    timeout_ms: u64,
    #[serde(default)]
    files: Vec<ExecFile>,
    /// `stderr` for a run, whose stdout is the trace the runner already pushed over HTTP.
    #[serde(default)]
    capture: Option<String>,
}

/// One piece of output, or the end.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExecEvent {
    exec_id: String,
    /// `stdout` or `stderr`, with `chunk`. Absent on the final event.
    stream: Option<&'static str>,
    chunk: Option<String>,
    done: bool,
    code: Option<i32>,
    timed_out: bool,
    truncated: bool,
    /// The execution could not be started, or was stopped. Never a traceback — those are output.
    error: Option<String>,
}

/// Whether this machine can execute anything right now, as the page reports it to the server.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExecHost {
    protocol: u32,
    /// `ready`, `preparing`, `failed` or `unavailable`.
    state: &'static str,
    detail: Option<String>,
}

#[derive(Clone, Debug)]
enum Readiness {
    /// This shell supervises its own backend, which runs code itself.
    Unavailable,
    Preparing(Option<String>),
    Ready { runtime: PathBuf },
    Failed(String),
}

static READINESS: Mutex<Readiness> = Mutex::new(Readiness::Unavailable);
/// Held while a preparation is running, so a retry cannot start a second one beside it.
static PREPARING: Mutex<()> = Mutex::new(());

struct Running {
    exec_id: String,
    child: Arc<Mutex<Child>>,
    /// Set by `exec_stop`: when to escalate from a polite signal to SIGKILL.
    stop_at: Arc<Mutex<Option<Instant>>>,
}

static RUNNING: Mutex<Vec<Running>> = Mutex::new(Vec::new());

fn host_of(readiness: &Readiness) -> ExecHost {
    let (state, detail) = match readiness {
        Readiness::Unavailable => ("unavailable", Some("this app runs its own backend".to_string())),
        Readiness::Preparing(d) => ("preparing", d.clone()),
        Readiness::Ready { .. } => ("ready", None),
        Readiness::Failed(d) => ("failed", Some(d.clone())),
    };
    ExecHost { protocol: PROTOCOL, state, detail }
}

fn set_readiness(app: &AppHandle, next: Readiness) {
    if let Ok(mut r) = READINESS.lock() {
        *r = next.clone();
    }
    let _ = app.emit(HOST_EVENT, host_of(&next));
}

/// What the page reports to the server about this machine.
#[tauri::command]
pub fn exec_host() -> ExecHost {
    let readiness = READINESS.lock().map(|r| r.clone()).unwrap_or(Readiness::Unavailable);
    host_of(&readiness)
}

/// Make this machine able to run Python for a REMOTE backend: the payload's `runtime/`, the bundled
/// CPython, and the pinned environment. The same three steps a local backend's first run takes,
/// without the setup screen — a thin client is usable long before an agent is first run, and the
/// one surface that needs Python says so itself while this is still going.
pub fn prepare(app: &AppHandle) {
    let Ok(_guard) = PREPARING.try_lock() else { return };
    set_readiness(app, Readiness::Preparing(Some("extracting the runtime".into())));
    let began = Instant::now();

    let app_dir = match payload::ensure(app) {
        Ok(Some(dir)) => dir,
        Ok(None) => repo_dir(),
        Err(err) => {
            logs::say(format!("exec: could not extract the runtime: {err}"));
            set_readiness(app, Readiness::Failed(err));
            return;
        }
    };
    set_readiness(app, Readiness::Preparing(Some("unpacking Python".into())));
    if let Err(err) = python::ensure(app) {
        logs::say(format!("exec: could not unpack Python: {err}"));
        set_readiness(app, Readiness::Failed(err));
        return;
    }
    set_readiness(app, Readiness::Preparing(Some("installing the pinned dependencies".into())));
    let env = python::environment();
    let mut last = Instant::now();
    let synced = python::sync(&app_dir, &env, &mut |line| {
        // uv is chatty; the page does not need every package name, only proof of life.
        if last.elapsed() > Duration::from_millis(500) {
            last = Instant::now();
            set_readiness(app, Readiness::Preparing(Some(line.chars().take(160).collect())));
        }
    });
    if let Err(err) = synced {
        let offline = err.contains("dns") || err.contains("network") || err.contains("connect");
        let message = if offline {
            "installing Python dependencies needs the internet the first time, and there is none right now".to_string()
        } else {
            err.chars().take(600).collect()
        };
        logs::say(format!("exec: the Python environment could not be prepared: {message}"));
        set_readiness(app, Readiness::Failed(message));
        return;
    }
    sweep_stale();
    logs::detail(format!("exec: this machine can run agents ({:?})", began.elapsed()));
    set_readiness(app, Readiness::Ready { runtime: app_dir.join("runtime") });
}

/// Start one execution. Returns once it is running; its output and its end arrive as events.
#[tauri::command]
pub async fn exec_start(app: AppHandle, request: ExecRequest) -> Result<(), String> {
    let runtime = match READINESS.lock().map(|r| r.clone()).unwrap_or(Readiness::Unavailable) {
        Readiness::Ready { runtime } => runtime,
        Readiness::Preparing(detail) => {
            return Err(format!(
                "Jaroku is still preparing Python on this Mac{} — try again in a minute.",
                detail.map(|d| format!(" ({d})")).unwrap_or_default()
            ))
        }
        Readiness::Failed(detail) => {
            // Worth another try: the usual cause is a first launch with no network.
            let handle = app.clone();
            std::thread::spawn(move || prepare(&handle));
            return Err(format!("Python could not be prepared on this machine: {detail}. Retrying now."));
        }
        Readiness::Unavailable => return Err("this app runs agents through its own backend".into()),
    };
    validate(&request)?;
    {
        let running = RUNNING.lock().map_err(|_| "the execution table is poisoned".to_string())?;
        if running.len() >= MAX_RUNNING {
            return Err(format!("{MAX_RUNNING} executions are already running on this machine"));
        }
        if running.iter().any(|r| r.exec_id == request.exec_id) {
            return Err("that execution is already running".into());
        }
    }

    let home = paths::jaroku_home().ok_or("this machine will not say where home is")?;
    let dir = home.join("exec").join(&request.exec_id);
    write_files(&dir, &request.files)?;
    let checkpoints = home.join("checkpoints");
    let _ = std::fs::create_dir_all(&checkpoints);

    let dir_text = dir.to_string_lossy().into_owned();
    let substitute = |s: &str| s.replace(EXEC_DIR_TOKEN, &dir_text);
    let args: Vec<String> = request.args.iter().map(|a| substitute(a)).collect();

    let mut command = Command::new(uv_program());
    command.args(["run", "--no-sync", "python"]).args(&args).current_dir(&runtime);
    command.env_clear();
    for (k, v) in base_environment() {
        command.env(k, v);
    }
    command.env("JAROKU_CHECKPOINT_DIR", &checkpoints);
    for (k, v) in &request.env {
        command.env(k, substitute(v));
    }
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn().map_err(|e| {
        let _ = std::fs::remove_dir_all(&dir);
        format!("could not start Python: {e}")
    })?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));
    let stop_at = Arc::new(Mutex::new(None));
    if let Ok(mut running) = RUNNING.lock() {
        running.push(Running { exec_id: request.exec_id.clone(), child: child.clone(), stop_at: stop_at.clone() });
    }

    // Written and closed on its own thread: a check that does not read its input until later must
    // not hold this command up, and one that never reads it must still be given an EOF.
    let input = request.stdin.unwrap_or_default();
    std::thread::spawn(move || {
        if let Some(mut pipe) = stdin {
            let _ = pipe.write_all(input.as_bytes());
        }
    });

    let exec_id = request.exec_id.clone();
    let stdout_only_drained = request.capture.as_deref() == Some("stderr");
    let budget = Arc::new(Mutex::new(0usize));
    let over = Arc::new(Mutex::new(false));
    let readers = [
        stdout.map(|p| reader(app.clone(), exec_id.clone(), "stdout", p, !stdout_only_drained, budget.clone(), over.clone(), child.clone())),
        stderr.map(|p| reader(app.clone(), exec_id.clone(), "stderr", p, true, budget.clone(), over.clone(), child.clone())),
    ];
    let timeout = Duration::from_millis(request.timeout_ms).min(MAX_TIMEOUT);
    std::thread::spawn(move || {
        let deadline = Instant::now() + timeout;
        let mut timed_out = false;
        let status = loop {
            let polled = child.lock().map(|mut c| c.try_wait());
            match polled {
                Ok(Ok(Some(status))) => break Some(status),
                Ok(Ok(None)) => {}
                _ => break None,
            }
            if !timed_out && Instant::now() >= deadline {
                timed_out = true;
                kill_tree(&child, true);
            }
            let escalate = stop_at.lock().ok().and_then(|s| *s).is_some_and(|at| Instant::now() >= at);
            if escalate {
                kill_tree(&child, true);
                if let Ok(mut s) = stop_at.lock() {
                    *s = None;
                }
            }
            std::thread::sleep(Duration::from_millis(40));
        };
        for handle in readers.into_iter().flatten() {
            let _ = handle.join();
        }
        if let Ok(mut running) = RUNNING.lock() {
            running.retain(|r| r.exec_id != exec_id);
        }
        let _ = std::fs::remove_dir_all(&dir);
        let truncated = over.lock().map(|o| *o).unwrap_or(false);
        let _ = app.emit(
            EVENT,
            ExecEvent {
                exec_id,
                stream: None,
                chunk: None,
                done: true,
                code: status.and_then(|s| s.code()),
                timed_out,
                truncated,
                error: if status.is_none() { Some("the process could not be waited on".into()) } else { None },
            },
        );
    });
    Ok(())
}

/// Ask an execution to stop: a polite signal now, the whole tree killed after `grace_ms`.
#[tauri::command]
pub fn exec_stop(exec_id: String, grace_ms: Option<u64>) {
    let Ok(running) = RUNNING.lock() else { return };
    for r in running.iter().filter(|r| r.exec_id == exec_id) {
        kill_tree(&r.child, false);
        if let Ok(mut s) = r.stop_at.lock() {
            *s = Some(Instant::now() + Duration::from_millis(grace_ms.unwrap_or(5_000).min(30_000)));
        }
    }
}

/// Every execution, ended now. The app is quitting, and a run nobody can see is a run nobody stops.
pub fn cancel_all() {
    let running: Vec<Running> = RUNNING.lock().map(|mut r| r.drain(..).collect()).unwrap_or_default();
    for r in running {
        kill_tree(&r.child, true);
        logs::say(format!("execution {} stopped as the app quit", r.exec_id));
    }
}

#[allow(clippy::too_many_arguments)]
fn reader(
    app: AppHandle,
    exec_id: String,
    stream: &'static str,
    mut pipe: impl Read + Send + 'static,
    emit: bool,
    budget: Arc<Mutex<usize>>,
    over: Arc<Mutex<bool>>,
    child: Arc<Mutex<Child>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        let mut carry: Vec<u8> = Vec::new();
        loop {
            let n = match pipe.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            // Drained either way, so a child is never blocked on a full pipe nobody reads.
            if !emit || over.lock().map(|o| *o).unwrap_or(true) {
                continue;
            }
            let exceeded = budget
                .lock()
                .map(|mut b| {
                    *b += n;
                    *b > MAX_OUTPUT_BYTES
                })
                .unwrap_or(true);
            if exceeded {
                if let Ok(mut o) = over.lock() {
                    *o = true;
                }
                kill_tree(&child, true);
                continue;
            }
            carry.extend_from_slice(&buf[..n]);
            let text = take_utf8(&mut carry);
            if !text.is_empty() {
                let _ = app.emit(
                    EVENT,
                    ExecEvent {
                        exec_id: exec_id.clone(),
                        stream: Some(stream),
                        chunk: Some(text),
                        done: false,
                        code: None,
                        timed_out: false,
                        truncated: false,
                        error: None,
                    },
                );
            }
        }
        if emit && !carry.is_empty() {
            let _ = app.emit(
                EVENT,
                ExecEvent {
                    exec_id,
                    stream: Some(stream),
                    chunk: Some(String::from_utf8_lossy(&carry).into_owned()),
                    done: false,
                    code: None,
                    timed_out: false,
                    truncated: false,
                    error: None,
                },
            );
        }
    })
}

/// The longest prefix of `bytes` that is whole UTF-8, removed from it. A read can end in the middle
/// of a character, and decoding each read on its own would turn every such split into two `�`.
fn take_utf8(bytes: &mut Vec<u8>) -> String {
    let mut out = String::new();
    loop {
        match std::str::from_utf8(bytes) {
            Ok(text) => {
                out.push_str(text);
                bytes.clear();
                return out;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                out.push_str(std::str::from_utf8(&bytes[..valid]).unwrap_or_default());
                match e.error_len() {
                    // Incomplete at the end: keep it for the next read.
                    None => {
                        bytes.drain(..valid);
                        return out;
                    }
                    // Genuinely invalid: say so once and move past it.
                    Some(len) => {
                        out.push('\u{FFFD}');
                        bytes.drain(..valid + len);
                    }
                }
            }
        }
    }
}

fn kill_tree(child: &Arc<Mutex<Child>>, hard: bool) {
    let Ok(mut c) = child.lock() else { return };
    #[cfg(unix)]
    {
        let pid = c.id() as i32;
        let signal = if hard { libc::SIGKILL } else { libc::SIGTERM };
        // The group this child leads (`process_group(0)`), so `uv`'s Python and anything it
        // started go with it. Safety: a plain signal to a pid this process spawned.
        unsafe {
            libc::kill(-pid, signal);
        }
        if hard {
            let _ = c.kill();
        }
    }
    #[cfg(windows)]
    {
        let _ = hard;
        let _ = Command::new("taskkill")
            .args(["/PID", &c.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = c.kill();
    }
}

fn validate(request: &ExecRequest) -> Result<(), String> {
    let id_ok = (8..=64).contains(&request.exec_id.len())
        && request.exec_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !id_ok {
        return Err("an execution id must be 8-64 letters, digits or dashes".into());
    }
    match request.args.first().map(String::as_str) {
        Some("-m") | Some("-c") if request.args.len() >= 2 => {}
        _ => return Err("an execution must start with `-m <module>` or `-c <script>`".into()),
    }
    if request.env.len() > 256 {
        return Err("too many environment variables".into());
    }
    for (key, value) in &request.env {
        if !env_key_allowed(key) {
            return Err(format!("{key} may not be set on an execution"));
        }
        if value.len() > 64 * 1024 {
            return Err(format!("{key} is too long"));
        }
    }
    if request.files.len() > MAX_FILES {
        return Err("too many files".into());
    }
    for file in &request.files {
        safe_relative(&file.path)?;
    }
    Ok(())
}

fn env_key_allowed(key: &str) -> bool {
    let shaped = !key.is_empty()
        && key.len() <= 128
        && key.chars().next().is_some_and(|c| c.is_ascii_uppercase() || c == '_')
        && key.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    // What decides which program and which interpreter run, and what the dynamic loader injects,
    // is this shell's to set and nobody else's.
    const FIXED: [&str; 9] =
        ["PATH", "HOME", "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "VIRTUAL_ENV", "SYSTEMROOT", "COMSPEC", "JAROKU_CHECKPOINT_DIR"];
    shaped
        && !FIXED.contains(&key)
        && !key.starts_with("UV_")
        && !key.starts_with("DYLD_")
        && !key.starts_with("LD_")
}

fn safe_relative(path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    if path.is_empty() || path.len() > 512 || path.contains('\0') {
        return Err(format!("{path:?} is not a usable file name"));
    }
    let mut out = PathBuf::new();
    for component in p.components() {
        match component {
            Component::Normal(part) => out.push(part),
            _ => return Err(format!("{path:?} is not a plain relative path")),
        }
    }
    if out.as_os_str().is_empty() {
        return Err(format!("{path:?} names no file"));
    }
    Ok(out)
}

fn write_files(dir: &Path, files: &[ExecFile]) -> Result<(), String> {
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let mut total = 0usize;
    for file in files {
        let bytes = match (&file.text, &file.b64) {
            (Some(text), _) => text.as_bytes().to_vec(),
            (None, Some(b64)) => base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|e| format!("{} is not valid base64: {e}", file.path))?,
            (None, None) => Vec::new(),
        };
        total += bytes.len();
        if total > MAX_FILE_BYTES {
            let _ = std::fs::remove_dir_all(dir);
            return Err("the project is too large to run here".into());
        }
        let target = dir.join(safe_relative(&file.path)?);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("could not create {}: {e}", parent.display()))?;
        }
        std::fs::write(&target, bytes).map_err(|e| format!("could not write {}: {e}", target.display()))?;
    }
    Ok(())
}

/// The bundled uv, or whichever one `PATH` finds (development, where the developer's own is right).
fn uv_program() -> PathBuf {
    python::uv_binary().unwrap_or_else(|| PathBuf::from("uv"))
}

/// The environment an execution starts from, before the server's variables are added.
///
/// ALLOWLISTED, NOT INHERITED. A packaged app launched from Finder inherits almost nothing, but
/// `tauri dev` inherits a developer's entire shell — provider keys included — and a run that found
/// one of those would quietly bill an account nobody chose. The locale, home and temp directory a
/// Python program reasonably expects survive; everything else is set on purpose.
fn base_environment() -> HashMap<String, String> {
    let mut env = HashMap::new();
    const KEEP: [&str; 14] = [
        "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ", "SHELL",
        "SYSTEMROOT", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    ];
    for key in KEEP {
        if let Ok(value) = std::env::var(key) {
            env.insert(key.to_string(), value);
        }
    }
    for key in ["TEMP", "TMP", "COMSPEC", "PATHEXT", "PROGRAMDATA"] {
        if cfg!(windows) {
            if let Ok(value) = std::env::var(key) {
                env.insert(key.to_string(), value);
            }
        }
    }
    let python_env = python::environment();
    let path = python_env.get("PATH").cloned().unwrap_or_else(|| {
        let existing = std::env::var("PATH").unwrap_or_default();
        if cfg!(windows) {
            existing
        } else {
            format!("/opt/homebrew/bin:/usr/local/bin:{existing}")
        }
    });
    env.extend(python_env);
    env.insert("PATH".into(), path);
    env.insert("PYTHONUNBUFFERED".into(), "1".into());
    env.insert("PYTHONIOENCODING".into(), "utf-8".into());
    env
}

/// Leftovers from a previous launch: execution directories (an app killed mid-run never removed
/// its own) and checkpoints older than anybody will resume or branch from.
fn sweep_stale() {
    let Some(home) = paths::jaroku_home() else { return };
    if let Ok(entries) = std::fs::read_dir(home.join("exec")) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
    let Ok(entries) = std::fs::read_dir(home.join("checkpoints")) else { return };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > CHECKPOINT_RETENTION);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn repo_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().map(PathBuf::from).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(args: &[&str]) -> ExecRequest {
        ExecRequest {
            exec_id: "0b5f4c1e-run".into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            env: HashMap::new(),
            stdin: None,
            timeout_ms: 1000,
            files: Vec::new(),
            capture: None,
        }
    }

    #[test]
    fn only_python_modules_and_scripts_are_accepted() {
        assert!(validate(&request(&["-m", "jaroku_runner", "agent"])).is_ok());
        assert!(validate(&request(&["-c", "print(1)"])).is_ok());
        assert!(validate(&request(&["/bin/sh", "-c", "id"])).is_err());
        assert!(validate(&request(&["-m"])).is_err());
        assert!(validate(&request(&[])).is_err());
    }

    #[test]
    fn the_interpreter_and_loader_are_not_the_servers_to_choose() {
        for key in ["PATH", "PYTHONPATH", "UV_PROJECT_ENVIRONMENT", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "HOME", "lower"] {
            assert!(!env_key_allowed(key), "{key} should be refused");
        }
        for key in ["JAROKU_RUN_ID", "ANTHROPIC_API_KEY", "JAROKU_AGENT_DIR", "_X"] {
            assert!(env_key_allowed(key), "{key} should be allowed");
        }
    }

    #[test]
    fn a_file_cannot_be_written_outside_its_execution() {
        assert!(safe_relative("agent.py").is_ok());
        assert!(safe_relative("tools/gmail.py").is_ok());
        for bad in ["../x", "/etc/passwd", "a/../../b", "", "./"] {
            assert!(safe_relative(bad).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn a_character_split_across_two_reads_survives() {
        let mut carry = "héllo".as_bytes()[..2].to_vec(); // "h" and half of "é"
        assert_eq!(take_utf8(&mut carry), "h");
        carry.extend_from_slice(&"héllo".as_bytes()[2..]);
        assert_eq!(take_utf8(&mut carry), "éllo");
        assert!(carry.is_empty());
        let mut bad = vec![b'a', 0xff, b'b'];
        assert_eq!(take_utf8(&mut bad), "a\u{FFFD}b");
    }

    #[test]
    fn the_ids_a_server_mints_are_accepted() {
        let mut r = request(&["-c", "1"]);
        r.exec_id = "6f1c2a9e-3b4d-4e5f-8a7b-1c2d3e4f5a6b".into();
        assert!(validate(&r).is_ok());
        r.exec_id = "../../x".into();
        assert!(validate(&r).is_err());
    }
}
