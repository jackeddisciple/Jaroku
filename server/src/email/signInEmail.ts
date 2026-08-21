// The one email this product sends.
//
// §8.3 SPECIFIES THE COPY ALMOST WORD FOR WORD, and it is followed rather than improved on. Every
// instinct to add something here is the instinct that turns a transactional message into a
// marketing one — and the cost of that is not taste, it is deliverability: providers classify mail
// by what is in it, a sign-in message with a product tour in it looks like a newsletter, and a
// newsletter goes to the Promotions tab where nobody signing in will look for it.
//
// SO, EXPLICITLY, WHAT IS NOT HERE:
//
//   NO MARKETING COPY. Not a tagline, not a "while you're here", not a link to the docs.
//   NO UNSUBSCRIBE LINK. Transactional mail is not subject to CAN-SPAM's unsubscribe requirement,
//   and adding one weakens the transactional classification with the provider. §8.3 says this in
//   as many words, and it is the instruction most likely to be "corrected" by somebody being
//   careful about compliance.
//   NO TRACKING PIXEL, no click-wrapped link, no image of any kind. A remote image is a request to
//   somebody else's server from inside a person's mailbox; a click-wrapper turns a sign-in link
//   into a redirect through a third party, which is both a privacy problem and a phishing pattern
//   filters are trained on.
//   NO EXTERNAL STYLESHEET AND NO WEB FONT. Mail clients strip both, and the ones that do not are
//   the ones that would then render the message differently every time.
//
// AND THE PLAIN-TEXT HALF IS A REAL MESSAGE. §8.3: "Plain-text version is a literal fallback, not a
// 'click here for HTML version' — it contains the same link and message." A multipart message whose
// text half says "your client does not support HTML" is a message that reads as broken to everybody
// on a terminal mail client, and reads as suspicious to a spam filter.

/** §8.3, exactly. Short, specific, and the same every time so it threads in a mailbox. */
export const SIGN_IN_SUBJECT = "Sign in to Jaroku";

/**
 * The message, both halves, for one link.
 *
 * `expiresInMinutes` IS PASSED RATHER THAN HARDCODED so the sentence in the mail and the TTL in the
 * database cannot drift. A message that says fifteen minutes over a token that lives five is a
 * support conversation nobody can resolve.
 */
export function signInEmail(link: string, expiresInMinutes: number): { subject: string; text: string; html: string } {
  return {
    subject: SIGN_IN_SUBJECT,
    text: [
      "Sign in to Jaroku",
      "",
      `Open the link below to sign in. It expires in ${expiresInMinutes} minutes and can only be used once.`,
      "",
      link,
      "",
      "If you didn't request this, you can safely ignore this email — nothing has changed and",
      "nobody has access to your account.",
      "",
      "—",
      "Jaroku",
    ].join("\n"),
    html: html(link, expiresInMinutes),
  };
}

/**
 * The HTML half.
 *
 * TABLE-BASED AND INLINE-STYLED, which is not a stylistic choice — Outlook's rendering engine is
 * Word's, and it supports neither flexbox nor `<style>` blocks reliably. Every layout decision here
 * is one that has to survive that, which is why this looks like 2004 and is correct.
 *
 * LIGHT, DELIBERATELY, unlike every other surface this product draws. A mail client composites a
 * message onto its OWN background and several invert dark colours on their own initiative — so a
 * near-black email is one that renders as a grey box on white in some clients and as unreadable
 * dark-on-dark in others. A message that must be read is a message that takes the mail client's
 * defaults rather than the product's.
 *
 * THE LINK IS BOTH A BUTTON AND TEXT, and the text one is the important half. Some clients strip
 * anchors from unknown senders, several strip background colours from them, and a person forwarding
 * the message to themselves loses the markup entirely — so the raw URL is printed underneath, where
 * it can be copied. It is also what makes the message honest: a button whose destination cannot be
 * read is the shape of every phishing email anybody has been trained to distrust.
 */
function html(link: string, expiresInMinutes: number): string {
  const safe = escape(link);
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f4;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border:1px solid #e7e5e4;border-radius:12px;">
      <tr><td style="padding:32px 32px 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
        <h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;font-weight:600;color:#1c1917;">Sign in to Jaroku</h1>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#57534e;">
          Click the button below to sign in. This link expires in ${expiresInMinutes} minutes and can only be used once.
        </p>
      </td></tr>
      <tr><td style="padding:0 32px 20px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td style="border-radius:8px;background:#1c1917;">
            <a href="${safe}" style="display:inline-block;padding:12px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">Sign in to Jaroku</a>
          </td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:0 32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
        <p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#78716c;">
          Or copy this link into your browser:<br>
          <span style="word-break:break-all;color:#57534e;">${safe}</span>
        </p>
        <p style="margin:0;padding-top:16px;border-top:1px solid #e7e5e4;font-size:13px;line-height:1.6;color:#78716c;">
          If you didn&rsquo;t request this, you can safely ignore this email &mdash; nothing has changed
          and nobody has access to your account.
        </p>
      </td></tr>
    </table>
    <p style="margin:16px 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;color:#a8a29e;">Jaroku</p>
  </td></tr>
</table>
</body></html>`;
}

/**
 * Escape a URL for both an attribute and a text node.
 *
 * THE URL IS OURS AND IT IS STILL ESCAPED. It is built from a token this server minted and an
 * address a person typed — and that address is in the query string. An unescaped `"` in it would
 * close the `href` attribute and put whatever followed into the markup of a message we are sending
 * on that person's behalf, which is an HTML injection into somebody else's inbox.
 */
function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
