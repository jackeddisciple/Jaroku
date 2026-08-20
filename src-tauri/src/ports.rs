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
// THE PROBE HAS TO ASK THE QUESTION THE BACKEND ASKS, and for the whole of this wrapper's life it
// asked a different one. It bound `127.0.0.1`; `wsRelay.ts` calls `http.listen(port)` with no
// host, which is Node binding the WILDCARD — `[::]`, dual-stack, so it answers IPv4 too. On
// Windows those are not the same claim: a bind to one specific address succeeds while a wildcard
// bind holds the same port, because Windows only refuses two binds that name the same address
// unless somebody asked for exclusivity. So the probe reported 4317 FREE while a stale Jaroku
// backend was listening on it, the shell told the new backend to take 4317, Node threw
// `EADDRINUSE` from a `listen` with no error handler, the process exited 1, and the supervisor —
// which re-used the same port every time — watched it fail three identical times and gave up. A
// window with no backend, no error on screen and, until logs.rs, nothing written down anywhere.
//
// That is the whole of the intermittent freeze. It needed a stale listener on 4317 to happen,
// which is why it happened some launches and not others, and `sidecar::stop` leaving one behind
// is why there was so often one to find.
//
// SO `is_free` NOW BINDS THE WILDCARD, in both families, and then asks the port whether anything
// answers. The second half is not redundant: a listener bound to loopback alone is a bind the
// wildcard probe can still succeed against on Windows, and something already answering on the
// port is the case that matters however it got there.
//
// THE RACE IS REAL AND IS NOT CLOSED HERE. Between this function proving a port free and Node
// binding it for real, something else can take it. There is no way to hand a bound listener to a
// child process portably, and pre-binding it here would mean holding the port the child needs.
// What makes it survivable is one level up, and it had to be BUILT there rather than merely
// claimed: `sidecar.rs` re-resolves the port on every restart, so losing the race costs one
// restart rather than a dead app. This comment used to say that and it was not true.

use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream};
use std::time::Duration;

/// The port `server/src/index.ts` uses when `JAROKU_PORT` is unset.
pub const DEFAULT_PORT: u16 = 4317;

/// How far above the default to look before giving up. Deliberately small: a machine with
/// thirty-two consecutive ports in use above 4317 has something wrong with it that a wider scan
/// would paper over, and an app that silently landed on 4400 is one whose logs nobody can match
/// against the port they expected.
const SCAN: u16 = 32;

/// How long the "is anything answering here" half waits for a connection.
///
/// A refused connection on loopback comes back immediately on every platform, so this is a
/// ceiling rather than a cost: it is what stops a port being black-holed by a local firewall from
/// adding a second to every launch. One probe happens on the ordinary launch, because the
/// ordinary launch's first candidate is free.
const ANSWER_PROBE: Duration = Duration::from_millis(150);

/// The first free port at or above `preferred`, or `None` when the whole window is taken.
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

/// Whether the backend could actually have this port.
pub fn is_free(port: u16) -> bool {
    bindable_as_the_backend_binds(port) && !answered_by_something(port)
}

/// Can we bind the port the way `http.listen(port)` binds it?
///
/// BOTH WILDCARDS, AND ONLY `AddrInUse` COUNTS AS TAKEN. Node picks `[::]` when the machine has
/// IPv6 and `0.0.0.0` when it does not, and a dual-stack listener on the first claims the second
/// as well — so a port is only free if neither is spoken for. Any other error is this machine
/// declining to offer that address family at all, which is a statement about the machine rather
/// than about the port, and reading it as a conflict would walk the scan up for no reason on
/// every box with IPv6 switched off.
fn bindable_as_the_backend_binds(port: u16) -> bool {
    for address in [IpAddr::V6(Ipv6Addr::UNSPECIFIED), IpAddr::V4(Ipv4Addr::UNSPECIFIED)] {
        match TcpListener::bind(SocketAddr::new(address, port)) {
            // Dropped at the end of the arm, which closes it. Nothing here ever accepts, so there
            // is no established connection to leave a socket in TIME_WAIT behind.
            Ok(listener) => drop(listener),
            Err(err) if err.kind() == io::ErrorKind::AddrInUse => return false,
            Err(_) => continue,
        }
    }
    true
}

/// Is something already answering on this port?
///
/// The half the bind probe cannot see. A listener bound to loopback alone does not stop a
/// wildcard bind on Windows, so a dev server or a hand-started process on 4317 would pass the
/// check above and then quietly receive the traffic the app meant for its own backend — which is
/// worse than a refusal, because the window connects and the answers are somebody else's.
///
/// Both loopbacks, because which one answers depends on how the other process bound: a dual-stack
/// listener takes 127.0.0.1, a v6-only one takes ::1 and nothing else.
fn answered_by_something(port: u16) -> bool {
    [IpAddr::V4(Ipv4Addr::LOCALHOST), IpAddr::V6(Ipv6Addr::LOCALHOST)]
        .into_iter()
        .any(|address| TcpStream::connect_timeout(&SocketAddr::new(address, port), ANSWER_PROBE).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A port nothing is using, found by letting the kernel pick one and handing it straight back.
    fn a_free_port() -> u16 {
        let held = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).unwrap();
        let port = held.local_addr().unwrap().port();
        drop(held);
        port
    }

    #[test]
    fn the_preferred_port_is_returned_when_nothing_holds_it() {
        let free = a_free_port();
        assert_eq!(first_free(free), Some(free));
    }

    #[test]
    fn a_held_port_is_stepped_over_rather_than_returned() {
        let held = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).unwrap();
        let taken = held.local_addr().unwrap().port();
        let resolved = first_free(taken).expect("something above the held port is free");
        assert_ne!(resolved, taken, "a port this process is holding must not be reported free");
        assert!(resolved > taken, "the scan walks upwards from the preferred port, never down");
        drop(held);
    }

    #[test]
    fn a_port_held_the_way_the_backend_holds_one_is_not_reported_free() {
        // THE REGRESSION TEST FOR THE FREEZE. `http.listen(port)` in Node binds the wildcard, and
        // the probe that shipped bound `127.0.0.1` — which on Windows succeeds against a wildcard
        // listener and reported the port free. The app then handed its backend a port it could
        // not have, three times, silently. This binds the port the way the backend does and
        // asserts the probe sees it.
        let held = TcpListener::bind(SocketAddr::from((Ipv6Addr::UNSPECIFIED, 0)))
            .or_else(|_| TcpListener::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0))))
            .expect("a wildcard bind on an ephemeral port");
        let taken = held.local_addr().unwrap().port();

        assert!(!is_free(taken), "a wildcard listener on {taken} means the backend cannot have it");
        assert_ne!(first_free(taken), Some(taken));
        drop(held);
    }

    #[test]
    fn a_port_something_is_answering_on_is_not_reported_free() {
        // The other half, and the one the bind probe cannot see: a listener on loopback only.
        // The backend would come up beside it and receive none of the traffic meant for it.
        let held = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).unwrap();
        let taken = held.local_addr().unwrap().port();
        assert!(answered_by_something(taken), "the listener is accepting on {taken}");
        assert!(!is_free(taken));
        drop(held);
    }

    #[test]
    fn a_free_port_is_not_reported_as_answered() {
        // The probe must not report every port as busy on a machine where a refused connection
        // behaves unusually — which would silently walk the scan to its end on every launch.
        assert!(!answered_by_something(a_free_port()));
    }

    #[test]
    fn a_scan_that_would_overflow_the_port_space_ends_rather_than_wrapping() {
        // u16::MAX + 1 is not port 0, and port 0 means "the kernel picks" — which for a backend
        // whose port has to be told to a frontend is the one answer that cannot be used.
        assert!(first_free(u16::MAX).map_or(true, |port| port == u16::MAX));
    }
}
