// Running one Chat turn on the user's own provider subscription, and streaming it to the page.
//
// THIS IS THE ONLY PLACE IN JAROKU THAT SPENDS SOMEBODY'S PLAN, and it is in the shell because the
// shell is the only part standing on the machine where their sign-in lives. The backend is remote —
// `wss://jaroku-api.fly.dev` in the shipped build — so it cannot reach `codex` or `claude`, and it
// must never be handed a credential so that it could. The page orchestrates, the shell executes,
// and the credential never moves.
//
// THE SHELL BUILDS THE COMMAND, NOT THE PAGE, and that is a security decision rather than a
// stylistic one. The obvious design has the server plan an argv — it already does, in
// providerAuth/invocation.ts — and the page forward it here to be spawned. That makes this function
// "run whatever argv you are given", reachable from anything that can talk to the webview, and the
// binaries in question take flags like `codex login --with-api-key` (reads a key from stdin) and
// `claude --dangerously-skip-permissions`. So the page sends FIELDS and this file assembles them:
// the provider must be one of two, the effort must be one of five, and the prompt is one argv
// element that no shell ever sees. The worst a caller can do is ask a question.
//
// THE ARGV IS DELIBERATELY A SECOND IMPLEMENTATION of the server's planner, and it is said out loud
// rather than pretended away — the same posture `effort.ts` takes about its Python twin. The server
// one is the POLICY authority: it decides whether a provider may be used at all, and its suite
// holds the `--bare` prohibition and the effort clamps. This one is the EXECUTION authority: it
// decides what actually runs on this machine. Each is tested against the same rules, and neither
// can be talked into something by the other being wrong.
//
// STREAMED LINE BY LINE, because both protocols are newline-delimited JSON and a turn can take
// minutes — `xhigh` on Codex exceeded three minutes for a one-line prompt on 2026-09-13. Anything
// that waited for the process to exit would render nothing for that whole time and then everything
// at once, which is not a chat.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::{logs, paths, provider_auth};

/// The event the page listens for. Colon-separated, like every other event this shell emits.
pub const EVENT: &str = "jaroku:provider-turn";

/// One line of a running turn, or its end.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TurnEvent {
    /// Which turn this belongs to. The page runs one at a time today and will not always.
    pub turn_id: u64,
    /// A line the provider's CLI wrote to stdout, already trimmed. Absent on the final event.
    pub line: Option<String>,
    /// True on the last event for this turn.
    pub done: bool,
    /// The process's exit code, on the final event. `None` if it was killed.
    pub code: Option<i32>,
    /// What went wrong, when something did. Never carries the provider's own stderr verbatim —
    /// see `run` for why.
    pub error: Option<String>,
}

/// The turns currently running, so one can be cancelled.
///
/// A `Mutex<Vec<..>>` rather than a map: there is one turn in flight in practice, the list is
/// scanned on cancel and on completion, and a HashMap for a list that is almost always empty or
/// one element is a data structure chosen for a diagram rather than for a workload.
static RUNNING: Mutex<Vec<(u64, Child)>> = Mutex::new(Vec::new());
static NEXT_TURN: AtomicU64 = AtomicU64::new(1);

/// The levels any provider may be sent, mirroring `EFFORT_LEVELS` on the server.
///
/// VALIDATED RATHER THAN TRUSTED, because this string reaches a command line. It is already
/// clamped per provider by the server's `mapEffort` — Codex stops at `xhigh` — and this is the
/// second gate: a value from outside that list is dropped rather than passed through, so the worst
/// a wrong caller achieves is a turn at the provider's default effort.
const EFFORT_VALUES: &[&str] = &["low", "medium", "high", "xhigh", "max"];

fn valid_effort(v: &str) -> bool {
    EFFORT_VALUES.contains(&v)
}

/// A model id that is safe to put on a command line.
///
/// Conservative on purpose: real model ids are lowercase alphanumerics with dashes and dots
/// (`gpt-6-astra`, `claude-opus-5`, `muse-spark-1.3`). Anything else is dropped and the provider
/// runs on its own default, which is a working turn rather than a failed one.
fn valid_model(v: &str) -> bool {
    // MUST NOT LOOK LIKE A FLAG. The first version of this allowed dashes anywhere, which let
    // `--dangerously-do-something` through as a "model name" — it is alphanumerics and dashes, and
    // it would have been placed on the command line right after `--model`, where the CLI reads it
    // as a flag of its own. Caught by this file's own test before it ran anywhere.
    !v.is_empty()
        && v.len() <= 64
        && !v.starts_with('-')
        && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_')
}

/// Build the command for one provider. The whole of what may ever be executed here.
///
/// Returns `None` for a provider this shell will not run — which is every provider except the two
/// with an official local mechanism. Muse Spark has none and so has no branch. Whether a provider
/// may answer Chat at all is the SERVER's capability table's decision (both of these may, since
/// 2026-09-13); this function decides only what runs on this machine once one does.
pub fn build_argv(provider: &str, prompt: &str, model: Option<&str>, effort: Option<&str>) -> Option<Vec<String>> {
    let s = |x: &str| x.to_string();
    let effort = effort.filter(|e| valid_effort(e));
    let model = model.filter(|m| valid_model(m));

    match provider {
        "openai" => {
            // NO TRANSCRIPT. `codex exec` files every session under `~/.codex/sessions` as plain JSONL
            // unless told not to, and a Jaroku chat turn is somebody's own conversation: Jaroku's
            // thread keeps it, and nothing else on disk does.
            let mut argv = vec![s("codex"), s("exec"), s("--json"), s("--skip-git-repo-check"), s("--ephemeral")];
            if let Some(e) = effort {
                argv.push(s("-c"));
                argv.push(format!("model_reasoning_effort=\"{e}\""));
            }
            if let Some(m) = model {
                argv.push(s("--model"));
                argv.push(s(m));
            }
            argv.push(s(prompt));
            Some(argv)
        }
        "anthropic" => {
            // NEVER `--bare`: it makes Claude Code ignore the keychain and demand an API key, which
            // would move a subscription turn onto API billing with nothing appearing to go wrong.
            let mut argv = vec![
                s("claude"), s("-p"),
                s("--output-format"), s("stream-json"),
                s("--verbose"), s("--include-partial-messages"),
                // NO TRANSCRIPT, for Codex's reason: `claude -p` otherwise files the conversation under
                // `~/.claude/projects/<directory>` as plain JSONL.
                s("--no-session-persistence"),
            ];
            if let Some(m) = model {
                argv.push(s("--model"));
                argv.push(s(m));
            }
            // THE LEVEL IS A FLAG, NEVER A PROMPT PREFIX. `claude --effort <level>` takes the same five
            // names. It used to ride inside the prompt as `/effort <level>\n<prompt>`, and Claude Code
            // reads a prompt opening with `/` as a slash command whose argument is EVERYTHING after it:
            // the model was never called, and "Invalid argument: high\n<the message>" came back as a
            // successful answer on every Claude turn.
            if let Some(e) = effort {
                argv.push(s("--effort"));
                argv.push(s(e));
            }
            argv.push(s(prompt));
            Some(argv)
        }
        _ => None,
    }
}

/// Where every subscription turn runs: `~/.jaroku/chat`, made on first use and private to its owner.
///
/// NEVER A DIRECTORY THE PAGE NAMES. The page sent one, read from a `home` field this shell never
/// injected, so every shipped turn ran in `/tmp` — writable by every process on the machine. Both CLIs
/// take instructions from the directory they start in (`CLAUDE.md`, `AGENTS.md`, `.mcp.json`), so
/// anything able to drop a file there was writing into a session holding the user's own plan.
fn chat_dir() -> Result<PathBuf, String> {
    let home = paths::jaroku_home().ok_or("this machine does not say where its home directory is")?;
    chat_dir_in(&home)
}

/// `<home>/chat`, made private. Apart from `chat_dir` so a test can point it somewhere harmless.
///
/// TIGHTENED EVERY TIME, not only when made: a directory somebody widened is put back to owner-only
/// before a turn runs in it. And A LINK IS REFUSED rather than followed — planted where the directory
/// belongs, it would send the turn wherever it points.
fn chat_dir_in(home: &Path) -> Result<PathBuf, String> {
    let dir = home.join("chat");
    if let Ok(meta) = std::fs::symlink_metadata(&dir) {
        if !meta.file_type().is_dir() {
            return Err(format!("{} is not a directory Jaroku made", dir.display()));
        }
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("could not make {} private: {e}", dir.display()))?;
    }
    Ok(dir)
}

/// Start a turn. Returns its id, which the page uses to match events and to cancel.
#[tauri::command]
pub fn provider_turn_start(
    app: AppHandle,
    provider: String,
    prompt: String,
    model: Option<String>,
    effort: Option<String>,
) -> Result<u64, String> {
    let Some(argv) = build_argv(&provider, &prompt, model.as_deref(), effort.as_deref()) else {
        return Err(format!("{provider} cannot run a turn on this machine"));
    };
    // Resolved through the same search a detection pass uses, so a Finder launch with no PATH finds
    // the binary in the places these tools actually install to.
    let Some(exe) = provider_auth::locate(&argv[0]) else {
        return Err(format!("{} is not installed", argv[0]));
    };
    // Where it runs is this shell's decision alone — see `chat_dir`.
    let dir = chat_dir()?;

    let turn_id = NEXT_TURN.fetch_add(1, Ordering::Relaxed);
    let child = Command::new(&exe)
        .args(&argv[1..])
        // STDIN CLOSED. `codex exec` treats an open stdin as additional input and waits on it, so a
        // turn whose stdin stayed open would hang forever rather than answer.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .current_dir(&dir)
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", argv[0]))?;

    // The argument vector is logged WITHOUT the prompt, which is the user's own words and has no
    // business in a file on disk. Everything before the last element is flags we chose.
    logs::say(format!(
        "provider turn {turn_id}: {} {}",
        exe.display(),
        argv[1..argv.len().saturating_sub(1)].join(" ")
    ));
    run(app, turn_id, child);
    Ok(turn_id)
}

/// Pump one child's output to the page, on its own thread, until it exits.
fn run(app: AppHandle, turn_id: u64, mut child: Child) {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    RUNNING.lock().expect("running turns").push((turn_id, child));

    // Stderr is drained on its own thread and kept out of the event stream. Both CLIs print
    // progress and warnings there, and interleaving them with the JSON the page parses would turn
    // a diagnostic into a parse failure. It goes to the desktop log, where a launch problem is
    // already looked for.
    if let Some(err) = stderr {
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                if !line.trim().is_empty() {
                    logs::say(format!("provider turn {turn_id} stderr: {}", line.trim()));
                }
            }
        });
    }

    std::thread::spawn(move || {
        // COUNTED, BECAUSE "NO ANSWER" HAS TWO VERY DIFFERENT CAUSES and the log could not tell
        // them apart: a CLI that printed nothing at all, and one that printed plenty which the
        // page then failed to make sense of. The count is the cheapest thing that separates them,
        // and it carries no content — the lines themselves are the user's conversation.
        let mut lines_seen = 0usize;
        if let Some(out) = stdout {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let line = line.trim().to_string();
                if line.is_empty() {
                    continue;
                }
                lines_seen += 1;
                let _ = app.emit(EVENT, TurnEvent {
                    turn_id, line: Some(line), done: false, code: None, error: None,
                });
            }
        }
        // Reclaim the child and report how it ended.
        let mut running = RUNNING.lock().expect("running turns");
        let code = running
            .iter()
            .position(|(id, _)| *id == turn_id)
            .map(|i| running.remove(i).1)
            .and_then(|mut c| c.wait().ok())
            .and_then(|s| s.code());
        drop(running);

        logs::say(format!("provider turn {turn_id} ended, exit {code:?}, {lines_seen} line(s) of output"));
        let _ = app.emit(EVENT, TurnEvent {
            turn_id,
            line: None,
            done: true,
            code,
            // A non-zero exit with no JSON is the shape of a refused or expired sign-in. The page
            // renders this sentence; the provider's own stderr stays in the log, because it can
            // carry a key prefix or an account address and this string reaches a browser.
            error: match code {
                Some(0) | None => None,
                Some(c) => Some(format!(
                    "The provider's CLI exited with status {c}. Check the desktop log, and that \
                     your sign-in is still valid."
                )),
            },
        });
    });
}

/// Stop a running turn. Killing the process is what ends the spend.
#[tauri::command]
pub fn provider_turn_cancel(turn_id: u64) -> bool {
    let mut running = RUNNING.lock().expect("running turns");
    match running.iter().position(|(id, _)| *id == turn_id) {
        Some(i) => {
            let (_, mut child) = running.remove(i);
            let killed = child.kill().is_ok();
            // Reaped here rather than left for the reader thread, which is about to find its pipe
            // closed and exit. An unreaped child is a zombie for the life of the application.
            let _ = child.wait();
            logs::say(format!("provider turn {turn_id} cancelled"));
            killed
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_is_invoked_as_it_was_verified_to_work() {
        let argv = build_argv("openai", "hello", None, Some("high")).unwrap();
        assert_eq!(argv[0], "codex");
        assert_eq!(argv[1], "exec");
        assert!(argv.contains(&"--json".to_string()));
        // Without this, `codex exec` refuses outside a trusted git repo — a real failure seen on
        // 2026-09-13 before the flag was added.
        assert!(argv.contains(&"--skip-git-repo-check".to_string()));
        assert!(argv.contains(&"model_reasoning_effort=\"high\"".to_string()));
        assert_eq!(argv.last().unwrap(), "hello");
    }

    #[test]
    fn claude_is_never_invoked_with_bare() {
        // The flag that would make Claude Code ignore the keychain and demand an API key, moving a
        // subscription turn onto API billing silently.
        for effort in [None, Some("low"), Some("max")] {
            let argv = build_argv("anthropic", "hi", None, effort).unwrap();
            assert!(!argv.contains(&"--bare".to_string()), "{argv:?}");
            assert!(argv.contains(&"-p".to_string()));
        }
    }

    #[test]
    fn a_provider_with_no_local_mechanism_builds_nothing() {
        assert!(build_argv("meta", "hi", None, None).is_none());
        assert!(build_argv("", "hi", None, None).is_none());
        assert!(build_argv("openai; rm -rf /", "hi", None, None).is_none());
    }

    #[test]
    fn an_invented_effort_is_dropped_rather_than_passed_through() {
        // This string reaches a command line. Anything outside the five levels is ignored and the
        // provider runs at its own default, which is a working turn rather than a failed one.
        let argv = build_argv("openai", "hi", None, Some("'; codex login --with-api-key #")).unwrap();
        assert!(!argv.iter().any(|a| a.contains("login")), "{argv:?}");
        assert!(!argv.iter().any(|a| a.contains("model_reasoning_effort")), "{argv:?}");
    }

    #[test]
    fn an_invented_model_is_dropped_rather_than_passed_through() {
        let argv = build_argv("openai", "hi", Some("--dangerously-do-something"), None).unwrap();
        assert!(!argv.contains(&"--model".to_string()), "{argv:?}");
        // And a real one survives.
        let ok = build_argv("openai", "hi", Some("gpt-6-astra"), None).unwrap();
        assert!(ok.contains(&"gpt-6-astra".to_string()));
    }

    #[test]
    fn the_prompt_is_one_argument_and_never_shell_syntax() {
        // There is no shell in this path: `Command::new` execs directly. Quotes, semicolons and
        // backticks are characters in one argv element.
        let nasty = "\"; rm -rf / #`whoami`";
        let argv = build_argv("openai", nasty, None, None).unwrap();
        assert_eq!(argv.last().unwrap(), nasty);
        assert_eq!(argv.iter().filter(|a| a.as_str() == nasty).count(), 1);
    }

    #[test]
    fn claude_carries_its_effort_as_a_flag_and_the_prompt_untouched() {
        // THE FAILURE THIS REPLACES. `/effort xhigh\nexplain this` made Claude Code parse the whole
        // message as the slash command's argument: the model was never called and the error text was
        // rendered as the answer, on every Claude turn at every level.
        for level in ["low", "medium", "high", "xhigh", "max"] {
            let argv = build_argv("anthropic", "explain this", None, Some(level)).unwrap();
            let at = argv.iter().position(|a| a == "--effort").expect("--effort is its own flag");
            assert_eq!(argv[at + 1], level);
            assert_eq!(argv.last().unwrap(), "explain this", "{argv:?}");
            assert!(!argv.iter().any(|a| a.contains("/effort")), "{argv:?}");
        }
        // And an invented level is dropped rather than passed through, as it is for Codex.
        let argv = build_argv("anthropic", "hi", None, Some("turbo")).unwrap();
        assert!(!argv.contains(&"--effort".to_string()), "{argv:?}");
    }

    #[test]
    fn a_turn_leaves_no_transcript_on_disk() {
        // Found after a replay: the question sat in plain JSONL under ~/.claude/projects/-private-tmp
        // and ~/.codex/sessions. Jaroku's thread is the one record of a chat turn.
        let codex = build_argv("openai", "hi", None, None).unwrap();
        assert!(codex.contains(&"--ephemeral".to_string()), "{codex:?}");
        let claude = build_argv("anthropic", "hi", None, None).unwrap();
        assert!(claude.contains(&"--no-session-persistence".to_string()), "{claude:?}");
        assert_eq!(codex.last().unwrap(), "hi");
        assert_eq!(claude.last().unwrap(), "hi");
    }

    /// A directory of its own under the system's temp dir, removed when the test ends.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("jaroku-provider-turn-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn the_chat_directory_is_made_inside_jarokus_home() {
        let home = Scratch::new("inside");
        let dir = chat_dir_in(&home.0).unwrap();
        assert_eq!(dir, home.0.join("chat"));
        assert!(dir.is_dir());
        // And asked again, the same directory — a turn does not fail because the last one made it.
        assert_eq!(chat_dir_in(&home.0).unwrap(), dir);
    }

    #[cfg(unix)]
    #[test]
    fn the_chat_directory_is_private_even_after_somebody_widens_it() {
        use std::os::unix::fs::PermissionsExt;
        let home = Scratch::new("private");
        let dir = chat_dir_in(&home.0).unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).unwrap();
        chat_dir_in(&home.0).unwrap();
        assert_eq!(mode(&dir), 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_where_the_chat_directory_belongs_is_refused() {
        let home = Scratch::new("link");
        let elsewhere = Scratch::new("elsewhere");
        std::os::unix::fs::symlink(&elsewhere.0, home.0.join("chat")).unwrap();
        assert!(chat_dir_in(&home.0).is_err());
        // A plain file in its place is refused too, rather than replaced.
        let other = Scratch::new("file");
        std::fs::write(other.0.join("chat"), "not a directory").unwrap();
        assert!(chat_dir_in(&other.0).is_err());
    }
}
