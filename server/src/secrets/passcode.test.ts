// The passcode: what it accepts, what it refuses, and what it refuses to tell an attacker.
//
// THE ASSERTION THIS SUITE EXISTS FOR is the timing one. "Wrong passcode" and "no passcode has
// ever been set" must be indistinguishable, and the body half of that is trivially true by reading
// the code — both return the same string. The timing half is not: an early return for a missing
// record answers in microseconds where a real comparison takes a tenth of a second, and that
// difference is readable across a network. It enumerates which accounts have secrets worth gating,
// which is the first step of deciding who to attack.
//
// So the no-record path hashes against a dummy salt at the current cost, and this suite measures
// that it actually does. The tolerance is loose on purpose — the failure being caught is three
// orders of magnitude, not three percent, and a tight bound on a shared CI runner is a test that
// fails for reasons that are not the code.
//
// The ladder is asserted as a pure function AND through the repository, because the two can
// disagree: a correct table consulted at the wrong moment, or a hold computed and never written.
//
//   npm run test:secret-passcode

import { randomBytes, randomUUID, scrypt as scryptCb } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { Db } from "../db/db.ts";
import { migrate } from "../db/migrate.ts";
import { SqliteDb } from "../db/sqlite.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { SecretPasscodeRepository } from "../db/repositories/secretPasscodes.ts";
import {
  CURRENT_PARAMS,
  LOCKOUT_MS,
  PASSCODE_MAX,
  PASSCODE_MIN,
  SecretPasscodes,
  hashPasscode,
  ladderFor,
  needsRehash,
  unusablePasscodeReason,
} from "./passcode.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const MIGRATIONS = join(fileURLToPath(new URL("../..", import.meta.url)), "migrations");
const scratch: string[] = [];
const tmpDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "jaroku-passcode-"));
  scratch.push(d);
  return d;
};

async function newWorkspace(db: Db): Promise<TenantContext> {
  const identity = new IdentityRepository(db);
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `passcode ${randomUUID().slice(0, 6)}`,
  });
  return systemContextFor(ws.id, newRequestId());
}

async function newUser(db: Db): Promise<string> {
  const identity = new IdentityRepository(db);
  const { user } = await identity.provisionUser(systemContext(newRequestId()), {
    externalId: `pc_${randomUUID().slice(0, 10)}`,
    email: `${randomUUID().slice(0, 10)}@example.com`,
  });
  return user.id;
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/**
 * A hash made at some OTHER cost, to stand in for one written by an older deployment.
 *
 * Spelled out here with the raw primitive rather than by exporting a knob from the module under
 * test: a production function that takes arbitrary parameters is a function somebody eventually
 * calls with weak ones. The point of the test is that a hash from the past still verifies, and the
 * past is reconstructed rather than made reachable.
 */
const LEGACY_SALT = randomBytes(32).toString("base64");
async function hashPasscodeAt(
  passcode: string,
  params: { N: number; r: number; p: number; keylen: number },
): Promise<{ hash: string }> {
  const scrypt = promisify(scryptCb) as (
    password: string,
    salt: Buffer,
    keylen: number,
    options: { N: number; r: number; p: number; maxmem: number },
  ) => Promise<Buffer>;
  const derived = await scrypt(passcode.normalize("NFKC"), Buffer.from(LEGACY_SALT, "base64"), params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 80 * 1024 * 1024,
  });
  return { hash: derived.toString("base64") };
}

// --- the policy, with no database in sight ----------------------------------------------
console.log("\nwhat a passcode may be");
check(unusablePasscodeReason("abc") !== null, `shorter than ${PASSCODE_MIN} is refused`);
check(unusablePasscodeReason("a".repeat(PASSCODE_MAX + 1)) !== null, `longer than ${PASSCODE_MAX} is refused`);
check(unusablePasscodeReason("hunter2") === null, "and something in between is accepted");
check(unusablePasscodeReason("      ") !== null, "a passcode of spaces is refused, not stored");
check(unusablePasscodeReason(12345678) !== null, "a number is not a passcode");
// Counted in code points, so an emoji is the one character somebody typed rather than two. Getting
// this wrong refuses a passcode for exceeding a limit it is under.
check(unusablePasscodeReason("pass🔐word12") === null, "length is counted in characters, not UTF-16 units");

console.log("\nthe backoff ladder");
check(ladderFor(1).holdMs === 0, "the first three failures retry immediately");
check(ladderFor(3).holdMs === 0, "...through the third");
check(ladderFor(4).holdMs === 2_000, "the fourth waits 2s");
check(ladderFor(5).holdMs === 8_000, "the fifth 8s");
check(ladderFor(6).holdMs === 30_000, "the sixth 30s");
check(ladderFor(7).holdMs === LOCKOUT_MS, "and the seventh locks for fifteen minutes");
check(ladderFor(7).lockedOut === true, "which is the step somebody is told about");
check(ladderFor(6).lockedOut === false, "and a backoff is not");
check(ladderFor(99).holdMs === LOCKOUT_MS, "past the end of the ladder it stays locked, never wraps to zero");

console.log("\nhashing");
{
  const a = await hashPasscode("correct horse");
  const b = await hashPasscode("correct horse");
  check(a.hash !== b.hash, "the same passcode hashes differently twice, because the salt is per-record");
  check(a.salt !== b.salt, "...which is what makes a stolen table not a rainbow table");
  check(a.algo === "scrypt", "the algorithm travels with the hash");
  check(Number(a.params["N"]) === CURRENT_PARAMS.N, "and so do the cost parameters");
  check(!a.hash.includes("correct"), "and the hash is not the passcode in a costume");
  check(needsRehash({ algo: "scrypt", params: { ...a.params } }) === false, "a current hash needs no re-hash");
  check(needsRehash({ algo: "scrypt", params: { N: 1024, r: 8, p: 1, keylen: 64 } }), "a cheaper one does");
  check(needsRehash({ algo: "argon2id", params: { ...a.params } }), "and so does a different algorithm");
}

// --- and now against a real database -----------------------------------------------------
const dir = tmpDir();
const db = new SqliteDb(join(dir, "passcode.db"));
await migrate(db.migrationTarget(), join(MIGRATIONS, "sqlite"), () => {});

try {
  const repo = new SecretPasscodeRepository(db);
  const ws = await newWorkspace(db);

  console.log("\nsetting and verifying");
  {
    const passcodes = new SecretPasscodes({ passcodes: repo });
    const user = await newUser(db);
    check((await passcodes.isSet(ws, user)) === false, "a user starts with no passcode");
    await passcodes.set(ws, user, "hunter2!");
    check(await passcodes.isSet(ws, user), "and has one after setting it");

    const right = await passcodes.verify(ws, user, "hunter2!");
    check(right.ok, "the right passcode verifies");
    check(right.message === null, "with nothing to tell the user");

    const wrong = await passcodes.verify(ws, user, "hunter3!");
    check(!wrong.ok, "the wrong one does not");
    check(wrong.message === "Incorrect passcode", "with a generic message");

    // NFKC, so the same passcode typed on two keyboards is the same passcode. A composed and a
    // decomposed 'é' are different bytes and identical to look at.
    await passcodes.set(ws, user, "café123");
    check((await passcodes.verify(ws, user, "café123")).ok, "a decomposed accent verifies against a composed one");

    let refused = false;
    try {
      await passcodes.set(ws, user, "abc");
    } catch {
      refused = true;
    }
    check(refused, "and a too-short passcode is refused at set time, not stored and failed later");
  }

  console.log("\nwrong passcode and no passcode are the same answer");
  {
    const passcodes = new SecretPasscodes({ passcodes: repo });
    const known = await newUser(db);
    const unknown = await newUser(db);
    await passcodes.set(ws, known, "hunter2!");

    const wrong = await passcodes.verify(ws, known, "not-it-99");
    const missing = await passcodes.verify(ws, unknown, "not-it-99");
    check(wrong.message === missing.message, "the same message");
    check(wrong.ok === missing.ok && missing.ok === false, "the same outcome");
    check(
      JSON.stringify({ ...wrong, lockedUntil: null }) === JSON.stringify({ ...missing, lockedUntil: null }),
      "and the same shape, field for field",
      `${JSON.stringify(wrong)} vs ${JSON.stringify(missing)}`,
    );

    // THE ONE THAT MATTERS. An early return for the missing record would be ~1000x faster.
    const samples = 5;
    const wrongTimes: number[] = [];
    const missingTimes: number[] = [];
    for (let i = 0; i < samples; i++) {
      let t = process.hrtime.bigint();
      await passcodes.verify(ws, known, `nope-${i}xx`);
      wrongTimes.push(Number(process.hrtime.bigint() - t) / 1e6);
      // A fresh user each time: a real record accumulates failures and would eventually be held
      // out, which returns early by design and would poison the measurement.
      t = process.hrtime.bigint();
      await passcodes.verify(ws, await newUser(db), `nope-${i}xx`);
      missingTimes.push(Number(process.hrtime.bigint() - t) / 1e6);
      await repo.recordSuccess(ws, known);
    }
    const withRecord = median(wrongTimes);
    const withoutRecord = median(missingTimes);
    // Loose on purpose: the failure being caught is three orders of magnitude, and a tight bound
    // on a shared runner fails for reasons that are not the code.
    check(
      withoutRecord > withRecord * 0.4,
      "verifying against no record costs the same order of magnitude as verifying against one",
      `with=${withRecord.toFixed(1)}ms without=${withoutRecord.toFixed(1)}ms`,
    );
    check(
      withRecord > 5,
      "and the comparison is genuinely expensive rather than trivially fast for both",
      `${withRecord.toFixed(1)}ms`,
    );
  }

  console.log("\nthe ladder, enforced server-side");
  {
    // A clock the test controls, so fifteen minutes is not fifteen minutes.
    let clock = Date.parse("2026-08-14T12:00:00.000Z");
    const passcodes = new SecretPasscodes({ passcodes: repo, now: () => clock });
    const user = await newUser(db);
    await passcodes.set(ws, user, "hunter2!");

    for (let i = 1; i <= 3; i++) {
      const out = await passcodes.verify(ws, user, "wrong-one");
      check(out.lockedUntil === null, `failure ${i} allows an immediate retry`);
    }

    const fourth = await passcodes.verify(ws, user, "wrong-one");
    check(fourth.lockedUntil !== null, "the fourth writes a hold");
    check(
      Date.parse(fourth.lockedUntil!) - clock === 2_000,
      "of two seconds",
      String(Date.parse(fourth.lockedUntil ?? "") - clock),
    );
    // AND THE HOLD IS REAL, not advice: the very next attempt is refused without hashing, even
    // with the correct passcode, because a backoff the client is asked to observe is not a control.
    const during = await passcodes.verify(ws, user, "hunter2!");
    check(!during.ok, "and the correct passcode is refused while the hold stands");

    clock += 2_001;
    const fifth = await passcodes.verify(ws, user, "wrong-one");
    check(Date.parse(fifth.lockedUntil!) - clock === 8_000, "the fifth holds for eight seconds");
    clock += 8_001;
    const sixth = await passcodes.verify(ws, user, "wrong-one");
    check(Date.parse(sixth.lockedUntil!) - clock === 30_000, "the sixth for thirty");
    clock += 30_001;
    const seventh = await passcodes.verify(ws, user, "wrong-one");
    check(Date.parse(seventh.lockedUntil!) - clock === LOCKOUT_MS, "and the seventh for fifteen minutes");
    check(seventh.justLockedOut, "which is reported once, so it can be emailed once");

    // Survives a reload, because it is a column rather than a variable in a browser.
    const stored = await repo.get(ws, user);
    check(stored?.locked_until === seventh.lockedUntil, "the lockout is in the database, not in the client");
    check(stored?.failed_attempts === 7, "and so is the count that produced it");

    clock += LOCKOUT_MS + 1;
    const after = await passcodes.verify(ws, user, "hunter2!");
    check(after.ok, "once it expires the right passcode works again");
    check((await repo.get(ws, user))?.failed_attempts === 0, "and the run of failures is cleared");
  }

  console.log("\nre-hashing at a new cost");
  {
    const passcodes = new SecretPasscodes({ passcodes: repo });
    const user = await newUser(db);
    // A hash made at a cost this deployment has since moved on from.
    await repo.put(ws, user, {
      hash: (await hashPasscodeAt("legacy-pc", { N: 1024, r: 8, p: 1, keylen: 64 })).hash,
      salt: LEGACY_SALT,
      algo: "scrypt",
      params: { N: 1024, r: 8, p: 1, keylen: 64 },
    });
    check(needsRehash((await repo.get(ws, user))!), "the stored hash is behind the current cost");
    const out = await passcodes.verify(ws, user, "legacy-pc");
    check(out.ok, "and it still verifies, so nobody is locked out by a parameter change");
    const after = await repo.get(ws, user);
    check(!needsRehash(after!), "...and is re-hashed at the current cost on the way through");
    check((await passcodes.verify(ws, user, "legacy-pc")).ok, "and still verifies afterwards");
  }
} finally {
  await db.close();
}

for (const d of scratch) rmSync(d, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
