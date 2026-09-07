// One verified address, one account — in both directions, which is the half that was broken.
//
// THE BUG THIS PINS. The rule was written twice, in two callbacks a hundred lines apart, and the
// copies disagreed. Signing up with a magic link and later pressing "Continue with Google" for the
// SAME address was refused — `provisionUser` will not give an address to a second subject — while
// the reverse order worked, because the magic-link copy matched by address first. Two buttons the
// sign-in screen presents as equals, one of which failed depending on which you pressed months ago.
//
//   npm run test:link-identity

import { linkIdentity, type IdentityLookup } from "./linkIdentity.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else { failures++; console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`); }
};

interface Row { id: string; email: string; externalId: string; provider: string }

/** The repository, reduced to what the rule touches, with the UNIQUE constraint that matters. */
function repo() {
  const rows: Row[] = [];
  const signIns: { userId: string; provider: string }[] = [];
  let n = 0;
  const impl: IdentityLookup<null> = {
    async userByEmail(_ctx, email) {
      return rows.find((r) => r.email === email.trim().toLowerCase());
    },
    async recordSignIn(_ctx, userId, detail) {
      signIns.push({ userId, provider: detail.provider });
      const row = rows.find((r) => r.id === userId);
      // §10: `auth_provider` reflects the MOST RECENT sign-in.
      if (row) row.provider = detail.provider;
    },
    async provisionUser(_ctx, input) {
      const email = input.email.trim().toLowerCase();
      // THE CONSTRAINT THAT MADE THE ORIGINAL BUG A REFUSAL RATHER THAN A DUPLICATE. `users.email`
      // is UNIQUE, so an address held by a different subject cannot simply be inserted again.
      const taken = rows.find((r) => r.email === email);
      if (taken && taken.externalId !== input.externalId) {
        throw new Error(`${email} already belongs to a different sign-in on this server`);
      }
      const row: Row = {
        id: `u${++n}`,
        email,
        externalId: input.externalId,
        provider: input.authProvider ?? "",
      };
      rows.push(row);
      return { user: { id: row.id } };
    },
  };
  return { impl, rows, signIns };
}

const google = (email: string, sub = "sub-1") =>
  ({ email, externalId: `google|${sub}`, displayName: "Ada", provider: "google" }) as const;
const magic = (email: string) =>
  ({ email, externalId: `email|${email}`, displayName: null, provider: "magic_link" }) as const;

console.log("\na new address provisions exactly one account");
{
  const r = repo();
  const first = await linkIdentity(r.impl, null, google("ada@example.com"));
  check(first.created, "the first sign-in creates the account");
  check(r.rows.length === 1, "one row");
  check(r.signIns.length === 1, "...and the sign-in is recorded even on creation");
}

console.log("\nGoogle first, then a magic link — the order that already worked");
{
  const r = repo();
  const a = await linkIdentity(r.impl, null, google("ada@example.com"));
  const b = await linkIdentity(r.impl, null, magic("ada@example.com"));
  check(a.userId === b.userId, "the same account", `${a.userId} vs ${b.userId}`);
  check(!b.created, "the second sign-in creates nothing");
  check(r.rows.length === 1, "still one row — never two accounts for one email");
}

console.log("\na magic link first, then Google — the order that was REFUSED");
{
  const r = repo();
  const a = await linkIdentity(r.impl, null, magic("ada@example.com"));
  let threw: string | null = null;
  let b: { userId: string; created: boolean } | null = null;
  try {
    b = await linkIdentity(r.impl, null, google("ada@example.com"));
  } catch (e) {
    threw = (e as Error).message;
  }
  check(threw === null, "Google does not throw at an address a link already proved", threw ?? "");
  check(b !== null && a.userId === b.userId, "...it lands on the same account");
  check(r.rows.length === 1, "...and creates no second row");
  // THE external_id IS NOT REWRITTEN, because it is what the minted token carries as `sub`.
  // Rewriting it would strand every token already issued on a subject that no longer resolves.
  check(r.rows[0]!.externalId === "email|ada@example.com", "the original subject is kept");
  check(r.rows[0]!.provider === "google", "...while auth_provider moves to the most recent");
}

console.log("\nthe address is what identifies a person, however it is spelled");
{
  const r = repo();
  const a = await linkIdentity(r.impl, null, magic("Ada@Example.com"));
  const b = await linkIdentity(r.impl, null, google("  ada@example.com  "));
  check(a.userId === b.userId, "case and surrounding space do not make a second account");
  check(r.rows.length === 1, "one row");
  check(r.rows[0]!.email === "ada@example.com", "stored normalised");
}

console.log("\ntwo different people are still two accounts");
{
  const r = repo();
  await linkIdentity(r.impl, null, google("ada@example.com", "sub-a"));
  await linkIdentity(r.impl, null, google("grace@example.com", "sub-b"));
  check(r.rows.length === 2, "different addresses do not collapse");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
