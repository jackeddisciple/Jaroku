// Which backend this window talks to, and it is one of exactly two things.
//
// THE SHELL WAS ALWAYS A SUPERVISOR. It resolves a port, extracts a payload, unpacks a CPython,
// starts `tsx src/index.ts` and keeps it alive — a whole Jaroku on the machine, with its own
// database. That is the right shape for one person on a laptop and the wrong one for a product
// where two hundred people share accounts: two installs of that are two databases, and "signing
// up" on one of them is invisible to the other.
//
// SO THERE IS A SECOND SHAPE, and this module is the whole of the decision between them:
//
//   LOCAL   — everything above. The default, unchanged, and what `npm run tauri:dev` still does.
//   REMOTE  — supervise nothing. No port, no payload, no Python, no sidecar. The window points at
//             a Jaroku that is already running somewhere and the page talks to it exactly as a
//             browser tab would, because `hostConfig.ts` accepts `wss://` and every HTTP surface
//             in the client derives from the same value (`apiBase` rewrites the scheme).
//
// THE CLIENT NEEDED NO CHANGES FOR THIS, which is worth saying out loud because it is the payoff
// of a decision made long before: the injected socket URL was always a SEED the page reads rather
// than a constant compiled into it, precisely so a host could correct it. A remote backend is that
// same seam used one step further out.
//
// AND THE MODE IS AN ENVIRONMENT VARIABLE RATHER THAN A BUILD FLAG, so one binary can be pointed
// at a staging deployment, at production, or at nothing — and so the local path cannot be
// compiled away by accident. An absent or malformed value is LOCAL: the failure of guessing wrong
// here is a window pointed at a server that does not exist, and the safe direction is the one that
// still works with no network at all.

/// The variable that switches the shell into a thin client.
///
/// A `wss://` (or `ws://`) URL, because that is what the page is actually given — the HTTP base is
/// derived from it by the client, so naming the socket names both and they cannot drift apart.
pub const BACKEND_URL_ENV: &str = "JAROKU_BACKEND_URL";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Backend {
    /// Supervise a backend on this machine. Carries nothing: the port is resolved later.
    Local,
    /// Talk to one that is already running. Carries the socket URL to hand the page.
    Remote(String),
}

impl Backend {
    pub fn is_remote(&self) -> bool {
        matches!(self, Backend::Remote(_))
    }
}

/// Read the mode, or fall back to supervising one here.
///
/// IT VALIDATES RATHER THAN TRUSTING, for `hostConfig.ts`'s reason one layer down: the value ends
/// up as the address every request in the application goes to, and the symptom of a malformed one
/// is a socket that never opens — which reads as "the backend is down" rather than as "this string
/// is not a URL". Refusing it here means the shell falls back to a mode that works.
pub fn resolve(env_value: Option<&str>) -> Backend {
    let raw = env_value.unwrap_or("").trim();
    if raw.is_empty() {
        return Backend::Local;
    }
    match url_shape(raw) {
        Some(url) => Backend::Remote(url),
        None => {
            crate::logs::say(format!(
                "{BACKEND_URL_ENV}={raw:?} is not a ws:// or wss:// URL — supervising a local backend instead"
            ));
            Backend::Local
        }
    }
}

/// The same rule `client/src/lib/hostConfig.ts` applies, spelled here so the shell never hands the
/// page a value the page will refuse: only `ws`/`wss`, only with a host, and no trailing slash.
fn url_shape(raw: &str) -> Option<String> {
    let (scheme, rest) = raw.split_once("://")?;
    if scheme != "ws" && scheme != "wss" {
        return None;
    }
    // Host must be present and must not itself look like a path or a query.
    let host = rest.split(['/', '?', '#']).next()?;
    if host.is_empty() || host.contains(' ') {
        return None;
    }
    Some(raw.trim_end_matches('/').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_is_local_so_a_machine_with_no_network_still_works() {
        assert_eq!(resolve(None), Backend::Local);
        assert_eq!(resolve(Some("")), Backend::Local);
        assert_eq!(resolve(Some("   ")), Backend::Local);
    }

    #[test]
    fn a_socket_url_selects_remote() {
        assert_eq!(
            resolve(Some("wss://jaroku-api.fly.dev")),
            Backend::Remote("wss://jaroku-api.fly.dev".into())
        );
        // ws:// too, so a staging deployment behind a tunnel is reachable without a certificate.
        assert!(resolve(Some("ws://127.0.0.1:4317")).is_remote());
    }

    #[test]
    fn a_trailing_slash_is_dropped_because_every_url_is_built_by_appending() {
        assert_eq!(
            resolve(Some("wss://jaroku-api.fly.dev/")),
            Backend::Remote("wss://jaroku-api.fly.dev".into())
        );
    }

    #[test]
    fn anything_that_is_not_a_socket_url_falls_back_rather_than_being_handed_to_the_page() {
        // The http/ws confusion is the one worth naming: `apiBase` DERIVES http from this, so a
        // host that offered https:// here has confused the two and quietly rewriting it would hide
        // the mistake in a socket that never opens.
        for bad in [
            "https://jaroku-api.fly.dev",
            "http://localhost:4317",
            "jaroku-api.fly.dev",
            "wss://",
            "wss:///path",
            "not a url",
        ] {
            assert_eq!(resolve(Some(bad)), Backend::Local, "{bad} should not be accepted");
        }
    }
}
