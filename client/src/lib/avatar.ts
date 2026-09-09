// The signed-in person's picture: fetched with a token, held as a blob, shared by every consumer.
//
// WHY THERE IS A MODULE HERE AT ALL, rather than an `<img src>` on the footer. The avatar route is
// authenticated, and a browser will not put an `Authorization` header on an image request — so the
// bytes have to be fetched by script and turned into an object URL. That is three lines. What is
// not three lines is doing it ONCE: the footer wants it, settings wants it, and both mount and
// unmount independently, so a naive `useEffect` per consumer refetches the same image every time
// somebody opens a panel and leaks a blob URL every time one closes.
//
// SO THIS IS A ONE-ENTRY CACHE WITH REFERENCE COUNTING, and it is deliberately not a store: nothing
// here is state anybody renders from directly, and putting a blob URL in zustand would mean every
// subscriber re-rendering when a picture that has not changed is re-fetched.
//
// `revoke` MATTERS MORE THAN IT LOOKS. An object URL pins its blob in memory until it is revoked or
// the document goes away — so a session that changed its avatar a dozen times without revoking
// would hold a dozen images for the life of the tab.

import { useEffect, useState } from "react";

import { apiBase, storedToken } from "./auth.ts";

/** The blob URL for the current avatar, or null when there is none — see `loadAvatar`. */
let current: { url: string; token: string } | null = null;
/** In-flight fetch, so two consumers mounting in the same tick make one request. */
let pending: Promise<string | null> | null = null;

/**
 * Who to tell when the picture changes, and the bug that made this necessary.
 *
 * REPLACING A PICTURE IS INVISIBLE TO `hasAvatar`. Both consumers keyed their fetch on that
 * boolean, which is correct for "got one" and "lost one" and WRONG for "swapped one": uploading a
 * new picture leaves it `true` → `true`, so nothing re-rendered — while `uploadAvatar` had already
 * called `forget()` and revoked the object URL the sidebar was still holding. The footer showed a
 * dead blob until the next reload, and only after the one action most likely to make somebody look
 * at it.
 *
 * A COUNTER RATHER THAN AN EVENT PAYLOAD. Subscribers do not need to know what changed — there is
 * one picture — only that what they hold is stale. `useAvatar` below turns that into a re-fetch.
 */
let version = 0;
const listeners = new Set<() => void>();
function changed(): void {
  version++;
  for (const l of listeners) l();
}

/**
 * The current avatar as an object URL, fetching it at most once per session.
 *
 * KEYED ON THE TOKEN, which is what makes signing out and back in as somebody else show the right
 * face. The token changes on every session; the cache entry carries the one it was fetched under
 * and a mismatch refetches rather than serving the previous person's picture.
 *
 * Returns null for "no picture", including every failure. A footer that fell back to an initial
 * because the network hiccuped is correct; one that rendered a broken image is not.
 */
export async function loadAvatar(): Promise<string | null> {
  const token = storedToken();
  if (!token) return null;
  if (current && current.token === token) return current.url;
  if (pending) return pending;

  pending = (async (): Promise<string | null> => {
    try {
      const res = await fetch(`${apiBase()}/v1/users/me/avatar`, {
        headers: { authorization: `Bearer ${token}` },
      });
      // 404 is the ordinary answer for somebody with no picture, not an error worth logging.
      if (!res.ok) return null;
      const blob = await res.blob();
      if (blob.size === 0) return null;
      // REVOKED DIRECTLY RATHER THAN THROUGH `forget()`, which would notify — and the only
      // listeners are the effects that called this, so telling them the picture changed while
      // handing them the new one is a wasted render at best and a loop at worst. `forget` means
      // "somebody changed the picture"; this is just this function tidying up after itself.
      if (current) URL.revokeObjectURL(current.url);
      current = null;
      const url = URL.createObjectURL(blob);
      current = { url, token };
      return url;
    } catch {
      return null;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

/**
 * Drop the cached picture and release its blob.
 *
 * Called after an upload or a delete — the bytes on the server have changed, so the next `loadAvatar`
 * must go and get them — and by `signOut`, because holding the previous person's face in memory
 * after their session ended is exactly the leak this module is careful about elsewhere.
 */
export function forget(): void {
  if (current) URL.revokeObjectURL(current.url);
  current = null;
  changed();
}

/**
 * The current picture as an object URL, kept fresh.
 *
 * ONE HOOK FOR BOTH CONSUMERS. The sidebar footer and the settings row had the same effect written
 * out twice — and the duplicate is what let them drift, because only one of them knew to refetch
 * after an upload. This is the behaviour in one place: fetch when there is one to fetch, refetch
 * when it changes underneath, and drop it when there is none.
 */
export function useAvatar(hasAvatar: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const [tick, setTick] = useState(version);

  useEffect(() => {
    const onChange = (): void => setTick(version);
    listeners.add(onChange);
    return () => { listeners.delete(onChange); };
  }, []);

  useEffect(() => {
    if (!hasAvatar) { setUrl(null); return; }
    let live = true;
    void loadAvatar().then((next) => { if (live) setUrl(next); });
    return () => { live = false; };
  }, [hasAvatar, tick]);

  return url;
}

/** Upload new bytes. The caller has already cropped; this only carries them. */
export async function uploadAvatar(blob: Blob): Promise<void> {
  const token = storedToken();
  const res = await fetch(`${apiBase()}/v1/users/me/avatar`, {
    method: "PUT",
    headers: {
      "content-type": blob.type || "image/png",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: blob,
  });
  if (!res.ok) throw new Error((await res.text()).slice(0, 200) || "could not save that picture");
  forget();
}

/** Remove the picture. Idempotent on the server, so pressing it twice is not an error. */
export async function removeAvatar(): Promise<void> {
  const token = storedToken();
  const res = await fetch(`${apiBase()}/v1/users/me/avatar`, {
    method: "DELETE",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new Error((await res.text()).slice(0, 200) || "could not remove that picture");
  forget();
}
