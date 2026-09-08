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

/// The URL baked in at COMPILE time, when the build was given one.
///
/// AN ENVIRONMENT VARIABLE CANNOT CONFIGURE A PACKAGED MAC APP, which is the whole reason this
/// exists and it took building one to notice. A `.app` launched from Finder, from Spotlight, or by
/// LaunchServices answering a `jaroku://` URL inherits no shell environment at all — so
/// `JAROKU_BACKEND_URL=… open -a Jaroku.app` configures nothing, and the mode I could set freely
/// from a terminal was unreachable in the only way the application actually ships.
///
/// So the distribution build bakes it: `JAROKU_BACKEND_URL=wss://… npm run tauri:build` puts the
/// address in the binary, and the runtime variable still overrides it for a developer with a
/// terminal. Compile-time first as the DEFAULT, runtime second as the OVERRIDE — that ordering is
/// what keeps one binary usable against staging without rebuilding it.
const BAKED_IN: Option<&str> = option_env!("JAROKU_BACKEND_URL");

/// A DISTRIBUTION BUILD CANNOT SILENTLY SHIP IN LOCAL MODE.
///
/// The failure this exists for left no trace anywhere: `release.yml` did not set
/// `JAROKU_BACKEND_URL`, `option_env!` answered `None` exactly as designed, `resolve` returned
/// `Local` exactly as designed, and every published artefact was a private Jaroku with its own
/// database. Nothing was wrong with any line of it. The bug was an ABSENCE, and an absence is
/// precisely what a test cannot notice — so the check has to be the one thing that fails on
/// nothing being there.
///
/// AT COMPILE TIME, because that is when the value is read. A runtime check would fail on the
/// user's machine, after the download, which is the one place this must never be discovered.
///
/// `debug_assertions` IS THE LINE BETWEEN THE TWO BUILDS, and it is drawn where the meaning
/// changes rather than where a flag is convenient: `tauri dev` and `cargo test` are debug and are
/// meant to be LOCAL, while a release profile is something somebody will run without a terminal.
///
/// AND THERE IS A DELIBERATE WAY PAST IT. `JAROKU_ALLOW_LOCAL_DIST=1` builds a packaged app that
/// supervises its own backend — a real thing to want, and how a single-user or air-gapped install
/// is made. What it is not, any more, is what you get by forgetting.
#[cfg(not(debug_assertions))]
const _: () = {
    if BAKED_IN.is_none() && option_env!("JAROKU_ALLOW_LOCAL_DIST").is_none() {
        panic!(
            "this is a release build with no JAROKU_BACKEND_URL, so it would ship as its own \
             private Jaroku: its own database, accounts nobody else can see, and a Google \
             callback on a localhost port that differs per machine and cannot be registered. \
             Set JAROKU_BACKEND_URL=wss://<host> to point it at a deployment, or \
             JAROKU_ALLOW_LOCAL_DIST=1 if a self-contained install is what you actually want."
        );
    }
};

/// Read the mode, or fall back to supervising one here.
///
/// IT VALIDATES RATHER THAN TRUSTING, for `hostConfig.ts`'s reason one layer down: the value ends
/// up as the address every request in the application goes to, and the symptom of a malformed one
/// is a socket that never opens — which reads as "the backend is down" rather than as "this string
/// is not a URL". Refusing it here means the shell falls back to a mode that works.
pub fn resolve(env_value: Option<&str>) -> Backend {
    // The runtime value wins when there is one; otherwise whatever the build was given.
    let raw = match env_value.map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) => v,
        None => BAKED_IN.unwrap_or("").trim(),
    };
    let raw = raw.trim();
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
        // Only true when nothing was baked in — which is the case for `cargo test`, and is stated
        // rather than assumed so this does not quietly invert for a distribution build.
        if BAKED_IN.is_none() {
            assert_eq!(resolve(None), Backend::Local);
            assert_eq!(resolve(Some("")), Backend::Local);
            assert_eq!(resolve(Some("   ")), Backend::Local);
        }
    }

    #[test]
    fn a_runtime_value_overrides_whatever_the_build_was_given() {
        // THE ORDERING THAT MAKES ONE BINARY USABLE AGAINST STAGING. A packaged app carries its
        // address because a `.app` launched from Finder has no environment to read one from; a
        // developer with a terminal still needs to point that same binary somewhere else.
        assert_eq!(
            resolve(Some("wss://staging.example")),
            Backend::Remote("wss://staging.example".into())
        );
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
