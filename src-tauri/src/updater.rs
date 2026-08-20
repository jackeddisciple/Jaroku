// Tauri's built-in updater, and why it is behind a Cargo feature.
//
// THE UPDATER CANNOT BE BUILT WITHOUT A SIGNING KEY PAIR, and that is the point of it: an update
// is a signed artefact, the public half goes in the configuration, and the private half signs
// each release. If the public key were absent or wrong, the updater would either refuse to build
// or — worse — install whatever an endpoint handed it. So the key is a real prerequisite rather
// than a formality, this repository has neither half of one and must never have the private half,
// and a default build that pretended otherwise would be a build whose update path had never been
// exercised by anybody.
//
// So: `--features updater`, plus `--config src-tauri/tauri.updater.conf.json` carrying the
// endpoint and the public key. A default build has no updater and says so; a release build has
// one and had to be given the two things it genuinely needs. docs/tauri.md has the commands.
//
// THE ENDPOINT IS NOT INVENTED HERE. The overlay file's placeholder uses the `.invalid` top-level
// domain, which RFC 2606 reserves precisely so that it can never resolve to anything. A plausible
// hostname would be a URL somebody could register, and an unconfigured build reaching for a
// domain a stranger owns is the whole of a supply-chain compromise. `.invalid` fails as a DNS
// error, which is what an unconfigured updater should look like.
//
// WHAT IT DOES WHEN IT FINDS ONE: says so, and stops. Downloading and restarting an application
// out from under somebody who is watching a run stream is not something to do without asking, and
// the surface that would ask belongs to a specification this work is not. `install_update` is the
// call that surface makes; until it exists, an available update is an event and a log line.

#![cfg(feature = "updater")]

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// Emitted when a check finds something. Colon-separated for the reason `deeplink::EVENT` is.
pub const EVENT: &str = "jaroku:update-available";

#[derive(Serialize, Clone)]
pub struct Available {
    pub version: String,
    /// The release notes from the manifest, when it carries any. Rendered by whatever surface
    /// eventually asks; never parsed.
    pub notes: Option<String>,
}

/// Ask the endpoint whether there is a newer version.
///
/// Returns `Ok(None)` both for "you are up to date" and for "the endpoint could not be reached",
/// and the collapse is deliberate. A user offline, an endpoint that is down, and a genuinely
/// current version are three causes with one correct behaviour: carry on running the application
/// they already have. The difference goes to the log, where somebody debugging can see it, and
/// not to a dialog, where it would be an error about something nobody asked for.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<Available>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => Ok(Some(Available { version: update.version.clone(), notes: update.body.clone() })),
        Ok(None) => Ok(None),
        Err(err) => {
            crate::logs::say(format!("update check did not complete: {err}"));
            Ok(None)
        }
    }
}

/// Download, verify, install, and restart.
///
/// RE-CHECKS RATHER THAN HOLDING THE UPDATE FROM THE EARLIER CALL. That costs one request and
/// removes a piece of state whose failure mode is installing a version somebody was told about
/// ten minutes and one release ago. The signature is verified by the plugin against the public key
/// in the configuration — that verification is the whole security model of this feature, and
/// nothing here is in a position to weaken it.
///
/// It does not return: `restart` replaces the process. The `Ok(())` exists for the paths where
/// there was nothing to install.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(());
    };
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;

    // The backend is asked to stop before the process is replaced. `restart` does not raise
    // `RunEvent::Exit`, so the shutdown that drains the trace-ingest chain would otherwise be
    // skipped — and an update that lost the end of a run somebody watched would be a strange
    // thing to have gone to this much trouble over.
    crate::sidecar::stop(&app);
    // NO SEMICOLON. `restart` returns `!` — it replaces this process and does not come back — and
    // as a statement it would leave the function falling off the end without the `Result` it
    // promises. As the tail expression the never type coerces to it, which is both what compiles
    // and what is true.
    app.restart()
}

/// Check once, shortly after launch.
///
/// AFTER A DELAY, and not because the request is expensive. A launch is already doing the two
/// things that matter — extracting a payload and starting a backend — and an update check racing
/// them competes for exactly the disk and network a first launch needs. Thirty seconds puts it
/// after both on any machine and is still inside the session of anybody who is going to work.
pub fn check_on_launch(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        if let Ok(Some(available)) = check_for_update(app.clone()).await {
            crate::logs::say(format!("version {} is available", available.version));
            let _ = app.emit(EVENT, available);
        }
    });
}
