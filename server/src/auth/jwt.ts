// Verifying a JWT, which is the one place in this codebase where getting it slightly wrong
// means anyone can be anyone.
//
// Written by hand against `node:crypto` rather than pulled from a library, for the reason the
// migration runner and the file-protocol parser are: it is about a hundred and fifty lines,
// the failure modes are all well documented, and a dependency here is a dependency inside the
// authentication path of every request. What it is NOT is a general JWT implementation — it
// verifies exactly the shapes an OIDC provider issues and refuses everything else, which is a
// much smaller and much safer job than "parse a JWT".
//
// THE THREE ATTACKS THIS SHAPE EXISTS TO REFUSE, in the order they are usually found:
//
//   `alg: "none"`. The header claims the token is unsigned, and a naive verifier that
//   dispatches on the header's algorithm happily agrees. The refusal here is structural: the
//   algorithm is looked up in an allow-list of asymmetric algorithms, and there is no branch
//   that skips verification.
//
//   ALGORITHM CONFUSION. The header claims HS256, the verifier reaches for "the key", and the
//   key it finds is the issuer's PUBLIC key — which is public, so anyone can sign with it.
//   Refused twice: no HMAC algorithm is in the allow-list at all, and jwks.ts never imports a
//   symmetric key in the first place.
//
//   A VALID TOKEN FROM THE WRONG ISSUER, or for the wrong audience. A perfectly-signed Google
//   token is a perfectly-signed token; what makes it not a credential for this server is that
//   `iss` and `aud` do not match. Both are checked, both are required, and neither has a
//   "skip if unset" path.
//
// The claims are checked AFTER the signature, deliberately. Nothing in the payload means
// anything until the signature says the issuer wrote it, and a verifier that reads claims
// first is one refactor away from acting on one.

import { createVerify, verify as cryptoVerify, constants, type KeyObject } from "node:crypto";
import { isSupportedAlg, type SupportedAlg } from "./jwks.ts";

/** No legitimate provider issues one near this size, and parsing is not free. */
const MAX_TOKEN_BYTES = 8192;
/** How far two clocks may disagree before a valid token is called expired. */
export const DEFAULT_CLOCK_SKEW_S = 60;
/** `sub` is an opaque provider identifier. Bounded because it is stored and indexed. */
const MAX_SUB_LENGTH = 255;

export class JwtError extends Error {
  constructor(
    message: string,
    readonly kind: "malformed" | "unsupported" | "bad_signature" | "expired" | "claims",
  ) {
    super(message);
    this.name = "JwtError";
  }
}

/** The header, once it has been proven to be a header this verifier will act on. */
export interface JwtHeader {
  alg: SupportedAlg;
  kid: string;
  typ?: string;
}

/** The registered claims this codebase reads. Everything else stays in `raw`. */
export interface JwtClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nbf?: number;
  email?: string;
  email_verified?: boolean;
  name?: string;
  raw: Record<string, unknown>;
}

/**
 * The header of an unverified token.
 *
 * Split out because `kid` has to be read before the key is known — that is the whole point of
 * `kid` — and the caller therefore holds, briefly, a value that came off a token nobody has
 * checked. Naming the function this way is the reminder: everything it returns is a claim.
 */
export function readUnverifiedHeader(token: string): JwtHeader {
  if (token.length > MAX_TOKEN_BYTES) throw new JwtError("token is implausibly large", "malformed");
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtError("not a three-part compact JWS", "malformed");
  const header = decodeJson(parts[0]!, "header");
  const alg = header["alg"];
  if (alg === "none") {
    throw new JwtError('alg "none" is not a signature', "unsupported");
  }
  if (!isSupportedAlg(alg)) {
    // Everything symmetric lands here, which is the algorithm-confusion refusal: there is no
    // code path that reaches an HMAC verification, so there is nothing to confuse.
    throw new JwtError(`unsupported signature algorithm ${JSON.stringify(alg)}`, "unsupported");
  }
  const kid = header["kid"];
  if (typeof kid !== "string" || kid.length === 0 || kid.length > 128) {
    throw new JwtError("token header has no usable kid", "malformed");
  }
  const typ = header["typ"];
  if (typ !== undefined && typ !== "JWT" && typ !== "at+jwt") {
    throw new JwtError(`unexpected token type ${JSON.stringify(typ)}`, "unsupported");
  }
  return { alg, kid, typ: typeof typ === "string" ? typ : undefined };
}

export interface VerifyOptions {
  issuer: string;
  audience: string;
  clockSkewS?: number;
  now?: () => number;
}

/**
 * Verify a token's signature, then its claims.
 *
 * `key` must be the key `readUnverifiedHeader`'s `kid` resolved to — that lookup is the
 * caller's, because it is the one part of this that talks to the network.
 */
export function verifyJwt(token: string, key: KeyObject, header: JwtHeader, opts: VerifyOptions): JwtClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtError("not a three-part compact JWS", "malformed");
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];

  const signed = Buffer.from(`${rawHeader}.${rawPayload}`, "ascii");
  const signature = base64url(rawSignature, "signature");
  if (!signatureIsValid(header.alg, signed, signature, key)) {
    throw new JwtError("signature does not verify against the issuer's key", "bad_signature");
  }

  // Only now. Nothing above this line acted on anything in the payload.
  return checkClaims(decodeJson(rawPayload, "payload"), opts);
}

function signatureIsValid(alg: SupportedAlg, signed: Buffer, signature: Buffer, key: KeyObject): boolean {
  try {
    if (alg.startsWith("ES")) {
      // A JWS ECDSA signature is raw r||s, not the DER sequence `crypto.verify` assumes by
      // default. Told wrong, every valid token fails — and, worse, the fix people reach for
      // is to stop checking.
      const hash = alg === "ES384" ? "sha384" : "sha256";
      return cryptoVerify(hash, signed, { key, dsaEncoding: "ieee-p1363" }, signature);
    }
    if (alg.startsWith("PS")) {
      const v = createVerify("sha256");
      v.update(signed);
      v.end();
      return v.verify(
        { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST },
        signature,
      );
    }
    const hash = alg === "RS512" ? "sha512" : alg === "RS384" ? "sha384" : "sha256";
    return cryptoVerify(hash, signed, { key, padding: constants.RSA_PKCS1_PADDING }, signature);
  } catch {
    // A malformed signature makes OpenSSL throw rather than return false. That is a failed
    // verification, not a server error, and it must not become a 500 that tells an attacker
    // their input reached something interesting.
    return false;
  }
}

function checkClaims(payload: Record<string, unknown>, opts: VerifyOptions): JwtClaims {
  const skew = opts.clockSkewS ?? DEFAULT_CLOCK_SKEW_S;
  const now = Math.floor((opts.now?.() ?? Date.now()) / 1000);

  const iss = payload["iss"];
  if (iss !== opts.issuer) {
    // Not "starts with", not "hostname matches". A signed token from a different issuer is a
    // signed token, and a prefix comparison here is an open redirect wearing a hat.
    throw new JwtError(`token issuer ${JSON.stringify(iss)} is not ${JSON.stringify(opts.issuer)}`, "claims");
  }

  const aud = payload["aud"];
  const audiences = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
  if (!audiences.includes(opts.audience)) {
    throw new JwtError(`token is not for audience ${JSON.stringify(opts.audience)}`, "claims");
  }

  const exp = payload["exp"];
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    // A token with no expiry is a permanent credential. There is no configuration here that
    // accepts one, because "it expires eventually" is the only reason a bearer token is
    // survivable at all.
    throw new JwtError("token has no expiry", "claims");
  }
  if (now > exp + skew) throw new JwtError("token has expired", "expired");

  const nbf = payload["nbf"];
  if (typeof nbf === "number" && now + skew < nbf) throw new JwtError("token is not valid yet", "expired");

  const iat = payload["iat"];
  if (typeof iat === "number" && iat > now + skew + 300) {
    // Issued comfortably in the future. Either a badly wrong clock somewhere or a forgery
    // against a key that should not have signed it; both are worth refusing loudly.
    throw new JwtError("token was issued in the future", "claims");
  }

  const sub = payload["sub"];
  if (typeof sub !== "string" || sub.length === 0 || sub.length > MAX_SUB_LENGTH) {
    throw new JwtError("token has no usable subject", "claims");
  }

  return {
    iss: opts.issuer,
    sub,
    aud: aud as string | string[],
    exp,
    iat: typeof iat === "number" ? iat : undefined,
    nbf: typeof nbf === "number" ? nbf : undefined,
    email: typeof payload["email"] === "string" ? payload["email"] : undefined,
    email_verified: payload["email_verified"] === true,
    name: typeof payload["name"] === "string" ? payload["name"] : undefined,
    raw: payload,
  };
}

function base64url(segment: string, what: string): Buffer {
  // Buffer's base64url decoder is lenient — it accepts characters the encoding does not have
  // and quietly drops them, so `a.b.!!!` would decode rather than fail. Checked first, because
  // a signature that decodes to something other than what was sent is not the signature.
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) throw new JwtError(`token ${what} is not base64url`, "malformed");
  return Buffer.from(segment, "base64url");
}

function decodeJson(segment: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(base64url(segment, what).toString("utf8"));
  } catch {
    throw new JwtError(`token ${what} is not JSON`, "malformed");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new JwtError(`token ${what} is not an object`, "malformed");
  }
  return value as Record<string, unknown>;
}
