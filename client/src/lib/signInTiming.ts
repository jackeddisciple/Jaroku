// The one number the client and the server both have to agree about.
//
// A MODULE FOR ONE CONSTANT, WHICH NEEDS A REASON. It is here rather than in `signIn.ts` because
// `signIn.ts` reaches for `fetch`, `crypto` and the session vault the moment it is imported — and
// the thing that needs this number is a React component, which would then be dragging the whole
// sign-in machinery into any test that rendered it. A constant that forces its consumers to import
// a network client is a constant in the wrong file.
//
// AND IT IS ASSERTED AGAINST THE SERVER'S OWN by `test:desktop-contract`, across a seam nothing
// typechecks. The server's `RESEND_COOLDOWN_S` is what the rate limiter's shorter sibling is
// documented as; this is what a person watches count down. If they drift, the screen either offers
// a resend the server will refuse — which reads as a broken button — or holds somebody back for
// longer than anything requires.

/**
 * §3.3 step 4's countdown, in seconds.
 *
 * FORTY-FIVE, AND IT IS NOT THE RATE LIMIT. The limit is three an hour and lives on the server,
 * where a client cannot be talked out of it. This is the shorter interval that stops somebody
 * hammering the mail provider the moment the first message is a few seconds slow, and its whole job
 * is to be VISIBLE — a number going down is the difference between "it is coming" and "nothing
 * happened", which is the only question the check-your-email screen exists to answer.
 */
export const RESEND_COOLDOWN_S = 45;
