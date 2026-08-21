// §7's last three routes, as three functions.
//
// ALL THREE ARE FACTS ABOUT A PERSON, which is why none of them takes a workspace and none of them
// goes down the socket. A socket is scoped to a workspace by its ticket; "how far through setup am
// I" is not a question about a workspace, and scoping it to one would describe it wrongly — the
// same argument `markOnboarded` and `acceptInvite` already make about being HTTP.
//
// AND NONE OF THEM SENDS A USER ID, because there is nowhere to put one. The only account any of
// these can touch is whoever holds the token, so there is nothing to forge.
//
// THE FIRST TWO NEVER THROW AT THE CALLER, and that is the load-bearing decision here. Advancing a
// step and marking somebody onboarded are both fire-and-forget: the person is already looking at
// the next screen, and a five-step flow that waited for a round trip between every Continue and the
// screen after it would feel like a five-step form. What a failed write costs is a resume that
// lands one screen early — which §9.3 already treats as correct behaviour for an interruption.
//
// `restart` IS DIFFERENT AND DOES THROW. Its caller is a settings screen with a button on it and a
// person watching that button, and a restart that silently did nothing would be a button that
// appears broken. It also has to be known to have landed before the client reopens the flow, or a
// failure would put somebody into a tour the server still believes they finished.

import { apiBase, storedToken } from "./auth.ts";

async function post(path: string): Promise<Response> {
  return fetch(`${apiBase()}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(storedToken() ? { authorization: `Bearer ${storedToken()}` } : {}),
    },
    body: "{}",
  });
}

/**
 * §5.3 — record how far through the tour somebody got.
 *
 * SWALLOWS EVERYTHING. See the header. The one thing it does is log, because a step that
 * consistently fails to write is a resume that consistently lands early, and that is a real bug
 * whose only symptom is somebody saying "it asked me twice".
 */
export async function advanceOnboarding(step: number): Promise<void> {
  try {
    const res = await fetch(`${apiBase()}/v1/users/me/onboarding/step`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(storedToken() ? { authorization: `Bearer ${storedToken()}` } : {}),
      },
      body: JSON.stringify({ step }),
    });
    if (!res.ok) console.warn(`[jaroku] could not record onboarding step ${step}: ${res.status}`);
  } catch (err) {
    console.warn(`[jaroku] could not record onboarding step ${step}: ${String(err)}`);
  }
}

/** §5.2 — the engagement action happened. Swallows, for the reason above. */
export async function completeOnboarding(): Promise<void> {
  try {
    const res = await post("/v1/users/me/onboarding/complete");
    if (!res.ok) console.warn(`[jaroku] could not mark onboarding complete: ${res.status}`);
  } catch (err) {
    console.warn(`[jaroku] could not mark onboarding complete: ${String(err)}`);
  }
}

/** §5.4 — walk through the setup screens again. Throws, for the reason above. */
export async function restartOnboarding(): Promise<void> {
  const res = await post("/v1/users/me/onboarding/restart");
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = text.slice(0, 200);
    try {
      message = (JSON.parse(text) as { error?: { message?: string } })?.error?.message ?? message;
    } catch {
      /* not an error envelope */
    }
    throw new Error(message || `the server answered ${res.status}`);
  }
}
