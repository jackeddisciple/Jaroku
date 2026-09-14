// What the provider CLIs on THIS machine can tell us about themselves.
//
// The shell is the only part of Jaroku standing on the computer where a user's provider sign-in
// lives, so it is the only part that can answer "is `codex` installed, and is it signed in". It
// answers by ASKING THE PROVIDER'S OWN TOOL and believing what it says. It does not open
// `~/.codex/auth.json`, and that restraint is not fastidiousness: collecting or inspecting another
// company's session tokens is the specific thing every one of these providers forbids, and the
// whole architecture here exists to never need to.
//
// WHAT COUNTS AS A SUBSCRIPTION, AND WHAT EMPHATICALLY DOES NOT. `codex login status` has six
// things it can say, and only one of them is a consumer plan:
//
//   Logged in using ChatGPT                    <- a plan. THIS is subscription-backed access.
//   Logged in using an API key - …             <- API billing
//   Logged in using Amazon Bedrock API key     <- API billing, someone else's cloud
//   Logged in using Amazon Bedrock AWS access keys
//   Logged in using personal access token
//   Logged in using workload identity
//
// Everything after the first line bills an API account, and treating any of it as a subscription
// would be precisely the mixing the product forbids: Chat would quietly start spending a user's
// API balance while telling them it was using their plan. So the match is EXACT and the default is
// no — an unrecognised line is not a sign-in, because a string we have not seen before is a string
// whose billing we do not know.
//
// AND IT DOES NOT DECIDE WHAT A SIGN-IN MEANS. It reports what each CLI says about itself; the
// server's capability table decides whether that provider may answer Chat at all, and answers "not
// connected" for one it does not permit — Muse Spark, today — no matter what arrives here. A
// provider that permits nothing is only noted as present (see `observe_gated`), which is what lets
// the product say "Muse is installed on this machine, and Meta documents no way for Jaroku to use
// it" rather than pretending not to have noticed.
//
// WHY PATH IS NOT ENOUGH. A `.app` launched from Finder, from Spotlight, or by LaunchServices
// inherits no shell environment at all — the same fact `backend.rs` documents about
// `JAROKU_BACKEND_URL`. So a user who installed `codex` with Homebrew has it on the PATH of every
// terminal they own and on none that this process can see. The extra directories below are that
// gap, and without them the feature is "works for developers, missing for everybody else".

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::logs;

/// How long a CLI gets to answer before we call it absent.
///
/// Generous, because the honest failure is a slow answer rather than a wrong one, and mean enough
/// that a wedged binary cannot hold the window's first render. These commands are local and print
/// one line; a second is already an anomaly.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Directories searched in addition to `PATH`. See the note above on Finder launches.
///
/// Ordered most-likely-first, and every one is a documented install location for one of these
/// tools: Homebrew on Apple silicon and on Intel, npm's global prefix, and the per-user bin that
/// several of these installers now prefer.
const EXTRA_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
];

/// The same idea for per-user installs, resolved against `$HOME` at call time.
///
/// `~/.local/bin` IS WHERE CLAUDE CODE PUTS ITSELF, which is how this list earned its existence:
/// with only the system directories above, a Finder-launched build found `codex` under Homebrew and
/// missed `claude` entirely — on a machine where both were installed and signed in. The bug is
/// invisible from a terminal, because a terminal has the user's real PATH.
const EXTRA_HOME_DIRS: &[&str] = &[".local/bin", ".bun/bin", ".deno/bin"];

/// One provider CLI as this machine has it. Serialised straight to the page.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostProvider {
    /// The server's provider id, so the relay can key on it without a translation table.
    pub provider: String,
    pub installed: bool,
    pub version: Option<String>,
    /// True ONLY for a consumer-plan sign-in. See the module note.
    pub signed_in: bool,
    /// Which account, when the tool named one. Display only.
    pub account: Option<String>,
    /// What the tool said it is authenticated with, normalised. `None` when not signed in.
    ///
    /// Carried so the product can explain the one confusing case out loud: a user with `codex`
    /// signed in via an API key is signed in, and still cannot use Chat on a subscription. Without
    /// this field that reads as a bug.
    pub auth_mode: Option<String>,
    /// A sentence for the user when `signed_in` is false for a reason worth naming.
    pub note: Option<String>,
}

impl HostProvider {
    fn absent(provider: &str) -> Self {
        Self {
            provider: provider.to_string(),
            installed: false,
            version: None,
            signed_in: false,
            account: None,
            auth_mode: None,
            note: None,
        }
    }
}

/// Find an executable by name, on `PATH` and then in the places a GUI launch cannot see.
pub fn locate(binary: &str) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(binary);
            if is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    for dir in EXTRA_DIRS {
        let candidate = Path::new(dir).join(binary);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        for dir in EXTRA_HOME_DIRS {
            let candidate = Path::new(&home).join(dir).join(binary);
            if is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return std::fs::metadata(path)
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false);
    }
    #[cfg(not(unix))]
    {
        return path.is_file();
    }
}

/// Run a command and return its stdout, or `None` if it failed, timed out, or wrote nothing.
///
/// STDOUT ONLY, AND TRIMMED. These tools print their answer on stdout and their complaints on
/// stderr, and a complaint is not an answer — a probe that concatenated the two would read
/// "Not logged in" out of a warning about a config file.
fn probe(exe: &Path, args: &[&str]) -> Option<String> {
    probe_within(exe, args, PROBE_TIMEOUT).ok()
}

/// Why a probe produced no answer — kept apart, because the row owes each a different sentence.
///
/// A CLI that is signed out ANSWERS. One waiting on a Keychain prompt nobody has seen does not, and
/// killed at the timeout it used to read exactly like a signed-out one: somebody with a working plan
/// was told to go and sign in, while the log alone knew better.
#[derive(Debug, PartialEq, Eq)]
enum Silence {
    /// It did not answer inside the timeout, and was killed.
    TimedOut,
    /// It could not be started, or waited on.
    Failed,
    /// It exited having written nothing to either stream.
    Empty,
}

/// `probe`, with the reason for a silence kept and the timeout named by the caller.
fn probe_within(exe: &Path, args: &[&str], timeout: Duration) -> Result<String, Silence> {
    let mut child = Command::new(exe)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        // CAPTURED RATHER THAN DISCARDED, AND THIS WAS A REAL BUG. `codex login status` exits 0 and
        // writes its answer to STDERR, so a probe reading stdout alone got an empty string from a
        // successful command and reported a signed-in machine as signed out. It survived every
        // shell test because those were written with `2>&1`, which merged the two and hid which
        // stream the sentence came from — the app, reading only one, could not.
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|_| Silence::Failed)?;

    // A hand-rolled wait rather than a dependency: this is the only place in the shell that needs
    // a timeout on a child, and `wait_timeout` would be a crate for one loop.
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    // Reaped, so a killed probe is not a zombie for the life of the application.
                    let _ = child.wait();
                    logs::say(format!(
                        "provider probe timed out after {}ms: {} {}",
                        timeout.as_millis(),
                        exe.display(),
                        args.join(" ")
                    ));
                    return Err(Silence::TimedOut);
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return Err(Silence::Failed),
        }
    }

    let out = child.wait_with_output().map_err(|_| Silence::Failed)?;
    // STDOUT WINS WHEN THERE IS ANY, and stderr is the fallback rather than a merge: `claude auth
    // status --json` answers in JSON on stdout, and concatenating a warning onto that would turn a
    // parseable answer into an unparseable one. Only a command that said nothing on stdout falls
    // through to what it said on stderr.
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let text = if stdout.is_empty() {
        String::from_utf8_lossy(&out.stderr).trim().to_string()
    } else {
        stdout
    };
    if text.is_empty() {
        // WHY, RATHER THAN JUST "NO". A probe that answers nothing is indistinguishable from a
        // provider that is signed out, and the two want completely different things done about
        // them. `codex login status` reported a ChatGPT sign-in in every shell it was tried in and
        // reported nothing from inside the packaged app, and there was no way to tell from the log
        // whether it had failed, been refused, or simply said something unexpected.
        logs::say(format!(
            "provider probe said nothing: {} {} (exit {:?})",
            exe.display(),
            args.join(" "),
            out.status.code()
        ));
        return Err(Silence::Empty);
    }
    Ok(text)
}

/// The one line of `codex login status` that means a consumer plan, matched exactly.
const CHATGPT_SIGN_IN: &str = "Logged in using ChatGPT";

/// Turn `codex login status` output into a verdict.
///
/// Split out so it can be tested without a `codex` on the machine running the tests — which is
/// every CI runner.
pub fn read_codex_status(status: &str) -> (bool, Option<String>, Option<String>) {
    let line = status.lines().next().unwrap_or("").trim();

    if line.starts_with(CHATGPT_SIGN_IN) {
        return (true, Some("chatgpt".to_string()), None);
    }
    if line.starts_with("Logged in using") {
        // Signed in, but against something that bills an API account. Named rather than silently
        // treated as absent, because "I am logged in and it says I am not" is the single most
        // confusing thing this feature could say to somebody.
        let mode = if line.contains("API key") || line.contains("access keys") {
            "apikey"
        } else if line.contains("personal access token") {
            "token"
        } else if line.contains("workload identity") {
            "federation"
        } else {
            "other"
        };
        return (
            false,
            Some(mode.to_string()),
            Some(
                "Codex is signed in with API credentials rather than a ChatGPT plan. Chat runs on \
                 your subscription, so it needs `codex login` with your ChatGPT account. Your API \
                 key stays where it is and keeps powering agent runs."
                    .to_string(),
            ),
        );
    }
    (false, None, None)
}

/// The address in a Codex app-server `account/read` answer, when the account is a ChatGPT one.
///
/// Split out so it is tested against a captured answer without a `codex` on the machine running the
/// tests. Bounded like every other display string that leaves this module.
pub fn read_codex_account(response: &str) -> Option<String> {
    let v = serde_json::from_str::<serde_json::Value>(response).ok()?;
    let account = v.get("result")?.get("account")?;
    if account.get("type")?.as_str()? != "chatgpt" {
        return None;
    }
    let email = account.get("email")?.as_str()?.trim();
    (!email.is_empty()).then(|| email.chars().take(128).collect())
}

/// Which ChatGPT account `codex` is signed in with, asked of its own app-server.
///
/// `codex login status` SAYS ONLY "Logged in using ChatGPT", so somebody with two ChatGPT accounts
/// could not tell which one Jaroku was spending. The app-server Codex documents for embedding answers
/// `account/read` with the address, asked the way its protocol asks — `initialize`, `initialized`,
/// then the request — and never by opening `~/.codex/auth.json`, which is the credential itself and
/// none of Jaroku's business.
///
/// Display only, under the same timeout as every other probe, and `None` on any surprise: the row
/// works without an address, it just cannot say which account.
fn codex_account(exe: &Path) -> Option<String> {
    use std::io::{BufRead, BufReader, Write};
    use std::sync::mpsc;

    let mut child = Command::new(exe)
        .arg("app-server")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let (mut stdin, stdout) = (child.stdin.take()?, child.stdout.take()?);
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });

    let deadline = std::time::Instant::now() + PROBE_TIMEOUT;
    // The first line carrying this id, or `None` once the probe's time is up.
    let answer_to = |id: u64| -> Option<String> {
        loop {
            let left = deadline.checked_duration_since(std::time::Instant::now())?;
            let line = rx.recv_timeout(left).ok()?;
            let carries = serde_json::from_str::<serde_json::Value>(&line)
                .ok()
                .and_then(|v| v.get("id").and_then(|i| i.as_u64()));
            if carries == Some(id) {
                return Some(line);
            }
        }
    };
    let initialize = format!(
        r#"{{"id":1,"method":"initialize","params":{{"clientInfo":{{"name":"jaroku","version":"{}"}}}}}}"#,
        env!("CARGO_PKG_VERSION")
    );
    let answer = (|| {
        writeln!(stdin, "{initialize}").ok()?;
        answer_to(1)?;
        writeln!(stdin, r#"{{"method":"initialized"}}"#).ok()?;
        writeln!(stdin, r#"{{"id":2,"method":"account/read","params":{{}}}}"#).ok()?;
        answer_to(2)
    })();

    let _ = child.kill();
    let _ = child.wait();
    let account = answer.as_deref().and_then(read_codex_account);
    if account.is_none() {
        // NO ADDRESS IN THE LOG EITHER WAY — only that there was none to show.
        logs::say("codex app-server named no ChatGPT account for a ChatGPT sign-in");
    }
    account
}

/// Turn `claude auth status --json` into a verdict.
///
/// STRUCTURED OUTPUT, SO NO PARSING OF PROSE. Claude Code answers with `loggedIn`, `authMethod`,
/// `subscriptionType` and the account's email. `authMethod` is the field that matters: `claude.ai`
/// is a consumer plan sign-in, and anything else — an API key, a Console credential, a cloud
/// provider — bills something other than the subscription and must not count.
///
/// WHAT IS DELIBERATELY DROPPED. The same payload carries `orgId` and `configDirectory`. Neither
/// is needed to decide anything and both would end up on a wire and in a log, so only the account
/// address and the plan name survive — the two things a user needs to recognise their own sign-in.
pub fn read_claude_status(json: &str) -> (bool, Option<String>, Option<String>, Option<String>) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return (false, None, None, None);
    };
    let logged_in = v.get("loggedIn").and_then(|b| b.as_bool()).unwrap_or(false);
    let method = v.get("authMethod").and_then(|m| m.as_str()).unwrap_or("");
    let email = v.get("email").and_then(|e| e.as_str()).map(str::to_string);
    let plan = v.get("subscriptionType").and_then(|p| p.as_str()).map(str::to_string);

    if !logged_in {
        return (false, None, None, None);
    }
    if method == "claude.ai" {
        return (true, Some("claude.ai".to_string()), email, plan);
    }
    // Signed in to something that is not a consumer plan.
    (
        false,
        Some(if method.is_empty() { "other".to_string() } else { method.to_string() }),
        email,
        plan,
    )
}

/// The sentence for a Claude Code sign-in that cannot answer Chat, or `None`.
///
/// THE SAME SENTENCE `read_codex_status` GIVES, FOR THE SAME CASE: signed in, and still refused,
/// because what is signed in bills an API account rather than a plan. Without it the row tells
/// somebody who can see they are signed in to go and sign in.
pub fn claude_note(signed_in: bool, auth_mode: Option<&str>) -> Option<String> {
    if signed_in || auth_mode.is_none() {
        return None;
    }
    Some(
        "Claude Code is signed in with API credentials rather than a Claude plan. Chat runs on your \
         subscription, so it needs `claude auth login` with your Claude account. Your API key stays \
         where it is and keeps powering agent runs."
            .to_string(),
    )
}

/// The sentence for a CLI that did not answer inside the probe's timeout — which is not signed out.
///
/// The log always told the two apart and the row did not, so a Keychain prompt nobody had seen became
/// "sign in with your plan" on screen, for somebody whose plan was working.
pub fn unanswered_note(product: &str) -> String {
    format!(
        "{product} did not answer within {} seconds, so Jaroku cannot tell whether it is signed in. If \
         macOS asked whether it may use the Keychain, allow it, then press Check again.",
        PROBE_TIMEOUT.as_secs()
    )
}

/// Ask `codex` about itself.
fn observe_codex() -> HostProvider {
    let Some(exe) = locate("codex") else {
        return HostProvider::absent("openai");
    };
    let version = probe(&exe, &["--version"]).map(|v| v.trim().to_string());
    let answer = probe_within(&exe, &["login", "status"], PROBE_TIMEOUT);
    let status = answer.as_deref().unwrap_or_default().to_string();
    let (signed_in, auth_mode, note) = read_codex_status(&status);
    // A CLI THAT NEVER ANSWERED IS NOT A SIGNED-OUT ONE, and the row says which it was.
    let note = if answer == Err(Silence::TimedOut) { Some(unanswered_note("Codex")) } else { note };
    if !signed_in && !status.is_empty() {
        // An unrecognised first line is the third silent outcome, and the log is the only place it
        // can show up: the row just reads "not signed in" either way.
        logs::say(format!("codex login status said: {:?}", status.lines().next().unwrap_or("")));
    }

    HostProvider {
        provider: "openai".to_string(),
        installed: true,
        version,
        signed_in,
        // ASKED ONLY OF A CHATGPT SIGN-IN, which is the only one with an account worth naming here —
        // an API-key sign-in is refused for Chat whichever key it is.
        account: if signed_in { codex_account(&exe) } else { None },
        auth_mode,
        note,
    }
}

/// Ask `claude` about itself.
///
/// PROBED IN FULL, because Claude is permitted: the server's capability table has let Anthropic
/// answer Chat since 2026-09-13, so `auth status --json` is what decides whether this machine's
/// sign-in is a plan that may run a turn.
fn observe_claude() -> HostProvider {
    let Some(exe) = locate("claude") else {
        return HostProvider::absent("anthropic");
    };
    let version = probe(&exe, &["--version"]).map(|v| v.trim().to_string());
    // `auth status` READS THE KEYCHAIN, and a freshly built or unsigned app raises a Keychain prompt —
    // one nobody answered inside the timeout used to read as "not signed in", telling somebody with a
    // working plan to go and sign in.
    let answer = probe_within(&exe, &["auth", "status", "--json"], PROBE_TIMEOUT);
    let status = answer.as_deref().unwrap_or_default().to_string();
    let (signed_in, auth_mode, account, _plan) = read_claude_status(&status);
    let note = if answer == Err(Silence::TimedOut) {
        Some(unanswered_note("Claude Code"))
    } else {
        claude_note(signed_in, auth_mode.as_deref())
    };

    HostProvider {
        provider: "anthropic".to_string(),
        installed: true,
        version,
        signed_in,
        account,
        auth_mode,
        // WHY NOT, NEVER WHICH PLAN. `note` is the sentence for a sign-in that cannot answer Chat, and
        // it used to carry "Claude pro plan" for one that could — which a page reading the field as
        // documented would have shown as the explanation of a refusal that never happened.
        note,
    }
}

/// Note a gated provider's CLI if it is here, without asking it anything.
///
/// PRESENCE ONLY, DELIBERATELY. These providers do not permit Jaroku to use a subscription at all,
/// so interrogating their sign-in state would be collecting information about a credential we have
/// no sanctioned use for. Whether the binary exists is enough to say something true and useful —
/// "Claude Code is installed here" — and nothing more is anyone's business.
fn observe_gated(provider: &str, binary: &str) -> HostProvider {
    match locate(binary) {
        None => HostProvider::absent(provider),
        Some(exe) => HostProvider {
            provider: provider.to_string(),
            installed: true,
            version: probe(&exe, &["--version"]).map(|v| v.trim().to_string()),
            signed_in: false,
            account: None,
            auth_mode: None,
            note: None,
        },
    }
}

/// The last full answer and when it was taken, so a burst of asks costs one set of spawns.
static LAST: Mutex<Option<(Instant, Vec<HostProvider>)>> = Mutex::new(None);
/// Held for the length of a probe, so an ask arriving mid-probe waits for that one rather than
/// starting its own.
static PROBING: Mutex<()> = Mutex::new(());
/// How long an answer stands. Long enough to absorb a burst — the log showed six asks 316ms apart —
/// and far shorter than it takes a person to sign in somewhere and come back.
const FRESH_FOR: Duration = Duration::from_millis(1500);

/// Everything this machine has, for the page to report inward.
///
/// A COMMAND RATHER THAN AN EVENT, like `status::backend_status` beside it: the page asks when it
/// mounts and after it sends the user to sign in, and there is no ordering to get right. It is also
/// several process spawns, which is a thing to do on request rather than on a timer.
///
/// ASYNC, SO IT RUNS OFF THE MAIN THREAD. A synchronous command runs on it, and this is up to five
/// spawns with a five-second timeout each — a Keychain prompt nobody answered froze the whole window
/// for as long as it waited.
#[tauri::command]
pub async fn provider_hosts() -> Vec<HostProvider> {
    tauri::async_runtime::spawn_blocking(observe_machine).await.unwrap_or_default()
}

/// One answer for this machine: a fresh probe when the last answer is stale, that answer when not.
fn observe_machine() -> Vec<HostProvider> {
    let _probing = PROBING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((at, hosts)) = LAST.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref() {
        if at.elapsed() < FRESH_FOR {
            return hosts.clone();
        }
    }
    // THE THREE AT ONCE. Each is mostly waiting on a child process, so the probe takes as long as its
    // slowest CLI rather than the sum of all three.
    let hosts = std::thread::scope(|scope| {
        let codex = scope.spawn(observe_codex);
        let claude = scope.spawn(observe_claude);
        let muse = scope.spawn(|| observe_gated("meta", "muse"));
        vec![
            codex.join().unwrap_or_else(|_| HostProvider::absent("openai")),
            claude.join().unwrap_or_else(|_| HostProvider::absent("anthropic")),
            muse.join().unwrap_or_else(|_| HostProvider::absent("meta")),
        ]
    });
    logs::say(format!(
        "provider CLIs: {}",
        hosts
            .iter()
            .map(|h| format!(
                "{}={}",
                h.provider,
                if !h.installed { "absent" } else if h.signed_in { "signed in" } else { "installed" }
            ))
            .collect::<Vec<_>>()
            .join(", ")
    ));
    *LAST.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((Instant::now(), hosts.clone()));
    hosts
}

#[cfg(test)]
mod tests {
    use super::*;

    // The strings below are the REAL ones, taken from `codex-cli 0.154.0` and Claude Code on
    // 2026-09-13 — the six lines `codex` can print were read out of its own binary rather than
    // guessed, and the JSON is an actual `claude auth status --json` response with the account
    // details changed. A parser tested against invented output is a parser tested against nothing.

    #[test]
    fn only_a_chatgpt_plan_counts_as_a_codex_subscription() {
        let (signed_in, mode, note) = read_codex_status("Logged in using ChatGPT");
        assert!(signed_in);
        assert_eq!(mode.as_deref(), Some("chatgpt"));
        assert!(note.is_none());
    }

    #[test]
    fn every_other_codex_sign_in_bills_an_api_account() {
        // THE CASE THIS WHOLE MODULE EXISTS FOR. Each of these is a real sign-in, and treating any
        // of them as a subscription would spend a user's API balance while the product claimed to
        // be using their plan.
        for line in [
            "Logged in using an API key - sk-proj-…",
            "Logged in using Amazon Bedrock API key",
            "Logged in using Amazon Bedrock AWS access keys",
            "Logged in using personal access token",
            "Logged in using workload identity",
        ] {
            let (signed_in, mode, note) = read_codex_status(line);
            assert!(!signed_in, "{line} must not count as a subscription");
            assert!(mode.is_some(), "{line} should still report its mode");
            assert!(note.is_some(), "{line} should explain why Chat is unavailable");
        }
    }

    #[test]
    fn an_unrecognised_codex_line_is_not_a_sign_in() {
        // A string we have not seen before is a string whose billing we do not know, so the safe
        // direction is "not signed in" rather than "probably fine".
        for line in ["", "Not logged in", "Logged in via some future mechanism"] {
            let (signed_in, _, _) = read_codex_status(line);
            assert!(!signed_in, "{line:?} must not count as a subscription");
        }
    }

    #[test]
    fn codex_names_its_chatgpt_account_through_the_app_server() {
        // THE ANSWER `account/read` GAVE on 2026-09-14, with the address changed. `codex login status`
        // says only "Logged in using ChatGPT", so without this a row could not say which account.
        let answer = r#"{"id":2,"result":{"account":{"type":"chatgpt","email":"someone@example.com","planType":"go"},"requiresOpenaiAuth":true}}"#;
        assert_eq!(read_codex_account(answer).as_deref(), Some("someone@example.com"));
        // An API-key account has no address worth naming, and a surprise is nothing rather than a guess.
        assert!(read_codex_account(r#"{"id":2,"result":{"account":{"type":"apiKey"},"requiresOpenaiAuth":true}}"#).is_none());
        assert!(read_codex_account(r#"{"id":2,"result":{"account":null,"requiresOpenaiAuth":true}}"#).is_none());
        assert!(read_codex_account(r#"{"id":2,"result":{"account":{"type":"chatgpt","email":"  "}}}"#).is_none());
        assert!(read_codex_account("not json").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_probe_that_does_not_answer_in_time_is_told_apart_from_a_signed_out_one() {
        // THE CASE THAT READ AS A SIGNED-OUT PLAN: `claude auth status` waiting on a Keychain prompt
        // nobody answered, killed at the timeout. It has to reach the row as "did not answer".
        let started = Instant::now();
        let silence = probe_within(Path::new("/bin/sleep"), &["5"], Duration::from_millis(200));
        assert_eq!(silence, Err(Silence::TimedOut));
        assert!(started.elapsed() < Duration::from_secs(3), "the timeout is honoured: {:?}", started.elapsed());
        // An answer is still an answer, and a command that says nothing is its own case.
        assert_eq!(
            probe_within(Path::new("/bin/echo"), &["Logged in using ChatGPT"], PROBE_TIMEOUT).as_deref(),
            Ok("Logged in using ChatGPT")
        );
        assert_eq!(probe_within(Path::new("/usr/bin/true"), &[], PROBE_TIMEOUT), Err(Silence::Empty));
        // And the row's sentence points at the prompt, not at a sign-in.
        assert!(unanswered_note("Claude Code").contains("Keychain"));
    }

    #[test]
    fn a_claude_ai_sign_in_is_a_subscription() {
        let json = r#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty",
            "email":"someone@example.com","orgId":"35495560-3339-4725-b32a-d6c9f3095bb9",
            "subscriptionType":"pro"}"#;
        let (signed_in, mode, account, plan) = read_claude_status(json);
        assert!(signed_in);
        assert_eq!(mode.as_deref(), Some("claude.ai"));
        assert_eq!(account.as_deref(), Some("someone@example.com"));
        assert_eq!(plan.as_deref(), Some("pro"));
    }

    #[test]
    fn a_claude_api_key_sign_in_is_not_a_subscription() {
        let json = r#"{"loggedIn":true,"authMethod":"apiKey","apiProvider":"firstParty"}"#;
        let (signed_in, mode, _, _) = read_claude_status(json);
        assert!(!signed_in);
        assert_eq!(mode.as_deref(), Some("apiKey"));
    }

    #[test]
    fn a_claude_sign_in_that_bills_an_api_account_says_why() {
        // THE CASE THE ROW USED TO GUESS AT. Signed in, still refused, and now told why — the same
        // sentence Codex's reader gives for the same case.
        let json = r#"{"loggedIn":true,"authMethod":"apiKey","apiProvider":"firstParty"}"#;
        let (signed_in, mode, _, _) = read_claude_status(json);
        let note = claude_note(signed_in, mode.as_deref()).expect("an explanation");
        assert!(note.contains("claude auth login"), "{note}");
        // A plan sign-in, or no sign-in at all, has nothing to explain.
        assert!(claude_note(true, Some("claude.ai")).is_none());
        assert!(claude_note(false, None).is_none());
    }

    #[test]
    fn a_signed_out_or_unparseable_claude_reports_nothing() {
        for json in [r#"{"loggedIn":false}"#, "", "not json at all", "{}"] {
            let (signed_in, _, _, _) = read_claude_status(json);
            assert!(!signed_in, "{json:?} must not count as a sign-in");
        }
    }

    #[test]
    fn a_gui_launch_finds_a_per_user_install() {
        // THE BUG THIS CAUGHT. A `.app` opened from Finder inherits no shell PATH, so the search
        // falls back to the fixed lists. With only the system directories, a machine with Claude
        // Code in ~/.local/bin — where its installer puts it — reported it absent while a terminal
        // found it instantly. Asserting the list rather than the filesystem, because CI has neither
        // binary and the thing that was wrong was the list.
        assert!(
            EXTRA_HOME_DIRS.contains(&".local/bin"),
            "Claude Code installs to ~/.local/bin; a GUI launch must look there"
        );
        assert!(EXTRA_DIRS.contains(&"/opt/homebrew/bin"), "Homebrew on Apple silicon");
        assert!(EXTRA_DIRS.contains(&"/usr/local/bin"), "Homebrew on Intel, and npm's default prefix");
    }

    #[test]
    fn the_org_id_never_leaves_the_parser() {
        // `claude auth status` carries orgId and configDirectory. Neither decides anything, both
        // would end up on a wire and in a log, so the parser returns only the account and the plan.
        let json = r#"{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c",
            "orgId":"SECRET-ORG","configDirectory":"/Users/someone/.claude","subscriptionType":"max"}"#;
        let (_, mode, account, plan) = read_claude_status(json);
        for field in [mode, account, plan] {
            assert!(!field.unwrap_or_default().contains("SECRET-ORG"));
        }
    }
}
