// Run the provider-key classification. See migrateProviderKeys.ts for what it does and does not do.
//
//   npm run secrets:migrate-provider-keys -- --dry-run
//   npm run secrets:migrate-provider-keys
//
// A SEPARATE COMMAND FROM `npm run migrate`, deliberately. The schema migration is DDL and runs in
// the release command before any new machine takes traffic; this is a data job that walks every
// workspace, and putting it in the release path would make a deploy's duration a function of how
// many tenants exist. It is also safe to re-run, which a release command should not have to be.

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { openDb } from "../db/open.ts";
import { SecretRefRepository } from "../db/repositories/secretRefs.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { migrateProviderKeys } from "./migrateProviderKeys.ts";

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DB_PATH = process.env.JAROKU_DB ?? join(SERVER_DIR, "jaroku.db");

const dryRun = process.argv.includes("--dry-run");

// The same opening the migration runner uses, so `JAROKU_DB_DRIVER=postgres` points this at the
// hosted database without a second way of spelling it.
const db = openDb({ sqlitePath: DB_PATH });
try {
  const report = await migrateProviderKeys({
    db,
    refs: new SecretRefRepository(db),
    identity: new IdentityRepository(db),
    dryRun,
  });
  // A non-zero exit when a dry run found work, so a pipeline can gate on "is there anything to do"
  // without parsing the log. Zero when there is nothing left, which is what a second run reports.
  process.exit(dryRun && report.keysClassified > 0 ? 1 : 0);
} finally {
  await db.close();
}
