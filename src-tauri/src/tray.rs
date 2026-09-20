// The system tray, on all three platforms, and the reason closing the window does not quit.
//
// A TRAY THAT ONLY REOPENS A WINDOW IS DECORATION. This one exists because of what Jaroku is: a
// run can take minutes, an eval fans a dataset out across providers and takes longer, a deploy
// streams a build log, and every one of those is happening inside the Node backend this shell
// supervises. If closing the window ended the process, closing it would cancel work somebody
// started and is paying a provider for — and it would do so silently, because a window that is
// closing does not stop to explain itself.
//
// So the close button HIDES the window and the application keeps running, with the tray as the
// way back and the way out. That is a real change from what a browser tab does, it is the
// convention for every application that does work while you are not looking at it, and it is
// written down here and in docs/tauri.md rather than left for somebody to discover.
//
// THE ESCAPE HATCH IS NEVER MORE THAN ONE CLICK AWAY, because "I cannot quit this application" is
// the failure mode this pattern actually has. Quit is the last item in the tray menu on every
// platform, and on macOS it is also ⌘Q in the app menu where a Mac user already looks for it.
// AND: if the tray cannot be created at all — a Linux session with no StatusNotifier host, which
// is a real configuration — the close button is left alone and quits, because hiding a window
// with nothing to bring it back is the one outcome worse than cancelling a run.

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::{logs, window};

const ID_SHOW: &str = "jaroku:tray-show";
const ID_QUIT: &str = "jaroku:tray-quit";

/// Build the tray icon. `Ok(false)` means the platform would not give us one, which is a
/// configuration rather than a fault — see the header on what the caller does about it.
pub fn install(app: &AppHandle) -> tauri::Result<bool> {
    let show = MenuItem::with_id(app, ID_SHOW, "Show Jaroku", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, ID_QUIT, "Quit Jaroku", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &PredefinedMenuItem::separator(app)?, &quit])?;

    // THE MENU BAR IS NOT A SMALL DOCK, and this is the one place the logo is deliberately not the
    // logo. macOS draws a tray icon as a TEMPLATE: it discards the colours, keeps the coverage, and
    // redraws it in the bar's own ink — which is how an icon follows a light bar, a dark bar, and
    // the inverted ink it gets while its own menu is open. Hand that the orange plate and macOS
    // renders a solid rounded rectangle. So macOS gets `assets/mono.png`'s silhouette, which is the
    // piece of artwork drawn for exactly this, by way of `icons/tray@2x.png`.
    //
    // EVERY OTHER PLATFORM GETS THE PLATE. Windows and Linux composite a tray icon as it is, over a
    // notification area whose colour they do not tell us; a black-on-transparent glyph there is
    // invisible against half the themes in existence. Those keep the window icon, as before.
    #[cfg(target_os = "macos")]
    let (icon, is_template) = (Image::from_bytes(include_bytes!("../icons/tray@2x.png"))?, true);
    #[cfg(not(target_os = "macos"))]
    let (icon, is_template) = {
        let Some(icon) = app.default_window_icon().cloned() else {
            return Ok(false);
        };
        (icon, false)
    };

    let built = TrayIconBuilder::with_id("jaroku")
        .icon(icon)
        // macOS only, and a no-op everywhere else — see above for what it buys and what it costs
        // if the icon handed to it is not a silhouette.
        .icon_as_template(is_template)
        .tooltip("Jaroku")
        .menu(&menu)
        // FALSE, so a left click is not swallowed by the menu on Windows and Linux, where the
        // expectation is that clicking a tray icon opens the thing. macOS expects the menu on
        // either button and gets it from the handler below, which only acts on a LEFT click —
        // so the right-click menu keeps working everywhere without a special case.
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event
            {
                // On `Up` rather than `Down`: a click that raises a window on press means a
                // drag of the icon — which is how a tray icon is REORDERED on Windows — also
                // raises the window.
                window::focus_existing(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            ID_SHOW => window::focus_existing(app),
            // `exit` rather than closing the window: this is the deliberate way out, and it is
            // the path that reaches `RunEvent::Exit` and therefore `sidecar::stop`, which asks
            // the backend to drain before it goes. A quit that skipped that would lose the tail
            // of a trace that visibly ran, which is the thing the drain exists for.
            ID_QUIT => app.exit(0),
            _ => {}
        })
        .build(app);

    match built {
        Ok(_) => Ok(true),
        Err(err) => {
            // Named, not swallowed. On Linux this is usually "no StatusNotifier host is running",
            // which is a sentence somebody can act on, and the consequence — the close button
            // quits instead of hiding — is a behaviour change they would otherwise have to guess
            // the cause of.
            logs::say(format!("no system tray on this session ({err}); closing the window will quit"));
            Ok(false)
        }
    }
}

/// Make the close button hide the window instead of ending the application.
///
/// Only called when the tray was actually created. See the header: hiding a window with no way to
/// bring it back is worse than cancelling a run, and worse than either is doing it to somebody
/// who cannot tell which of the two just happened.
pub fn hide_on_close(app: &AppHandle) {
    let Some(main) = app.get_webview_window(window::MAIN) else { return };
    main.clone().on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = main.hide();
        }
    });
}
