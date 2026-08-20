// What the shell is doing about the backend, told to the page.
//
// THE HOLE THIS FILLS. The window opens before the backend starts — deliberately, so a first
// launch that has a runtime to unpack shows something rather than nothing — and from that moment
// the page is on its own. If extraction fails, if the payload is missing, if the port cannot be
// had, if the backend crashes three times and the supervisor gives up, the page's information is
// identical in every case: a socket that will not open. So it renders "connecting", forever,
// truthfully describing what IT is doing and saying nothing about what has actually happened.
// That is the freeze as a user experiences it — not a hang, an application that cannot say it has
// failed.
//
// So the half of the system that knows says so. Four phases, and the only one that changes what
// the page renders is the last:
//
//   preparing   the payload or the Python runtime is being unpacked. First launch and upgrades.
//   started     a backend process is up. NOT "ready" — this shell does not know when the relay is
//               listening, and claiming it did would be a phase that lies for a second on every
//               launch. Whether the server can be reached is the page's own question, and the page
//               already answers it.
//   restarting  it exited without being asked to, and another attempt is coming.
//   failed      the supervisor has stopped. This is the one the page must render, because it is
//               the one that never resolves on its own.
//
// AND EVERY EVENT CARRIES THE SOCKET URL. The port can move — `sidecar.rs` re-resolves it when a
// restart finds the old one taken — and the page was told the original at load time. Carrying the
// current one on every status means a move corrects itself rather than becoming a second failure
// nobody can see.
//
// A COMMAND BESIDE THE EVENT, for the reason `deeplink.rs` has a queue: a status settled before
// React mounted is a status no listener heard. The page asks once on mount and subscribes for the
// rest, so there is no ordering to get right.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::{logs, sidecar, window};

/// The event the page listens for. Colon-separated for the reason `deeplink::EVENT` is: it must
/// never be mistaken for one of the `jaroku.*` browser-storage keys `test:reset` audits by prefix.
pub const EVENT: &str = "jaroku:backend";

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Preparing,
    Started,
    Restarting,
    Failed,
}

#[derive(Serialize, Clone)]
pub struct Status {
    pub phase: Phase,
    /// Where the backend is, or will be. Always present, always current.
    #[serde(rename = "wsUrl")]
    pub ws_url: String,
    /// One sentence a person can act on. Present on `restarting` and `failed`.
    pub message: Option<String>,
    /// Where the whole story is. The page offers this rather than printing it: a log path is
    /// something somebody copies into a bug report, and the log itself is not a UI.
    #[serde(rename = "logPath")]
    pub log_path: Option<String>,
}

/// The last thing said, so a page that mounts afterwards can be told it.
///
/// `pub` only because the command below takes it as managed state and Tauri resolves that through
/// the signature; nothing outside this module constructs or reads one.
pub struct Latest(Mutex<Status>);

pub fn init(app: &AppHandle, port: u16) {
    app.manage(Latest(Mutex::new(Status {
        phase: Phase::Preparing,
        ws_url: window::ws_url(port),
        message: None,
        log_path: logs::path().map(|p| p.to_string_lossy().into_owned()),
    })));
}

/// Say what is happening. Recorded first, emitted second, so the log and the page never disagree.
pub fn announce(app: &AppHandle, phase: Phase, message: Option<String>) {
    let status = Status {
        phase,
        ws_url: window::ws_url(app.state::<sidecar::Backend>().port()),
        message,
        log_path: logs::path().map(|p| p.to_string_lossy().into_owned()),
    };

    if let Some(latest) = app.try_state::<Latest>() {
        if let Ok(mut slot) = latest.0.lock() {
            *slot = status.clone();
        }
    }
    logs::detail(format!(
        "backend is {:?} on {}{}",
        status.phase,
        status.ws_url,
        status.message.as_deref().map(|m| format!(" — {m}")).unwrap_or_default(),
    ));
    // `emit` succeeds whether or not anybody is listening, which is why the state above exists.
    let _ = app.emit(EVENT, status);
}

/// What the shell last said. For a page that was not there when it said it.
#[tauri::command]
pub fn backend_status(latest: tauri::State<'_, Latest>) -> Option<Status> {
    latest.0.lock().ok().map(|s| s.clone())
}
