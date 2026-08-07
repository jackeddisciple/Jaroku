// The capability matrix, and the assertion that keeps it honest.
//
// Most of this file is ordinary: a member cannot do an admin's job, an admin cannot do an
// owner's. The one that earns its keep is the LAST section, which reads wsRelay.ts and checks
// that every command the relay accepts has an entry here. Without it, a command added in a
// later session arrives ungated and nothing says so — which is precisely how a role check
// scattered across handlers grows its hole.
//
//   npm run test:capabilities

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  CAPABILITIES,
  COMMAND_CAPABILITY,
  ROLE_CAPABILITIES,
  can,
  capabilityFor,
  requireCapability,
  type Capability,
} from "./capabilities.ts";
import type { TenantContext, Role } from "../db/tenant.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const ctx = (role: Role): TenantContext => ({
  workspaceId: "00000000-0000-4000-8000-000000000001",
  actorUserId: "u1",
  role,
  requestId: "r1",
});

const denied = (role: Role, cap: Capability): boolean => {
  try {
    requireCapability(ctx(role), cap);
    return false;
  } catch {
    return true;
  }
};

console.log("\nnesting");
{
  const member = ROLE_CAPABILITIES.member;
  const admin = ROLE_CAPABILITIES.admin;
  const owner = ROLE_CAPABILITIES.owner;
  check(member.every((c) => admin.includes(c)), "an admin can do everything a member can");
  check(admin.every((c) => owner.includes(c)), "an owner can do everything an admin can");
  check(owner.length === CAPABILITIES.length, "an owner holds every capability there is");
  check(
    ROLE_CAPABILITIES.system.length === CAPABILITIES.length,
    "so does `system` — the server acting on its own behalf",
  );
  check(admin.length > member.length && owner.length > admin.length, "...and the three are genuinely different");
}

console.log("\nthe boundaries");
{
  check(can("member", "agent:write"), "a member builds and edits agents — that is the product");
  check(can("member", "run:execute"), "...and runs them");
  check(can("member", "eval:run"), "...and runs evals");
  check(can("member", "mcp:confirm"), "...and can answer a confirmation that halted their own run");

  check(denied("member", "mcp:manage"), "a member cannot connect a third-party MCP server");
  check(denied("member", "provider:manage"), "...nor store a provider key");
  check(denied("member", "deploy:manage"), "...nor put an agent on a public URL");
  check(denied("member", "member:manage"), "...nor change who is in the workspace");

  check(can("admin", "mcp:manage") && can("admin", "provider:manage") && can("admin", "deploy:manage"),
    "an admin does all three of those");
  check(denied("admin", "member:manage"), "an admin still cannot change membership");
  check(denied("admin", "workspace:manage"), "...nor delete the workspace");
  check(denied("admin", "billing:manage"), "...nor touch billing");

  check(can("owner", "member:manage") && can("owner", "workspace:manage") && can("owner", "billing:manage"),
    "an owner does all three of those");
}

console.log("\nrequireCapability");
{
  let message = "";
  try {
    requireCapability(ctx("member"), "deploy:manage");
  } catch (e) {
    message = (e as Error).message;
  }
  check(/member/.test(message), "a refusal names the role that was refused");
  check(/deploy:manage/.test(message), "...and the capability it lacked");

  let status = 0;
  try {
    requireCapability(ctx("member"), "member:manage");
  } catch (e) {
    status = (e as { status: number }).status;
  }
  check(status === 403, "...and is a 403, not a 401 — the token was fine");

  check(!can("member", "nonsense" as Capability), "an unknown capability is denied to everyone");
  check(capabilityFor("no-such-command") === undefined, "an unclassified command yields undefined, not a default");
  // `__proto__` as a plain-object key assigns a prototype rather than an entry, so a lookup
  // that does not guard it returns Object.prototype and reads as "classified". Same reasoning
  // as the MCP tool-name refusal.
  check(capabilityFor("__proto__") === undefined, "...including __proto__, which is not an entry");
}

console.log("\nevery command the relay accepts is classified");
{
  // Read from the relay's own source rather than a list kept here, so this cannot pass by
  // being out of date. Two shapes to find: the `msg.cmd === "x"` comparisons and the
  // `new Set([...])` groupings the forwarding switch uses.
  const relay = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "..", "wsRelay.ts"), "utf8");
  const commands = new Set<string>();
  for (const m of relay.matchAll(/msg\.cmd === "([a-zA-Z]+)"/g)) commands.add(m[1]!);
  for (const m of relay.matchAll(/^const [A-Z_]+_COMMANDS = new Set\(\[([\s\S]*?)\]\);/gm)) {
    for (const q of m[1]!.matchAll(/"([a-zA-Z]+)"/g)) commands.add(q[1]!);
  }
  check(commands.size > 40, `found the relay's command surface (${commands.size} commands)`);

  const unclassified = [...commands].filter((c) => capabilityFor(c) === undefined);
  check(
    unclassified.length === 0,
    `every relay command has a capability (unclassified: ${unclassified.join(", ") || "none"})`,
  );

  // And the other direction: an entry here for a command that no longer exists is a rule
  // nobody enforces, and it makes the table read as covering more than it does.
  const stale = Object.keys(COMMAND_CAPABILITY).filter((c) => !commands.has(c));
  check(stale.length === 0, `no entry names a command the relay dropped (stale: ${stale.join(", ") || "none"})`);

  // Every capability in the vocabulary is reachable from some role, or it is decoration.
  const unreachable = CAPABILITIES.filter((c) => !can("owner", c));
  check(unreachable.length === 0, `every capability is held by someone (${unreachable.join(", ") || "all reachable"})`);
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
