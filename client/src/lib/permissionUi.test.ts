// §14.1's `test:permission-ui` — who is offered what, and whether the client still agrees with
// the server about it.
//
// §8.2 ENDS IN BOLD: "Do NOT guess which capabilities map to which roles. Read COMMAND_CAPABILITY
// in the server source." A copy of that table now lives in `lib/capabilities.ts`, and §8.1 claims
// a copy "guarantees they match" — which is the one claim in the section that is only true if
// something makes it true. This is that something. It reads `server/src/auth/capabilities.ts` as
// TEXT, not as an import: the server module pulls in the router and the tenant types, and a client
// suite that imported it would be asserting that two things it had built agree rather than that
// two source files do.
//
// THE DIRECTION THAT MATTERS IS THE ONE NOBODY WATCHES. A capability the client grants and the
// server does not is a button that 403s — annoying, visible the first time anybody clicks it, and
// reported the same day. A capability the server grants and the client does not is a feature that
// silently is not there for the role that has it, and nobody files that: they assume the product
// does not do it. Both directions are asserted, and the second is why this is not a spot check.
//
// AND THE RENDER, which is what §14.1 actually asks for: "render the component with a member role
// and assert the affordance is NOT in the DOM. Render with admin role and assert it IS in the DOM.
// This is a structural test, not a click test." `react-dom/server` gives exactly that — no
// browser, no jsdom, no click — against the same components the desktop app runs. The assertion is
// ABSENCE, not a disabled attribute: §8 rules out disabled and rules out hidden, and a suite that
// accepted either would pass on the two shapes the section exists to forbid.
//
//   npm run test:permission-ui

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React from "react";

import {
  CAPABILITIES,
  COMMAND_CAPABILITY,
  ROLE_CAPABILITIES,
  ROUTE_CAPABILITY,
  can,
  canRun,
  type Role,
} from "./capabilities.ts";
import { markup, seed, sessionAs } from "./testRender.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { useConnectionStore } from "../store/connectionStore.ts";
import { useDeployStore } from "../store/deployStore.ts";
import { useGithubStore } from "../store/githubStore.ts";
import { useMcpStore } from "../store/mcpStore.ts";
import { useSecretsStore } from "../store/secretsStore.ts";
import { TopBar } from "../components/TopBar.tsx";
import { McpPanel } from "../components/McpPanel.tsx";
import { ConnectionsPanel } from "../components/ConnectionsPanel.tsx";
import { SecretsPanel } from "../components/SecretsPanel.tsx";
import { GitHubPanel } from "../components/GitHubPanel.tsx";
import { DeployPanel } from "../components/DeployPanel.tsx";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

// --- reading the server's own source ------------------------------------------------------------

const SERVER_SOURCE = fileURLToPath(
  new URL("../../../server/src/auth/capabilities.ts", import.meta.url),
);

/**
 * The server's file with its prose removed.
 *
 * THE COMMENTS HAVE TO GO FIRST AND THAT IS NOT TIDINESS. `capabilities.ts` is the most heavily
 * annotated file on the server and its doc blocks QUOTE capability names — "`member:read` — A
 * MEMBER'S — AND NOT `member:manage`" sits directly above the entry it is explaining. A parser
 * that pulled every quoted string out of the raw text would read those as entries and this suite
 * would assert that the client is missing capabilities that exist only in a sentence.
 */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * The bracketed body of a declaration, by depth rather than by a closing-line pattern.
 *
 * `COMMAND_CAPABILITY` is four hundred lines with blank lines and section rules through it, so
 * "read to the next `};` at column zero" is a rule about how somebody formats rather than about
 * where the object ends — and it breaks silently, by returning a PREFIX. A short prefix parses,
 * compares, and reports every command below the cut as missing from the server.
 *
 * THE SCAN STARTS AFTER THE `=`, WHICH IS NOT FUSSINESS. `const MEMBER: readonly Capability[] =`
 * puts a `[` in the TYPE, two characters before the one that opens the array — so a scan from the
 * declaration finds `[]`, closes at depth zero immediately, and returns the empty string. Which
 * then reports that the server grants a member nothing and the client invented all sixteen.
 */
function body(src: string, declaration: string): string {
  const at = src.indexOf(declaration);
  if (at < 0) throw new Error(`no \`${declaration}\` in ${SERVER_SOURCE}`);
  const assigned = src.indexOf("=", at + declaration.length);
  if (assigned < 0) throw new Error(`\`${declaration}\` is not assigned anything`);
  const open = src.slice(assigned).search(/[[{]/);
  const start = assigned + open;
  const closing = src[start] === "[" ? "]" : "}";
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        if (ch !== closing) throw new Error(`mismatched bracket in \`${declaration}\``);
        return src.slice(start + 1, i);
      }
    }
  }
  throw new Error(`unterminated \`${declaration}\``);
}

const server = withoutComments(readFileSync(SERVER_SOURCE, "utf8"));

/** Every double-quoted string in a block, in order. */
const quoted = (block: string): string[] => [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);

const serverCapabilities = quoted(body(server, "export const CAPABILITIES"));
const serverMember = quoted(body(server, "const MEMBER:"));
const serverAdmin = [...serverMember, ...quoted(body(server, "const ADMIN:"))];
const serverOwner = [...serverAdmin, ...quoted(body(server, "const OWNER:"))];
const serverRoles: Record<Role, string[]> = {
  member: serverMember,
  admin: serverAdmin,
  owner: serverOwner,
};

/** `name: "capability"` pairs. Anything else in the block is not an entry. */
const serverCommands = new Map<string, string>(
  [...body(server, "export const COMMAND_CAPABILITY").matchAll(/([A-Za-z_$][\w$]*)\s*:\s*"([^"]+)"/g)].map(
    (m) => [m[1]!, m[2]!],
  ),
);

const ROLES: Role[] = ["member", "admin", "owner"];
const missing = (a: readonly string[], b: readonly string[]): string[] => a.filter((x) => !b.includes(x));

console.log("\n§8.1 — the copy is the original");
{
  // A SANITY CHECK ON THE PARSER BEFORE ANYTHING IT PRODUCES IS TRUSTED. Every assertion below
  // reads a set this parser built, so a regex that silently matched nothing would report perfect
  // agreement between the client's table and an empty one — the failure mode of a source-reading
  // suite is that it passes.
  check(serverCapabilities.length > 20, `the server's capability list parsed (${serverCapabilities.length})`);
  check(serverCommands.size > 80, `...and its command table (${serverCommands.size} commands)`);
  check(serverMember.length > 10, `...and the member set (${serverMember.length})`);

  for (const role of ROLES) {
    const mine = ROLE_CAPABILITIES[role];
    const theirs = serverRoles[role];
    const notHere = missing(theirs, mine);
    const notThere = missing(mine, theirs);
    // BOTH DIRECTIONS, NAMED. "the sets differ" is a failure somebody has to reproduce by hand;
    // the capability that moved is the whole content of the report.
    check(notHere.length === 0, `every ${role} capability the server grants is in the client's copy${notHere.length ? ` — missing ${notHere.join(", ")}` : ""}`);
    check(notThere.length === 0, `...and the client grants a ${role} nothing extra${notThere.length ? ` — extra ${notThere.join(", ")}` : ""}`);
  }

  const capsNotHere = missing(serverCapabilities, CAPABILITIES);
  const capsNotThere = missing([...CAPABILITIES], serverCapabilities);
  check(capsNotHere.length === 0, `every capability the server declares exists here${capsNotHere.length ? ` — missing ${capsNotHere.join(", ")}` : ""}`);
  // THE OTHER HALF OF THAT IS A REAL RULE AND NOT A TAUTOLOGY: the client's `CAPABILITIES` is the
  // OWNER set, so this failing means the server declared a capability that no role holds — a
  // capability nobody has, which is a command nobody can send and almost certainly a typo.
  check(capsNotThere.length === 0, `...and no capability here is one no role holds${capsNotThere.length ? ` — ${capsNotThere.join(", ")}` : ""}`);
}

console.log("\n§8.1 — the command table is the server's");
{
  const notHere: string[] = [];
  const disagree: string[] = [];
  for (const [cmd, capability] of serverCommands) {
    if (!Object.prototype.hasOwnProperty.call(COMMAND_CAPABILITY, cmd)) notHere.push(cmd);
    else if (COMMAND_CAPABILITY[cmd] !== capability) disagree.push(`${cmd} (${COMMAND_CAPABILITY[cmd]} vs ${capability})`);
  }
  const notThere = Object.keys(COMMAND_CAPABILITY).filter((cmd) => !serverCommands.has(cmd));

  // THE ONE THAT CATCHES THE REAL DRIFT. A command added on the server with no entry here answers
  // `undefined` from `capabilityFor`, `canRun` refuses it, and the affordance is absent — for
  // EVERY role, owner included. That is a feature shipped and invisible, and the only thing that
  // ever reports it is this line.
  check(notHere.length === 0, `every command the server classifies is classified here${notHere.length ? ` — missing ${notHere.join(", ")}` : ""}`);
  check(notThere.length === 0, `...and no command here is one the relay does not have${notThere.length ? ` — ${notThere.join(", ")}` : ""}`);
  check(disagree.length === 0, `...and the two agree on which capability each needs${disagree.length ? ` — ${disagree.join(", ")}` : ""}`);
}

console.log("\n§8.2's checklist, resolved through the table");
{
  /**
   * §8.2's rows, each keyed by the thing the affordance actually does.
   *
   * `who` IS WHAT THE MATRIX ANSWERS, NOT WHAT THE CHECKLIST PRINTS, and they differ on six rows.
   * §8.2 files Deploy under `agent:write` — a MEMBER capability, so following the prose would put
   * a Deploy button in every member's title bar; and it files members, export, delete and every
   * billing row as "Owner, Admin", where the server puts `member:manage`, `workspace:manage` and
   * `billing:manage` in `OWNER` alone. The section's own last line settles it: read the source.
   * These rows are the corrections, written down, so that a later edit toward the prose fails here
   * rather than in somebody's workspace.
   */
  const rows: { surface: string; action: string; key: string; kind: "cmd" | "route"; who: Role[] }[] = [
    { surface: "Agent card", action: "Deploy / Redeploy", key: "deploy", kind: "cmd", who: ["admin", "owner"] },
    { surface: "Agent card", action: "Archive / Restore", key: "archiveAgent", kind: "cmd", who: ["member", "admin", "owner"] },
    { surface: "Agent card", action: "Rename", key: "renameAgent", kind: "cmd", who: ["member", "admin", "owner"] },
    { surface: "Agent card", action: "Fork", key: "forkAgent", kind: "cmd", who: ["member", "admin", "owner"] },
    { surface: "Composer", action: "Generate / Edit", key: "generate", kind: "cmd", who: ["member", "admin", "owner"] },
    { surface: "Composer", action: "Run", key: "run", kind: "cmd", who: ["member", "admin", "owner"] },
    { surface: "Eval panel", action: "Start eval", key: "startEval", kind: "cmd", who: ["member", "admin", "owner"] },
    { surface: "Eval panel", action: "Cancel eval", key: "cancelEval", kind: "cmd", who: ["member", "admin", "owner"] },
    { surface: "Eval panel", action: "Edit rubric", key: "saveRubric", kind: "cmd", who: ["member", "admin", "owner"] },
    { surface: "MCP panel", action: "Connect server", key: "addMcpServer", kind: "cmd", who: ["admin", "owner"] },
    { surface: "MCP panel", action: "Remove server", key: "removeMcpServer", kind: "cmd", who: ["admin", "owner"] },
    { surface: "MCP panel", action: "Grant / revoke tools", key: "setMcpToolImpact", kind: "cmd", who: ["admin", "owner"] },
    { surface: "Connections", action: "Connect OAuth", key: "connectConnector", kind: "cmd", who: ["admin", "owner"] },
    { surface: "Connections", action: "Disconnect", key: "disconnectConnector", kind: "cmd", who: ["admin", "owner"] },
    { surface: "Secrets panel", action: "Add / rotate / reveal", key: "secretWrite", kind: "route", who: ["admin", "owner"] },
    { surface: "Workspace panel", action: "Members: invite", key: "inviteMember", kind: "cmd", who: ["owner"] },
    { surface: "Workspace panel", action: "Members: remove", key: "removeMember", kind: "cmd", who: ["owner"] },
    { surface: "Workspace panel", action: "Members: role change", key: "setMemberRole", kind: "cmd", who: ["owner"] },
    { surface: "Workspace panel", action: "Export workspace", key: "workspaceExport", kind: "route", who: ["owner"] },
    { surface: "Workspace panel", action: "Delete workspace", key: "workspaceDelete", kind: "route", who: ["owner"] },
    { surface: "Usage / Billing", action: "Set spend ceiling", key: "setSpendCeiling", kind: "cmd", who: ["owner"] },
    { surface: "Usage / Billing", action: "Change plan / checkout", key: "billingCheckout", kind: "route", who: ["owner"] },
    { surface: "Usage / Billing", action: "BYOK toggle", key: "setByok", kind: "cmd", who: ["owner"] },
    { surface: "GitHub panel", action: "CI config", key: "setAgentCiConfig", kind: "cmd", who: ["admin", "owner"] },
    { surface: "GitHub panel", action: "Safety override", key: "shadowRunGithub", kind: "cmd", who: ["admin", "owner"] },
    { surface: "Thread row", action: "Delete / archive thread", key: "archiveThread", kind: "cmd", who: ["member", "admin", "owner"] },
    { surface: "Run controls", action: "Pause / Resume / Stop", key: "pauseRun", kind: "cmd", who: ["member", "admin", "owner"] },
    { surface: "Enforcement strip", action: "Appeal", key: "appealEnforcement", kind: "cmd", who: ["member", "admin", "owner"] },
    { surface: "Sidebar", action: "Members list", key: "listMembers", kind: "cmd", who: ["member", "admin", "owner"] },
    { surface: "Members panel", action: "Leave workspace", key: "leaveWorkspace", kind: "cmd", who: ["member", "admin", "owner"] },
  ];

  const allows = (role: Role, row: (typeof rows)[number]): boolean => {
    if (row.kind === "cmd") return canRun(role, row.key);
    const capability = ROUTE_CAPABILITY[row.key];
    return capability === undefined ? false : can(role, capability);
  };

  for (const row of rows) {
    // A ROW WHOSE KEY IS NOT IN EITHER TABLE WOULD PASS EVERY "NOT ALLOWED" ASSERTION, because an
    // unclassified command is refused for everybody — so a checklist entry naming a command that
    // was renamed would read as a correctly-locked-down surface. Named separately, first.
    const known = row.kind === "cmd"
      ? Object.prototype.hasOwnProperty.call(COMMAND_CAPABILITY, row.key)
      : Object.prototype.hasOwnProperty.call(ROUTE_CAPABILITY, row.key);
    if (!known) {
      check(false, `${row.surface} — ${row.action}: \`${row.key}\` is in no table`);
      continue;
    }
    const got = ROLES.filter((role) => allows(role, row));
    check(
      got.join(",") === row.who.join(","),
      `${row.surface} — ${row.action}: ${row.who.join(", ")}${got.join(",") === row.who.join(",") ? "" : ` — got ${got.join(", ") || "nobody"}`}`,
    );
  }
}

console.log("\nwhat a role that is not one gets");
{
  // BEFORE THE SESSION LANDS AND AFTER A SIGN-OUT, `role()` is null. Answering `true` here would
  // flash every privileged control on screen for the frame before hydration — on every launch, for
  // everybody — which is the one way an absent-affordance rule fails without anybody's role being
  // wrong.
  check(!can(null, "agent:read"), "a null role holds nothing, not everything");
  check(!canRun(undefined, "run"), "...and neither does an absent one");
  // A SERVER THAT GREW A FOURTH ROLE must not have it silently granted everything here. The
  // relay resolves only owner/admin/member today; this is the floor for the day it does not.
  check(!can("auditor", "agent:read"), "a role this client does not know holds nothing");
  check(!canRun("owner", "noSuchCommand"), "an unclassified command is refused even for an owner");
}

// --- and what the components actually draw ------------------------------------------------------

const CONNECTOR = {
  connectorId: "gmail",
  label: "Gmail",
  provider: "google",
  auth: "oauth",
  fields: [],
  status: "disconnected",
  scopes: [],
  consent: ["Read your mail"],
  account: null,
  connectedAt: null,
  lastError: null,
  available: true,
};

/**
 * Every store a guarded panel reads, filled enough that the panel gets past its own loading gate.
 *
 * `seed` RATHER THAN `setState`, WHICH IS THE WHOLE REASON `testRender` EXISTS. A server render
 * reads `getInitialState()`, so a store written only through `setState` renders as if it were
 * empty — and a panel that renders its loading branch has no affordance in it for EITHER role,
 * which passes the absence half of every assertion below while proving nothing. That is why each
 * surface here asserts presence as well.
 */
function fillStores(): void {
  seed(useBuildStore, { agents: [{ agent_id: "a1", name: "agent_one" }], activeAgentId: "a1" });
  seed(useConnectionStore, { connections: [CONNECTOR], loaded: true, connecting: {}, error: null, notice: null });
  seed(useDeployStore, { deployments: [], railwayConfigured: true, loaded: true, plan: null, planning: false, serveToken: null, error: null, notice: null });
  seed(useGithubStore, { loaded: true, connected: true, views: {}, links: [], error: null, notice: null });
  seed(useMcpStore, { servers: [], discovering: {}, addingEndpoint: null, error: null, notice: null });
  seed(useSecretsStore, { elevated: true, gateLoaded: true, gate: "mutations", loaded: true, secrets: [], error: null, notice: null, pending: null });
}

/** One surface's markup at one role. */
function render(component: React.FC, role: string): string {
  fillStores();
  seed(useSessionStore, sessionAs(role));
  return markup(React.createElement(component));
}

console.log("\n§14.1's structural test — absent for a member, present for an admin");
{
  const surfaces: { name: string; component: React.FC; marker: string; admin: boolean }[] = [
    // The title bar's Deploy button — the row §8.2 files under `agent:write`. If that were
    // followed, this affordance would be in the member render, on every screen in the product.
    { name: "TopBar — Deploy", component: TopBar, marker: ">Deploy<", admin: true },
    { name: "MCP panel — Connect a server", component: McpPanel, marker: "Connect a server", admin: true },
    { name: "Connections — Connect Gmail", component: ConnectionsPanel, marker: "Connect Gmail", admin: true },
    { name: "Secrets panel — Import", component: SecretsPanel, marker: ">Import<", admin: true },
    { name: "GitHub panel — Link repository", component: GitHubPanel, marker: "Link repository", admin: true },
    { name: "Deploy panel — Deploy", component: DeployPanel, marker: ">Deploy<", admin: true },
  ];

  for (const s of surfaces) {
    const member = render(s.component, "member");
    const admin = render(s.component, "admin");
    const owner = render(s.component, "owner");
    check(!member.includes(s.marker), `${s.name}: absent for a member`);
    check(admin.includes(s.marker) === s.admin, `...${s.admin ? "present" : "absent"} for an admin`);
    check(owner.includes(s.marker), "...and present for an owner");
    // ABSENT, NOT DISABLED. §8 rules out both `disabled` and display:none, and the difference is
    // invisible in a length comparison — a member render that merely greyed the control would be
    // very nearly the same markup. So the member render is checked for the pattern that would
    // mean somebody reached for `disabled` instead of removing the control.
    check(
      !/disabled=""[^>]*>\s*Deploy|aria-disabled="true"/.test(member),
      "...and the member render disables nothing in its place",
    );
  }
}

console.log("\n§8.2 — no surface decides a role for itself");
{
  /**
   * Guards that spell a role literal instead of asking the matrix, and the two that may.
   *
   * WHY THIS IS A RULE AND NOT A STYLE. Six surfaces read `role === "owner"` — billing, the spend
   * ceiling, the checkout, members, the audit log, export and delete — and every one of them was
   * RIGHT, because `billing:manage`, `member:manage` and `workspace:manage` are all the owner's
   * today. That is exactly what makes it worth a suite: nothing was broken, nothing would have
   * been reported, and the day one of those capabilities moves to admin, six surfaces go on
   * quietly meaning the old thing while the matrix, the relay and the server all mean the new one.
   * Two of them even named the capability in a comment directly above the comparison.
   *
   * THE EXCEPTIONS ARE RULES ABOUT OWNERSHIP RATHER THAN CAPABILITIES, which is why they are
   * listed here by their exact source line rather than by file — a second hardcode added to
   * `WorkspacePanel` tomorrow is not covered by yesterday's reason.
   */
  const ALLOWED = new Map<string, string>([
    [
      'const canRename = role === "owner" || role === "admin";',
      "§10.2's rename mirrors `/v1/workspaces/rename`, which checks the two roles directly rather " +
        "than through the matrix — `ROUTE_CAPABILITY.workspaceRename` names `workspace:manage`, the " +
        "owner's, and using it would hide the field from admins the route would have accepted",
    ],
    [
      'if (!workspace || role === "owner") return null;',
      "§6.5 — an owner may not leave. That is a fact about ownership, not a capability: " +
        "`leaveWorkspace` is `member:read`, which every role holds, and the one who cannot use it " +
        "is the one who holds the most",
    ],
  ]);

  // `workspace?.role` as well as a bare `role`, because both name the VIEWER's membership.
  // `member.role` deliberately does not match: a row's own role is what the list renders, not a
  // decision about who may do what.
  const GUARD = new RegExp(
    '(?:^|[^A-Za-z0-9_.])role\\s*(?:===|!==)\\s*"(?:owner|admin|member)"' +
      '|workspace\\??\\.role\\s*(?:===|!==)\\s*"(?:owner|admin|member)"',
  );

  const dir = fileURLToPath(new URL("../components/", import.meta.url));
  const offenders: string[] = [];
  let scanned = 0;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".tsx") || file.includes(".test.")) continue;
    scanned++;
    // COMMENTS FIRST, for the reason the server parser strips them: the fixes for this rule
    // explain themselves by quoting the comparison they replaced, and a scan of the raw text
    // would report every one of those explanations as the thing it is explaining.
    for (const line of withoutComments(readFileSync(dir + file, "utf8")).split(/\r?\n/)) {
      const text = line.trim();
      if (!GUARD.test(text)) continue;
      if (ALLOWED.has(text)) continue;
      offenders.push(`${file}: ${text}`);
    }
  }
  check(scanned > 10, `every component was read (${scanned} files)`);
  check(
    offenders.length === 0,
    `no component decides a membership role for itself${offenders.length ? ` — ${offenders.join(" | ")}` : ""}`,
  );
  // AND THE EXCEPTIONS ARE STILL THERE. An allow-list nothing matches is one somebody can delete
  // along with the reason it records, and the reasons are the load-bearing half of this block.
  const present = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".tsx") || file.includes(".test.")) continue;
    for (const line of withoutComments(readFileSync(dir + file, "utf8")).split(/\r?\n/)) {
      if (ALLOWED.has(line.trim())) present.add(line.trim());
    }
  }
  for (const [line] of ALLOWED) {
    check(present.has(line), `the allow-list still describes real code: ${line.slice(0, 52)}…`);
  }
}

console.log("\n§8.2's members surface is the owner's alone");
{
  // THE ROW THE PROSE GETS WRONG IN THE DIRECTION THAT COSTS SOMETHING. Every other correction in
  // this suite narrows an affordance; this one is the reason narrowing is right. `member:manage`
  // is the owner's, and an admin who could invite and remove could add an account and hand it a
  // role — which is the "a member can do something they shouldn't" half of §8.2's own warning.
  check(!canRun("admin", "inviteMember"), "an admin cannot invite");
  check(!canRun("admin", "removeMember"), "...nor remove");
  check(!canRun("admin", "setMemberRole"), "...nor change a role");
  check(canRun("admin", "listMembers"), "...but does see the list, like every member");
  check(canRun("owner", "inviteMember"), "and an owner can invite");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
