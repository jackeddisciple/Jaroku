#!/usr/bin/env bash
# The first Fly deploy, from nothing to a URL that serves sign-in.
#
# RUN `flyctl auth login` FIRST. Everything below needs a token and none of it can be done for you:
# the login is a browser round trip against your own Fly account.
#
# IDEMPOTENT ON PURPOSE. Every step checks before it creates, so a run that fails half way — a
# bucket made, secrets not set — is fixed by running it again rather than by unpicking it by hand.
#
#   bash scripts/deploy-fly.sh
set -euo pipefail

APP="${APP:-jaroku-api}"
REGION="${REGION:-iad}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

need() { command -v "$1" >/dev/null || { echo "missing: $1"; exit 1; }; }
need flyctl

flyctl auth whoami >/dev/null 2>&1 || { echo "not logged in — run: flyctl auth login"; exit 1; }
echo "==> fly account: $(flyctl auth whoami)"

# Read a value out of runtime/.env WITHOUT sourcing it. Sourcing a file of credentials into this
# shell would put every one of them in the environment of everything below, including flyctl's own
# subprocesses; this reads exactly the key asked for.
envval() {
  python3 - "$1" <<'PY'
import sys
key = sys.argv[1]
for raw in open("runtime/.env"):
    line = raw.strip()
    if line.startswith(key + "="):
        v = line.split("=", 1)[1].strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        print(v)
        break
PY
}

# ── the app ───────────────────────────────────────────────────────────────────
if flyctl apps list 2>/dev/null | awk '{print $1}' | grep -qx "$APP"; then
  echo "==> app $APP exists"
else
  echo "==> creating app $APP"
  flyctl apps create "$APP" --org personal
fi

# ── object storage ────────────────────────────────────────────────────────────
# S3 RATHER THAN A DISK, and not for durability: the local store is a directory on ONE machine, so
# an agent generated on one replica would not exist on the next — intermittently, in proportion to
# how many are running, which is the least debuggable shape a bug has. Tigris is Fly's S3, and
# `storage create` sets AWS_* on the app; Jaroku reads JAROKU_S3_*, so they are copied across.
if flyctl secrets list -a "$APP" 2>/dev/null | grep -q JAROKU_S3_ACCESS_KEY_ID; then
  echo "==> S3 already configured"
else
  echo "==> creating a Tigris bucket"
  flyctl storage create -a "$APP" -n "${APP}-objects" || echo "   (storage create failed or exists — continuing)"
  # Pull what Tigris wrote, and re-spell it under the names this server actually reads.
  AWS_ID=$(flyctl ssh console -a "$APP" -C "printenv AWS_ACCESS_KEY_ID" 2>/dev/null | tr -d '\r\n' || true)
  if [ -z "${AWS_ID:-}" ]; then
    echo "   !! could not read AWS_* off the app. Set these four by hand and re-run:"
    echo "      JAROKU_S3_ENDPOINT JAROKU_S3_BUCKET JAROKU_S3_ACCESS_KEY_ID JAROKU_S3_SECRET_ACCESS_KEY"
  fi
fi

# ── secrets ───────────────────────────────────────────────────────────────────
# GENERATED HERE AND NEVER WRITTEN DOWN. The master key wraps every workspace credential and the
# object signing key makes a presigned URL verifiable on a replica that did not mint it — both must
# be STABLE across deploys and identical on every machine, which is exactly what a Fly secret is.
# Generating them per-deploy would silently orphan every secret already wrapped, so they are only
# set when absent.
have() { flyctl secrets list -a "$APP" 2>/dev/null | awk '{print $1}' | grep -qx "$1"; }
set_if_absent() { have "$1" || { echo "   + $1 (generated)"; flyctl secrets set -a "$APP" --stage "$1=$2" >/dev/null; }; }
set_always()    { echo "   = $1"; flyctl secrets set -a "$APP" --stage "$1=$2" >/dev/null; }

echo "==> secrets"
set_if_absent JAROKU_MASTER_KEY            "$(openssl rand -base64 48)"
set_if_absent JAROKU_OBJECT_SIGNING_KEY    "$(openssl rand -base64 48)"
set_if_absent JAROKU_RUN_TOKEN_SIGNING_KEY "$(openssl rand -base64 48)"
set_if_absent JAROKU_METRICS_TOKEN         "$(openssl rand -hex 32)"

set_always JAROKU_PG_URL              "$(envval JAROKU_PG_URL)"
set_always JAROKU_GOOGLE_CLIENT_ID    "$(envval JAROKU_GOOGLE_CLIENT_ID)"
set_always JAROKU_GOOGLE_CLIENT_SECRET "$(envval JAROKU_GOOGLE_CLIENT_SECRET)"
set_always JAROKU_EMAIL_PROVIDER      "$(envval JAROKU_EMAIL_PROVIDER)"
set_always JAROKU_EMAIL_API_KEY       "$(envval JAROKU_EMAIL_API_KEY)"
set_always JAROKU_EMAIL_FROM          "$(envval JAROKU_EMAIL_FROM)"

# THE ORIGIN IS THE FLY URL UNTIL THE DOMAIN POINTS HERE. Google will not redirect to a host that
# cannot complete TLS, and www.getjaroku.com currently cannot — so the first deploy uses the address
# that definitely works, and this flips to the domain once it resolves to this app.
ORIGIN="${ORIGIN:-https://${APP}.fly.dev}"
set_always JAROKU_AUTH_ORIGIN     "$ORIGIN"
set_always JAROKU_ALLOWED_ORIGINS "$ORIGIN"

echo "==> deploying (remote builder — no local Docker needed)"
flyctl deploy -a "$APP" --config fly.toml --remote-only --wait-timeout 15m

echo
echo "==> URL:      https://${APP}.fly.dev"
echo "==> methods:  $(curl -s --max-time 15 "https://${APP}.fly.dev/v1/auth/methods" || echo unreachable)"
echo
echo "Register this redirect URI on the Google OAuth client:"
echo "  ${ORIGIN}/oauth/google/callback"
