// The application window, and the one thing the shell tells the bundle before it runs.
//
// WHY THE WINDOW IS BUILT HERE RATHER THAN DECLARED IN `tauri.conf.json`. A window in the
// configuration is created during `Builder::build()`, which is before `setup` — and an
// initialisation script can only be attached to a window at creation. The script below is how
// the resolved backend port reaches the client's `hostConfig.ts` before its first module
// evaluates, and everything else about this window would have been perfectly happy declared.
// That is the whole reason, written down so nobody moves it back and spends an afternoon on why
// the port stopped arriving.
//
// THE MINIMUM SIZE IS NOT A GUESS. Jaroku's main view is three columns — sidebar, conversation,
// the trace/graph/evals panel — and the Threads, Agents, Inbox and Activity destinations each
// have a narrow-width fallback below that. 1024 is where the three-column layout stops being
// three columns; going under it is a state the product supports and is not a state a desktop
// window should open in.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// The label everything else refers to this window by — the capability file, the tray's
/// show-and-focus, the single-instance handler, and the window-state plugin's stored geometry.
/// One constant rather than four string literals, because a typo in any of them is a feature
/// that silently does nothing.
pub const MAIN: &str = "main";

pub fn open(app: &AppHandle, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    WebviewWindowBuilder::new(app, MAIN, WebviewUrl::default())
        .title("Jaroku")
        .inner_size(1440.0, 900.0)
        .min_inner_size(1024.0, 680.0)
        .center()
        .resizable(true)
        .initialization_script(&host_config(port))
        .build()?;
    Ok(())
}

/// Bring the existing window to the front.
///
/// THREE CALLS AND NOT ONE, because the ways a window can be out of the way are three different
/// states and each has its own undo. A minimised window is not hidden and a hidden window is not
/// unfocused; calling `set_focus` on a minimised window on Windows raises a taskbar flash and
/// nothing else, which is the failure that reads as "the second launch did nothing".
///
/// Two callers, deliberately sharing one: a second launch of the application, and a `jaroku://`
/// link arriving while the window is behind something. Both are somebody asking for Jaroku and
/// expecting to see it.
pub fn focus_existing(app: &AppHandle) {
    let Some(main) = app.get_webview_window(MAIN) else { return };
    let _ = main.unminimize();
    let _ = main.show();
    let _ = main.set_focus();
}

/// §9.2 — put the workspace's name in the window title.
///
/// WHY THE SHELL OWNS THE TITLE AT ALL, when the page could set `document.title` and be done. In a
/// browser those are the same thing; in a WebViewgnat they are not — the native window has a title of
/// its own, set at creation, and nothing the page writes reaches it. What Alt-Tab, the taskbar and
/// a window list show is the native one.
///
/// THROUGH `invoke` RATHER THAN `@tauri-apps/api/window`, which is the invariant `docs/tauri.md`
/// states by name: the client reaches the shell through `__TAURI__.core.invoke` and nothing else,
/// so the number of modules that know they are inside Tauri stays at three and neither
/// `package.json` grows a dependency on it. It also means the capability file grants one command
/// rather than a window-permission group.
///
/// IT CLAMPS AND FALLS BACK RATHER THAN REFUSING. A workspace name is 1-64 characters by the time
/// the server has stored one, so the clamp is belt-and-braces — but this string comes from the page
/// and the failure of a bad one is a window with no title at all, which reads as a broken build.
/// An empty name yields the product's own name, which is what the window opened with.
#[tauri::command]
pub fn set_window_title(app: AppHandle, name: Option<String>) {
    let Some(main) = app.get_webview_window(MAIN) else { return };
    let trimmed = name.unwrap_or_default().trim().chars().take(64).collect::<String>();
    // An em dash rather than a hyphen: the two halves are a product and a place, not a compound.
    let title = if trimmed.is_empty() { "Jaroku".to_string() } else { format!("Jaroku — {trimmed}") };
    let _ = main.set_title(&title);
}

/// The script that runs before the bundle does.
///
/// IT SETS ONE FIELD AND IT IS FROZEN. A host configuration object that the page can rewrite is
/// a host configuration object that a bug rewrites, and the failure would be a socket pointed at
/// a port nothing is listening on — which reads as "the backend is down" rather than as "the
/// address was changed". `Object.freeze` costs nothing and makes that impossible.
///
/// The port is a `u16` and is formatted through `serde_json`, so there is no string here a value
/// could break out of. That is belt-and-braces rather than a real risk — the number came from
/// `TcpListener` — but this string is executed as script in the application's own context, and
/// "the input is trusted" is the sentence that precedes most injection bugs.
fn host_config(port: u16) -> String {
    let url = serde_json::Value::String(ws_url(port));
    format!("window.__JAROKU_CONFIG__ = Object.freeze({{ wsUrl: {url} }});")
}

/// The socket URL for a port, spelled once.
///
/// Two callers now — the script above, and `status.rs`, which carries the current URL on every
/// status it sends because the port can move after the script has run. Two spellings of one
/// address is exactly the kind of duplication that stays correct until somebody adds a `wss` case
/// to one of them.
pub fn ws_url(port: u16) -> String {
    format!("ws://localhost:{port}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_injected_url_is_a_ws_url_on_the_resolved_port() {
        assert_eq!(
            host_config(4318),
            "window.__JAROKU_CONFIG__ = Object.freeze({ wsUrl: \"ws://localhost:4318\" });"
        );
    }

    #[test]
    fn the_default_port_is_injected_unchanged_so_a_normal_launch_matches_the_build_time_fallback() {
        // The client's fallback is `ws://localhost:4317`. On the ordinary launch the host says
        // the same thing, which is what makes the override invisible when nothing needed it.
        assert!(host_config(4317).contains("ws://localhost:4317"));
    }
}
