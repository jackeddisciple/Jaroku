// The five pages a browser sees during a sign-in, and the one shell all of them are.
//
// WHY THERE ARE PAGES AT ALL. Two of this server's routes are driven by something other than the
// Jaroku client — Google redirecting a browser back, and a person clicking a link in their mail —
// and whatever is at the end of those is being looked at by a person in a tab. `http/oauth.ts`
// makes this argument first for the connections flow: `{"error":{"code":"bad_request"}}` on a white
// page is not something anybody can act on.
//
// WHY THEY ARE SHARED. Both flows end at the same four outcomes — signed in, cancelled, expired,
// something broke — and two files that each drew a "you can close this tab" page are two pages that
// eventually say it differently. Somebody who signs in with Google on Monday and a link on Tuesday
// would then have met two products.
//
// SELF-CONTAINED, WITH NO EXTERNAL ANYTHING. No font, no stylesheet, no script, no image, from any
// origin. These are served from the auth domain, which is the one origin in this product that must
// have the smallest possible attack surface — §3.2's own reasoning for keeping the callback
// stateless — and a page that pulls a webfont from a CDN is a page whose appearance depends on
// somebody else's uptime at the exact moment somebody is trying to sign in.
//
// AND THEY LOOK LIKE THE APP. Near-black, the dot field, the mark, and the display serif for the
// one line that matters. Somebody arrives here mid-sign-in and is back in the app a second later; a
// white page with Times New Roman on it in between reads as having been redirected somewhere
// unrelated, which is the exact feeling a phishing page produces.

export interface AuthPageInput {
  /** The `<title>`, which is what a browser tab and a history entry show. */
  title: string;
  /** The one line in the serif. */
  heading: string;
  /** One or two sentences under it. Plain text; anything with markup in it is escaped. */
  body: string;
  /** The quiet line at the bottom, when there is one. */
  footer?: { text: string; linkText: string; href: string };
  /**
   * Where to send the browser immediately, when there is somewhere.
   *
   * A `<meta http-equiv="refresh">` RATHER THAN A 302 or `location.assign`. A 302 to `jaroku://`
   * is refused outright by several browsers — a redirect to a scheme the browser cannot handle is
   * treated as a failed navigation — and a script-driven one is blocked by the same. A meta refresh
   * is handled by the browser's own external-protocol machinery, which is what puts up the "open
   * Jaroku?" prompt some platforms show. That prompt is the reason `footer` exists: §3.2 step 7
   * asks for a visible fallback for exactly the people who dismiss it.
   */
  redirect?: string;
}

export function authPage(input: AuthPageInput): string {
  const redirect = input.redirect
    ? `<meta http-equiv="refresh" content="0;url=${escapeAttr(input.redirect)}">`
    : "";
  const footer = input.footer
    ? `<p class="quiet">${escapeText(input.footer.text)} <a href="${escapeAttr(input.footer.href)}">${escapeText(
        input.footer.linkText,
      )}</a></p>`
    : "";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeText(input.title)} &middot; Jaroku</title>
<meta name="robots" content="noindex,nofollow">
<style>
  :root { color-scheme: dark }
  * { box-sizing: border-box }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px;
         background:#08080a; color:#e4e4e7;
         font:400 14px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
         background-image:radial-gradient(rgba(228,228,231,0.05) 1px,transparent 1px); background-size:24px 24px }
  main { width:100%; max-width:420px; padding:36px 32px; text-align:center;
         border:1px solid #2a2a30; border-radius:14px; background:rgba(13,13,15,0.92);
         box-shadow:0 4px 12px rgba(0,0,0,.4), 0 28px 64px -16px rgba(0,0,0,.7) }
  h1 { margin:0 0 12px; font:400 26px/1.2 ui-serif,Georgia,Cambria,"Times New Roman",serif; letter-spacing:-.005em; color:#e4e4e7 }
  p { margin:0; color:#a1a1aa }
  .quiet { margin-top:22px; padding-top:18px; border-top:1px solid #1e1e22; color:#71717a; font-size:12px }
  a { color:#e08a5c; text-underline-offset:2px }
  svg { display:block; margin:0 auto 18px }
</style>
${redirect}
</head><body><main>
${MARK}
<h1>${escapeText(input.heading)}</h1>
<p>${escapeText(input.body)}</p>
${footer}
</main></body></html>`;
}

/** The same three contours as `lib/icons.tsx` and `assets/logo.svg`. Inline, so nothing is fetched. */
const MARK = `<svg width="26" height="26" viewBox="0 0 24 24" fill="#e4e4e7" aria-hidden="true"><path d="M11 1.04C11.6 0.98 12.2 0.97 12.79 1.03C13.38 1.07 13.97 1.18 14.54 1.34C15.12 1.5 15.69 1.7 16.22 1.95C16.76 2.2 17.37 2.46 17.76 2.85C18.13 3.25 18.55 3.85 18.51 4.36C18.48 4.85 17.94 5.4 17.56 5.85C17.19 6.3 16.73 6.7 16.24 7.05C15.77 7.39 15.23 7.66 14.69 7.9C14.15 8.14 13.57 8.32 12.99 8.47C12.42 8.62 11.83 8.7 11.25 8.83C10.66 8.96 10.08 9.07 9.51 9.24C8.94 9.41 8.37 9.62 7.83 9.86C7.29 10.09 6.76 10.37 6.25 10.68C5.75 11 5.26 11.36 4.81 11.74C4.36 12.13 4.01 12.68 3.55 13C3.08 13.31 2.39 13.78 2.02 13.62C1.64 13.48 1.39 12.64 1.3 12.08C1.21 11.53 1.37 10.89 1.47 10.31C1.57 9.73 1.71 9.14 1.9 8.58C2.08 8.01 2.29 7.45 2.57 6.92C2.83 6.39 3.15 5.89 3.49 5.4C3.85 4.92 4.24 4.47 4.67 4.05C5.09 3.64 5.56 3.26 6.05 2.92C6.54 2.59 7.06 2.29 7.59 2.04C8.13 1.78 8.69 1.56 9.26 1.39C9.83 1.23 10.41 1.1 11 1.04Z"/><path d="M20.99 7.72C21.31 7.65 21.84 8.21 22.08 8.61C22.33 9.01 22.39 9.63 22.5 10.15C22.6 10.67 22.66 11.2 22.69 11.73C22.71 12.27 22.68 12.8 22.62 13.33C22.57 13.85 22.48 14.38 22.34 14.9C22.21 15.41 22.04 15.91 21.83 16.41C21.62 16.9 21.39 17.38 21.11 17.83C20.85 18.29 20.53 18.73 20.2 19.14C19.86 19.55 19.51 19.96 19.11 20.31C18.73 20.67 18.29 20.99 17.85 21.29C17.41 21.58 16.95 21.86 16.47 22.08C16 22.31 15.49 22.5 14.98 22.65C14.47 22.8 13.92 22.97 13.41 22.96C12.9 22.95 12.31 22.84 11.9 22.57C11.49 22.29 11.08 21.79 10.95 21.32C10.81 20.86 10.88 20.22 11.07 19.77C11.27 19.32 11.72 18.92 12.12 18.59C12.52 18.26 13.05 18.07 13.49 17.78C13.93 17.49 14.38 17.19 14.8 16.85C15.21 16.52 15.6 16.15 15.97 15.78C16.34 15.39 16.68 14.98 17.01 14.57C17.34 14.15 17.66 13.71 17.95 13.27C18.24 12.83 18.53 12.38 18.78 11.91C19.04 11.45 19.29 10.97 19.52 10.49C19.75 10.01 19.91 9.49 20.16 9.03C20.41 8.56 20.67 7.78 20.99 7.72Z"/><path d="M10.31 11.35C10.75 11.29 11.21 11.29 11.65 11.3C12.1 11.33 12.56 11.37 12.98 11.51C13.39 11.64 13.88 11.82 14.15 12.13C14.42 12.43 14.61 12.94 14.61 13.35C14.6 13.76 14.36 14.22 14.12 14.59C13.88 14.94 13.5 15.24 13.15 15.51C12.81 15.8 12.4 16.01 12.04 16.25C11.66 16.51 11.29 16.75 10.94 17.02C10.59 17.31 10.24 17.6 9.95 17.94C9.65 18.27 9.37 18.64 9.18 19.04C8.99 19.43 8.87 19.88 8.8 20.32C8.74 20.76 8.9 21.28 8.76 21.66C8.63 22.05 8.33 22.51 7.99 22.64C7.64 22.78 7.09 22.61 6.67 22.46C6.26 22.32 5.86 22.07 5.5 21.81C5.14 21.55 4.81 21.23 4.54 20.88C4.26 20.53 4.03 20.14 3.85 19.73C3.69 19.32 3.56 18.87 3.52 18.43C3.48 18 3.51 17.53 3.59 17.1C3.68 16.66 3.81 16.22 4 15.81C4.17 15.4 4.4 15.01 4.66 14.65C4.91 14.28 5.21 13.93 5.53 13.62C5.84 13.31 6.2 13.03 6.57 12.78C6.94 12.53 7.34 12.33 7.75 12.14C8.16 11.95 8.57 11.77 9 11.64C9.42 11.51 9.86 11.41 10.31 11.35Z"/></svg>`;

/**
 * Escape for an attribute, and for a text node.
 *
 * TWO FUNCTIONS RATHER THAN ONE, because the deep link goes into an `href` and a `content=` and
 * both of those are attribute contexts where a bare `"` ends the attribute. Everything else here is
 * a text node. One escaper used for both would be correct; two named for their context is what
 * makes it obvious at the call site which one is needed, which is what stops the next person
 * interpolating an attribute with the text escaper.
 *
 * NOTHING INTERPOLATED HERE COMES FROM A USER TODAY — every value is a constant in this codebase or
 * a URL built from a token this server minted. It is escaped anyway, because "no user input reaches
 * this template" is a property of today's call sites rather than of the template, and the day it
 * stops being true is a day nobody will remember to check.
 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
