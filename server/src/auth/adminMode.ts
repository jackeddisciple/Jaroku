// The founder's override, and every reason it is built the way it is rather than the obvious way.
//
// IT IS NOT A TIER, AND BUILDING IT AS ONE IS THE MISTAKE THE SPECIFICATION NAMES. "Another tier
// with all the features on" is a plan, and a plan is something that can be assigned, sold, granted
// by an admin panel, or set by a bug — which is how a testing convenience becomes a permission
// escalation eighteen months later. So there is no `admin` in `PLAN_IDS`, no row in `plans`, and
// nothing in any dropdown.
//
// WHO MAY IS AN ENVIRONMENT VARIABLE. Not a column, not a role, not a grant. Adding an admin
// requires a deploy and a restart, and that friction is the feature: nobody in a hurry can promote
// themselves, and the list of who can bypass every limit is a line in a configuration file that
// somebody reviews rather than a row somebody could write.
//
// WHETHER IT IS ON IS IN-MEMORY SESSION STATE, and it defaults to off. Two flags rather than one,
// and the pair is the whole security model: `isAdmin` is derived from the environment and says a
// person MAY; `adminMode` is a deliberate act and says they currently ARE. A request body carrying
// `adminMode: true` grants nothing, because the first flag is not something a request can set.
//
// "NEW SESSION" MEANS SOMETHING DIFFERENT ON A DESKTOP APP, and this is the subtlety the
// specification spends a paragraph on. The session token lives in the OS keychain and survives
// quitting — somebody can stay signed in for weeks without ever signing in again. If "new session"
// meant only "signed out and back in", admin mode could stay on across dozens of app launches,
// which defeats the point of defaulting it off. Because it is held ONLY in this process's memory,
// a relaunch starts from false whether or not the token was reused: the state has nowhere to
// survive. That is automatic, and it is written down here and asserted in the suite anyway, because
// "in-memory state naturally resets" is exactly the assumption that quietly breaks the first time
// somebody adds session persistence for an unrelated reason.
//
// IT DOES NOT BYPASS RLS AND IT DOES NOT BYPASS THE AUDIT LOG. Admin mode grants FEATURE access
// inside the admin's own workspaces; it is not a way to read another tenant's data, and the tenancy
// layer never learns it exists. If anything it logs more — every bypass writes a row, so
// retrospective auditing can tell "a user hit a limit" from "an admin walked through one".

import { forbidden } from "../http/router.ts";

/** Where the list of who may lives. Comma-separated user ids; absent means nobody. */
export const ADMIN_IDS_ENV = "JAROKU_ADMIN_USER_IDS";

/**
 * The user ids allowed to turn admin mode on.
 *
 * READ PER CALL rather than captured at import, which matters for one specific reason: a value
 * frozen at import is frozen at whatever the environment held the first time anything touched this
 * module, and the edge case the specification names is an admin being REMOVED while they have a
 * live session. Reading per call means the removal takes effect at the next request rather than at
 * the next deploy — the friction is meant to be on adding an admin, not on removing one.
 */
export function adminUserIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env[ADMIN_IDS_ENV] ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

/**
 * Whether this user may turn admin mode on.
 *
 * CALLED IN EXACTLY ONE PLACE — session hydration — and the resulting boolean rides the session.
 * Downstream code reads `session.isAdmin` and never re-derives, so there is one answer per session
 * rather than a scattering of environment reads that could disagree with each other mid-request.
 */
export function isAdminUser(userId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof userId === "string" && userId.length > 0 && adminUserIds(env).has(userId);
}

/** Whether this deployment has any admins at all. For a log line at boot, not a gate. */
export function adminModeConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return adminUserIds(env).size > 0;
}

/**
 * Whether admin mode is currently ON, per user, for the life of this process.
 *
 * A MODULE-LEVEL MAP AND NOT A DATABASE TABLE, which is the mechanism that makes "resets on every
 * app launch" true without anybody having to remember it. There is no column, no cache with a TTL,
 * and no file — so a restart, a crash, a redeploy and a desktop relaunch all produce the same
 * thing: nobody in admin mode.
 *
 * KEYED BY USER AND NOT BY SESSION. Two admins in one workspace toggle independently, which the
 * specification asks for; one admin with two windows open gets one answer, which is the honest
 * reading — the mode is about the person, and a per-socket flag would mean the banner appeared in
 * one window and not the other while both bypassed limits.
 */
const active = new Set<string>();

/** Whether this user currently has it on. False for everybody at process start, always. */
export function adminModeOn(userId: string | null | undefined): boolean {
  return typeof userId === "string" && active.has(userId);
}

export interface ToggleResult {
  on: boolean;
}

/**
 * Turn it on or off for one user.
 *
 * REFUSES A NON-ADMIN WITH A 403 AND NOT A 404, which is a deliberate departure from how this
 * codebase hides things elsewhere. A 404 is the right answer for a resource somebody may not know
 * about; this is a permission failure by somebody who found an endpoint they were not shown, and
 * the specification is explicit that it is worth logging rather than disguising. The caller logs it
 * to `audit_log`; the status code is what tells the truth about what happened.
 */
export function setAdminMode(userId: string, isAdmin: boolean, on: boolean): ToggleResult {
  if (!isAdmin) {
    throw forbidden("admin mode is not available to this account");
  }
  if (on) active.add(userId);
  else active.delete(userId);
  return { on: active.has(userId) };
}

/**
 * Forget every toggle. For a suite, and for a shutdown that wants to be explicit about it.
 *
 * Exported so the assertion "a relaunch starts from off" can be made without spawning a process —
 * and so the thing the assertion is about is a function with a name rather than an implicit
 * property of module state.
 */
export function resetAdminMode(): void {
  active.clear();
}
