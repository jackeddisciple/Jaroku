// The desktop wrapper's entry point.
//
// WHAT THIS APP IS. A window pointed at the same React bundle `npm run build` produces, and a
// supervisor for the same Node process `cd server && npm run dev` starts. It is a host, not a
// port: no route handler, no WebSocket message shape, no RLS policy and no SecretStore
// behaviour is reachable from this crate, and none of them is changed by it. The frontend still
// talks to the backend over a localhost WebSocket exactly as it does in a browser — replacing
// that with Tauri's IPC would mean rewriting the twenty-one channels the client already speaks,
// which is the opposite of wrapping.
//
// THE ORDER IN `setup` IS LOAD-BEARING and each step is written down where it happens.

mod paths;

pub fn run() {
    tauri::Builder::default()
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("jaroku: the desktop shell failed to start");
}
