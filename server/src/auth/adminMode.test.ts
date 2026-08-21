// Admin mode, which is a permission bypass and is therefore the one feature here whose suite is
// mostly about what it must NOT do.
//
// THE ESCALATION IT REFUSES. There are two flags and a request can reach neither. `isAdmin` comes
// from an environment variable read at session hydration; `adminMode` lives in this process's
// memory and moves only through an endpoint that checks the first. A body carrying
// `adminMode: true` is a claim, and the assertions below are what make it only ever a claim.
//
// AND THE DESKTOP CASE, WHICH IS THE SUBTLE ONE. On a web app "new session" means signing in. On
// this one the token lives in the OS keychain and survives quitting, so somebody stays signed in
// for weeks — and if admin mode were persisted anywhere, it would stay on across dozens of app
// launches, which defeats the whole reason it defaults off. It is not persisted, so a relaunch
// starts from false automatically. That automatic property is asserted here anyway, because
// "in-memory state naturally resets" is exactly the assumption that breaks the first time somebody
// adds session persistence for an unrelated reason.
//
// IT IS NOT A TIER, and the last block proves it structurally: nothing in `PLAN_IDS`, nothing in
// the plans table, nothing selectable. A feature built as "another tier with everything on" is one
// that can be assigned, sold or set by a bug, which is how a testing convenience becomes a
// permission escalation eighteen months later.
//
//   npm run test:admin-mode

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ADMIN_IDS_ENV, adminModeConfigured, adminModeOn, adminUserIds, isAdminUser, resetAdminMode,
  setAdminMode,
} from "./adminMode.ts";
import { ADMIN_ENTITLEMENTS, resolveEntitlements } from "../billing/entitlements.ts";
import { PLAN_IDS } from "../billing/plans.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const FOUNDER = "11111111-1111-4111-8111-111111111111";
const ORDINARY = "22222222-2222-4222-8222-222222222222";

/** The environment, restored after every block so one block cannot leak into the next. */
const withAdmins = (value: string | undefined): void => {
  if (value === undefined) delete process.env[ADMIN_IDS_ENV];
  else process.env[ADMIN_IDS_ENV] = value;
};

// ---------------------------------------------------------------------------------------------
console.log("\nwho may is an environment variable, and nothing else");
// ---------------------------------------------------------------------------------------------
{
  withAdmins(undefined);
  check(!isAdminUser(FOUNDER), "with nothing configured, nobody may");
  check(!adminModeConfigured(), "...and the deployment says it has no admins");

  withAdmins(FOUNDER);
  check(isAdminUser(FOUNDER), "a listed id may");
  check(!isAdminUser(ORDINARY), "...and an unlisted one may not");
  check(adminModeConfigured(), "the deployment says it has admins");

  // A list, with the spacing somebody actually types.
  withAdmins(` ${FOUNDER} , ${ORDINARY} `);
  check(isAdminUser(FOUNDER) && isAdminUser(ORDINARY), "a comma-separated list works, spaces and all");
  check(adminUserIds().size === 2, "...and is read as two entries rather than one long string");

  // Empties are not admins. `JAROKU_ADMIN_USER_IDS=,,` is what a partially-edited config looks
  // like, and reading it as "three empty admins" would make `isAdminUser("")` true.
  withAdmins(",,");
  check(adminUserIds().size === 0, "a config of nothing but commas lists nobody");
  check(!isAdminUser(""), "...and the empty string is not an admin");
  check(!isAdminUser(null) && !isAdminUser(undefined), "nor is an absent user id");

  // READ PER CALL, so removing an admin takes effect at the next request rather than the next
  // deploy. The friction is meant to be on ADDING one.
  withAdmins(FOUNDER);
  check(isAdminUser(FOUNDER), "listed");
  withAdmins("");
  check(!isAdminUser(FOUNDER), "...and removed from the environment is removed now, not at redeploy");
}

// ---------------------------------------------------------------------------------------------
console.log("\nturning it on requires being allowed to, and the request cannot say so");
// ---------------------------------------------------------------------------------------------
{
  withAdmins(FOUNDER);
  resetAdminMode();

  check(!adminModeOn(FOUNDER), "an admin starts with it off");

  // THE ESCALATION. `setAdminMode` takes `isAdmin` as an argument rather than deriving it, which
  // looks like a hole and is the opposite: the ONE caller derives it from the environment, and a
  // signature that took it means a suite can prove the refusal without standing a server up.
  let status = 0;
  try {
    setAdminMode(ORDINARY, false, true);
  } catch (e) {
    status = (e as { status: number }).status;
  }
  check(status === 403, "a non-admin asking for it is refused with a 403");
  check(!adminModeOn(ORDINARY), "...and it did not go on anyway");
  // 403 AND NOT 404, deliberately, and against how this codebase hides things elsewhere. A 404 is
  // right for a resource somebody may not know about; this is a permission failure by somebody who
  // found an endpoint they were never shown, and it is worth logging rather than disguising.
  check(status !== 404, "...and it is a permission failure rather than a disguise");

  check(setAdminMode(FOUNDER, true, true).on, "an admin turning it on turns it on");
  check(adminModeOn(FOUNDER), "...and it stays on");
  check(!adminModeOn(ORDINARY), "...for that person only");

  check(!setAdminMode(FOUNDER, true, false).on, "and off turns it off again");
  check(!adminModeOn(FOUNDER), "...which sticks too");
}

// ---------------------------------------------------------------------------------------------
console.log("\ntwo admins toggle independently");
// ---------------------------------------------------------------------------------------------
{
  withAdmins(`${FOUNDER},${ORDINARY}`);
  resetAdminMode();
  setAdminMode(FOUNDER, true, true);
  check(adminModeOn(FOUNDER), "the first has it on");
  // The specification's own edge case: two admins in one workspace, one toggles. Only that
  // person's session flips — a shared flag would put a banner on somebody else's screen and
  // bypass limits they had not asked to bypass.
  check(!adminModeOn(ORDINARY), "...and the second is unaffected");
  setAdminMode(ORDINARY, true, true);
  setAdminMode(FOUNDER, true, false);
  check(!adminModeOn(FOUNDER) && adminModeOn(ORDINARY), "...and turning one off leaves the other on");
}

// ---------------------------------------------------------------------------------------------
console.log("\nit resets on every process start, which on a desktop app is every launch");
// ---------------------------------------------------------------------------------------------
{
  withAdmins(FOUNDER);
  resetAdminMode();
  setAdminMode(FOUNDER, true, true);
  check(adminModeOn(FOUNDER), "on");

  // `resetAdminMode` IS WHAT A NEW PROCESS DOES, expressed as a function so the property has a name
  // and an assertion rather than being an implicit consequence of module state. The desktop case is
  // why it matters: the session token survives in the OS keychain for weeks, so if this were
  // persisted anywhere it would stay on across dozens of launches.
  resetAdminMode();
  check(!adminModeOn(FOUNDER), "a fresh process starts from off, even for a listed admin");

  // AND THE STRUCTURAL HALF. The assertion above passes for a module that writes to a database and
  // happens to have an empty cache; this is what says there is nowhere for it to survive.
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "adminMode.ts"),
    "utf8",
  ).replace(/\/\/[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  for (const persistence of ["localStorage", "writeFile", "INSERT", "UPDATE", "redis", "keytar"]) {
    check(!src.includes(persistence), `admin mode reaches for no "${persistence}" — there is nowhere to survive`);
  }
}

// ---------------------------------------------------------------------------------------------
console.log("\nwhat it grants, and what it is not");
// ---------------------------------------------------------------------------------------------
{
  withAdmins(FOUNDER);

  // BOTH FLAGS. `adminMode` alone is a claim a request could make; `isAdmin` is what the
  // environment says, and only the pair resolves to the permissive object.
  const claimed = resolveEntitlements({ plan: "free", isAdmin: false, adminMode: true });
  check(claimed.maxAgents === 3, "a claim without the environment behind it grants nothing");

  const dormant = resolveEntitlements({ plan: "free", isAdmin: true, adminMode: false });
  check(dormant.maxAgents === 3, "an admin who has not turned it on is an ordinary user");

  const bypassing = resolveEntitlements({ plan: "free", isAdmin: true, adminMode: true });
  check(bypassing.maxAgents === "unlimited", "both together lift every limit");
  check(bypassing.policyEngine && bypassing.githubPhase2, "...and turn on every gated feature");

  // IT IS NOT A TIER, structurally rather than by assertion of intent. A plan is something that can
  // be assigned, sold, or set by a bug; this is not one, and the day somebody adds `admin` to
  // PLAN_IDS to "simplify" is the day this fails.
  check(
    !(PLAN_IDS as readonly string[]).includes("admin"),
    "there is no `admin` plan — it is an override, not a tier that could be assigned",
  );
  check(
    Object.isFrozen(ADMIN_ENTITLEMENTS),
    "the permissive object is frozen, so no caller can widen it for the whole process",
  );
}

// ---------------------------------------------------------------------------------------------
console.log("\nthe bypass is logged where it can be read back");
// ---------------------------------------------------------------------------------------------
{
  // A STRUCTURAL CHECK, because the write itself lives in index.ts on a path that needs a database,
  // a relay and a socket to reach. What can be asserted here is that the write exists, names the
  // action the specification names, and records what WOULD have stopped the request — a row saying
  // only "an admin did something" answers none of the questions the trail exists for.
  const index = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts"),
    "utf8",
  );
  check(
    index.includes("admin.entitlement_bypassed"),
    "every bypass writes an audit row under the specification's own action name",
  );
  check(
    index.includes('originalResult: "denied"'),
    "...recording what would have stopped it, which is the whole point of the trail",
  );
  check(
    index.includes("admin.mode_denied") || readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "session.ts"), "utf8",
    ).includes("admin.mode_denied"),
    "and a non-admin who asks for it leaves a row too, rather than only a 403",
  );
}

withAdmins(undefined);
resetAdminMode();
console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
