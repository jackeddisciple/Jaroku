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
  AGENT_CAPABILITIES,
  CAPABILITIES,
  COMMAND_CAPABILITY,
  ROLE_AGENT_CAPABILITIES,
  ROLE_CAPABILITIES,
  agentCeiling,
  can,
  capabilityFor,
  closeAgentCapabilities,
  isAgentCapability,
  roleFor,
  requireCapability,
  withArticle,
  type AgentCapability,
  type Capability,
} from "./capabilities.ts";
import type { TenantContext, Role } from "../db/tenant.ts";
import { COMMAND_CHANNEL, channelFor } from "../wsRelay.ts";

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

  // AND SAYS IT IN ENGLISH. `a ${ctx.role}` read "a admin", and admin is one of only two roles
  // that ever reach a refusal — an owner is refused nothing. Asserted for every role rather than
  // for the one that was wrong, so a fourth role is right without anybody remembering this exists.
  let adminMessage = "";
  try {
    requireCapability(ctx("admin"), "member:manage");
  } catch (e) {
    adminMessage = (e as Error).message;
  }
  check(adminMessage.startsWith("an admin"), `an admin, not "a admin" (${adminMessage.slice(0, 20)}…)`);
  check(withArticle("member") === "a member", "a member");
  check(withArticle("owner") === "an owner", "an owner");
  check(withArticle("system") === "a system", "and a system, which is refused nothing but would read correctly");

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

// The seven agent-level capabilities, their implication closure, and the ceilings the three
// membership roles put on them. All of it is data in the same file as the matrix above, so all of
// it is asserted here rather than in the resolver's suite: what the resolver does with the ceiling
// is one question, and whether the ceiling is the right shape is another.
console.log("\nthe agent-level vocabulary");
{
  check(AGENT_CAPABILITIES.length === 7, `there are seven of them (${AGENT_CAPABILITIES.join(", ")})`);
  check(
    AGENT_CAPABILITIES.every((c) => !c.includes(":")),
    "...and none is spelled like a workspace capability, so the two cannot be mistyped into each other",
  );
  check(!isAgentCapability("agent:write"), "a workspace capability is not an agent capability");
  check(!isAgentCapability("__proto__"), "...and neither is __proto__, which is not an entry");

  // §3.2's four rules, each asserted as the sentence it is written as.
  const closed = (...set: AgentCapability[]): string[] => [...closeAgentCapabilities(set)].sort();

  check(
    AGENT_CAPABILITIES.filter((c) => c !== "view").every((c) => closed(c).includes("view")),
    "view is implied by every other capability — there is no `can deploy but cannot see`",
  );
  check(closed("edit").includes("run"), "edit implies run — you cannot meaningfully edit what you cannot execute");
  // TRANSITIVE, which is the assertion the walk exists for: a single pass over the table would
  // produce {edit, run} and drop the one capability everything implies.
  check(closed("edit").join(",") === "edit,run,view", `...and view through it (${closed("edit").join(", ")})`);

  check(!closed("secrets").includes("edit"), "secrets does not imply edit");
  check(!closed("edit").includes("secrets"), "...and edit does not imply secrets — they are genuinely different roles");
  check(!closed("admin").includes("secrets"), "admin does not imply secrets — managing access is not holding the keys");
  check(
    ["edit", "run", "deploy", "eval"].every((c) => !closed("admin").includes(c as AgentCapability)),
    "...nor anything else, so being made an administrator is not an escalation with one click",
  );

  check(closed().length === 0, "an empty set closes to an empty set");
  check(closed("nonsense" as AgentCapability).length === 0, "...and an unknown capability contributes nothing");
}

console.log("\nthe ceiling each workspace role puts on a grant");
{
  const ceiling = (role: Role): string[] => [...agentCeiling(role)].sort();

  check(ceiling("owner").length === 7, "an owner's ceiling is all seven");
  check(ceiling("admin").length === 7, "...and so is an admin's — nothing per-agent separates the two");
  check(ceiling("system").length === 7, "...and `system` holds everything here as it does above");
  check(
    ceiling("member").join(",") === "edit,eval,run,view",
    `a member's ceiling is the product and nothing that commits the workspace (${ceiling("member").join(", ")})`,
  );
  check(
    !ceiling("member").includes("deploy") && !ceiling("member").includes("secrets") && !ceiling("member").includes("admin"),
    "...so no grant can give a member deploy, secrets or admin on any agent",
  );

  // EVERY CEILING IS ALREADY CLOSED, which is what makes `agentCeiling`'s closure a floor rather
  // than a behaviour — and the day somebody adds a capability to a default set without its
  // implications, this is what says so rather than an agent that cannot be opened by the person
  // evaluating it.
  const unclosed = (["member", "admin", "owner", "system"] as Role[]).filter((role) => {
    const declared = ROLE_AGENT_CAPABILITIES[role];
    return declared.length !== agentCeiling(role).size;
  });
  check(unclosed.length === 0, `every declared default set is already closed (${unclosed.join(", ") || "all are"})`);

  // The nesting the workspace matrix has, one scope down: a member's ceiling is a subset of an
  // admin's, which is a subset of an owner's. Written as a check rather than by construction
  // because the three lists here are not built from each other — `AGENT_MEMBER` is its own list,
  // and the day it gains something the other two do not have is the day a member holds an
  // authority over an agent that an owner does not.
  check(
    ceiling("member").every((c) => ceiling("admin").includes(c)) &&
      ceiling("admin").every((c) => ceiling("owner").includes(c)),
    "the three ceilings nest, exactly as the workspace roles do",
  );
}

// §13.5 — what a refusal tells somebody to DO about it. A capability is precise and is addressed
// to whoever can read this file; a role is the thing a person can actually be granted.
console.log("\nthe role a refusal names");
{
  check(roleFor("agent:read") === "member", "a member capability names the member");
  check(roleFor("connector:manage") === "admin", "an admin capability names the admin");
  check(roleFor("workspace:manage") === "owner", "an owner capability names the owner");

  // THE WEAKEST ROLE THAT HOLDS IT, and this is the assertion the function exists for. The
  // ladder is nested, so every capability is held by more than one role above its floor — and
  // returning the WIDEST would answer "owner" for every question, which is advice that costs a
  // round trip to the one person on holiday in a workspace whose admin could have done it.
  const ladder: Role[] = ["member", "admin", "owner"];
  const overshot = CAPABILITIES.filter((cap) => {
    const named = roleFor(cap);
    if (named === null) return false;
    return ladder.slice(0, ladder.indexOf(named)).some((weaker) => can(weaker, cap));
  });
  check(
    overshot.length === 0,
    `no capability names a role stronger than the weakest one holding it (overshot: ${overshot.join(", ") || "none"})`,
  );

  // DERIVED FROM `ROLE_CAPABILITIES`, NEVER FROM A SECOND TABLE, which is what this asserts by
  // construction: a hand-kept map is the copy that goes stale the day a capability moves between
  // roles, and its symptom is a refusal telling somebody to ask the wrong person.
  const unreachable = CAPABILITIES.filter((c) => roleFor(c) === null);
  check(
    unreachable.length === 0,
    `every capability names a membership role that holds it (unnamed: ${unreachable.join(", ") || "none"})`,
  );

  // `system` IS NOT ON THE LADDER. It is the server acting on its own behalf and is never
  // resolvable from a membership row, so a refusal that named it would be telling somebody to ask
  // a thing that is not a person and cannot be granted.
  check(
    CAPABILITIES.every((c) => roleFor(c) !== ("system" as Role)),
    "...and never names `system`, which nobody can be promoted to",
  );
  check(roleFor("nonsense" as Capability) === null, "an unknown capability names nobody");
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

  // ...and every command has a channel to be REFUSED on. A refusal broadcast to the wrong
  // channel is indistinguishable from no answer at all: the panel that asked waits forever
  // while an unrelated one shows an error about something it never did.
  // Explicit presence, not "does not equal log". Five commands legitimately refuse on `log`
  // because their own channels carry data rather than errors — and "log because that is right"
  // must not be indistinguishable from "log because nobody decided".
  const homeless = [...commands].filter((c) => !Object.prototype.hasOwnProperty.call(COMMAND_CHANNEL, c));
  check(
    homeless.length === 0,
    `every relay command names the channel its refusal goes to (undecided: ${homeless.join(", ") || "none"})`,
  );
  const staleChannels = Object.keys(COMMAND_CHANNEL).filter((c) => !commands.has(c));
  check(staleChannels.length === 0, `no channel entry names a dropped command (${staleChannels.join(", ") || "none"})`);
  check(channelFor("no-such-command") === "log", "an unknown command falls back to `log` — visible, not silent");

  // AND NO COMMAND ON THIS SOCKET WRITES A PROVIDER KEY. Two did, classified `provider:manage`,
  // and a capability is not the gate the Secrets surface is built on: elevation rides on a request
  // header, which a WebSocket cannot carry, so anybody holding a session could store or probe a
  // model credential without ever meeting the passcode. Asserted by name rather than left to the
  // stale-entry check above, because that one would also pass if somebody re-added them together
  // with their table entries.
  for (const gone of ["setProviderKey", "testProviderKey"]) {
    check(!commands.has(gone), `${gone} is not a command this socket accepts`);
    check(capabilityFor(gone) === undefined, `...and nothing in the matrix suggests it could be`);
  }

  // AND EVERY COMMAND THE RELAY FORWARDS IS ONE THE APP ROUTES.
  //
  // The relay's job ends at "this caller may do this, send it on"; `index.ts` decides what it
  // means, and the two are joined by a name in a set on each side. Nothing checked that the sets
  // agreed, and they did not: `setOwnKeyForPlatform` was forwarded by the relay, classified in the
  // matrix above, refused correctly for a member — and then fell past every branch of the app's
  // dispatch chain into the eval handler, whose switch has no default. It returned. Silently. The
  // one thing a workspace could say about who pays for our calls did nothing at all, for as long
  // as it has existed.
  //
  // Read out of the source rather than imported, because importing `index.ts` starts a server.
  // Same technique as the audit above, applied to the other end of the same handshake.
  const app = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "..", "index.ts"), "utf8");
  const setIn = (source: string, name: string): Set<string> => {
    const found = new RegExp(`${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(source);
    return new Set([...(found?.[1] ?? "").matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]!));
  };
  const forwarded = setIn(relay, "PROVIDER_COMMANDS");
  const routed = setIn(app, "PROVIDER_COMMAND_NAMES");
  check(forwarded.size > 0 && routed.size > 0, `found both ends (${forwarded.size} forwarded, ${routed.size} routed)`);
  const dropped = [...forwarded].filter((c) => !routed.has(c));
  check(
    dropped.length === 0,
    `every provider command the relay forwards is routed by the app (dropped: ${dropped.join(", ") || "none"})`,
  );
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
