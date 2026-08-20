// Which port the Node backend gets.
//
// 4317 IS THE DEFAULT AND STAYS THE DEFAULT. `server/src/index.ts` reads `JAROKU_PORT ?? 4317`,
// the client's `VITE_JAROKU_WS` falls back to `ws://localhost:4317`, the README documents it and
// `debug-client.html` is served from it. A desktop app that quietly moved the port would break
// every one of those for the developer who has both a terminal and the app open — which is the
// person most likely to have the port taken in the first place.
//
// SO THIS ONLY RUNS WHEN 4317 IS ALREADY IN USE, and what it does then is walk upwards to the
// first free port. The resolved number goes two places: into the sidecar's `JAROKU_PORT`, and
// into the webview as runtime configuration, so the frontend's socket and the backend's listener
// are two readings of one decision rather than two defaults that happen to agree.
//
// THE RACE IS REAL AND IS NOT CLOSED HERE. Between this function binding a port to prove it is
// free and Node binding it for real, something else can take it. There is no way to hand a bound
// listener to a child process portably, and pre-binding it here would mean holding the port the
// child needs. What actually makes this safe is one level up: `sidecar.rs` treats a backend that
// exits early as a crash and restarts it, and a restart re-runs this — so losing the race costs
// one restart rather than a dead app. Written down because a comment claiming the check is
// authoritative would be worse than no comment.

use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};

/// The port `server/src/index.ts` uses when `JAROKU_PORT` is unset.
pub const DEFAULT_PORT: u16 = 4317;

/// How far above the default to look before giving up. Deliberately small: a machine with
/// thirty-two consecutive ports in use above 4317 has something wrong with it that a wider scan
/// would paper over, and an app that silently landed on 4400 is one whose logs nobody can match
/// against the port they expected.
const SCAN: u16 = 32;

/// The first free port at or above `preferred`, or `None` when the whole window is taken.
///
/// Binds to 127.0.0.1 rather than 0.0.0.0 on purpose. The backend binds loopback and the
/// README's network posture says so; probing the wildcard address would report a port as taken
/// because some other process holds it on an external interface, which is a port this app could
/// have used perfectly well.
pub fn first_free(preferred: u16) -> Option<u16> {
    let chosen = (0..SCAN)
        .filter_map(|offset| preferred.checked_add(offset))
        .find(|port| is_free(*port));
    // WHICH PORT, AND WHETHER IT WAS THE PREFERRED ONE. A backend on 4318 is a backend whose logs
    // nobody can match against the port they expected, and until this line the only way to find
    // out which one it got was to go looking in a process list.
    match chosen {
        Some(port) if port == preferred => crate::logs::detail(format!("port {port}, which was free")),
        Some(port) => crate::logs::say(format!(
            "port {preferred} is already in use, so the backend gets {port}"
        )),
        None => crate::logs::say(format!(
            "every port from {preferred} to {} is in use",
            preferred.saturating_add(SCAN - 1)
        )),
    }
    chosen
}

fn is_free(port: u16) -> bool {
    // The listener is dropped at the end of the expression, which closes it. On Windows that is
    // enough; on Linux and macOS a socket in TIME_WAIT would still refuse a later bind without
    // SO_REUSEADDR, but nothing here has an established connection to leave one behind — this
    // listener never accepts.
    TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_preferred_port_is_returned_when_nothing_holds_it() {
        let held = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        let free = held.local_addr().unwrap().port();
        drop(held);
        assert_eq!(first_free(free), Some(free));
    }

    #[test]
    fn a_held_port_is_stepped_over_rather_than_returned() {
        let held = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        let taken = held.local_addr().unwrap().port();
        let resolved = first_free(taken).expect("something above the held port is free");
        assert_ne!(resolved, taken, "a port this process is holding must not be reported free");
        assert!(resolved > taken, "the scan walks upwards from the preferred port, never down");
        drop(held);
    }

    #[test]
    fn a_scan_that_would_overflow_the_port_space_ends_rather_than_wrapping() {
        // u16::MAX + 1 is not port 0, and port 0 means "the kernel picks" — which for a backend
        // whose port has to be told to a frontend is the one answer that cannot be used.
        assert!(first_free(u16::MAX).map_or(true, |port| port == u16::MAX));
    }
}
