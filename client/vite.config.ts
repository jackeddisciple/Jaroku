import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The client talks to the Node relay (default :4317) over a WebSocket AND over HTTP — the
// whole sign-in exchange (`/v1/auth/*`, `/v1/ws-ticket`) has to happen before a socket can
// exist, because a browser cannot put an `Authorization` header on one.
//
// Still no dev proxy, deliberately. The server answers those requests with CORS headers drawn
// from the same origin allowlist that guards the socket upgrade, so the path a developer
// exercises here is the path a deployment takes — a proxy would work locally and hide the fact
// that a client served from another origin needs the server's permission. See the README's
// "CORS, and why it is here rather than in Session 8".
//
// Override the WS URL with VITE_JAROKU_WS if the relay moves; VITE_JAROKU_API is derived from
// it, so one variable configures both.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
