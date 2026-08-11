// DATABASE_URL is user-supplied and is the SSRF vector the migration spec calls out by name —
// exercised against the nasty cases: private-range hosts, a port outside the allowlist, a
// credential embedded in the URL, and a resolver that answers with a mix of public and private
// addresses.
//
//   npm run test:database-url

import { EgressPolicyError } from "./egressPolicy.ts";
import { DatabaseUrlError, validateDatabaseUrl } from "./databaseUrl.ts";
import type { Resolver } from "./egressPolicy.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const fakeResolver = (answers: Record<string, string[]>): Resolver => {
  return async (host) => {
    const v4 = answers[host];
    if (!v4) throw new Error(`no fixture answer for ${host}`);
    return { v4, v6: [] };
  };
};

async function throws<E extends Error>(p: Promise<unknown>, ctor: new (...a: never[]) => E, substr?: string): Promise<boolean> {
  try {
    await p;
    return false;
  } catch (e) {
    return e instanceof ctor && (!substr || (e as Error).message.includes(substr));
  }
}

await (async () => {
  const resolver = fakeResolver({ "db.example.com": ["93.184.216.34"] });
  const v = await validateDatabaseUrl("postgres://user:pass@db.example.com:5432/app", resolver);
  check("a well-formed URL on the default port validates", v.host === "db.example.com" && v.port === 5432);
  check("the resolved, pinned address is returned", v.ips.includes("93.184.216.34"));
})();

await (async () => {
  const resolver = fakeResolver({ "db.example.com": ["93.184.216.34"] });
  const v = await validateDatabaseUrl("postgres://db.example.com/app", resolver);
  check("a missing port defaults to 5432, not to \"unrestricted\"", v.port === 5432);
})();

await (async () => {
  const resolver = fakeResolver({ "pooled.example.com": ["93.184.216.35"] });
  const v = await validateDatabaseUrl("postgresql://pooled.example.com:6543/app", resolver);
  check("the pgbouncer/Supabase pooled port 6543 is allowed", v.port === 6543);
})();

check(
  "a non-postgres scheme is refused",
  await throws(validateDatabaseUrl("mysql://host/db", fakeResolver({})), DatabaseUrlError, "postgres://"),
);

check(
  "an unparseable URL is refused",
  await throws(validateDatabaseUrl("not a url at all", fakeResolver({})), DatabaseUrlError),
);

check(
  "a port outside the allowlist is refused",
  await throws(
    validateDatabaseUrl("postgres://db.example.com:22/app", fakeResolver({ "db.example.com": ["93.184.216.34"] })),
    DatabaseUrlError,
    "not on the allowed list",
  ),
);

check(
  "a port aimed at a Redis-shaped target (6379) is refused",
  await throws(
    validateDatabaseUrl("postgres://db.example.com:6379/app", fakeResolver({ "db.example.com": ["93.184.216.34"] })),
    DatabaseUrlError,
  ),
);

check(
  "a hostname resolving to a private address is refused via the shared egress refusal",
  await throws(
    validateDatabaseUrl("postgres://internal.example.com:5432/app", fakeResolver({ "internal.example.com": ["10.0.0.5"] })),
    EgressPolicyError,
    "private/link-local/reserved",
  ),
);

check(
  "a hostname resolving to the metadata endpoint is refused",
  await throws(
    validateDatabaseUrl("postgres://evil.example.com:5432/app", fakeResolver({ "evil.example.com": ["169.254.169.254"] })),
    EgressPolicyError,
  ),
);

check(
  "loopback is refused even on an allowed port",
  await throws(
    validateDatabaseUrl("postgres://localhost:5432/app", fakeResolver({ localhost: ["127.0.0.1"] })),
    EgressPolicyError,
  ),
);

await (async () => {
  // A credential in the URL is read for the connection itself (this is Postgres' own
  // convention, unlike the MCP server URL rule which refuses one outright) but must never
  // appear in what this function raises — the same "never echo the offending value" discipline
  // the MCP client already applies to server URLs.
  const resolver = fakeResolver({ "db.example.com": ["10.0.0.5"] });
  try {
    await validateDatabaseUrl("postgres://admin:s3cr3t@db.example.com:5432/app", resolver);
    check("credentialed URL to a private host should have thrown", false);
  } catch (e) {
    check("a refusal never echoes the password back", !(e as Error).message.includes("s3cr3t"));
  }
})();

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
