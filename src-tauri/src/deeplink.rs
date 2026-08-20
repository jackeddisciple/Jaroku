// `jaroku://` — registering the scheme, and getting a URL to the page in all three of the states
// the application can be in when one arrives.
//
// WHAT THIS DOES AND DOES NOT DO. It registers the scheme, receives the URL and hands it to the
// frontend. It does not interpret one: what `jaroku://auth/callback?...` MEANS — redeeming a
// magic link, finishing an OAuth round trip, matching a state parameter — is a separate
// specification, and the handler here logs and forwards. That split is deliberate rather than
// unfinished: a URL from outside the application is untrusted input, and the code that decides
// what to do with it belongs beside the session it would be acting on, not in the shell.
//
// THE THREE STATES, and the third is the one that needs work:
//
//   RUNNING, IN FRONT — the plugin's handler fires, the URL is emitted, the page has a listener
//   attached and receives it. Nothing else is needed.
//
//   RUNNING, BEHIND — the same, plus the window has to come forward. A deep link is somebody
//   clicking something expecting Jaroku to respond; leaving the answer behind three other windows
//   is indistinguishable from nothing having happened.
//
//   NOT RUNNING — the operating system starts the app WITH the URL, so the handler fires during
//   startup, which is before the webview exists and long before any React effect has subscribed.
//   An event emitted then goes nowhere. So a URL that arrives with no listener is HELD, and the
//   page drains the queue when it mounts. That queue is the entire reason this module has state.
//
// On Windows and Linux the not-running case is really a second process: the OS starts a new
// instance carrying the URL in argv, and `tauri-plugin-single-instance` hands it to the first
// one. See lib.rs for why that plugin is registered before every other.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

use crate::window;

/// The event the page listens for. Colon-separated rather than dot-separated so it can never be
/// mistaken for one of the `jaroku.*` browser-storage keys, which `test:reset` audits by
/// scanning the client source for exactly that prefix.
pub const EVENT: &str = "jaroku:deep-link";

/// URLs that arrived before anything was listening. See the header's third case.
#[derive(Default)]
pub struct Pending(Mutex<Vec<String>>);

pub fn init(app: &AppHandle) {
    app.manage(Pending::default());

    // REGISTERED AT RUNTIME ON WINDOWS AND LINUX, AND NOT ON macOS. macOS takes the scheme from
    // the bundle's own Info.plist, which `tauri.conf.json` produces at build time — asking for it
    // again at runtime is both unnecessary and unavailable. The other two associate the scheme
    // with the executable's current path, which is exactly what a development build needs and
    // exactly what an installer does for a packaged one. Failure is logged rather than fatal: an
    // app that refused to start because it could not claim a URL scheme would be trading the
    // whole product for one feature.
    #[cfg(any(windows, target_os = "linux"))]
    if let Err(err) = app.deep_link().register_all() {
        eprintln!("[jaroku] could not register the jaroku:// scheme: {err}");
    }

    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            deliver(&handle, url.as_str());
        }
    });
}

/// Emit a URL to the page, or hold it until there is a page.
///
/// `Emitter::emit` succeeds whether or not anybody is listening, so "did that reach anything?"
/// cannot be answered by its return value. What CAN be answered is whether a webview exists at
/// all, which is the difference that actually matters here — the not-running case is precisely
/// the one where it does not.
pub fn deliver(app: &AppHandle, url: &str) {
    println!("[jaroku] received {url}");

    if app.get_webview_window(window::MAIN).is_none() {
        if let Some(pending) = app.try_state::<Pending>() {
            if let Ok(mut queue) = pending.0.lock() {
                // Bounded, because this queue is fed by anything on the machine that can open a
                // URL. Sixteen is far more than a person can produce and small enough that a
                // program producing them in a loop cannot grow this without limit. The OLDEST is
                // dropped: a burst of deep links ends with the one somebody most recently meant.
                if queue.len() >= 16 {
                    queue.remove(0);
                }
                queue.push(url.to_owned());
            }
        }
        return;
    }

    // Forward, then bring the window out. In that order: emitting first means the page has
    // already begun whatever the link asked for by the time it is looked at, rather than
    // appearing and then doing something a moment later.
    let _ = app.emit(EVENT, url);
    window::focus_existing(app);
}

/// Hand the page whatever arrived before it existed, and empty the queue.
///
/// DRAINED RATHER THAN READ. A link is an instruction to do something once — sign in, open this
/// thread — and a queue that could be read twice is one where a reload repeats it. Emptying it
/// here means the page that asked is the page that gets it, and a second caller gets nothing.
#[tauri::command]
pub fn drain_deep_links(pending: tauri::State<'_, Pending>) -> Vec<String> {
    pending.0.lock().map(|mut queue| std::mem::take(&mut *queue)).unwrap_or_default()
}
