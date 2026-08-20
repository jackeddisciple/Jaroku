// The macOS menu bar.
//
// macOS ONLY, AND THAT IS A DESIGN DECISION RATHER THAN AN OMISSION. On macOS the menu bar lives
// at the top of the SCREEN and every application has one whether it wants one or not; an app with
// no menu bar there is an app whose window cannot be closed from the keyboard and whose name does
// not appear beside the apple. On Windows and Linux a Tauri menu is drawn INSIDE the window, as a
// strip above the content — and Jaroku's window is "a panel on a surface with an 8px inset, a
// hairline, and a four-level elevation scale", with its own header carrying the workspace, the
// destination and the search. A grey File/Edit/View strip above that is a second chrome from a
// different decade sitting on top of a deliberate one. Those platforms get the system tray
// instead, which is where their conventions actually put an always-available control.
//
// AND THE EDIT MENU IS NOT DECORATION. This is the part that surprises people: on macOS, a
// WebView's copy, paste, select-all and undo are wired to the standard Edit menu's key
// equivalents. With no Edit menu, ⌘C and ⌘V DO NOTHING inside the app — in a product whose main
// interaction is a text composer, and whose Agents tab has a "Copy agent context" action that
// exists to be pasted into an issue. Every item below is a predefined role for that reason: a
// hand-rolled menu item that emitted an event would put a second, subtly different clipboard
// implementation beside the platform's.
//
// The keyboard shortcuts the PRODUCT owns are untouched by any of this. ⌘K, ⌘P, ⌘/, ⌘Z on the
// Inbox board, J/K everywhere — those are the client's binding layer, they work identically in a
// browser, and nothing here duplicates one. A menu item that fired ⌘K would be a second
// definition of a binding that already has one.

#![cfg(target_os = "macos")]

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::AppHandle;

/// Emitted when "Open the Jaroku folder" is chosen. The page decides what to do with it, which
/// today is nothing — the item exists because the answer to "where did my agents go" is a path,
/// and a support conversation that can say "the app will show you" is shorter than one that
/// spells out `~/.jaroku` and then explains what a dotfile is.
pub const ID_OPEN_HOME: &str = "jaroku:open-home";

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let app_menu = Submenu::with_items(
        app,
        "Jaroku",
        true,
        &[
            // The metadata comes from the bundle rather than from literals here, so the version
            // in the About box is the version that was built. A hardcoded one is a number that is
            // right on the day it is typed.
            &PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, ID_OPEN_HOME, "Open the Jaroku Folder", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            // Services, Hide, Hide Others and Show All are what make an app feel like a macOS
            // app rather than a window that happens to be running there. They cost one line each.
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    // See the header: without these, ⌘C and ⌘V do nothing inside the webview.
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            // ⌘W closes the window; on macOS that leaves the application running, which is the
            // platform's own convention and is also what makes the tray's "Show Jaroku" mean
            // something. Quit is in the app menu, where a Mac user looks for it.
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let menu = Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])?;
    app.set_menu(menu)?;

    app.on_menu_event(|_app, event| {
        if event.id() == ID_OPEN_HOME {
            open_home();
        }
    });
    Ok(())
}

/// Show the Jaroku folder in Finder.
///
/// `open` rather than a plugin. `tauri-plugin-opener` would be the tidy answer and would mean
/// granting the webview a permission to open paths — a capability the page has no use for and
/// which, granted, is a way for anything running in it to ask the operating system to launch
/// something. This path is a constant, it is spawned from Rust, and nothing the page says reaches
/// it.
fn open_home() {
    let Some(home) = crate::paths::jaroku_home() else { return };
    let _ = std::fs::create_dir_all(&home);
    let _ = std::process::Command::new("open").arg(&home).spawn();
}
