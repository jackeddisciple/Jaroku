// The name of the computer this app is running on, for the header over the conversation.
//
// THE NAME SOMEBODY GAVE THEIR MACHINE, NOT ITS HOSTNAME. macOS keeps both: `scutil --get
// ComputerName` is "Adarsh's MacBook Air", the name System Settings shows and Finder's sidebar uses,
// while the hostname is `Adarshs-MacBook-Air.local`, a DNS-safe spelling of it that nobody would
// recognise as theirs. Windows and Linux keep only the one, so that is what they report.
//
// A COMMAND RATHER THAN SOMETHING INJECTED AT STARTUP, because the page only needs it once a
// conversation is on screen, and a person can rename the machine while the app is open.

/// The longest name handed to the page. macOS caps a computer name at 63 bytes, so anything longer
/// is not a name anybody typed.
const MAX_CHARS: usize = 64;

/// This machine's name, or `None` when the platform would not say.
///
/// ASYNC, SO IT RUNS OFF THE MAIN THREAD. On macOS it is a process spawn, and a synchronous command
/// runs on the thread that draws the window.
#[tauri::command]
pub async fn machine_name() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| raw().as_deref().and_then(clean))
        .await
        .ok()
        .flatten()
}

#[cfg(target_os = "macos")]
fn raw() -> Option<String> {
    let out = std::process::Command::new("/usr/sbin/scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout).ok()
}

#[cfg(target_os = "windows")]
fn raw() -> Option<String> {
    std::env::var("COMPUTERNAME").ok()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn raw() -> Option<String> {
    std::fs::read_to_string("/etc/hostname").ok()
}

/// A name fit to print: control characters gone, trimmed, capped, and `None` when nothing is left.
fn clean(raw: &str) -> Option<String> {
    let visible: String = raw.chars().filter(|c| !c.is_control()).collect();
    let name: String = visible.trim().chars().take(MAX_CHARS).collect();
    let name = name.trim_end().to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

#[cfg(test)]
mod tests {
    use super::clean;

    #[test]
    fn keeps_a_name_as_it_was_given() {
        assert_eq!(clean("Adarsh’s MacBook Air\n").as_deref(), Some("Adarsh’s MacBook Air"));
    }

    #[test]
    fn nothing_printable_is_no_name() {
        assert_eq!(clean(""), None);
        assert_eq!(clean("  \n\t "), None);
        assert_eq!(clean("\u{7}\u{1b}"), None);
    }

    #[test]
    fn control_characters_are_dropped_and_the_length_is_capped() {
        assert_eq!(clean("Mac\u{1b}Book").as_deref(), Some("MacBook"));
        assert_eq!(clean(&"a".repeat(200)).map(|n| n.chars().count()), Some(64));
    }
}
