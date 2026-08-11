// The sandbox image every hosted RunSandbox boots from, and the rule that keeps it pinned.
//
// A run's isolation depends on the image being the one that was actually reviewed — not
// whatever a mutable tag currently happens to point to. `:latest`, or any bare tag, can be
// repointed by anyone with push access to the registry, which turns "the sandbox image" into a
// promise a registry admin has to keep rather than a fact the deploy pipeline can check. A
// digest cannot be repointed: it names these exact bytes, forever.
//
// This is deliberately the same posture dockerfile.ts already takes on the two base images a
// deployed agent's Dockerfile is built from (pinned tags, never `:latest`) — pushed one step
// further, because those images run code we wrote and this one runs code a language model did.

/** `name@sha256:<64 hex>` — a registry reference pinned to content, not a mutable tag. */
const DIGEST_PIN = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

export function isDigestPinned(ref: string): boolean {
  return DIGEST_PIN.test(ref);
}

export function requireDigestPinnedImage(ref: string): string {
  if (!isDigestPinned(ref)) {
    throw new Error(
      `sandbox image ${JSON.stringify(ref)} is not pinned by digest ` +
        `(expected "name@sha256:<64 hex>"). A tag can be repointed after review; a digest cannot.`,
    );
  }
  return ref;
}

/**
 * The image a hosted RunSandbox boots, from `JAROKU_SANDBOX_IMAGE`.
 *
 * No default. Every other selector in this codebase (`JAROKU_DB_DRIVER`, `JAROKU_OBJECT_STORE`)
 * defaults to the local, zero-dependency choice — but there is no "local" sandbox image, because
 * the local path does not use one at all (LocalSubprocessSandbox spawns directly). An unset value
 * here is a configuration error on the hosted path, not something to paper over with a tag.
 */
export function sandboxImageRef(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.JAROKU_SANDBOX_IMAGE ?? "").trim();
  if (!raw) {
    throw new Error(
      "JAROKU_SANDBOX_IMAGE is not set. The hosted RunSandbox needs a digest-pinned image ref " +
        "(see runtime/sandbox/Dockerfile) — there is no default, because defaulting to a tag " +
        "would defeat the pin.",
    );
  }
  return requireDigestPinnedImage(raw);
}
