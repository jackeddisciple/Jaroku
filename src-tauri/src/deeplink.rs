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

use crate::{logs, window};

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
        logs::say(format!("could not register the jaroku:// scheme: {err}"));
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
    logs::say(format!("received {url}"));

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

// --- the outbound half ---------------------------------------------------------------------------
//
// Everything above receives a URL from the operating system. This sends one TO it, and the two
// belong in one file because they are one round trip: the app opens a payment page in the system
// browser, and the browser comes back through `jaroku://`. Splitting them would put half a
// conversation in each of two modules.
//
// WHY THE APP CANNOT JUST NAVIGATE THERE. Stripe Checkout is built for a real browser — saved cards,
// autofill, and a 3-D Secure challenge that may itself redirect to a bank. None of that works
// reliably in an embedded webview, and `window.location.assign` inside the app navigates the APP
// away with no route back, because the return URL is a web origin the packaged frontend is not
// served from. So the payment step is a deliberate, single hop out and back.
//
// AND WHY IT IS A COMMAND RATHER THAN A PLUGIN PERMISSION. `tauri-plugin-opener` would be the tidy
// answer and would mean granting the webview a permission to open arbitrary URLs — see menu.rs,
// which declines the same offer for the same reason. A capability the page holds is a capability
// anything running in the page holds, and this one launches programs. So the frontend asks, and
// THIS decides, against a rule the frontend cannot influence — and the capability file stays at the
// two permissions it has had since the wrapper shipped.
//
// It goes through `tauri-plugin-opener`, called from RUST. The plugin being present is not the
// same as the page being allowed to use it: a capability is granted per window in
// capabilities/default.json, and that file still lists exactly `core:default` and
// `deep-link:default`. `tauri-plugin-shell` is registered on the same terms and has been since the
// wrapper shipped — it spawns the backend and the page cannot reach it either.

/// Hosts a checkout may be opened at.
///
/// AN ALLOWLIST, NOT A SCHEME CHECK, and the difference is the whole security of this command. The
/// page hands over a URL it got from our own server, but "from our own server" is not something
/// this side can verify — a compromised or merely buggy frontend would be asking with whatever it
/// had. `https://` alone would permit every site on the internet; these three are the only hosts a
/// payment flow ever needs.
const ALLOWED_HOSTS: [&str; 3] = ["checkout.stripe.com", "billing.stripe.com", "checkout.jaroku.dev"];

/// Whether this URL may be handed to the operating system.
///
/// Split out and `pub` so it can be tested without a running app: the rule is the valuable part and
/// a rule that can only be exercised by launching a desktop application is a rule nobody exercises.
/// The same argument `deepLink.ts` makes about keeping the inbound parser in the frontend.
pub fn may_open(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else { return false };
    if parsed.scheme() != "https" {
        return false;
    }
    // EXACT HOST MATCH, never a suffix test. `ends_with("stripe.com")` also admits
    // `checkout.stripe.com.evil.example`, which is the oldest hole in this shape of check.
    parsed.host_str().is_some_and(|host| ALLOWED_HOSTS.contains(&host))
}

/// Open a payment page in the user's own browser.
///
/// Returns an error the page can render rather than panicking: a refused URL is a bug worth seeing,
/// and a spawn that fails is a machine with no browser configured — neither should take the app
/// down, and both should say which happened.
#[tauri::command]
pub fn open_checkout(app: AppHandle, url: String) -> Result<(), String> {
    if !may_open(&url) {
        // The URL is NOT echoed into the error. It came from outside this function and is about to
        // be rendered in a webview; the log line has it for whoever is debugging.
        logs::say(format!("refused to open a URL that is not a payment page: {url}"));
        return Err("that is not a payment page this app will open".into());
    }
    let _ = &app;
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|err| {
        logs::say(format!("could not open the system browser: {err}"));
        "could not open your browser — copy the link and open it yourself".to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_payment_page_may_be_opened() {
        // The three hosts a checkout flow ever needs, spelled as literals rather than read from
        // ALLOWED_HOSTS — so the suite fails if somebody edits the constant, which would be
        // editing what this app is willing to launch.
        assert!(may_open("https://checkout.stripe.com/c/pay/cs_test_a1b2c3"));
        assert!(may_open("https://billing.stripe.com/p/session/live_abc"));
        assert!(may_open("https://checkout.jaroku.dev/success?session_id=cs_test_x"));
    }

    #[test]
    fn a_lookalike_host_is_not_a_match() {
        // THE OLDEST HOLE IN THIS SHAPE OF CHECK. `ends_with("stripe.com")` admits every one of
        // these, and each is a domain anybody can register this afternoon.
        assert!(!may_open("https://checkout.stripe.com.evil.example/c/pay"));
        assert!(!may_open("https://evil-checkout.stripe.com.attacker.test/"));
        assert!(!may_open("https://notcheckout.stripe.com/"));
        // A userinfo section is the other half of the same trick: everything before the `@` is a
        // credential, not a host, and a reader that scanned the string would find the wrong one.
        assert!(!may_open("https://checkout.stripe.com@evil.example/pay"));
    }

    #[test]
    fn a_scheme_that_is_not_https_is_refused_whatever_the_host() {
        // http, because a payment page over plain http is one anybody on the path can rewrite.
        assert!(!may_open("http://checkout.stripe.com/c/pay"));
        // file and javascript, because this string reaches the operating system: a shell asked to
        // "open" either of those does something considerably more interesting than show a page.
        assert!(!may_open("file:///etc/passwd"));
        assert!(!may_open("javascript:alert(1)"));
        // And our own scheme, which would be the app asking the OS to reopen the app.
        assert!(!may_open("jaroku://billing/success"));
    }

    #[test]
    fn nonsense_is_refused_rather_than_parsed_halfway() {
        assert!(!may_open(""));
        assert!(!may_open("checkout.stripe.com"), "a bare host is not a URL");
        assert!(!may_open("not a url at all"));
        assert!(!may_open("https://"), "a scheme with no host is not a page");
    }
}
