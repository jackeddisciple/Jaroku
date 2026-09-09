// What may become somebody's face, and what may not.
//
// TWO OF THESE ASSERTIONS ARE SECURITY PROPERTIES AND THE REST ARE HYGIENE, which is why this file
// exists at all for a module of four functions.
//
//   SVG IS REFUSED. It is the one image format that is also a document: a browser handed an SVG
//   with a `<script>` in it, under a content type that says image, runs the script on this origin.
//   The avatar route serves back whatever was stored, so "what may be stored" is the only place
//   that decision can be made. `sniffImage` returns null for it and `putAvatar` throws — and the
//   test asserts the refusal by CONTENT rather than by extension, because there are no extensions
//   here: the route takes a body, not a filename.
//
//   THE GOOGLE FETCH IS HOST-LOCKED. `fetchGoogleAvatar` takes a URL out of a verified token and
//   hands it to `fetch`, which is an outbound request from inside the sign-in path — an SSRF
//   primitive the moment that URL is not what we assume. The refusals below are the guard: another
//   host, plain http, and a redirect that would leave the allowlist after the check.
//
// AND EVERY FAILURE PATH RETURNS NULL RATHER THAN THROWING, which is asserted because it is the
// contract the caller depends on: a picture that will not import must never fail a sign-in.
//
//   npm run test:avatar

import { fetchGoogleAvatar, putAvatar, sniffImage, avatarKey, AVATAR_MAX_BYTES } from "./avatars.ts";
import type { ObjectStore } from "./objectStore.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else { failures++; console.log(`  FAIL ${msg}`); }
};

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const WEBP = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WEBP", "ascii"), Buffer.alloc(4)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "utf8");
const GIF = Buffer.from("GIF89a", "ascii");
/** Both must be real uuids — `userAvatarKey` asserts them, which is half of what it is for. */
const WS = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const USER = "11111111-2222-3333-4444-555555555555";

/** Just enough store to see what `putAvatar` wrote, and to prove it wrote nothing when it refused. */
function fakeStore(): ObjectStore & { written: Map<string, { body: Buffer; type?: string }> } {
  const written = new Map<string, { body: Buffer; type?: string }>();
  const store = {
    kind: "fs" as const,
    written,
    put: async (key: string, body: Buffer | string, opts?: { contentType?: string }) => {
      written.set(key, { body: Buffer.isBuffer(body) ? body : Buffer.from(body), ...(opts?.contentType ? { type: opts.contentType } : {}) });
      return { key, size: body.length, contentType: opts?.contentType ?? "", updatedAt: "" };
    },
  } as unknown as ObjectStore & { written: Map<string, { body: Buffer; type?: string }> };
  return store;
}

console.log("\nwhat counts as an image, read from the bytes rather than from a header");
{
  check(sniffImage(PNG) === "image/png", "a PNG is a PNG");
  check(sniffImage(JPEG) === "image/jpeg", "a JPEG is a JPEG");
  check(sniffImage(WEBP) === "image/webp", "a WebP is a WebP");
  // THE ONE THAT MATTERS. See the file header: an SVG served under an image content type is a
  // script on this origin.
  check(sniffImage(SVG) === null, "an SVG is NOT an image as far as this module is concerned");
  check(sniffImage(GIF) === null, "nor is a GIF — three formats are served and it is not one");
  check(sniffImage(Buffer.alloc(0)) === null, "nor is nothing at all");
  // A RIFF container that is not WebP — the four bytes at offset 8 are the whole difference, and
  // checking only `RIFF` would admit a WAV file.
  const wav = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WAVE", "ascii")]);
  check(sniffImage(wav) === null, "...and a RIFF that is not WEBP is refused rather than assumed");
}

console.log("\nwhat may be stored");
{
  const key = avatarKey(WS, "11111111-2222-3333-4444-555555555555");
  check(key === `ws/${WS}/users/11111111-2222-3333-4444-555555555555/avatar`, "the key is one per user, not one per upload");
  // WORKSPACE-SCOPED, WHICH IT DID NOT USED TO BE AND HAD TO BECOME. `assertKey` refuses any key
  // that does not start `ws/<uuid>/`, because that prefix is how a presigned URL is checked with
  // no database behind it — so an unscoped avatar key was rejected on every single upload. See
  // `keys.ts`'s `userAvatarKey`.
  check(key.startsWith(`ws/${WS}/`), "...under the workspace prefix every key must carry");

  void (async () => {
    const store = fakeStore();
    const stored = await putAvatar(store, WS, USER, PNG);
    check(stored === avatarKey(WS, USER), "a PNG is stored under the user's key");
    check(store.written.get(stored)?.type === "image/png", "...with the type the BYTES say, not the caller");

    for (const [name, bytes] of [["an SVG", SVG], ["a GIF", GIF], ["nothing", Buffer.alloc(0)]] as const) {
      const s2 = fakeStore();
      let threw = false;
      try { await putAvatar(s2, WS, USER, bytes); } catch { threw = true; }
      check(threw, `${name} is refused`);
      check(s2.written.size === 0, `...and ${name} left nothing behind in the store`);
    }

    const s3 = fakeStore();
    let tooBig = false;
    try { await putAvatar(s3, WS, USER, Buffer.concat([PNG, Buffer.alloc(AVATAR_MAX_BYTES)])); } catch { tooBig = true; }
    check(tooBig, "a picture over the cap is refused even though it IS a PNG");
    check(s3.written.size === 0, "...and it is refused before anything is written");

    await googleChecks();
    console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
    process.exit(failures === 0 ? 0 : 1);
  })();
}

async function googleChecks(): Promise<void> {
  console.log("\nwhere a Google picture may be fetched from, and what a failure does");
  // A fetch that would succeed for anything it is actually called with. Reaching it at all for a
  // refused host is the failure these assertions are looking for.
  let reached: string | null = null;
  const ok: typeof fetch = (async (url: string | URL) => {
    reached = String(url);
    return new Response(PNG, { status: 200, headers: { "content-length": String(PNG.length) } });
  }) as unknown as typeof fetch;

  check(await fetchGoogleAvatar("https://lh3.googleusercontent.com/a/x", ok) !== null,
    "a googleusercontent.com URL is fetched");

  for (const bad of [
    "https://evil.example/a.png",
    "http://lh3.googleusercontent.com/a/x",
    "https://googleusercontent.com.evil.example/a.png",
    "https://127.0.0.1/a.png",
    "not a url at all",
  ]) {
    reached = null;
    const got = await fetchGoogleAvatar(bad, ok);
    check(got === null, `${bad.slice(0, 42)} is refused`);
    // THE REFUSAL IS BEFORE THE FETCH, which is the property that makes this an SSRF guard rather
    // than a filter on the response.
    check(reached === null, "...and no request was made at all");
  }

  const notFound: typeof fetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
  check(await fetchGoogleAvatar("https://lh3.googleusercontent.com/a/x", notFound) === null,
    "a 404 is null rather than a throw — a missing picture must not fail a sign-in");

  const boom: typeof fetch = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
  check(await fetchGoogleAvatar("https://lh3.googleusercontent.com/a/x", boom) === null,
    "...and so is a network failure");

  const notImage: typeof fetch = (async () => new Response(SVG, { status: 200 })) as unknown as typeof fetch;
  check(await fetchGoogleAvatar("https://lh3.googleusercontent.com/a/x", notImage) === null,
    "...and so is a response Google served that is not one of the three formats");

  // REDIRECTS, WHICH THE FIRST DRAFT GOT WRONG IN BOTH DIRECTIONS. `redirect: "error"` refused them
  // outright, which quietly imports nothing for every account whose picture URL happens to hop;
  // `follow` would have let fetch chase one to an internal address before this code saw the host.
  const hops = (to: string): typeof fetch => {
    let first = true;
    return (async (url: string | URL) => {
      reached = String(url);
      if (first) { first = false; return new Response("", { status: 302, headers: { location: to } }); }
      return new Response(PNG, { status: 200 });
    }) as unknown as typeof fetch;
  };
  check(await fetchGoogleAvatar("https://lh3.googleusercontent.com/a/x", hops("https://lh4.googleusercontent.com/b")) !== null,
    "a redirect WITHIN googleusercontent.com is followed rather than refused");

  reached = null;
  check(await fetchGoogleAvatar("https://lh3.googleusercontent.com/a/x", hops("http://127.0.0.1:4317/admin")) === null,
    "a redirect to an internal address is refused");
  check(reached === "https://lh3.googleusercontent.com/a/x",
    "...and the internal address was never requested — the hop is checked before it is taken");

  reached = null;
  check(await fetchGoogleAvatar("https://lh3.googleusercontent.com/a/x", hops("https://evil.example/x")) === null,
    "a redirect off the allowlist is refused too");
  check(reached === "https://lh3.googleusercontent.com/a/x", "...and likewise never requested");

  // A relative Location resolves against the original, which keeps it on the allowlist rather than
  // failing to parse — the case that would otherwise look like a refusal for the wrong reason.
  check(await fetchGoogleAvatar("https://lh3.googleusercontent.com/a/x", hops("/b/y")) !== null,
    "a relative redirect resolves against the original and stays allowed");

  const huge: typeof fetch = (async () =>
    new Response(PNG, { status: 200, headers: { "content-length": String(AVATAR_MAX_BYTES + 1) } })) as unknown as typeof fetch;
  check(await fetchGoogleAvatar("https://lh3.googleusercontent.com/a/x", huge) === null,
    "...and so is one that declares itself over the cap");
}
