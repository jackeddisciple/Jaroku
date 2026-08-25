// The capability matrix, and the assertion that keeps it honest.
//
// Most of this file is ordinary: a member cannot do an admin's job, an admin cannot do an
// owner's. The one that earns its keep is the LAST section, which reads wsRelay.ts and checks
// that every command the relay accepts has an entry here. Without it, a command added in a
// later session arrives ungated and nothing says so — which is precisely how a role check
// scattered across handlers grows its hole.
//
//   npm run test:capabilities

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  AGENT_CAPABILITIES,
  CAPABILITIES,
  COMMAND_AGENT_CAPABILITY,
  COMMAND_CAPABILITY,
  ROLE_AGENT_CAPABILITIES,
  ROLE_CAPABILITIES,
  agentCapabilityFor,
  agentCeiling,
  holds,
  resolveCapabilities,
  can,
  capabilityFor,
  closeAgentCapabilities,
  isAgentCapability,
  roleFor,
  requireCapability,
  withArticle,
  type AgentCapability,
  type GrantSource,
  type ResolvedAccess,
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

// The resolver, against a table of grants rather than against a database. Its behaviour under a
// real socket, a real revocation and a real cross-workspace id is `test:access-resolver`'s
// subject; what is asserted here is the arithmetic — the five steps, in order, and the two of them
// that a reasonable person would argue are redundant.
console.log("\nresolveCapabilities");
{
  const AGENT = "00000000-0000-4000-8000-0000000000a1";
  const USER = "u1";
  const HOUR = 3600_000;
  const AT = Date.parse("2026-01-01T12:00:00.000Z");

  /** A GrantSource over one in-memory row. Nothing here reaches a database. */
  const source = (row?: { capabilities: AgentCapability[]; expires_at?: string | null }): GrantSource => ({
    find: async () => (row ? { capabilities: row.capabilities, expires_at: row.expires_at ?? null } : undefined),
  });
  const resolve = async (
    role: Role,
    row?: { capabilities: AgentCapability[]; expires_at?: string | null },
    actorUserId: string | null = USER,
  ): Promise<ResolvedAccess> =>
    resolveCapabilities({ ...ctx(role), actorUserId }, AGENT, source(row), () => AT);
  const setOf = (r: ResolvedAccess): string[] => [...r.capabilities].sort();

  {
    const r = await resolve("member");
    check(setOf(r).join(",") === "edit,eval,run,view", `with no grant, the role's default set (${setOf(r).join(", ")})`);
    check(r.provenance.kind === "role", "...and the provenance says so, which is what the panel's line is drawn from");
  }

  {
    // A grant that NARROWS. This is the shape the whole feature exists for and the one a
    // role-only system cannot express at all.
    const r = await resolve("member", { capabilities: ["view"] });
    check(setOf(r).join(",") === "view", `a grant can narrow below the role's default (${setOf(r).join(", ")})`);
  }

  {
    // A grant that WIDENS, within the ceiling. An admin's ceiling is all seven, so `deploy` sticks.
    const r = await resolve("admin", { capabilities: ["view", "deploy"] });
    check(setOf(r).join(",") === "deploy,view", `...and widen within the ceiling (${setOf(r).join(", ")})`);
  }

  {
    // INVARIANT B, AND THE ASSERTION THE STEP EXISTS FOR. `grantAccess` refuses this set at write
    // time, so the only way this row exists is a role that changed afterwards or somebody writing
    // to the database — which is exactly the case write-time validation cannot cover.
    const r = await resolve("member", { capabilities: ["view", "run", "deploy", "secrets", "admin"] });
    check(
      setOf(r).join(",") === "run,view",
      `a stored set above the role's ceiling is intersected DOWN at read time (${setOf(r).join(", ")})`,
    );
    check(
      r.provenance.kind === "grant" && [...r.provenance.capped].sort().join(",") === "admin,deploy,secrets",
      "...and what the role took back off it is named, so the row can say `capped by role`",
    );
  }

  {
    // A DOWNGRADE BITES WITH NO CHANGE TO THE ROW, which is the same claim from the other side:
    // one grant, two roles, two answers.
    const grant = { capabilities: ["view", "run", "deploy"] as AgentCapability[] };
    const asAdmin = setOf(await resolve("admin", grant));
    const asMember = setOf(await resolve("member", grant));
    check(asAdmin.includes("deploy"), "an admin holding a deploy grant has deploy");
    check(!asMember.includes("deploy"), "...and the same row, read for a member, does not");
    check(asMember.join(",") === "run,view", `...but keeps everything under the ceiling (${asMember.join(", ")})`);
  }

  {
    // IMPLICATION CLOSES AFTER THE INTERSECTION. A grant of `edit` alone must resolve to three
    // capabilities, or the person can edit an agent they cannot open.
    const r = await resolve("member", { capabilities: ["edit"] });
    check(setOf(r).join(",") === "edit,run,view", `a grant closes under implication (${setOf(r).join(", ")})`);
  }

  {
    const expired = { capabilities: ["view", "eval"] as AgentCapability[], expires_at: new Date(AT - HOUR).toISOString() };
    const r = await resolve("member", expired);
    check(r.provenance.kind === "expired", "an expired grant is recognised at resolution, not by a job that may not have run");
    // AND FALLS BACK TO THE ROLE RATHER THAN TO NOTHING — see the resolver's own note. A
    // time-boxed widening that expired into a lockout would be a different feature.
    check(setOf(r).join(",") === "edit,eval,run,view", `...and the role's default set is what remains (${setOf(r).join(", ")})`);

    const live = { ...expired, expires_at: new Date(AT + HOUR).toISOString() };
    check(setOf(await resolve("member", live)).join(",") === "eval,view", "...while one an hour from expiry still applies");
  }

  {
    // NOT A MEMBER IS THE EMPTY SET, and it is what makes "absent, not forbidden" enforceable in
    // one place. `system` is not a membership role and cannot arrive from a client, so the only
    // role a socket can carry that is not in the ceiling table is one that does not exist.
    const r = await resolveCapabilities(
      { ...ctx("nobody" as Role), actorUserId: USER },
      AGENT,
      source({ capabilities: ["view", "admin"] }),
      () => AT,
    );
    check(r.capabilities.size === 0, "a role no membership row can carry resolves to nothing");
    check(r.provenance.kind === "none", "...and says `none`, which is what a 404 rather than a 403 is written from");
  }

  {
    // A REQUEST NOBODY TRIGGERED holds no personal grant, because a grant is made TO somebody.
    const r = await resolve("system", { capabilities: ["view"] }, null);
    check(r.capabilities.size === 7, "a request with no actor resolves to its role, which for `system` is everything");
  }

  check(holds(await resolve("member"), "run"), "`holds` answers the one question a handler asks");
  check(!holds(await resolve("member"), "deploy"), "...and answers it negatively where the ceiling does");
}

// EXACTLY ONE RESOLVER — invariant A, as a grep over the server's own source.
//
// THE CHECK IS THE FEATURE. Everything else in this file asserts that the resolver is right; this
// asserts that it is the ONLY one, which is the property that decays. A second `canUserDoX` added
// next year would pass every test above — they test this function — and the codebase would have
// two answers to one question, of which the one that drifts open is the one nobody reports.
console.log("\nthere is one resolver");
{
  const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) files.push(p);
    }
  };
  walk(SRC);
  check(files.length > 100, `read the server's source (${files.length} files)`);

  // The shape a second one would take: a function whose name claims to answer a permission
  // question. `canUserDoX`, `mayAccess`, `hasAgentPermission` — the family, not one spelling.
  const SECOND_RESOLVER =
    /\b(?:function|const|async)\s+(can[A-Z]\w*|may[A-Z]\w*|has[A-Z]\w*(?:Permission|Access|Capability)\w*)\b/g;

  /**
   * Functions this shape catches that are not permission checks, each with the question it
   * actually answers.
   *
   * A NAMED LIST RATHER THAN A NARROWER REGEX, deliberately. Every tightening of the pattern that
   * excluded these would also stop matching some spelling of the thing the rule is for — and a
   * structural check that has quietly narrowed itself into matching nothing passes forever. Four
   * exemptions somebody has to argue past is a smaller hole than a pattern nobody can see the
   * edges of. Each is keyed on file AND name, so an exemption covers one function rather than a
   * word anybody may reuse.
   *
   * All four answer v0.4.0's OTHER gate, or somebody else's: "who may" is this file, "what does
   * this workspace have left" is `requireEntitlement`, "whose money pays" is the key pool, and
   * "what does GitHub say about this token" is another system's ACL entirely.
   */
  const NOT_A_PERMISSION_CHECK: Record<string, string> = {
    "gate.ts:mayStartWork":
      "the spend ceiling and the balance — whether the WORKSPACE can afford this, which is refused by paying rather than by asking an admin",
    "gate.ts:mayStart":
      "the same question per run kind. It never reads a role, and a person with every capability is refused by it when the money is gone",
    "platformKey.ts:mayUsePlatformKey":
      "whether the PLATFORM's own key pool will pay for this call. Our money, decided by plan and kill switch, not the caller's authority",
    "githubApi.ts:hasWriteAccess":
      "what GitHub says about the token's access to a repository. A third party's ACL, reported, not a decision this product makes",
  };

  const found: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    SECOND_RESOLVER.lastIndex = 0;
    for (const m of text.matchAll(SECOND_RESOLVER)) {
      const name = m[1]!;
      // `can` itself is the workspace-level matrix read, in this file, and it is the resolver's
      // own step 2. Named rather than pattern-excluded, so the exemption is one function and not
      // a shape somebody else's name could accidentally fit.
      if (name === "can") continue;
      const key = `${file.split(/[\\/]/).pop()}:${name}`;
      seen.add(key);
      if (key in NOT_A_PERMISSION_CHECK) continue;
      found.push(key);
    }
  }
  check(
    found.length === 0,
    `no second permission checker exists in the server${found.length ? ` — found ${found.join(", ")}` : ""}`,
  );
  check(
    Object.values(NOT_A_PERMISSION_CHECK).every((reason) => reason.length > 20),
    "...and every exemption says which question it answers instead",
  );
  // An exemption for a function that no longer exists is a hole with a comment on it, exactly as
  // the method allowlist in test:db-boundary says of its own.
  const stale = Object.keys(NOT_A_PERMISSION_CHECK).filter((k) => !seen.has(k));
  check(stale.length === 0, `...and still names real code (${stale.join(", ") || "all four do"})`);

  // ...and the rule can still fail, for the reason every structural check in this repository
  // carries one: a regex that has quietly stopped matching reports that there is one resolver,
  // forever, and the sentence is true only because it can no longer see any.
  SECOND_RESOLVER.lastIndex = 0;
  check(
    SECOND_RESOLVER.test("export function canUserDeployAgent(user, agent) { return true; }"),
    "...and the rule still recognises one when it sees it",
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

  // AND EVERY COMMAND WHOSE MESSAGE NAMES AN AGENT HAS AN AGENT-LEVEL CAPABILITY.
  //
  // THE SAME AUDIT AS THE ONE ABOVE, ONE SCOPE DOWN, and it exists for the same failure: a command
  // added next year carrying an `agentId` would otherwise be gated at the workspace scope alone,
  // forever, with nothing anywhere saying so. The relay refuses one it cannot classify — loudly,
  // which is the right behaviour and a terrible thing to discover in production — so this is what
  // turns that into a build failure instead.
  //
  // WHICH COMMANDS THOSE ARE IS READ OUT OF THE RELAY'S OWN TYPES rather than listed here, by the
  // same argument the command surface above is read rather than remembered: a list maintained by
  // remembering is a list that is already wrong.
  {
    const named = new Set<string>();
    for (const m of relay.matchAll(/cmd:\s*"(\w+)"/g)) {
      // The enclosing object literal, found by walking back to its `{` and forward to the match.
      let open = m.index!;
      while (open > 0 && relay[open] !== "{") open--;
      let depth = 0;
      let close = relay.length;
      for (let i = open; i < relay.length; i++) {
        if (relay[i] === "{") depth++;
        else if (relay[i] === "}" && --depth === 0) { close = i; break; }
      }
      if (/\bagentId\??\s*:/.test(relay.slice(open, close))) named.add(m[1]!);
    }
    check(named.size > 30, `found the commands that name an agent (${named.size})`);
    check(named.has("run") && named.has("deploy") && named.has("pushGithub"), "...including the three worth being sure about");

    const ungated = [...named].filter((c) => agentCapabilityFor(c) === undefined);
    check(
      ungated.length === 0,
      `every command naming an agent has an agent-level capability (ungated: ${ungated.join(", ") || "none"})`,
    );

    // And the other direction. An entry for a command that carries no agent id can never fire —
    // the relay reads the id off the message — so it is a rule that reads as coverage and is not.
    const unreachable = Object.keys(COMMAND_AGENT_CAPABILITY).filter((c) => !named.has(c));
    check(
      unreachable.length === 0,
      `no agent-level entry names a command with no agent id (${unreachable.join(", ") || "none does"})`,
    );

    // AND THE COMMANDS THAT REFERENCE AN AGENT INDIRECTLY ARE STILL OUTSIDE THIS, WHICH IS THE
    // LIMITATION WRITTEN DOWN. `pauseRun` carries a run id and `applyEdit` a proposal id; both
    // belong to an agent and neither says which, so the per-agent narrowing does not reach them.
    // Asserted rather than left implicit, so that the day one of them starts carrying an agent id
    // this fails and somebody classifies it instead of it silently staying at the coarse gate.
    for (const indirect of ["pauseRun", "applyEdit", "cancelDeploy", "addExample"]) {
      check(
        agentCapabilityFor(indirect) === undefined,
        `${indirect} is gated at the workspace scope alone — it names no agent`,
      );
    }
    check(agentCapabilityFor("__proto__") === undefined, "and __proto__ is not an entry here either");
  }

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
