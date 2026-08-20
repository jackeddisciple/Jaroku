// Where Jaroku's desktop-side state lives, resolved in one place.
//
// `~/.jaroku` ON UNIX AND `%APPDATA%\jaroku` ON WINDOWS, which is the layout the specification
// names and is deliberately NOT Tauri's own `app_data_dir()`. Two reasons, and the second is the
// one that matters. The first is that a user who has ever run Jaroku from a terminal already has
// a home for its runtime state and a second one keyed by bundle identifier would be a second
// copy of the same facts. The second is that `app_data_dir()` on macOS is
// `~/Library/Application Support/<identifier>` — a path the bundle identifier appears in — so
// renaming the bundle would strand a user's extracted Python runtime and their first-launch
// marker somewhere they will never look, and the app would silently re-extract several hundred
// megabytes and call itself freshly installed.

use std::path::PathBuf;

/// The root of Jaroku's per-user state: `~/.jaroku` (Unix) or `%APPDATA%\jaroku` (Windows).
///
/// Returns `None` only when the platform cannot say where home is, which is a real case inside
/// some sandboxed and service-account contexts. Every caller treats that as "this machine cannot
/// host the bundled runtime" and says so, rather than falling back to a temporary directory that
/// a reboot would empty underneath an installed application.
pub fn jaroku_home() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        // APPDATA is the roaming profile, which is where per-user application state belongs on
        // Windows and what the specification names. USERPROFILE is the documented fallback for
        // the environments that do not set it — a stripped service account, some CI images.
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return Some(PathBuf::from(appdata).join("jaroku"));
        }
        std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join("AppData").join("Roaming").join("jaroku"))
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".jaroku"))
    }
}

/// Where the bundled Python interpreter and Jaroku's pinned dependencies are extracted to.
pub fn venv_dir() -> Option<PathBuf> {
    jaroku_home().map(|p| p.join("venv"))
}

/// The first-launch marker. Its presence means extraction and checkpoint-database
/// initialisation both finished; its absence means at least one of them did not.
pub fn marker_file() -> Option<PathBuf> {
    jaroku_home().map(|p| p.join("app-initialized"))
}
