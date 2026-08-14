// The passcode that gates the Secrets surface: how it is hashed, how it is compared, and how a
// run of wrong guesses is slowed down.
//
// WHAT THIS IS NOT. It is not a key. It is tempting to derive an encryption key from the passcode
// so that "even Jaroku can't read your secrets" — and it would break the product, silently and
// completely. Jaroku injects credentials into deployed agents and into tool calls at runtime, with
// nobody present to type anything. A passcode-derived key makes that impossible and turns every
// scheduled run into an authentication failure nobody is awake to see. The passcode AUTHORISES a
// session to manage secret metadata; envelope encryption is unchanged and untouched by it.
//
// SCRYPT, FROM `node:crypto`. The brief asks for Argon2id with a scrypt fallback. Argon2id here
// means a native `node-gyp` dependency — the first in a server whose entire runtime dependency
// list is six packages — that has to compile in CI and in the deploy image. scrypt is memory-hard,
// built in, and already the thing the fallback names. What makes this a choice rather than a
// compromise is that `algo` and `params` are STORED WITH EACH HASH: moving to Argon2id later is a
// new branch in `hash`, and every existing passcode migrates itself on its owner's next successful
// verify. Nothing has to be reset and nobody is locked out.
//
// THE TWO FAILURES THAT MUST BE INDISTINGUISHABLE are "wrong passcode" and "no passcode has ever
// been set", in the response body AND in how long the answer takes. The body is easy. The timing
// is not, and it is the reason `verify` hashes against a dummy salt when there is no record: a
// function that returned early for an unset passcode would answer in microseconds where a real
// comparison takes a hundred milliseconds, and that difference is readable over the network. It
// enumerates which accounts have secrets worth gating.

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import type { TenantContext } from "../db/tenant.ts";
import type {
  PasscodeRow,
  SecretPasscodeRepository,
} from "../db/repositories/secretPasscodes.ts";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export const PASSCODE_ALGO = "scrypt";

/**
 * The cost this deployment hashes at today.
 *
 * `N` is the memory/CPU cost and dominates: 128 * N * r bytes, so 64 MiB here. Node's default
 * `maxmem` is 32 MiB and would reject that outright, which is why the limit is passed explicitly
 * rather than left to a default that happens to be too small.
 *
 * THE MEMORY IS THE POINT AND ALSO THE RISK. 64 MiB per in-flight verify is what makes a GPU
 * attack expensive, and it is also what a flood of guesses would allocate on this server. That is
 * bounded elsewhere and deliberately: elevation requires an authenticated session, the route is
 * rate limited per user AND per IP, and the ladder below locks an account out after seven wrong
 * answers. None of those are optional decoration around this constant.
 */
export const CURRENT_PARAMS = { N: 65_536, r: 8, p: 2, keylen: 64, maxmem: 80 * 1024 * 1024 } as const;

export type PasscodeParams = {
  N: number;
  r: number;
  p: number;
  keylen: number;
  maxmem?: number;
};

/** Passcodes shorter than this are guessable; longer than this is a password, and fine, but the
 *  brief draws the line at twelve and a limit somebody can see is better than one they discover. */
export const PASSCODE_MIN = 6;
export const PASSCODE_MAX = 12;

/**
 * Why a passcode cannot be used, or null.
 *
 * Length in CODE POINTS rather than UTF-16 units, so an emoji counts as the one character somebody
 * typed rather than as two. Getting this wrong makes a twelve-character passcode with an emoji in
 * it refuse itself with a message about a limit it is under.
 */
export function unusablePasscodeReason(passcode: unknown): string | null {
  if (typeof passcode !== "string") return "a passcode must be text";
  const length = [...passcode].length;
  if (length < PASSCODE_MIN) return `a passcode must be at least ${PASSCODE_MIN} characters`;
  if (length > PASSCODE_MAX) return `a passcode must be at most ${PASSCODE_MAX} characters`;
  // A passcode of spaces is a passcode somebody will not be able to type again.
  if (!passcode.trim()) return "a passcode cannot be only whitespace";
  return null;
}

/** How long the ladder holds somebody after their Nth consecutive wrong answer. */
export interface LadderStep {
  /** Milliseconds to hold them out, 0 when they may retry at once. */
  holdMs: number;
  /** Whether this is the hard lockout rather than a backoff — the step that gets an email. */
  lockedOut: boolean;
}

export const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * The backoff ladder, as a pure function of the failure count.
 *
 * A FUNCTION RATHER THAN A TABLE IN THE HANDLER, so the shape can be asserted without a database
 * and without waiting thirty seconds to find out what the fifth step does.
 *
 *   1-3   immediate retry — people mistype
 *   4     2s     ┐
 *   5     8s     ├ enough to make a script slow and a person barely notice
 *   6     30s    ┘
 *   7+    15 minutes, and somebody is told
 *
 * EVERY STEP IS ENFORCED SERVER-SIDE, including the small ones. A backoff the client is asked to
 * observe is not a control: the attacker is not running the client. So 4 through 6 write
 * `locked_until` exactly as 7 does, and differ only in duration and in whether anyone is told.
 */
export function ladderFor(failedAttempts: number): LadderStep {
  if (failedAttempts >= 7) return { holdMs: LOCKOUT_MS, lockedOut: true };
  if (failedAttempts === 6) return { holdMs: 30_000, lockedOut: false };
  if (failedAttempts === 5) return { holdMs: 8_000, lockedOut: false };
  if (failedAttempts === 4) return { holdMs: 2_000, lockedOut: false };
  return { holdMs: 0, lockedOut: false };
}

export interface VerifyOutcome {
  ok: boolean;
  /** ISO-8601, when they may try again. Null when they may try now. */
  lockedUntil: string | null;
  /** True only on the step that crosses into the hard lockout, so it is notified once. */
  justLockedOut: boolean;
  /**
   * The message for a person, and it is the SAME STRING for every failure.
   *
   * "Incorrect passcode" whether the passcode was wrong, whether no passcode exists, and whether
   * the user has one in another workspace. Distinguishing them is a free account-enumeration
   * oracle, and it buys the honest user nothing they cannot get from the setup flow.
   */
  message: string | null;
}

const GENERIC_FAILURE = "Incorrect passcode";

function paramsFrom(stored: Record<string, unknown>): PasscodeParams {
  const num = (key: string, fallback: number): number => {
    const v = stored[key];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    N: num("N", CURRENT_PARAMS.N),
    r: num("r", CURRENT_PARAMS.r),
    p: num("p", CURRENT_PARAMS.p),
    keylen: num("keylen", CURRENT_PARAMS.keylen),
    maxmem: num("maxmem", CURRENT_PARAMS.maxmem),
  };
}

/** Whether a stored hash was made at a cost this deployment has since moved on from. */
export function needsRehash(row: Pick<PasscodeRow, "algo" | "params">): boolean {
  if (row.algo !== PASSCODE_ALGO) return true;
  const p = paramsFrom(row.params);
  return p.N !== CURRENT_PARAMS.N || p.r !== CURRENT_PARAMS.r || p.p !== CURRENT_PARAMS.p || p.keylen !== CURRENT_PARAMS.keylen;
}

async function derive(passcode: string, salt: string, params: PasscodeParams): Promise<Buffer> {
  return scrypt(passcode.normalize("NFKC"), Buffer.from(salt, "base64"), params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: params.maxmem ?? CURRENT_PARAMS.maxmem,
  });
}

export interface HashedPasscode {
  hash: string;
  salt: string;
  algo: string;
  params: Record<string, unknown>;
}

/**
 * Hash a passcode for storage.
 *
 * NFKC-normalised before hashing, so a passcode typed on a phone keyboard and the same passcode
 * typed on a laptop are the same bytes. Two visually identical strings that hash differently
 * produce a lockout nobody can explain.
 */
export async function hashPasscode(passcode: string): Promise<HashedPasscode> {
  const salt = randomBytes(32).toString("base64");
  const derived = await derive(passcode, salt, CURRENT_PARAMS);
  return {
    hash: derived.toString("base64"),
    salt,
    algo: PASSCODE_ALGO,
    params: { N: CURRENT_PARAMS.N, r: CURRENT_PARAMS.r, p: CURRENT_PARAMS.p, keylen: CURRENT_PARAMS.keylen },
  };
}

/**
 * Compare two digests without leaking where they first differ.
 *
 * `timingSafeEqual` throws on a length mismatch rather than returning false, which would itself be
 * a timing signal and, worse, an exception on a path that must not have branches. Lengths are
 * compared first and a mismatch is answered against a same-length buffer so the call still happens.
 */
function digestsMatch(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * A short random pause, added to every answer.
 *
 * NOT THE THING THAT MAKES THIS SAFE — the dummy hash below is. Jitter alone is defeated by
 * averaging over enough samples. What it does is stop a single well-timed request being
 * informative, which raises the number of attempts an oracle needs into the range the rate limiter
 * and the ladder already cover.
 */
async function jitter(): Promise<void> {
  const ms = randomBytes(1)[0]! % 25;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A salt to hash against when there is no passcode record.
 *
 * Per process rather than per call: generating one costs nothing, but the point is that the work
 * done for a nonexistent record is indistinguishable from the work done for a real one, and a
 * constant salt is as good as a random one for burning identical time.
 */
const DUMMY_SALT = randomBytes(32).toString("base64");

export interface PasscodeDeps {
  passcodes: SecretPasscodeRepository;
  /** Injected so the ladder can be tested without waiting fifteen real minutes. */
  now?: () => number;
}

export class SecretPasscodes {
  private now: () => number;

  constructor(private deps: PasscodeDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Whether this user has set one. For the UI's setup-versus-unlock decision, nothing more. */
  async isSet(ctx: TenantContext, userId: string): Promise<boolean> {
    return this.deps.passcodes.exists(ctx, userId);
  }

  /**
   * Set or replace a passcode.
   *
   * THE CALLER MUST HAVE PROVED IDENTITY TO A HIGHER STANDARD THAN A PASSCODE before reaching
   * this — a fresh IdP login. That check lives in the route, not here, because this method is also
   * how a re-hash at a new cost is written and that path has already verified the old one.
   */
  async set(ctx: TenantContext, userId: string, passcode: string): Promise<void> {
    const reason = unusablePasscodeReason(passcode);
    if (reason) throw new Error(reason);
    const hashed = await hashPasscode(passcode);
    await this.deps.passcodes.put(ctx, userId, hashed);
  }

  /**
   * Is this the right passcode, and may this person try at all?
   *
   * THE ORDER OF WORK HERE IS THE SECURITY PROPERTY, so it is worth reading as a sequence rather
   * than as five independent steps:
   *
   *   1. A live lockout answers before any hashing. Somebody already held out does not get to
   *      spend the server's 64 MiB per guess, which is what makes the lockout a real defence
   *      rather than a message.
   *   2. A missing record still hashes, against a dummy salt, at the current cost. This is the
   *      whole of the timing defence and the reason there is no early return above it.
   *   3. Comparison is constant-time.
   *   4. Success clears the counters and re-hashes if the cost has moved.
   *   5. Failure counts, consults the ladder, and writes the hold server-side.
   *
   * Every failure answers with the same string. The caller must not add to it.
   */
  async verify(ctx: TenantContext, userId: string, passcode: string): Promise<VerifyOutcome> {
    const row = await this.deps.passcodes.get(ctx, userId);
    const nowMs = this.now();

    // 1 — already held out. Answered before the expensive part, deliberately.
    if (row?.locked_until && Date.parse(row.locked_until) > nowMs) {
      await jitter();
      return { ok: false, lockedUntil: row.locked_until, justLockedOut: false, message: GENERIC_FAILURE };
    }

    // 2 — the work happens whether or not there is anything to compare against.
    const salt = row?.salt ?? DUMMY_SALT;
    const params = row ? paramsFrom(row.params) : { ...CURRENT_PARAMS };
    let derived: Buffer;
    try {
      derived = await derive(passcode, salt, params);
    } catch {
      // Stored parameters this build cannot honour — a cost lowered below what a future Node
      // accepts, or a corrupt row. Treated as a wrong answer rather than a 500, because the
      // alternative tells an attacker they found something unusual about this account.
      await jitter();
      return { ok: false, lockedUntil: null, justLockedOut: false, message: GENERIC_FAILURE };
    }

    // 3 — and the comparison happens too, against a dummy of matching length when there is no row.
    const expected = row ? Buffer.from(row.hash, "base64") : Buffer.alloc(derived.length);
    const matched = row ? digestsMatch(derived, expected) : (digestsMatch(derived, expected), false);

    if (matched) {
      await this.deps.passcodes.recordSuccess(ctx, userId);
      // 4 — carry this hash forward to the current cost, now, while the plaintext is in hand. It
      // is the only moment it will be, which is why the brief asks for it here specifically.
      if (needsRehash(row!)) {
        await this.deps.passcodes.put(ctx, userId, await hashPasscode(passcode));
      }
      await jitter();
      return { ok: true, lockedUntil: null, justLockedOut: false, message: null };
    }

    // 5 — a wrong answer against a real record moves the ladder. A wrong answer against no record
    // cannot: there is no row to count on, and inventing one would create the enumeration oracle
    // that all of the above exists to close.
    let lockedUntil: string | null = null;
    let justLockedOut = false;
    if (row) {
      const attempts = await this.deps.passcodes.recordFailure(ctx, userId);
      const step = ladderFor(attempts);
      if (step.holdMs > 0) {
        lockedUntil = new Date(this.now() + step.holdMs).toISOString();
        await this.deps.passcodes.lock(ctx, userId, lockedUntil);
        justLockedOut = step.lockedOut;
      }
    }
    await jitter();
    return { ok: false, lockedUntil, justLockedOut, message: GENERIC_FAILURE };
  }
}
