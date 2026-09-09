// The application window, and the one thing the shell tells the bundle before it runs.
//
// WHY THE WINDOW IS BUILT HERE RATHER THAN DECLARED IN `tauri.conf.json`. A window in the
// configuration is created during `Builder::build()`, which is before `setup` — and an
// initialisation script can only be attached to a window at creation. The script below is how
// the resolved backend port reaches the client's `hostConfig.ts` before its first module
// evaluates, and everything else about this window would have been perfectly happy declared.
// That is the whole reason, written down so nobody moves it back and spends an afternoon on why
// the port stopped arriving.
//
// THE MINIMUM SIZE IS NOT A GUESS. Jaroku's main view is three columns — sidebar, conversation,
// the trace/graph/evals panel — and the Threads, Agents, Inbox and Activity destinations each
// have a narrow-width fallback below that. 1024 is where the three-column layout stops being
// three columns; going under it is a state the product supports and is not a state a desktop
// window should open in.

use std::sync::Mutex;

use tauri::{AppHandle, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

/// The label everything else refers to this window by — the capability file, the tray's
/// show-and-focus, the single-instance handler, and the window-state plugin's stored geometry.
/// One constant rather than four string literals, because a typo in any of them is a feature
/// that silently does nothing.
pub const MAIN: &str = "main";

/// The window the welcome screen gets, and the window the application gets.
///
/// TWO WINDOW SIZES RATHER THAN ONE WINDOW WITH TWO LAYOUTS. The welcome screen asks exactly one
/// question — a mark, a name, a line, a button — and a 1440×900 window around a 340px column of
/// that reads as an application that has not finished loading yet. Every desktop application's
/// first screen is a small window that grows into the product once you are through it, and this
/// one is no exception.
///
/// THE FLOOR MOVES WITH THE STAGE, and that is the load-bearing half. `APP_MIN` is 1024 because
/// that is where the three-column layout stops being three columns (see the note below), and a
/// window that cannot go under 1024 cannot be 560 wide either — so the minimum is lowered for the
/// welcome screen and put back on the way out. Lowering it permanently would let somebody drag the
/// application itself down to a width the layout does not support.
const SPLASH: (f64, f64) = (560.0, 620.0);
const APP: (f64, f64) = (1440.0, 900.0);
const APP_MIN: (f64, f64) = (1024.0, 680.0);

/// The size the application was going to open at, held across the welcome screen.
///
/// WHY REMEMBER IT AT ALL, when `APP` is right there. The window-state plugin restores the width
/// somebody chose for their three columns, and shrinking to the welcome screen throws that away —
/// so "Get started" would return every user to 1440×900 on every launch, quietly undoing a
/// preference the plugin exists to keep. This holds it for the two seconds the welcome screen is up.
#[derive(Default)]
pub struct AppSize(Mutex<Option<LogicalSize<f64>>>);

pub fn open(app: &AppHandle, ws_url: &str) -> Result<(), Box<dyn std::error::Error>> {
    let builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::default())
        .title("Jaroku")
        .inner_size(APP.0, APP.1)
        .min_inner_size(APP_MIN.0, APP_MIN.1)
        .center()
        .resizable(true)
        // THE TITLE BAR IS THE PAGE'S. `Overlay` keeps the traffic lights and drops the bar they
        // sit on, so the webview reaches the top of the window and the sidebar's own first row is
        // what renders behind them — which is the only way a column can start level with those
        // three dots rather than 28px below a strip of chrome nothing else uses.
        //
        // TWO THINGS FOLLOW FROM IT AND BOTH ARE IN THE CLIENT. The window can no longer be
        // dragged by a bar that is not there, so `SidebarChrome` carries `data-tauri-drag-region`;
        // and the lights now sit OVER page content, so that same row reserves their width.
        //
        // `hidden_title` because the name would otherwise be drawn over the page, centred, in a
        // row the application is using for its own controls.
        // HIDDEN UNTIL THE PAGE SAYS WHICH SIZE IT NEEDS, which is the only way the welcome screen
        // does not open as a flash of the full application. The bundle decides between the two
        // stages on its first render — it depends on whether there is a session, which is a
        // question only the page can answer — and a window shown before that answer arrives is a
        // 1440×900 frame that snaps to 560 a moment later. `set_window_stage` shows it.
        //
        // NOTHING IS LOST IF THE PAGE NEVER CALLS: `reveal_eventually` shows the window anyway
        // after four seconds. A shell whose only path to a visible window runs through the bundle
        // is a shell that has no way to report that the bundle is what failed.
        .visible(false)
        // JAROKU IS A LIGHT-THEME APPLICATION AND THE WINDOW HAS TO SAY SO, which matters for
        // exactly one reason and it is not the page: `NSVisualEffectMaterial.sidebar` has a light
        // variant and a dark one, and it picks between them from the WINDOW's appearance rather
        // than from anything CSS can reach. Left to inherit, a person running macOS in dark mode
        // would get the dark material behind a light page — a column that goes muddy under
        // off-white text, on a product whose palette has no dark mode at all. `color-scheme: light`
        // in index.css says the same thing to the webview; this says it to AppKit.
        .theme(Some(tauri::Theme::Light))
        .initialization_script(&host_config(ws_url));

    // MACOS ONLY, AND NOT BY PREFERENCE — `title_bar_style` and `hidden_title` are compiled only
    // for macOS in Tauri, so chaining them unconditionally is a build that fails on the other three
    // targets `release.yml` uploads. The other platforms keep their ordinary title bar; the
    // client's reservation for the traffic lights is keyed off the host bridge rather than off the
    // platform, so a Windows window simply has a chrome row with nothing reserved on its left.
    // THE MATERIAL IS THE WINDOW'S, NOT THE PAGE'S. `Effect::Sidebar` is
    // `NSVisualEffectMaterial.sidebar` — the material Finder and Mail put behind their own columns
    // — and it sits BEHIND the webview, blurred by the window server rather than by CSS. That is
    // the whole reason it is done here: `backdrop-filter` in the page can only blur what the page
    // has already painted, and what sits behind the sidebar there is one flat colour, so it blurs
    // a solid rectangle into an identical one. This blurs the desktop.
    //
    // `transparent` is what lets any of it through, and it is why `macOSPrivateApi` is set in
    // tauri.conf.json — Tauri turns the `macos-private-api` feature on from that flag. On its own
    // it changes nothing visible: the page paints over the whole viewport, so the material stays
    // behind an opaque sheet until something deliberately opts out of it.
    //
    // AND EXACTLY ONE SCREEN DOES, WHICH IS THE SAFETY PROPERTY. The script below sets a FLAG
    // rather than a style; the client turns transparency on only where a sidebar is actually
    // rendered, and only when it sees that flag. Sign-in, first-run, the splash and account
    // onboarding never become transparent, so a region nobody remembered to paint cannot show the
    // desktop through it. Windows and Linux never see the flag and keep the opaque column.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .transparent(true)
        .effects(tauri::utils::config::WindowEffectsConfig {
            effects: vec![tauri::window::Effect::Sidebar],
            // `Active` rather than following the window's focus. A column that went flat the moment
            // you looked at your terminal would change material every time you alt-tabbed back,
            // which is motion nobody asked for on the one surface that is always on screen.
            state: Some(tauri::window::EffectState::Active),
            radius: None,
            color: None,
        })
        .initialization_script(VIBRANCY_FLAG);

    builder.build()?;
    Ok(())
}

/// Show the window even if the page never asked for a stage.
///
/// The failure this is for is not hypothetical: a bundle that throws before its first effect, a
/// dev server that is not up yet, a webview that fails to load at all. Every one of those ends
/// with `set_window_stage` uncalled, and without this the symptom would be an application that
/// starts, logs nothing wrong, and never appears.
///
/// EIGHT SECONDS, AND THE NUMBER IS SIZED FOR THE SLOWEST HONEST CASE RATHER THAN THE COMMON ONE.
/// A packaged build loads its bundle off local disk and answers in well under a second; `tauri dev`
/// points the webview at a Vite server that may still be compiling, and four seconds fired in front
/// of a page that was loading perfectly well — which is the failure this is supposed to prevent,
/// arriving as a full-size flash before the welcome screen. This is a safety net for a bundle that
/// is never going to answer, so it should lose every race against one that is.
pub fn reveal_eventually(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(8000));
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let Some(main) = handle.get_webview_window(MAIN) else { return };
            if matches!(main.is_visible(), Ok(true)) {
                return;
            }
            crate::logs::say("the page never asked for a window stage; showing it anyway");
            let _ = main.set_min_size(Some(LogicalSize::new(APP_MIN.0, APP_MIN.1)));
            let _ = main.show();
        });
    });
}

/// Which of the two windows this is, decided by the page and applied here.
///
/// THE PAGE DECIDES AND THE SHELL ACTS, rather than the shell inspecting a session it has no
/// business reading. Whether the welcome screen shows depends on whether there is a token in the
/// credential store, whether first-run is done and whether this launch already dismissed it — all
/// of which live in the bundle. The shell's half is the part the bundle cannot do: a webview
/// cannot resize the native window it is inside.
///
/// ANY UNKNOWN STAGE IS THE APPLICATION, deliberately. This is a string from the page, and the
/// failure of a typo should be a window somebody can use rather than a 560px one they cannot.
#[tauri::command]
pub fn set_window_stage(app: AppHandle, stage: String) {
    let Some(main) = app.get_webview_window(MAIN) else { return };
    let remembered = app.state::<AppSize>();

    // The size this call is moving the window TO, named once because `place_centred` below needs
    // the number we asked for rather than the one the window is mid-way through becoming.
    let target: LogicalSize<f64>;

    if stage == "splash" {
        // READ HERE RATHER THAN IN `open`, because the window-state plugin restores geometry after
        // the builder returns — so a size captured at creation is the builder's constant and not
        // the one somebody actually chose.
        //
        // AND IT IS ONLY REMEMBERED IF IT IS BIG ENOUGH TO BE AN APPLICATION WINDOW. Quitting while
        // the welcome screen is up saves 560×620 as the window's geometry, and the next launch
        // restores it; without this floor, that small size would be remembered as the "app" size
        // and Get started would open the product into it. Failing the check falls through to `APP`
        // below, so the state self-heals on the next launch rather than persisting.
        if let (Ok(size), Ok(scale)) = (main.inner_size(), main.scale_factor()) {
            let logical = size.to_logical::<f64>(scale);
            if logical.width >= APP_MIN.0 && logical.height >= APP_MIN.1 {
                if let Ok(mut slot) = remembered.0.lock() {
                    *slot = Some(logical);
                }
            }
        }
        target = LogicalSize::new(SPLASH.0, SPLASH.1);
        // The minimum comes down BEFORE the size does. Setting a size under the current minimum is
        // a request the window manager is entitled to ignore, and on macOS it does.
        let _ = main.set_min_size(Some(target));
        let _ = main.set_size(target);
        // Nothing on this screen reflows, so a resize handle offers a worse version of one layout.
        let _ = main.set_resizable(false);
    } else {
        target = remembered
            .0
            .lock()
            .ok()
            .and_then(|mut slot| slot.take())
            .unwrap_or_else(|| LogicalSize::new(APP.0, APP.1));
        let _ = main.set_resizable(true);
        let _ = main.set_min_size(Some(LogicalSize::new(APP_MIN.0, APP_MIN.1)));
        let _ = main.set_size(target);
    }

    let _ = main.show();
    place_centred(&main, target);
    let _ = main.set_focus();
}

/// Centre the window for a size it is BECOMING, rather than the one it currently reports.
///
/// WHY NOT `WebviewWindow::center()`, which is one call and exists for this. Because it centres the
/// window's CURRENT size, and the resize a line above has not necessarily landed: the size change
/// goes through the platform's event loop, `center()` reads the old box, computes the right
/// position for it, and the window ends up wherever it already was. That is not a theory — it was
/// the observed behaviour, before and after the show, and its symptom was a 560px welcome screen
/// left in the top-left corner at whatever position the window-state plugin had restored.
///
/// Passing the target size removes the race entirely: the arithmetic uses the number we just asked
/// for rather than the number the window happens to be mid-way through becoming.
///
/// `work_area` RATHER THAN `size`, so the menu bar and a dock are excluded and the window is
/// centred in the space it can actually occupy rather than in the glass.
fn place_centred(win: &tauri::WebviewWindow, target: LogicalSize<f64>) {
    let Ok(Some(monitor)) = win.current_monitor() else { return };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let origin = area.position.to_logical::<f64>(scale);
    let size = area.size.to_logical::<f64>(scale);
    // Clamped at the origin: a window taller than the work area would otherwise be placed at a
    // negative offset, which puts its title bar — and therefore its close button — off-screen.
    let x = origin.x + ((size.width - target.width) / 2.0).max(0.0);
    let y = origin.y + ((size.height - target.height) / 2.0).max(0.0);
    let _ = win.set_position(tauri::LogicalPosition::new(x, y));
}

/// Bring the existing window to the front.
///
/// THREE CALLS AND NOT ONE, because the ways a window can be out of the way are three different
/// states and each has its own undo. A minimised window is not hidden and a hidden window is not
/// unfocused; calling `set_focus` on a minimised window on Windows raises a taskbar flash and
/// nothing else, which is the failure that reads as "the second launch did nothing".
///
/// Two callers, deliberately sharing one: a second launch of the application, and a `jaroku://`
/// link arriving while the window is behind something. Both are somebody asking for Jaroku and
/// expecting to see it.
pub fn focus_existing(app: &AppHandle) {
    let Some(main) = app.get_webview_window(MAIN) else { return };
    let _ = main.unminimize();
    let _ = main.show();
    let _ = main.set_focus();
}

/// §9.2 — put the workspace's name in the window title.
///
/// WHY THE SHELL OWNS THE TITLE AT ALL, when the page could set `document.title` and be done. In a
/// browser those are the same thing; in a WebViewgnat they are not — the native window has a title of
/// its own, set at creation, and nothing the page writes reaches it. What Alt-Tab, the taskbar and
/// a window list show is the native one.
///
/// THROUGH `invoke` RATHER THAN `@tauri-apps/api/window`, which is the invariant `docs/tauri.md`
/// states by name: the client reaches the shell through `__TAURI__.core.invoke` and nothing else,
/// so the number of modules that know they are inside Tauri stays at three and neither
/// `package.json` grows a dependency on it. It also means the capability file grants one command
/// rather than a window-permission group.
///
/// IT CLAMPS AND FALLS BACK RATHER THAN REFUSING. A workspace name is 1-64 characters by the time
/// the server has stored one, so the clamp is belt-and-braces — but this string comes from the page
/// and the failure of a bad one is a window with no title at all, which reads as a broken build.
/// An empty name yields the product's own name, which is what the window opened with.
#[tauri::command]
pub fn set_window_title(app: AppHandle, name: Option<String>) {
    let Some(main) = app.get_webview_window(MAIN) else { return };
    let trimmed = name.unwrap_or_default().trim().chars().take(64).collect::<String>();
    // An em dash rather than a hyphen: the two halves are a product and a place, not a compound.
    let title = if trimmed.is_empty() { "Jaroku".to_string() } else { format!("Jaroku — {trimmed}") };
    let _ = main.set_title(&title);
}

/// The script that runs before the bundle does.
///
/// IT SETS ONE FIELD AND IT IS FROZEN. A host configuration object that the page can rewrite is
/// a host configuration object that a bug rewrites, and the failure would be a socket pointed at
/// a port nothing is listening on — which reads as "the backend is down" rather than as "the
/// address was changed". `Object.freeze` costs nothing and makes that impossible.
///
/// The port is a `u16` and is formatted through `serde_json`, so there is no string here a value
/// could break out of. That is belt-and-braces rather than a real risk — the number came from
/// `TcpListener` — but this string is executed as script in the application's own context, and
/// "the input is trusted" is the sentence that precedes most injection bugs.
/// What the page is told when the window is carrying the native material.
///
/// A FLAG RATHER THAN A STYLE, and that difference is the whole safety argument. If this script set
/// `background: transparent` itself it would do so on every screen the webview ever shows —
/// including the four that render before the shell exists — and any one of those that does not
/// paint its own background would show the desktop through it. Instead the client reads this and
/// opts IN, on the one screen that has a sidebar. See `[data-vibrancy]` in `index.css`.
///
/// IT STAYS A GLOBAL AND DOES NOT TOUCH THE DOM, which is the half that makes the paragraph above
/// true. Setting `documentElement.dataset` here would apply on every page load — sign-in included —
/// and the opt-in would be a fiction: the CSS gate would already be open before the shell existed.
/// The client sets the attribute, from the one render path that has a sidebar in it, and takes it
/// off again when that path unmounts. See `App.tsx`.
#[cfg(target_os = "macos")]
const VIBRANCY_FLAG: &str = "window.__JAROKU_VIBRANCY__ = true;";

fn host_config(ws_url: &str) -> String {
    let url = serde_json::Value::String(ws_url.to_string());
    format!("window.__JAROKU_CONFIG__ = Object.freeze({{ wsUrl: {url} }});")
}

/// The socket URL for a port, spelled once.
///
/// Two callers now — the script above, and `status.rs`, which carries the current URL on every
/// status it sends because the port can move after the script has run. Two spellings of one
/// address is exactly the kind of duplication that stays correct until somebody adds a `wss` case
/// to one of them.
pub fn ws_url(port: u16) -> String {
    format!("ws://localhost:{port}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_injected_url_is_a_ws_url_on_the_resolved_port() {
        assert_eq!(
            host_config(&ws_url(4318)),
            "window.__JAROKU_CONFIG__ = Object.freeze({ wsUrl: \"ws://localhost:4318\" });"
        );
    }

    #[test]
    fn the_default_port_is_injected_unchanged_so_a_normal_launch_matches_the_build_time_fallback() {
        // The client's fallback is `ws://localhost:4317`. On the ordinary launch the host says
        // the same thing, which is what makes the override invisible when nothing needed it.
        assert!(host_config(&ws_url(4317)).contains("ws://localhost:4317"));
    }

    #[test]
    fn a_remote_backend_is_injected_verbatim_so_the_page_talks_to_it_like_a_browser_tab() {
        // The whole of the thin-client change, from this file's side: the page reads whatever it is
        // given, `hostConfig.ts` accepts wss://, and `apiBase` derives the HTTP origin from it. So
        // one injected string moves both surfaces and they cannot drift apart.
        assert!(host_config("wss://jaroku-api.fly.dev").contains("wss://jaroku-api.fly.dev"));
    }

    #[test]
    fn the_injected_value_is_json_encoded_because_it_is_executed_as_script() {
        // Belt and braces rather than a real risk — the value came from an environment variable
        // this process read — but this string is evaluated in the application's own context, and
        // "the input is trusted" is the sentence that precedes most injection bugs.
        let script = host_config("wss://example.test/\" + alert(1) + \"");
        assert!(!script.contains("alert(1) + \""), "the quote must not close the literal");
    }
}
