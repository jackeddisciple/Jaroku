// The sign-in screen. Shown when, and only when, the session store says `signed_out`.
//
// It renders one of two things, and which one is a property of the SERVER rather than a
// setting here: a server with a local issuer has a `/v1/auth/dev-login` route and this shows a
// form; a server pointed at a real auth provider does not, and this says so instead of
// offering a box that will 404. See server/src/auth/config.ts for why local development gets a
// real issuer rather than a flag that skips verification.
//
// It owns the whole surface, like the welcome and provider steps do, because there is nothing
// underneath it that can be rendered: no session means no workspace, and every panel in the
// app is a view of one workspace's data.

import { useEffect, useState } from "react";
import { devSignIn, localIssuerAvailable } from "../lib/auth.ts";
import { pendingInvite } from "../lib/invite.ts";
import { restartSocket } from "../lib/socket.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { JarokuGlyph } from "../lib/icons.tsx";
import { BRAND } from "../lib/tokens.ts";

export function SignIn() {
  const message = useSessionStore((s) => s.message);
  const localIssuer = useSessionStore((s) => s.localIssuer);
  const setLocalIssuer = useSessionStore((s) => s.setLocalIssuer);
  const [checked, setChecked] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Read once, at mount. The URL cannot change under this screen — there is no router — and the
  // redemption that removes the parameter only runs once there is a session, which is the moment
  // this screen stops being rendered.
  const [invited] = useState(() => pendingInvite() !== null);

  // Ask the server which kind it is. Until the answer arrives neither branch is rendered:
  // flashing a dev form at somebody who needs a real provider is worse than a blank moment.
  useEffect(() => {
    let live = true;
    void localIssuerAvailable().then((available) => {
      if (!live) return;
      setLocalIssuer(available);
      setChecked(true);
    });
    return () => {
      live = false;
    };
  }, [setLocalIssuer]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await devSignIn(email.trim(), name.trim() || undefined);
      // A token exists now. Restarting the socket runs the whole exchange — session, ticket,
      // connect — and moves the session store to `ready` when it lands.
      useSessionStore.getState().setStatus("connecting");
      restartSocket();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-void p-6">
      <div className="w-full max-w-sm rounded-modal border border-edge bg-bg p-8 shadow-overlay">
        <JarokuGlyph size={BRAND.screen} />
        <h1 className="mt-5 text-lg font-medium text-ink">Sign in to Jaroku</h1>

        {/* AN INVITATION SURVIVES THIS SCREEN, and saying so is the difference between a link that
            works and a link that appears to have dropped somebody at a login form for no reason.
            The token stays in the URL until there is a session to spend it with — see lib/invite.ts
            — so nothing here has to carry it. */}
        {invited && (
          <p className="mt-3 rounded-control border border-edge bg-void px-3 py-2 text-[12px] text-muted">
            You have been invited to a workspace. Sign in and it will be accepted for you.
          </p>
        )}

        {message && (
          // Why they are here, when they did not arrive by choice: a revoked membership, an
          // expired token, a server that stopped trusting this session.
          <p className="mt-3 rounded-control border border-edge bg-void px-3 py-2 text-[12px] text-muted">{message}</p>
        )}

        {!checked && <p className="mt-6 text-[13px] text-muted">Checking how this server signs people in…</p>}

        {checked && !localIssuer && (
          <div className="mt-5 space-y-3 text-[13px] text-muted">
            <p>This server verifies tokens against an external identity provider.</p>
            <p className="text-[11px]">
              Sign in there and this tab will pick the session up. The server has no sign-in form of its own —
              it never sees a password, only a token it can verify.
            </p>
          </div>
        )}

        {checked && localIssuer && (
          <form onSubmit={submit} className="mt-5 space-y-3">
            <p className="text-[11px] leading-relaxed text-muted">
              This server is running its own local issuer. The token it mints is real and is verified exactly
              the way a provider&rsquo;s is — but there is no password, so anyone who can reach this port can
              sign in as anyone. Development only.
            </p>
            <label className="block">
              <span className="text-[11px] text-muted">Email</span>
              <input
                type="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="mt-1 w-full rounded-control border border-edge bg-void px-3 py-2 text-[13px] text-ink outline-none focus-visible:shadow-focusring focus:border-chrome"
              />
            </label>
            <label className="block">
              <span className="text-[11px] text-muted">Name (optional)</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full rounded-control border border-edge bg-void px-3 py-2 text-[13px] text-ink outline-none focus-visible:shadow-focusring focus:border-chrome"
              />
            </label>
            {error && <p className="text-[11px] text-err">{error}</p>}
            <button
              type="submit"
              disabled={busy || email.trim().length === 0}
              className="w-full rounded-control bg-ink px-3 py-2 text-[13px] font-medium text-void transition-opacity disabled:opacity-40"
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
