// The desktop binary, and deliberately nothing else. Everything is in the library beside it —
// see the `[lib]` note in Cargo.toml for why.
//
// `windows_subsystem = "windows"` in a release build is what stops a console window opening
// behind the app on Windows. It is guarded on `not(debug_assertions)` rather than applied
// unconditionally, because during development the sidecar's stdout and stderr are the only way
// to see what the Node server is saying, and a release attribute would swallow them.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    jaroku_lib::run()
}
