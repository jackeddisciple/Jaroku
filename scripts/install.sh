#!/usr/bin/env sh
# Install Jaroku on macOS or Linux, from the latest GitHub release.
#
# WHY THIS EXISTS RATHER THAN "DOWNLOAD THE DMG AND DOUBLE-CLICK IT". Apple attaches a quarantine
# flag to anything a BROWSER downloads, and Gatekeeper refuses to open a quarantined app that is
# not signed by a certificate from Apple's Developer Program. The refusal is not a warning with an
# "open anyway" button — on Apple silicon an unsigned app reads as *"Jaroku is damaged and can't
# be opened"*, which looks like a corrupt download and is the single most likely reason somebody
# gives up on a beta.
#
# `curl` does not set that flag. It is not a trick and it is not a bypass of anything: the
# quarantine attribute exists to mark files that arrived from a program acting on a web page's
# behalf, and a person typing a command is not that. So a one-line install genuinely opens with a
# double-click afterwards, where the same bytes fetched through Safari would not.
#
# THE PROPER FIX IS A CERTIFICATE, and this script is not a substitute for one. A notarised build
# needs no instructions, no terminal and no explaining — see "Code signing" in docs/tauri.md. This
# is what to do until then.
#
#   curl -fsSL https://raw.githubusercontent.com/jackeddisciple/Jaroku/main/scripts/install.sh | sh

set -eu

REPO="jackeddisciple/Jaroku"
API="https://api.github.com/repos/$REPO/releases/latest"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required and is not installed."

OS="$(uname -s)"
ARCH="$(uname -m)"

# Which asset to look for. Tauri names them by architecture, and picking the wrong one on a Mac is
# the difference between an app that runs natively and one that will not launch at all.
case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64)  PATTERN='Jaroku-macos-arm64.dmg' ; WHICH="Apple silicon" ;;
      x86_64) PATTERN='Jaroku-macos-intel.dmg' ; WHICH="Intel" ;;
      *) die "Unrecognised Mac architecture: $ARCH" ;;
    esac ;;
  Linux)
    case "$ARCH" in
      x86_64|amd64) PATTERN='Jaroku-linux-x86_64.AppImage' ; WHICH="x86-64" ;;
      *) die "Unrecognised Linux architecture: $ARCH.
The release publishes an x86-64 AppImage; there is no arm64 Linux runner in the workflow yet." ;;
    esac ;;
  *) die "This script installs Jaroku on macOS and Linux. On Windows, download the .exe from https://github.com/$REPO/releases/latest" ;;
esac

say "Jaroku — $OS, $WHICH"
printf 'Looking up the latest release…\n'

URL="$(curl -fsSL "$API" \
  | grep -o "https://[^\"]*$PATTERN" \
  | head -n 1)" || true

[ -n "${URL:-}" ] || die "No $PATTERN asset in the latest release of $REPO.
Check https://github.com/$REPO/releases/latest — a release is published as a draft until somebody
confirms all four platforms built, and a draft is not visible here."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FILE="$TMP/$(basename "$URL")"

printf 'Downloading %s\n' "$(basename "$URL")"
printf 'This is 350-400 MB: it carries a complete Python runtime so that you install nothing else.\n'
curl -fL# -o "$FILE" "$URL"

if [ "$OS" = "Darwin" ]; then
  say "Installing to /Applications"
  MOUNT="$(mktemp -d)"
  # -nobrowse so a disk image does not pop open a Finder window in the middle of a script.
  hdiutil attach -quiet -nobrowse -mountpoint "$MOUNT" "$FILE" \
    || die "Could not open the disk image. It may not have finished downloading."
  # The copy is the install. `ditto` rather than `cp -R` because it preserves extended attributes
  # and code signatures, and a copy that strips the signature is a copy Gatekeeper then rejects.
  if [ -d "$MOUNT/Jaroku.app" ]; then
    rm -rf "/Applications/Jaroku.app"
    ditto "$MOUNT/Jaroku.app" "/Applications/Jaroku.app"
  else
    hdiutil detach -quiet "$MOUNT" || true
    die "The disk image did not contain Jaroku.app."
  fi
  hdiutil detach -quiet "$MOUNT" || true
  rmdir "$MOUNT" 2>/dev/null || true

  # Belt and braces. Nothing here should be quarantined — curl did the fetching — but a file that
  # travelled some other way to this machine still might be, and clearing a flag that is already
  # absent costs nothing and turns a mystifying failure into no failure at all.
  xattr -dr com.apple.quarantine "/Applications/Jaroku.app" 2>/dev/null || true

  say "Installed: /Applications/Jaroku.app"
  printf 'Opening it now. The first launch takes about a minute — it unpacks a Node runtime and a\n'
  printf 'complete Python environment into ~/.jaroku so nothing has to be installed separately.\n'
  open -a "/Applications/Jaroku.app" || true
else
  DEST="${HOME}/.local/bin"
  mkdir -p "$DEST"
  install -m 755 "$FILE" "$DEST/jaroku" 2>/dev/null || { cp "$FILE" "$DEST/jaroku"; chmod +x "$DEST/jaroku"; }
  say "Installed: $DEST/jaroku"
  case ":$PATH:" in
    *":$DEST:"*) printf 'Run it with: jaroku\n' ;;
    *) printf 'Run it with: %s/jaroku\n(%s is not on your PATH.)\n' "$DEST" "$DEST" ;;
  esac
  printf '\nThe tray needs libayatana-appindicator3 — without it the close button quits instead of\n'
  printf 'hiding, and a run in flight is cancelled with the window.\n'
fi
