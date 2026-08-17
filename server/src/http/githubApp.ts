// The three round trips that replace a text field.
//
// §2.1's empty state used to end in an input box and a paragraph about which permissions to tick.
// This is what it ends in now: a button, GitHub's own screens, and a redirect back. Nothing is
// copied, nothing is pasted, and the permissions are decided by a manifest in this repository
// rather than by whoever is reading the instructions.
//
// THREE ROUTES, AND THEY ARE THREE BECAUSE GITHUB SPLITS THE JOURNEY IN THREE:
//
//   GET  /v1/github/app/start       decide what the browser should do next — register the App
//                                   (once per deployment) or install it (once per workspace).
//   GET  /v1/github/app/registered  GitHub redirects here after somebody creates the App from our
//                                   manifest, carrying a one-time code. We trade it for the App's
//                                   private key and store it. Happens once, ever, per deployment.
//   GET  /v1/github/install/callback GitHub redirects here after somebody chooses repositories,
//                                   carrying an installation id and — because the App requests
//                                   user authorization — a code for the user token too.
//
// WHY THESE ARE UNAUTHENTICATED IN THE `guarded()` SENSE, and why that is not a hole. They are
// REDIRECT TARGETS: a browser arrives here from github.com, following a 302, with no Authorization
// header and no way to add one. The same shape `POST /v1/github/webhook` and the OAuth connector
// callbacks already have. What stands in for the bearer token is the `state` parameter — issued by
// `/start` to a caller that WAS guarded, single-use, ten-minute lifetime, and carrying the
// workspace id server-side so the callback never takes a tenant from a query string. A request
// without a state it issued is refused before anything is read.
//
// AND NOTHING HERE TRUSTS A REPOSITORY NAME, AN ACCOUNT OR A WORKSPACE FROM THE QUERY STRING. The
// installation id is exchanged with GitHub for the account it belongs to; the workspace comes from
// the state; the login is whatever GitHub says it is.

import { badRequest, unauthorized, type Handler, type HttpRequest, type HttpResponse } from "./router.ts";
import {
  APP_ENV, RoundTripStates, buildManifest, convertManifest, exchangeUserCode, githubAppConfig,
  githubWebBase, readInstallation,
} from "../githubApp.ts";
import type { GithubIdentity } from "../githubIdentity.ts";
import { requireCapability } from "../auth/capabilities.ts";
import { newRequestId, systemContextFor, type TenantContext } from "../db/tenant.ts";

export interface GithubAppRoutesDeps {
  identity: GithubIdentity;
  /**
   * Who is asking, through the same resolver every authenticated route uses.
   *
   * `/start` IS GUARDED AND THE OTHER TWO CANNOT BE. This one is an ordinary request from the app,
   * so the workspace comes from the caller's own token — never from a query parameter, which would
   * let anybody who can reach the port issue a state for a tenant they are not in. The two
   * callbacks are redirect targets with no Authorization header available to them, and what stands
   * in for one there is the single-use state this route issued.
   *
   * NO ELEVATION, DELIBERATELY, and this is a change from the token flow it replaces. Storing a
   * pasted token wrote a credential and therefore needed an unlocked Secrets session — which meant
   * the first thing a new user saw after pressing Connect was "this needs an unlocked Secrets
   * session", on step one of the feature. Starting an install writes nothing: the credentials
   * arrive later, from GitHub, on a callback. The capability check is what decides who may connect.
   */
  callerFor: (req: HttpRequest) => Promise<{ ctx: TenantContext }>;
  /** Where this server is reachable from a browser. The manifest bakes it in at registration. */
  baseUrl: string;
  /** `runtime/.env` — where the App's own credentials are written. See `githubApp.APP_ENV`. */
  envPath: string;
  /** Issued by `/start`, claimed by a callback. Shared across the three routes deliberately. */
  states: RoundTripStates;
  /** Re-broadcast a workspace's GitHub state once an installation lands, so the panel updates. */
  notify?: (ctx: TenantContext) => void;
  log?: (line: string) => void;
}

/** A tiny page that closes itself, so a redirect target does not leave the user on blank JSON. */
function done(title: string, detail: string, ok: boolean): HttpResponse {
  const tone = ok ? "#3fb950" : "#f85149";
  return {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body:
      `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font:14px -apple-system,system-ui,sans-serif;background:#0d1117;color:#e6edf3;` +
      `display:grid;place-items:center;height:100vh;margin:0">` +
      `<div style="max-width:34rem;padding:2rem"><h1 style="font-size:1rem;color:${tone};margin:0 0 .5rem">${title}</h1>` +
      `<p style="color:#8b949e;line-height:1.6;margin:0">${detail}</p>` +
      `<p style="color:#6e7681;margin:1.5rem 0 0">You can close this tab and return to Jaroku.</p></div>` +
      `<script>try{window.opener&&window.opener.postMessage({jaroku:"github",ok:${ok}},"*")}catch(e){}` +
      `setTimeout(function(){try{window.close()}catch(e){}},${ok ? 1200 : 12000})</script>`,
  };
}

export function githubAppRoutes(
  deps: GithubAppRoutesDeps,
): { path: string; method: "GET"; handler: Handler }[] {
  const log = deps.log ?? ((line: string) => console.log(line));

  /**
   * What the browser should do next.
   *
   * TWO ANSWERS AND THE SERVER PICKS, rather than the client knowing whether an App exists. A
   * deployment registers once and installs many times, so the first person to press Connect on a
   * fresh server does one extra screen and nobody after them ever does — and the client does not
   * have to model that difference.
   */
  const start: Handler = async (req: HttpRequest): Promise<HttpResponse> => {
    const caller = await deps.callerFor(req);
    requireCapability(caller.ctx, "secret:manage");
    const state = deps.states.issue(caller.ctx.workspaceId);
    const app = githubAppConfig();
    if (!app) {
      return {
        status: 200,
        body: {
          action: "register",
          // POSTED AS A FORM BY THE BROWSER, not fetched by us: GitHub renders a confirmation
          // screen at this URL and only a top-level navigation can show it to a person.
          url: `${githubWebBase()}/settings/apps/new`,
          state,
          manifest: JSON.stringify(buildManifest({ baseUrl: deps.baseUrl })),
        },
      };
    }
    return {
      status: 200,
      body: {
        action: "install",
        url: `${githubWebBase()}/apps/${encodeURIComponent(app.slug)}/installations/new?state=${encodeURIComponent(state)}`,
        state,
      },
    };
  };

  /**
   * GitHub has created the App from our manifest. Trade the code for its credentials.
   *
   * THE ONE MOMENT A PRIVATE KEY EXISTS IN THIS PROCESS, and it is spent immediately: written to
   * `runtime/.env` base64-encoded and into the live environment, then dropped. It is not logged and
   * not returned, and the only thing this route says out loud is the App's slug, which is public.
   */
  const registered: Handler = async (req: HttpRequest): Promise<HttpResponse> => {
    const workspaceId = deps.states.claim(req.url.searchParams.get("state"));
    if (!workspaceId) throw unauthorized("that registration link has expired — start again from Jaroku");
    const code = req.url.searchParams.get("code");
    if (!code) throw badRequest("GitHub did not return a registration code");

    const outcome = await convertManifest(code, { envPath: deps.envPath });
    if (!outcome.ok) {
      log(`[github] app registration failed: ${outcome.message}`);
      return done("Registration failed", outcome.message, false);
    }
    log(`[github] registered the GitHub App @${outcome.slug}`);
    // STRAIGHT ON TO THE INSTALL, because registering an App that nobody has installed grants
    // nothing — the person pressed "Connect GitHub" and is not finished until they have.
    const next = deps.states.issue(workspaceId);
    return {
      status: 302,
      headers: {
        location: `${githubWebBase()}/apps/${encodeURIComponent(outcome.slug)}/installations/new?state=${encodeURIComponent(next)}`,
      },
    };
  };

  /**
   * Somebody has chosen what Jaroku may see. Record the grant.
   *
   * THE ACCOUNT IS ASKED FOR RATHER THAN READ OFF THE QUERY STRING. `installation_id` is the only
   * thing GitHub puts in the URL, and a URL is a thing a person can edit — so the account this
   * installation belongs to is established by minting a token for it and asking, which also proves
   * the App can actually use it before a row claims it can.
   */
  const installed: Handler = async (req: HttpRequest): Promise<HttpResponse> => {
    const workspaceId = deps.states.claim(req.url.searchParams.get("state"));
    if (!workspaceId) throw unauthorized("that install link has expired — start again from Jaroku");
    const installationId = req.url.searchParams.get("installation_id");
    if (!installationId) throw badRequest("GitHub did not return an installation");
    const app = githubAppConfig();
    if (!app) throw badRequest("this server has no GitHub App registered");

    const ctx = systemContextFor(workspaceId, newRequestId());
    let account: { login: string; type: "user" | "org" };
    try {
      account = await readInstallation(app, installationId);
    } catch (err) {
      log(`[github] could not read installation ${installationId}: ${(err as Error)?.message}`);
      return done("Could not finish connecting", "GitHub would not confirm that installation.", false);
    }

    // THE USER TOKEN, WHEN THE INSTALL CARRIED ONE. `request_oauth_on_install` puts a `code` on
    // this same redirect, and it is what makes "Create new repo" possible — see githubApp.ts. Its
    // absence is not a failure: the installation is complete and useful, and the one thing that
    // needs a user token says so at the moment somebody tries it.
    let user: { token: string; expiresAt: string | null; refreshToken: string | null } | null = null;
    const code = req.url.searchParams.get("code");
    if (code) {
      try {
        const exchanged = await exchangeUserCode(app, code);
        user = {
          token: exchanged.token,
          expiresAt: exchanged.expiresAt,
          refreshToken: exchanged.refreshToken,
        };
      } catch (err) {
        log(`[github] the user authorization step did not complete: ${(err as Error)?.message}`);
      }
    }

    const outcome = await deps.identity.installApp(ctx, {
      installationId,
      accountLogin: account.login,
      accountType: account.type,
      user,
    });
    if (!outcome.ok) {
      return done("Could not finish connecting", outcome.message ?? "the installation could not be recorded.", false);
    }
    deps.notify?.(ctx);
    return done(
      "GitHub connected",
      `Jaroku is installed on @${account.login}` +
        (user ? "." : ", but the account step was skipped — creating new repositories will ask for it."),
      true,
    );
  };

  return [
    { path: "/v1/github/app/start", method: "GET", handler: start },
    { path: "/v1/github/app/registered", method: "GET", handler: registered },
    { path: "/v1/github/install/callback", method: "GET", handler: installed },
  ];
}

/** Re-exported so the wiring site names the same env keys this module writes. */
export { APP_ENV };
