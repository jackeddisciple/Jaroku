// What a person can change about themselves, which is two things.
//
// `PATCH` RATHER THAN `POST`, AND THAT IS THE WHOLE OF THE INTERFACE DESIGN HERE. Both fields are
// optional and an absent one is untouched — so a settings screen that changes only the marketing
// preference cannot clear a display name by omitting it, and the name-collection screen that sends
// both is doing the same operation rather than a special one.
//
// IT SENDS NO USER ID AND THERE IS NOWHERE TO PUT ONE. The only person this can change is whoever
// holds the token, which is why there is nothing here to get wrong: a route that accepted an id
// would need a rule about who may edit whom, and the only correct rule is "nobody". The same shape
// `markOnboarded` in `auth.ts` takes, for the same reason.
//
// IT LIVES BESIDE `signIn.ts` RATHER THAN INSIDE `auth.ts` because of what `auth.ts` is: the four
// accessors every reconnect goes through, plus the three requests that establish a session. This is
// neither — it is a mutation somebody makes once, from a screen, and folding it into the module
// that holds the token would mean the token module grew a reason to know what a display name is.

import { apiBase, storedToken, type SessionUser } from "./auth.ts";
import { SignInFailure } from "./signIn.ts";

/** What the server answers with. The same user shape the session view carries, plus the opt-in. */
export interface ProfileUser extends SessionUser {
  marketingEmailsOptIn: boolean;
}

export interface ProfilePatch {
  /** 1-100 characters, trimmed. Emoji allowed — see the server's own note on why nothing is stripped. */
  name?: string;
  /** §3.4's checkbox. Strictly a boolean; the server refuses anything else. */
  marketingEmailsOptIn?: boolean;
}

/**
 * Change the caller's own profile.
 *
 * THROWS A `SignInFailure` RATHER THAN A BARE ERROR, which is a small piece of consistency worth
 * having: every screen in this flow renders a refusal the same way, under the control that produced
 * it, and a second error class would mean a second `instanceof` at every call site.
 */
export async function updateProfile(patch: ProfilePatch): Promise<ProfileUser> {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/v1/users/me`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        // The bearer token, which is the whole of the authorisation: there is no id in the body
        // because the only account this can touch is the one behind this token.
        ...(storedToken() ? { authorization: `Bearer ${storedToken()}` } : {}),
      },
      body: JSON.stringify(patch),
    });
  } catch (err) {
    throw new SignInFailure((err as Error).message || "could not reach the server", "network");
  }

  if (!res.ok) {
    const text = await res.text();
    let message = text.slice(0, 300);
    try {
      message = (JSON.parse(text) as { error?: { message?: string } })?.error?.message ?? message;
    } catch {
      /* not an error envelope; the raw text is the best available */
    }
    throw new SignInFailure(message || res.statusText, res.status >= 500 ? "server" : "refused");
  }

  const body = (await res.json()) as { user?: ProfileUser };
  if (!body.user) throw new SignInFailure("the server did not answer with a profile", "server");
  return body.user;
}
