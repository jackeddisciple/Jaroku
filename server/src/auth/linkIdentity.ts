// One verified address, one account — the rule both sign-in flows obey, spelled once.
//
// WHY IT IS A MODULE. It was written twice, in two callbacks a hundred lines apart, and the copies
// disagreed. The magic-link one looked the account up by address first; the Google one did not, and
// went straight to `provisionUser` — which refuses an address already held by a different subject.
// So the two buttons on the sign-in screen were not interchangeable:
//
//   Google, then a link  → the same account, because the link's copy matched by address.
//   A link, then Google  → "already belongs to a different sign-in on this server".
//
// That is a sentence nobody can act on, about two buttons the screen presents as equals, and with
// two hundred people it happens constantly because nobody remembers which one they used last.
//
// MATCHING ON THE ADDRESS IS THE SAFE PART, not the risky one, and it is worth being explicit about
// why: every caller has already PROVEN the mailbox before it gets here. `verifyGoogleIdToken`
// refuses a token whose `email_verified` is not true, and a magic link is a delivery receipt — a
// secret that only reached the person who can read that inbox. Two proofs of one mailbox are two
// proofs about one person, which is the entire premise of §10's "never two accounts for one email".
//
// AND THE EXISTING `external_id` IS KEPT rather than rewritten to the new provider's subject. That
// column is what the minted token carries as `sub` (see session.ts), so rewriting it would strand
// every token already issued on a subject that no longer resolves. The provider a person most
// recently used is recorded separately, by `recordSignIn`, which is the fact `auth_provider` is for.
//
//   npm run test:link-identity

/** What a caller has proven about somebody, whichever flow proved it. */
export interface ProvenIdentity {
  /** Already verified. Both callers refuse to reach here otherwise. */
  email: string;
  /** The subject to invent IF this is a new account. Namespaced by provider. */
  externalId: string;
  /** Google supplies one; a magic link has none until the person types it. */
  displayName: string | null;
  provider: "google" | "magic_link";
}

/** The narrow slice of the identity repository this rule needs. */
export interface IdentityLookup<Ctx> {
  userByEmail(ctx: Ctx, email: string): Promise<{ id: string } | undefined>;
  recordSignIn(ctx: Ctx, userId: string, detail: { provider: string; emailVerified: boolean }): Promise<void>;
  provisionUser(
    ctx: Ctx,
    input: { externalId: string; email: string; displayName?: string | null; authProvider?: string | null },
  ): Promise<{ user: { id: string } }>;
}

/**
 * Resolve a proven identity to the account it belongs to, creating one only if there is none.
 *
 * THE ORDER IS THE WHOLE RULE. Address first, subject second: an account is a PERSON, and the
 * person is identified by the mailbox they proved, not by which provider happened to prove it.
 */
export async function linkIdentity<Ctx>(
  repo: IdentityLookup<Ctx>,
  ctx: Ctx,
  identity: ProvenIdentity,
): Promise<{ userId: string; created: boolean }> {
  // Normalised here rather than trusted from the caller: `users.email` is compared case-insensitively
  // and one flow reads its address out of an ID token while the other reads it off a form.
  const email = identity.email.trim().toLowerCase();

  const existing = await repo.userByEmail(ctx, email);
  if (existing) {
    // RECORDED EVEN THOUGH NOTHING WAS CREATED. §10 says `auth_provider` "reflects most recent", so
    // a second sign-in has to move it or the column goes stale for the life of every account.
    await repo.recordSignIn(ctx, existing.id, { provider: identity.provider, emailVerified: true });
    return { userId: existing.id, created: false };
  }

  const provisioned = await repo.provisionUser(ctx, {
    externalId: identity.externalId,
    email,
    displayName: identity.displayName,
    authProvider: identity.provider,
  });
  await repo.recordSignIn(ctx, provisioned.user.id, { provider: identity.provider, emailVerified: true });
  return { userId: provisioned.user.id, created: true };
}
