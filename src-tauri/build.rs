fn main() {
    // WHY CARGO HAS TO BE TOLD ABOUT THIS VARIABLE.
    //
    // `backend.rs` reads `option_env!("JAROKU_BACKEND_URL")` so a distribution build can carry the
    // address of the Jaroku it talks to — a `.app` launched from Finder inherits no shell
    // environment, so a runtime variable cannot configure one and the value has to be in the
    // binary. But `option_env!` is invisible to cargo's freshness check: nothing about the source
    // changes when the variable does, so cargo happily reuses an artifact compiled WITHOUT it.
    //
    // That is not theoretical. A `cargo test` run with the variable unset compiled the crate,
    // cached it, and the `tauri build` that followed — with the variable set — found the artifact
    // up to date and never recompiled. The bundle shipped with the URL absent, launched in local
    // mode, and tried to start a backend it was never meant to have. The build looked completely
    // successful.
    //
    // This line is the documented fix: it makes the variable part of what cargo considers when
    // deciding whether the crate is stale.
    println!("cargo:rerun-if-env-changed=JAROKU_BACKEND_URL");

    tauri_build::build()
}
