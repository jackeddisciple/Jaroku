// Whether the role this process connects as can be governed by the policies at all.
//
// THE FAILURE THIS EXISTS FOR IS INVISIBLE FROM INSIDE THE APPLICATION, which is `009_rls.sql`'s
// own phrase and the reason a check at boot is worth its lines. Row-level security is the second
// wall: every repository already scopes its queries by workspace, and the policies are what catches
// the query that forgets. A role with BYPASSRLS ignores every policy unconditionally — forced or
// not — so an application connecting as one has one wall where it believes it has two, and NOTHING
// about the schema, the migrations or the query results says so. Every policy is still there. Every
// policy is inert.
//
// IT WAS NOT HYPOTHETICAL. The first hosted deployment of this server connected to Neon as
// `neondb_owner`, which carries `rolbypassrls`, so an unscoped `SELECT count(*) FROM threads`
// returned every row in the database — with `relforcerowsecurity` set on the table and the policy
// present and correct. `test:rls` asserts the role's attributes precisely because of this, and it
// could not run there: it needs SET ROLE, and the owner was not a member of the app role.
//
// SO THE CHECK MOVED TO WHERE IT CANNOT BE SKIPPED. This runs against the connection the server
// actually opened, in the environment it actually booted in, and refuses to serve traffic when the
// answer is wrong.
//
// PRODUCTION ONLY, and by refusal rather than a warning. A developer pointing at a local Postgres
// as a superuser is doing something ordinary and should not be stopped; a hosted deployment with no
// tenant isolation is one that must not take a request. A warning in that case is a line in a log
// nobody reads until afterwards.

export interface RoleFacts {
  role: string;
  superuser: boolean;
  bypassRls: boolean;
}

/** The narrow slice of a database this check needs. */
export interface RoleReader {
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
}

/**
 * Read what the CONNECTING role is, rather than what the migrations created.
 *
 * `current_user` and not a configured name: the question is about the session this process holds,
 * and a deployment can point its connection string at any role it likes.
 */
export async function readRoleFacts(db: RoleReader): Promise<RoleFacts | null> {
  const row = await db.get<{ rolname: string; rolsuper: boolean | number; rolbypassrls: boolean | number }>(
    `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
  );
  if (!row) return null;
  // The two drivers disagree about what a boolean is on the way back out — see
  // db/booleanLiterals.test.ts for the same seam in the other direction.
  const truthy = (v: boolean | number): boolean => v === true || v === 1;
  return { role: row.rolname, superuser: truthy(row.rolsuper), bypassRls: truthy(row.rolbypassrls) };
}

/**
 * Decide whether this connection may serve traffic. Returns the refusal, or null.
 *
 * SEPARATED FROM THE READ so the rule is a pure function of three facts and can be asserted without
 * a database — which is what makes it testable at all, and `009_rls.sql` says the failure is
 * otherwise invisible.
 */
export function rlsRefusal(facts: RoleFacts, production: boolean): string | null {
  if (!production) return null;
  if (!facts.superuser && !facts.bypassRls) return null;
  const why = facts.superuser ? "is a SUPERUSER" : "has BYPASSRLS";
  return (
    `the database role "${facts.role}" ${why}, so every row-level security policy in this database ` +
    `is ignored for this connection. Tenant isolation would rest entirely on each query remembering ` +
    `its own WHERE clause, with no second wall and nothing in the schema to say so. Connect as a ` +
    `role with neither — migrations/postgres/009_rls.sql creates "jaroku_app" for this and grants ` +
    `it what the application needs — and keep the owner's credentials for migrations only.`
  );
}
