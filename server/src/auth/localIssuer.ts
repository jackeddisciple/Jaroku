// The development issuer: a real OIDC issuer, in-process.
//
// See config.ts for why this exists rather than a flag that skips verification. The short
// version: the authentication path has to be the same path locally and hosted, or the code
// that matters is the code nobody runs.
//
// What it does NOT do is authenticate. There is no password, no email round trip, no identity
// proof of any kind — `POST /v1/auth/dev-login` takes an email and hands back a token for it.
// That is exactly as dangerous as it sounds and exactly as dangerous as `runtime/.env` being
// world-readable to whoever is sitting at the machine, which is the trust boundary this
// product has always had locally. It is refused under NODE_ENV=production in config.ts, and
// the boot log says so every time.
//
// THE KEY IS PERSISTED, and that is a considered choice rather than laziness. An ephemeral key
// would sign every developer out on every restart, and `tsx` restarts a lot — the predictable
// consequence is somebody reaching for a bypass to stop being logged out, which is the thing
// this design exists to avoid. So it lands in a gitignored file, `chmod 600`, alongside the
// database, and is regenerated if it is missing or unreadable.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { LOCAL_ISSUER } from "./config.ts";

/** How long a locally-minted token lasts. Short, so the refresh path is exercised too. */
export const LOCAL_TOKEN_TTL_S = 60 * 60;

export interface MintInput {
  /** The stable identity. Defaults to a uuid derived from the email, so re-login is the same user. */
  subject?: string;
  email: string;
  displayName?: string | null;
  ttlS?: number;
}

interface StoredKey {
  kid: string;
  privateJwk: Record<string, unknown>;
}

export class LocalIssuer {
  private readonly kid: string;
  private readonly privateJwk: Record<string, unknown>;

  constructor(
    keyPath: string,
    private audience: string,
    private log: (m: string) => void = console.log,
  ) {
    const stored = this.load(keyPath) ?? this.create(keyPath);
    this.kid = stored.kid;
    this.privateJwk = stored.privateJwk;
  }

  /** The public half, in the shape jwks.ts expects to fetch. */
  jwks(): { keys: Record<string, unknown>[] } {
    const pub = createPublicKey({ key: this.privateJwk as never, format: "jwk" });
    const jwk = pub.export({ format: "jwk" }) as Record<string, unknown>;
    return { keys: [{ ...jwk, kid: this.kid, alg: "RS256", use: "sig" }] };
  }

  /** A signed RS256 token, indistinguishable in shape from a provider's. */
  mint(input: MintInput): { token: string; expiresAt: number } {
    const now = Math.floor(Date.now() / 1000);
    const ttl = input.ttlS ?? LOCAL_TOKEN_TTL_S;
    const exp = now + ttl;
    const email = input.email.trim().toLowerCase();
    const header = { alg: "RS256", typ: "JWT", kid: this.kid };
    const payload = {
      iss: LOCAL_ISSUER,
      aud: this.audience,
      sub: input.subject ?? subjectFor(email),
      email,
      email_verified: true,
      name: input.displayName ?? null,
      iat: now,
      nbf: now,
      exp,
    };
    const signing = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
    const key = createPrivateKey({ key: this.privateJwk as never, format: "jwk" });
    const signature = sign("sha256", Buffer.from(signing, "ascii"), key);
    return { token: `${signing}.${signature.toString("base64url")}`, expiresAt: exp };
  }

  private load(path: string): StoredKey | null {
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as StoredKey;
      if (typeof parsed?.kid !== "string" || typeof parsed?.privateJwk !== "object") return null;
      // Prove it imports before trusting it. A truncated write from a previous crash would
      // otherwise fail at the first sign-in rather than here, where it can just be replaced.
      createPrivateKey({ key: parsed.privateJwk as never, format: "jwk" });
      return parsed;
    } catch {
      this.log(`[auth] the local issuer's key at ${path} is unreadable — generating a new one`);
      return null;
    }
  }

  private create(path: string): StoredKey {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const stored: StoredKey = {
      kid: `local-${randomUUID().slice(0, 8)}`,
      privateJwk: privateKey.export({ format: "jwk" }) as Record<string, unknown>,
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(stored), { mode: 0o600 });
    try {
      // Belt and braces: `mode` on writeFileSync only applies when the file is CREATED, so an
      // existing loose-permissioned file would keep its mode. Same reasoning as envWriter's.
      chmodSync(path, 0o600);
    } catch {
      /* a filesystem without modes; nothing to enforce */
    }
    this.log(`[auth] generated the local issuer's signing key at ${path} (chmod 600, gitignored)`);
    return stored;
  }
}

/**
 * A stable `sub` for an email, so signing in twice locally is the same user.
 *
 * A provider's `sub` is opaque and stable; the local issuer has to produce something with the
 * same property or every dev-login would provision a new account and a new workspace, and the
 * agents from ten minutes ago would be gone.
 */
export function subjectFor(email: string): string {
  return `local|${email.trim().toLowerCase()}`;
}

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64url");
