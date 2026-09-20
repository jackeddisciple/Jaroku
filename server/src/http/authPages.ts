import { createHash } from "node:crypto";

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
// AND THEY LOOK LIKE THE APP. The mark, the dot field, the off-white ground and the ink the app is
// actually drawn in. Somebody arrives here mid-sign-in and is back in the app a second later; a
// white page with Times New Roman on it in between reads as having been redirected somewhere
// unrelated, which is the exact feeling a phishing page produces.
//
// THEY WERE EXACTLY THAT, AND FOR TWO REASONS AT ONCE.
//
// THE FIRST: the policy on these responses is `default-src 'none'` with no `style-src`, so
// `style-src` fell back to `'none'` and the browser dropped every rule in the block below. The
// markup was correct, the stylesheet was right there in the document, and what a person saw at the
// end of a real sign-in was Times New Roman on white with a blue underlined link. Inline SVG is not
// governed by `style-src`, so the mark rendered — which made it look like a page that had loaded
// rather than one that had been stripped. `AUTH_PAGE_SECURITY_HEADERS` below is the fix, and it
// names the style by HASH rather than opening `'unsafe-inline'`: the CSS is a constant in this file,
// so the digest is computable at module load and is exact.
//
// THE SECOND: it was still dark. The application was near-black when these were written and is
// off-white now — see client/src/components/auth/AuthShell.tsx, which moved and left this behind.
// A dark page between two light ones is the same "somewhere unrelated" feeling by another route.

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


/**
 * The stylesheet, as one constant so its digest can be computed.
 *
 * LIGHT, BECAUSE THE APPLICATION IS. `#F6F6F4` is the canvas, `#FFFFFF` the elevated surface,
 * `#DCDCD8` the border an input or a card gets, `#1D1D1B` the ink — every one of them the value
 * `client/src/lib/palette.ts` holds, so this page and the screen it hands back to are the same
 * product rather than two.
 *
 * SANS RATHER THAN THE SERIF IT USED TO SET THE HEADING IN. The client had a display serif and
 * dropped it: "what carries it now is size and weight" (AuthShell). A serif here would have been
 * this page keeping a typeface the product no longer has.
 */
const STYLE = `
  :root { color-scheme: light }
  * { box-sizing: border-box }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px;
         background:#F6F6F4; color:#1D1D1B;
         font:400 14px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
         background-image:radial-gradient(rgba(29,29,27,0.05) 1px,transparent 1px); background-size:24px 24px }
  main { width:100%; max-width:420px; padding:40px 32px 32px; text-align:center;
         border:1px solid #DCDCD8; border-radius:16px; background:#FFFFFF;
         box-shadow:0 1px 2px rgba(29,29,27,.04), 0 12px 32px -12px rgba(29,29,27,.10) }
  h1 { margin:0 0 10px; font-size:28px; line-height:1.2; font-weight:600; letter-spacing:-.01em; color:#1D1D1B }
  p { margin:0; color:#62625F }
  /* THE FALLBACK, AS A CONTROL RATHER THAN A LINK. It is the whole recovery when the browser will
     not hand the scheme over — some refuse it outright for a background application — so it is the
     most important thing on the page in exactly the case somebody is reading it. It was a blue
     underlined link in a quiet grey line at the bottom, which is where a footnote goes. */
  .action { display:block; margin:28px 0 0; padding:12px 16px; border-radius:10px;
            background:#1D1D1B; color:#FAFAF9; font-size:13px; font-weight:500; text-decoration:none }
  .action:hover { background:#333330 }
  .action:focus-visible { outline:2px solid #1D1D1B; outline-offset:2px }
  .quiet { margin-top:14px; color:#90908C; font-size:12px }
  svg { display:block; margin:0 auto 20px }
`;

/**
 * The policy these documents need, and no more of one.
 *
 * A HASH RATHER THAN `'unsafe-inline'`. The stylesheet is a constant in this module, so its digest
 * is exact and cannot drift — edit the CSS and the hash follows on the next boot. `'unsafe-inline'`
 * would permit any style attribute anybody ever manages to inject into these pages; the hash
 * permits precisely the block above and nothing else. Everything else stays `'none'`: no script, no
 * frame, no form, no image, no font, from anywhere.
 */
export const AUTH_PAGE_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-security-policy":
    `default-src 'none'; style-src 'sha256-${createHash("sha256").update(STYLE, "utf8").digest("base64")}'; ` +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
});

const STYLE_TAG = `<style>${STYLE}</style>`;

export function authPage(input: AuthPageInput): string {
  const redirect = input.redirect
    ? `<meta http-equiv="refresh" content="0;url=${escapeAttr(input.redirect)}">`
    : "";
  // THE ACTION FIRST, THE EXPLANATION UNDER IT. When there is a fallback it is the thing to press,
  // so it is drawn as a control and the sentence that used to introduce it becomes the quiet line
  // beneath — which is the order somebody reads them in when the automatic hand-off has not worked.
  const footer = input.footer
    ? `<a class="action" href="${escapeAttr(input.footer.href)}">${escapeText(input.footer.linkText)}</a>` +
      `<p class="quiet">${escapeText(input.footer.text)}</p>`
    : "";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeText(input.title)} &middot; Jaroku</title>
<meta name="robots" content="noindex,nofollow">
${STYLE_TAG}
${redirect}
</head><body><main>
${MARK}
<h1>${escapeText(input.heading)}</h1>
<p>${escapeText(input.body)}</p>
${footer}
</main></body></html>`;
}

/**
 * The same three contours as `lib/icons.tsx`, traced from `assets/mono.png`.
 *
 * INLINE, AND IT HAS TO BE. These pages carry `default-src 'none'` with no `img-src` of its own, so
 * every image on them — an `<img>`, a `data:` URI, a background — is refused by the policy. A mark
 * that is markup is the only mark this page can have, which is why the contours are pasted here
 * rather than referenced, and why a logo change is an edit to this file.
 *
 * INK, NOT THE OLD NEAR-WHITE. The fill was `#e4e4e7`, which is what a mark on a near-black page
 * has to be and which is very nearly invisible on the white card these pages now draw — it survived
 * the theme move because the SVG is a string rather than a rule and the stylesheet's colours were
 * the only thing anybody thought to change.
 */
const MARK = `<svg width="26" height="26" viewBox="0 0 24 24" fill="#1D1D1B" aria-hidden="true"><path d="M11.99 3.30C12.66 3.32 12.85 3.29 13.46 3.40C13.56 3.42 13.64 3.47 13.73 3.49C13.76 3.50 13.79 3.48 13.82 3.49C14.09 3.57 14.36 3.65 14.62 3.76C15.03 3.93 15.40 4.16 15.74 4.44C15.84 4.52 15.92 4.62 16.02 4.71C16.03 4.71 16.04 4.70 16.05 4.71C16.23 4.90 16.42 5.09 16.58 5.30C16.77 5.55 16.94 5.83 17.11 6.10C17.13 6.14 17.30 6.38 17.25 6.51C17.19 6.68 16.78 6.58 16.76 6.58C16.47 6.60 16.14 6.72 15.89 6.83C15.62 6.95 15.24 7.19 15.01 7.36C14.95 7.40 14.91 7.46 14.85 7.50C14.82 7.53 14.77 7.54 14.74 7.57C14.69 7.60 14.67 7.65 14.62 7.69C14.61 7.70 14.60 7.69 14.59 7.69C14.43 7.84 14.27 7.98 14.12 8.14C14.12 8.14 14.13 8.16 14.12 8.17C14.03 8.28 13.92 8.36 13.83 8.47C13.60 8.76 13.49 8.91 13.37 9.23C13.34 9.30 13.31 9.37 13.30 9.45C13.29 9.57 13.29 9.70 13.30 9.83C13.31 9.96 13.46 10.20 13.52 10.27C13.60 10.37 13.72 10.44 13.81 10.53C13.81 10.54 13.85 10.64 13.80 10.65C13.62 10.70 13.62 10.62 13.44 10.61C12.85 10.59 12.09 10.57 11.69 11.10C11.63 11.18 11.58 11.26 11.54 11.35C11.50 11.43 11.49 11.52 11.47 11.61C11.44 11.90 11.55 12.22 11.73 12.44C11.86 12.61 12.02 12.77 12.17 12.92C12.18 12.93 12.20 12.92 12.21 12.93C12.31 13.02 12.39 13.13 12.49 13.22C12.50 13.23 12.51 13.21 12.52 13.22C12.63 13.32 12.72 13.43 12.82 13.53C12.83 13.54 12.85 13.53 12.86 13.54C13.03 13.71 13.20 13.88 13.36 14.06C13.37 14.07 13.36 14.09 13.37 14.10C13.42 14.15 13.48 14.19 13.53 14.25C13.59 14.32 13.63 14.41 13.68 14.48C13.71 14.50 13.74 14.52 13.76 14.55C14.02 14.92 14.21 15.21 14.37 15.62C14.50 15.93 14.60 16.30 14.65 16.63C14.67 16.76 14.66 16.90 14.67 17.03C14.67 17.04 14.69 17.04 14.69 17.05C14.69 17.23 14.69 17.41 14.67 17.58C14.63 17.99 14.50 18.39 14.29 18.74C14.10 19.06 13.86 19.32 13.57 19.56C13.40 19.71 13.20 19.85 13.00 19.96C12.79 20.09 12.56 20.19 12.33 20.28C12.18 20.34 12.01 20.38 11.85 20.41C11.77 20.42 11.69 20.42 11.61 20.41C11.50 20.39 11.40 20.35 11.31 20.30C11.11 20.18 11.03 19.94 11.01 19.72C11.00 19.59 11.02 19.46 11.01 19.32C11.00 19.15 10.98 18.97 10.95 18.79C10.85 18.26 10.74 17.93 10.49 17.45C10.17 16.85 10.28 17.12 9.96 16.75C9.96 16.74 9.97 16.72 9.96 16.71C9.49 16.25 9.39 16.15 8.78 15.85C8.75 15.83 8.36 15.60 8.22 15.74C8.19 15.77 8.17 15.83 8.20 15.86C8.40 16.14 8.66 16.36 8.87 16.63C9.24 17.11 9.44 17.52 9.67 18.08C9.74 18.27 9.86 18.74 9.88 18.94C9.91 19.36 9.97 19.76 9.83 20.15C9.81 20.21 9.79 20.27 9.75 20.32C9.61 20.52 9.37 20.70 9.11 20.70C6.98 20.73 4.85 20.72 2.72 20.70C2.59 20.70 2.47 20.67 2.34 20.64C2.03 20.57 1.77 20.48 1.50 20.32C0.76 19.90 0.27 19.16 0.08 18.34C0.04 18.13 0.02 17.92 0.00 17.71C-0.01 17.54 -0.02 17.37 0.00 17.20C0.07 16.52 0.17 16.13 0.44 15.49C0.69 14.91 1.00 14.40 1.39 13.89C1.52 13.72 1.69 13.57 1.83 13.40C1.83 13.40 1.82 13.38 1.83 13.37C2.07 13.12 2.32 12.87 2.57 12.63C2.58 12.62 2.59 12.64 2.60 12.63C2.65 12.59 2.69 12.53 2.74 12.49C2.74 12.48 2.76 12.49 2.77 12.48C2.82 12.44 2.85 12.38 2.90 12.34C2.98 12.27 3.07 12.23 3.15 12.17C3.18 12.14 3.20 12.09 3.24 12.07C3.50 11.86 3.77 11.67 4.04 11.48C4.07 11.46 4.11 11.45 4.14 11.43C4.16 11.42 4.16 11.39 4.19 11.37C4.24 11.34 4.30 11.32 4.35 11.28C4.80 10.96 5.06 10.76 5.42 10.36C5.78 9.95 6.04 9.48 6.22 8.97C6.51 8.16 6.31 8.51 6.62 7.45C6.70 7.17 6.80 6.89 6.92 6.62C7.14 6.10 7.41 5.70 7.78 5.26C7.92 5.08 8.10 4.93 8.26 4.77C8.27 4.76 8.29 4.78 8.30 4.77C8.43 4.66 8.55 4.54 8.68 4.44C9.32 3.95 10.09 3.63 10.87 3.45C11.54 3.29 11.36 3.37 11.97 3.32C11.98 3.32 11.98 3.30 11.99 3.30Z"/><path d="M17.37 7.25C17.47 7.25 17.57 7.23 17.67 7.25C17.96 7.31 18.13 7.60 18.30 7.80C18.31 7.81 18.30 7.83 18.31 7.84C18.57 8.11 18.73 8.26 19.05 8.45C19.62 8.79 20.08 8.91 20.79 9.12C21.01 9.19 21.23 9.21 21.45 9.27C21.51 9.28 21.56 9.32 21.61 9.33C22.39 9.51 22.44 9.44 23.24 9.73C23.49 9.82 23.74 9.98 23.89 10.20C24.11 10.51 24.02 10.97 23.79 11.24C23.34 11.77 22.68 12.10 22.04 12.34C21.58 12.51 21.23 12.58 20.74 12.67C20.62 12.69 20.51 12.71 20.40 12.71C20.30 12.72 20.20 12.71 20.10 12.71C20.09 12.72 20.09 12.74 20.08 12.74C19.91 12.74 19.74 12.74 19.57 12.74C19.57 12.74 19.57 12.72 19.56 12.71C19.01 12.66 19.21 12.75 18.63 12.59C18.22 12.48 17.73 12.30 17.34 12.13C17.24 12.08 17.14 12.01 17.04 11.96C17.02 11.95 17.00 11.96 16.99 11.96C16.55 11.74 16.13 11.52 15.70 11.28C15.65 11.26 15.62 11.21 15.57 11.18C15.45 11.11 15.32 11.06 15.20 10.99C14.93 10.83 14.72 10.66 14.54 10.40C14.49 10.31 14.44 10.21 14.42 10.10C14.33 9.63 14.60 9.18 14.90 8.85C15.10 8.63 15.31 8.43 15.53 8.24C15.72 8.08 15.92 7.95 16.12 7.82C16.31 7.70 16.49 7.59 16.69 7.50C16.91 7.40 17.13 7.25 17.37 7.25Z"/><path d="M13.65 5.76C13.45 5.83 13.33 5.84 13.20 6.01C13.11 6.13 13.02 6.33 13.03 6.48C13.04 6.78 13.22 7.09 13.52 7.19C13.69 7.24 13.78 7.24 13.97 7.21C14.06 7.19 14.15 7.14 14.22 7.08C14.41 6.92 14.54 6.71 14.52 6.46C14.50 6.20 14.41 6.04 14.20 5.89C14.08 5.79 13.82 5.70 13.65 5.76Z"/></svg>`;

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
