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
    let url = serde_json::Value::String(format!("ws://localhost:{port}"));
    format!("window.__JAROKU_CONFIG__ = Object.freeze({{ wsUrl: {url} }});")
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
