// Where the desktop app keeps the session token: the operating system's own credential store.
//
// macOS Keychain, Windows Credential Manager, and the Secret Service on Linux — one crate, three
// backends, and the reason for each is the same. `auth.ts` keeps the bearer token in
// `localStorage` in a browser and says so with the trade-off written out: it survives a reload
// and it is readable by any script that gets onto the page, and the mitigation that matters is
// the Content-Security-Policy rather than the storage choice. That argument holds in a browser
// and weakens in a desktop app, because a desktop app is a FILE ON A DISK that other programs
// running as the same user can read. A WebView's local storage is an SQLite file in a predictable
// directory. Anything on the machine can open it.
//
// AND IT IS NOT `tauri-plugin-store` EITHER, which is the other obvious answer. That plugin is a
// JSON file under the app's data directory — a plain file, in the same predictable place, with
// the same property. A token that opens every workspace the account belongs to does not belong
// in one.
//
// WHAT AN OS CREDENTIAL STORE ACTUALLY BUYS, stated honestly rather than sold: the value is
// encrypted at rest with a key the user's login unlocks, and reading it is an operation the OS
// can attribute and, on macOS, prompt about. It does NOT stop a program running as this user from
// asking for it — nothing at this layer does. It moves the token from "readable by anything that
// can open a file" to "readable by something that asks the OS for it as this application", which
// is a real difference and is the one available without asking the user for a passphrase.
//
// THE KEY ALLOWLIST IS THE OTHER HALF. These commands are reachable from the webview, so they are
// reachable from anything that achieves script execution in it. An unconstrained get/set pair
// would be a general-purpose credential store for whatever that script wanted to keep, and a
// general-purpose ENUMERATOR if a key could be guessed. Two keys are allowed, both of them ones
// the browser build already keeps in `localStorage`, so this widens nothing: the desktop app can
// store exactly what the web app stores, in a better place.

use keyring::Entry;

/// The service name every entry is filed under, matching the bundle identifier. A user opening
/// Keychain Access should find one entry they can attribute without being told what it is.
const SERVICE: &str = "app.jaroku.desktop";

/// What the webview may ask for by name.
///
/// The same two keys `client/src/lib/auth.ts` uses, spelled identically. They are `jaroku.token`
/// — the account's bearer token, cleared on sign-out — and `jaroku.workspace`, which is WHICH
/// workspace was last open and never anything in one. Neither is new: `test:reset`'s audit of
/// every `jaroku.*` browser key already classifies both.
const ALLOWED: [&str; 2] = ["jaroku.token", "jaroku.workspace"];

fn entry(key: &str) -> Result<Entry, String> {
    if !ALLOWED.contains(&key) {
        // Named in the refusal, because the only way to hit this is a programming mistake — a new
        // key added on the client without being added here — and a silent failure would present
        // as a session that never persists, which is a long way from its cause.
        return Err(format!("{key} is not a key the desktop shell stores"));
    }
    Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

/// Read a value, or `None`.
///
/// `None` FOR EVERY FAILURE, not only for "no such entry". The other failures are a Linux box
/// with no Secret Service running, a locked keychain, a session with no D-Bus — and in all of
/// them the true answer to "is there a session to resume" is no. Distinguishing them would give
/// the client a decision it has nothing different to do with: there is one path out of "no
/// session", and it is the sign-in screen this product already has.
#[tauri::command]
pub fn secret_get(key: String) -> Option<String> {
    entry(&key).ok()?.get_password().ok()
}

/// Store a value, replacing whatever was there.
///
/// The error is RETURNED rather than swallowed, unlike the read. A machine that cannot store a
/// credential still works — the session lives as long as the window does — but it is a real
/// degradation somebody should be able to find in a log rather than discover as "this app signs
/// me out every time I close it".
#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    entry(&key)?.set_password(&value).map_err(|e| e.to_string())
}

/// Remove a value. Sign-out, and the workspace that goes with it.
///
/// An entry that was not there is a success, not an error. Sign-out is the one operation that
/// must never fail: it is called from `signOut`, it is called again on a session the server has
/// already expired, and a refusal there would leave somebody signed in to a session that is gone.
#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), String> {
    match entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_the_client_does_not_use_is_refused_rather_than_stored() {
        // The commands are reachable from the webview, so this is the difference between "the
        // session token lives in the keychain" and "the keychain is a general-purpose store for
        // whatever runs in the page".
        assert!(entry("anything.else").is_err());
        assert!(entry("jaroku.tokens").is_err(), "a near-miss is a miss, not a prefix match");
    }

    #[test]
    fn both_keys_the_client_actually_uses_are_allowed() {
        // Spelled here as literals rather than read from ALLOWED, so the suite fails if somebody
        // renames the constant's contents — which would be renaming what the client stores.
        assert!(ALLOWED.contains(&"jaroku.token"));
        assert!(ALLOWED.contains(&"jaroku.workspace"));
    }
}
