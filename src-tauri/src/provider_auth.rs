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
// AND A GATED PROVIDER IS STILL REPORTED HONESTLY. If somebody has Claude Code installed and signed
// in, this says so. It does not decide what that means — the server's capability table does, and it
// answers "not connected" for Anthropic no matter what arrives here. Reporting it anyway is what
// lets the product say "Claude Code is installed on this machine, and Anthropic does not permit
// Jaroku to use it yet" rather than pretending not to have noticed.
//
// WHY PATH IS NOT ENOUGH. A `.app` launched from Finder, from Spotlight, or by LaunchServices
// inherits no shell environment at all — the same fact `backend.rs` documents about
// `JAROKU_BACKEND_URL`. So a user who installed `codex` with Homebrew has it on the PATH of every
// terminal they own and on none that this process can see. The extra directories below are that
// gap, and without them the feature is "works for developers, missing for everybody else".

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

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
    let mut child = Command::new(exe)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;

    // A hand-rolled wait rather than a dependency: this is the only place in the shell that needs
    // a timeout on a child, and `wait_timeout` would be a crate for one loop.
    let deadline = std::time::Instant::now() + PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    logs::say(format!(
                        "provider probe timed out after {}s: {} {}",
                        PROBE_TIMEOUT.as_secs(),
                        exe.display(),
                        args.join(" ")
                    ));
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    }

    let out = child.wait_with_output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
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
        return None;
    }
    Some(text)
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

/// Ask `codex` about itself.
fn observe_codex() -> HostProvider {
    let Some(exe) = locate("codex") else {
        return HostProvider::absent("openai");
    };
    let version = probe(&exe, &["--version"]).map(|v| v.trim().to_string());
    let status = probe(&exe, &["login", "status"]).unwrap_or_default();
    let (signed_in, auth_mode, note) = read_codex_status(&status);
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
        account: None,
        auth_mode,
        note,
    }
}

/// Ask `claude` about itself.
///
/// PROBED IN FULL EVEN THOUGH CLAUDE IS GATED. The server's capability table refuses Anthropic
/// today, and this still does the real work: the integration is finished and waiting on an
/// approval, so the day that arrives the only thing that changes is one field on the server. A
/// detector stubbed out until then would be a detector nobody had ever run.
fn observe_claude() -> HostProvider {
    let Some(exe) = locate("claude") else {
        return HostProvider::absent("anthropic");
    };
    let version = probe(&exe, &["--version"]).map(|v| v.trim().to_string());
    let status = probe(&exe, &["auth", "status", "--json"]).unwrap_or_default();
    let (signed_in, auth_mode, account, plan) = read_claude_status(&status);

    HostProvider {
        provider: "anthropic".to_string(),
        installed: true,
        version,
        signed_in,
        account,
        auth_mode,
        note: plan.map(|p| format!("Claude {p} plan")),
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

/// Everything this machine has, for the page to report inward.
///
/// A COMMAND RATHER THAN AN EVENT, like `status::backend_status` beside it: the page asks when it
/// mounts and after it sends the user to sign in, and there is no ordering to get right. It is also
/// several process spawns, which is a thing to do on request rather than on a timer.
#[tauri::command]
pub fn provider_hosts() -> Vec<HostProvider> {
    let hosts = vec![observe_codex(), observe_claude(), observe_gated("meta", "muse")];
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
