// Getting `server/` and `runtime/` out of the bundle and somewhere they can be written to.
//
// WHY THE PAYLOAD CANNOT SIMPLY BE RUN WHERE IT LANDS. Every one of the three bundles is
// read-only in normal use: a Windows install lives under Program Files, a macOS `.app` is signed
// and writing into it breaks the signature, and an AppImage is a read-only mount. And Jaroku
// writes inside `runtime/` constantly and by design — `runtime/.objects/` is the local object
// store, `runtime/.checkpoints/` holds a database per run, `runtime/agents/` is where a generated
// project is materialised, and `runtime/.env` is what the dotenv secret store IS. This was not
// theoretical: booting the staged payload in place created `.objects` and `.checkpoints` inside
// the staging directory on the first run.
//
// AND WHY THE WHOLE THING MOVES RATHER THAN JUST `runtime/`. `server/src/index.ts` computes
// `RUNTIME_DIR` from its own location — `resolve(dirname(import.meta.url), "..", "..", "runtime")`
// — so `runtime/` is wherever `server/` says it is. There is no environment variable that
// separates them, and the rule this wrapper works under is that Jaroku adapts to nothing. Moving
// both keeps that derivation true and costs a copy of `node_modules` on the launches after an
// upgrade, which is a price paid by the machine rather than by the codebase.
//
// EXTRACTION NEVER DELETES. It writes the payload's own files over whatever is there and touches
// nothing else, because the directory it is writing into is also where a user's generated agents,
// object store and checkpoints live. A tidier extractor that emptied the destination first would
// be correct exactly once and destroy somebody's work on the first upgrade. The cost is that a
// file dropped from a later version lingers; nothing imports it, and that is the cheaper failure.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::paths;

/// What the staging script wrote beside the payload. Only `digest` is compared; the rest is here
/// so that an installed app can answer "which Node is this, and which build" from a file rather
/// than from a guess.
const STAMP: &str = "payload.json";

/// Where the bundle put the staged tree.
///
/// TWO CANDIDATES, AND THAT IS DEFENSIVE ON PURPOSE. `bundle.resources` accepts both an array of
/// paths and a map of source-to-destination, and the two put the tree in different places
/// relative to the resource directory. Picking whichever is actually there costs one `exists`
/// call at startup and removes a whole class of "works on the machine it was bundled on"
/// failure — which matters more than usual here, because the person who wrote this could not
/// run a bundle to find out.
fn staged(app: &AppHandle) -> Option<PathBuf> {
    let root = app.path().resource_dir().ok()?;
    [root.join("resources").join("app"), root.join("app")]
        .into_iter()
        .find(|dir| dir.join(STAMP).is_file())
}

fn read_stamp(dir: &Path) -> Option<String> {
    let text = fs::read_to_string(dir.join(STAMP)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("digest")?.as_str().map(str::to_owned)
}

/// Put the payload where the backend can be started from, and answer where that is.
///
/// Returns `Ok(None)` when there is nothing to do because this is a development run — see
/// `lib.rs`'s `app_dir` for why development runs the working tree rather than a copy of it.
pub fn ensure(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    if tauri::is_dev() {
        return Ok(None);
    }

    let from = staged(app).ok_or_else(|| {
        "this build carries no payload: nothing under the resource directory has a payload.json. \
         `npm run tauri:build` stages one; `tauri build` on its own does not."
            .to_string()
    })?;
    let home = paths::jaroku_home().ok_or_else(|| {
        "this machine will not say where the user's home directory is, so there is nowhere to \
         extract the backend to."
            .to_string()
    })?;
    let to = home.join("app");

    let wanted = read_stamp(&from).ok_or_else(|| format!("{}'s stamp is unreadable", from.display()))?;
    if read_stamp(&to).as_deref() == Some(wanted.as_str()) {
        return Ok(Some(to)); // Already extracted, at this exact build. The ordinary launch.
    }

    fs::create_dir_all(&to).map_err(|e| format!("could not create {}: {e}", to.display()))?;
    // The stamp is removed BEFORE the copy rather than simply overwritten after it. An
    // extraction killed halfway — the machine sleeping, the user quitting, a full disk — would
    // otherwise leave the previous build's stamp beside a half-written tree, and the next launch
    // would read it, believe the payload was complete, and start a backend with a mixture of two
    // versions in it. Absent means "extract"; present means "this exact tree is all here".
    let _ = fs::remove_file(to.join(STAMP));
    copy_into(&from, &to).map_err(|e| format!("could not extract the backend to {}: {e}", to.display()))?;

    Ok(Some(to))
}

/// Copy every file under `from` into `to`, creating directories and overwriting files.
///
/// Iterative rather than recursive: `node_modules` is a deep tree of somebody else's making, and
/// a recursion depth this code does not control is a stack this code cannot bound.
fn copy_into(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut pending = vec![PathBuf::new()];
    while let Some(relative) = pending.pop() {
        let source = from.join(&relative);
        let destination = to.join(&relative);
        fs::create_dir_all(&destination)?;
        for entry in fs::read_dir(&source)? {
            let entry = entry?;
            let name = entry.file_name();
            // `file_type` rather than `metadata`, so a symlink is seen as one rather than as the
            // thing it points at. The staging script dereferences them on the way in, so a link
            // here would mean a bundle that was assembled some other way — and following one out
            // of the payload is how an extractor writes outside the directory it was given.
            let kind = entry.file_type()?;
            if kind.is_dir() {
                pending.push(relative.join(&name));
            } else if kind.is_file() {
                fs::copy(entry.path(), destination.join(&name))?;
            }
        }
    }
    Ok(())
}
