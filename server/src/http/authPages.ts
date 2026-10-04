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
 * The same path as `lib/icons.tsx`, traced from `assets/thenewlogo.png`.
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
const MARK = `<svg width="26" height="26" viewBox="0 0 24 24" fill="#1D1D1B" aria-hidden="true"><path d="M16.36 23.14C16.36 22.77 16.64 21.62 16.92 20.84C17.08 20.39 17.20 20.06 17.22 20.03C17.23 20.01 17.26 19.95 17.29 19.88C17.44 19.57 17.64 19.19 17.71 19.08C17.81 18.93 17.85 18.92 18.12 18.98C18.80 19.14 19.04 19.19 19.18 19.21C19.27 19.22 19.41 19.25 19.51 19.27C20.04 19.37 21.08 19.40 21.42 19.32C22.13 19.15 22.46 18.66 22.36 17.94C22.27 17.30 22.32 17.08 22.63 16.70C22.76 16.54 22.77 16.52 22.72 16.42C22.68 16.36 22.66 16.35 22.49 16.32C22.20 16.28 22.07 16.20 22.07 16.06C22.07 15.94 22.14 15.87 22.28 15.84C22.83 15.70 22.99 15.53 22.81 15.24C22.59 14.90 22.53 14.64 22.60 14.44C22.64 14.35 22.67 14.32 22.87 14.18C23.15 14.00 23.32 13.84 23.40 13.68C23.50 13.47 23.51 13.49 22.99 12.94C22.27 12.19 22.00 11.78 21.74 11.06C21.70 10.93 21.65 10.82 21.64 10.82C21.63 10.82 21.62 10.79 21.62 10.76C21.62 10.69 21.50 10.25 21.46 10.15C21.45 10.13 21.43 10.04 21.41 9.97C21.35 9.66 21.08 8.72 21.02 8.60C21.00 8.57 20.98 8.49 20.96 8.44C20.92 8.29 20.68 7.79 20.60 7.69C20.56 7.64 20.53 7.59 20.53 7.59C20.53 7.58 20.50 7.52 20.46 7.46L20.39 7.35L20.25 7.61C20.07 7.96 19.94 8.19 19.81 8.36C19.76 8.44 19.71 8.52 19.71 8.54C19.71 8.56 19.70 8.58 19.68 8.59C19.66 8.60 19.55 8.74 19.42 8.89C19.16 9.23 18.66 9.75 18.33 10.03C18.21 10.14 18.10 10.25 18.10 10.27C18.10 10.28 18.08 10.30 18.06 10.30C18.03 10.30 17.65 10.56 17.38 10.76C17.34 10.80 17.30 10.82 17.29 10.82C17.28 10.82 17.23 10.85 17.18 10.88C17.06 10.97 16.77 11.13 16.50 11.27C16.37 11.34 16.26 11.40 16.26 11.41C16.26 11.42 16.24 11.43 16.22 11.43C16.16 11.43 15.68 11.63 15.63 11.67C15.61 11.69 15.57 11.71 15.55 11.71C15.41 11.71 15.22 11.90 15.18 12.07C15.18 12.11 15.16 12.14 15.14 12.14C15.04 12.18 14.94 12.77 14.97 13.10C15.01 13.51 15.32 14.20 15.60 14.51C15.62 14.53 15.67 14.60 15.71 14.65C15.74 14.70 15.79 14.74 15.80 14.74C15.82 14.74 15.83 14.76 15.83 14.78C15.83 14.80 15.88 14.87 15.94 14.94C16.19 15.25 16.47 15.65 16.67 16.02C16.74 16.14 16.87 16.61 16.91 16.87C16.97 17.20 16.92 17.80 16.82 18.02C16.80 18.06 16.78 18.12 16.77 18.15C16.63 18.62 16.09 19.28 15.85 19.28C15.74 19.28 15.74 19.23 15.86 18.87C16.12 18.06 16.07 17.25 15.71 16.63C15.63 16.51 15.63 16.52 15.67 16.68C16.03 18.22 15.36 19.86 13.99 20.77C13.86 20.86 13.75 20.94 13.74 20.95C13.73 20.97 13.71 20.98 13.69 20.98C13.68 20.98 13.58 21.02 13.47 21.07C13.36 21.12 13.19 21.19 13.08 21.23C12.96 21.27 12.85 21.31 12.83 21.32C12.67 21.39 11.99 21.48 11.66 21.48C11.41 21.48 11.42 21.48 11.26 21.69C11.07 21.93 10.73 22.24 10.45 22.44C10.05 22.71 9.32 22.93 8.82 22.93C8.65 22.93 8.67 22.86 8.88 22.57C9.08 22.28 9.23 22.03 9.34 21.77C9.45 21.50 9.44 21.48 9.24 21.61C8.37 22.18 7.29 22.39 6.19 22.21C5.50 22.09 5.00 21.83 4.84 21.49C4.73 21.27 4.78 20.96 4.96 20.72L5.05 20.60L4.79 20.72C4.32 20.92 4.05 20.99 3.70 21.02C2.76 21.10 2.03 20.45 2.07 19.57C2.10 18.98 2.44 18.41 3.28 17.56C3.49 17.35 3.65 17.17 3.65 17.17C3.64 17.17 3.51 17.23 3.37 17.31C2.17 17.90 1.24 18.05 0.62 17.74C0.02 17.44 -0.16 16.86 0.16 16.21C0.46 15.58 1.18 14.95 2.33 14.31C2.90 13.99 3.32 13.61 3.61 13.18C3.72 13.01 3.85 12.71 3.87 12.58C3.89 12.49 3.90 12.50 3.57 12.45C2.98 12.37 2.19 12.06 1.69 11.72C1.28 11.44 0.84 10.93 0.68 10.56C0.60 10.37 0.60 10.01 0.67 9.82C0.79 9.53 1.25 9.04 2.02 8.37C2.52 7.94 2.95 7.54 3.13 7.35C3.47 7.00 3.81 6.62 4.01 6.37C5.44 4.68 6.21 3.91 7.28 3.10C10.23 0.89 13.61 0.21 16.65 1.22C17.91 1.64 18.91 2.31 19.79 3.31C19.87 3.40 19.88 3.40 19.99 3.40C20.46 3.40 21.07 3.63 21.52 3.97C21.98 4.31 22.56 4.99 22.81 5.49C23.33 6.52 22.96 7.74 21.85 8.58L21.72 8.69L21.79 8.95C21.84 9.10 21.92 9.44 21.98 9.71C22.17 10.52 22.21 10.69 22.29 10.92C22.49 11.50 22.76 11.89 23.45 12.62C23.94 13.13 24.00 13.23 24.00 13.53C24.00 13.87 23.73 14.26 23.30 14.55C23.11 14.68 23.11 14.68 23.26 14.95C23.49 15.35 23.48 15.66 23.22 15.93L23.12 16.04L23.20 16.15C23.37 16.41 23.32 16.70 23.08 16.99C22.88 17.23 22.84 17.44 22.91 17.88C23.07 18.86 22.50 19.66 21.49 19.88C21.14 19.95 20.28 19.95 19.80 19.88C19.72 19.87 19.72 19.87 19.69 19.97C19.64 20.13 19.65 20.51 19.71 20.72C19.84 21.19 20.19 21.66 20.57 21.89C20.72 21.98 20.73 21.99 20.73 22.06C20.73 22.15 20.70 22.16 20.40 22.26C19.46 22.57 18.10 22.63 17.27 22.40C17.16 22.37 17.06 22.35 17.06 22.36C17.04 22.38 16.96 22.80 16.92 23.05L16.89 23.25L16.62 23.25L16.36 23.25L16.36 23.14ZM6.97 13.02C8.54 11.57 10.16 10.28 12.22 8.88C16.29 6.08 20.02 4.70 21.85 5.30C21.94 5.32 22.02 5.35 22.02 5.34C22.04 5.32 21.71 4.92 21.51 4.72C20.93 4.13 20.20 3.86 19.25 3.86L18.96 3.86L18.96 3.78C18.96 3.70 18.97 3.69 19.10 3.64C19.18 3.60 19.24 3.57 19.24 3.56C19.24 3.55 19.08 3.39 18.89 3.21C18.39 2.72 18.05 2.47 17.44 2.17C14.99 0.94 11.89 1.08 9.18 2.54C7.55 3.42 6.38 4.44 4.71 6.42C3.83 7.46 3.34 7.96 2.40 8.78C1.55 9.53 1.18 9.94 1.18 10.14C1.18 10.45 1.58 10.95 2.09 11.29C2.58 11.62 3.35 11.88 3.89 11.91L3.99 11.92L4.06 11.72C4.24 11.18 4.58 10.75 5.04 10.48C5.14 10.42 5.21 10.39 5.27 10.39C5.35 10.39 5.35 10.39 5.35 10.48C5.35 10.56 5.34 10.58 5.30 10.59C5.27 10.60 5.23 10.64 5.21 10.67C5.02 10.93 4.87 11.21 4.83 11.36C4.74 11.73 4.74 11.74 4.75 12.06C4.75 12.34 4.76 12.40 4.83 12.58C5.00 13.10 5.36 13.66 5.72 13.97L5.86 14.09L6.31 13.66C6.55 13.42 6.85 13.13 6.97 13.02ZM19.78 12.55C19.35 12.41 19.23 11.83 19.57 11.51L19.70 11.40L19.90 11.40C20.11 11.40 20.11 11.40 20.21 11.48C20.49 11.70 20.51 12.19 20.23 12.44C20.11 12.55 19.94 12.59 19.78 12.55ZM18.45 10.90C18.41 10.87 18.40 10.84 18.40 10.75C18.40 10.65 18.41 10.63 18.53 10.48C18.69 10.27 18.86 10.12 19.07 9.99C19.15 9.93 19.23 9.88 19.23 9.86C19.24 9.85 19.25 9.84 19.27 9.84C19.29 9.84 19.39 9.81 19.51 9.78C19.91 9.65 20.14 9.69 20.14 9.91C20.14 10.07 20.14 10.08 19.90 10.15C19.50 10.26 19.22 10.42 18.86 10.75C18.63 10.95 18.56 10.98 18.45 10.90Z"/></svg>`;

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
