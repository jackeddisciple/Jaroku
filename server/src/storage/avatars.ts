// A person's picture: where it is keyed, what is allowed to be one, and how one arrives from Google.
//
// EVERYTHING ABOUT AVATAR BYTES IS IN THIS FILE. The identity repository stores an opaque string,
// the routes call these four functions, and nothing else in the server knows that an avatar is a
// PNG rather than a row. That boundary is what makes the format decisions below reviewable in one
// place instead of being spread across a route, a claim parser and a migration.
//
// THE VALIDATION IS BY MAGIC BYTES, NOT BY `content-type`. A header is a claim the uploader makes
// about their own payload; the first eight bytes are the payload. Trusting the header means storing
// whatever somebody sends under a name that says it is an image — and then serving it back with an
// image content type, which is the shape of a stored-XSS bug where an "avatar" is an SVG full of
// script. SVG is refused for exactly that reason and it is the only refusal here that is about
// security rather than about size: it is the one image format that is also a document.

import type { ObjectStore } from "./objectStore.ts";
import { userAvatarKey } from "./keys.ts";

/**
 * The biggest picture that may be stored, AFTER the client has cropped it.
 *
 * The crop editor sends a 512×512 PNG, which lands around 300–500KB at worst; this is generous
 * against that and still far under the router's 16MB binary cap. The cap exists because the route
 * is authenticated but not rate-limited by size, and an avatar is the one endpoint where a person
 * can legitimately hand the server a file.
 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/** What a browser may upload and what Google may serve. See the file header on SVG's absence. */
const MAGIC: { type: string; test: (b: Buffer) => boolean }[] = [
  { type: "image/png", test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: "image/jpeg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  // RIFF....WEBP — the four bytes at 8 are what separate WebP from every other RIFF container.
  { type: "image/webp", test: (b) => b.length > 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP" },
];

/** What this actually is, read from its own bytes, or null when it is nothing we serve. */
export function sniffImage(bytes: Buffer): string | null {
  return MAGIC.find((m) => m.test(bytes))?.type ?? null;
}

/**
 * Where a person's picture lives — see `keys.ts`'s `userAvatarKey` for why a workspace is in it.
 *
 * THIS FILE USED TO ASSEMBLE THE KEY ITSELF, as `users/<id>/avatar`, and every upload was refused
 * by the store: `assertKey` requires `ws/<workspace uuid>/` on every key, because that prefix is
 * how a presigned URL is checked without a database. Building keys by hand next to a module whose
 * whole job is to build them is the mistake, not the prefix that caught it.
 *
 * ONE KEY PER USER, OVERWRITTEN IN PLACE, rather than a new key per upload. A versioned key would
 * need a cleanup pass to stop the store growing every time somebody re-crops their face, and the
 * only thing it would buy is a cache-busting URL — which is not needed here, because the client
 * fetches with a bearer token and holds the blob for the session rather than letting a browser
 * cache own it.
 */
export { userAvatarKey as avatarKey } from "./keys.ts";

/**
 * Validate and store, returning the key. Throws a plain `Error` whose message is safe to show.
 *
 * The caller decides what a failure means — the upload route turns it into a 400, and the Google
 * import swallows it, because a picture that would not import is not a reason to fail a sign-in.
 */
export async function putAvatar(
  objects: ObjectStore,
  workspaceId: string,
  userId: string,
  bytes: Buffer,
): Promise<string> {
  if (bytes.length === 0) throw new Error("that file is empty");
  if (bytes.length > AVATAR_MAX_BYTES) {
    throw new Error(`a picture is at most ${Math.floor(AVATAR_MAX_BYTES / 1024 / 1024)}MB`);
  }
  const type = sniffImage(bytes);
  if (!type) throw new Error("that file is not a PNG, JPEG or WebP image");
  const key = userAvatarKey(workspaceId, userId);
  await objects.put(key, bytes, { contentType: type });
  return key;
}

/**
 * Google's `picture`, fetched once at sign-in.
 *
 * IT RETURNS NULL RATHER THAN THROWING, on every failure, and that is the whole contract. This runs
 * inside the sign-in path: a person whose Google avatar is a 404, or whose image is 9MB, or whose
 * network hiccups, must still get a session. The picture is a nicety and the sign-in is not.
 *
 * THE HOST IS CHECKED BEFORE THE FETCH. The URL comes from a token this server verified, so it is
 * not attacker-controlled in the ordinary sense — but "we verified the signature" is not the same
 * as "this string is safe to hand to `fetch`", and an outbound request to an arbitrary host from
 * inside the sign-in path is an SSRF primitive if that assumption ever stops holding. Google serves
 * these from `googleusercontent.com` and nowhere else.
 */
export async function fetchGoogleAvatar(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Buffer | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  if (host !== "googleusercontent.com" && !host.endsWith(".googleusercontent.com")) return null;

  try {
    // Five seconds, because this is in front of a person waiting to be signed in. If Google is
    // slow, they get their session and no picture, which is the right trade every time.
    //
    // `manual` RATHER THAN `error` OR `follow`, AND THE FIRST DRAFT HAD IT WRONG. `error` was the
    // safe-looking choice and it silently defeats the feature: Google's picture URLs redirect often
    // enough that a large share of accounts would import nothing, with no error anywhere to say
    // why. `follow` is the opposite failure — fetch would chase a redirect to 127.0.0.1 and make
    // the request before this code ever saw the new host, which is the SSRF the allowlist exists to
    // prevent. `manual` hands back the 3xx unfollowed so the `Location` can be put through the same
    // host check as the original, and then fetched deliberately.
    //
    // ONE HOP, NOT A LOOP. A redirect chain has no natural bound and this runs in front of somebody
    // waiting to sign in; one hop covers what Google actually does and cannot become a cycle.
    let res = await fetchImpl(parsed.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return null;
      let hop: URL;
      try {
        // Resolved against the original, because a `Location` may be relative.
        hop = new URL(location, parsed);
      } catch {
        return null;
      }
      if (hop.protocol !== "https:") return null;
      const hopHost = hop.hostname.toLowerCase();
      if (hopHost !== "googleusercontent.com" && !hopHost.endsWith(".googleusercontent.com")) return null;
      res = await fetchImpl(hop.toString(), { redirect: "manual", signal: AbortSignal.timeout(5000) });
    }
    if (!res.ok) return null;
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > AVATAR_MAX_BYTES) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    // The declared length is a claim; this is the reality. Same header-then-reality rule the
    // router applies to request bodies.
    if (bytes.length === 0 || bytes.length > AVATAR_MAX_BYTES) return null;
    return sniffImage(bytes) ? bytes : null;
  } catch {
    return null;
  }
}
