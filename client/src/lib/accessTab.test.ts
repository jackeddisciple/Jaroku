// §19.1's `test:access-tab` — what the Access panel says, and what it refuses to say.
//
// EVERY ASSERTION HERE IS ABOUT A SENTENCE OR AN ABSENCE, which is what makes it worth running.
// The enforcement lives on the server and `test:access-resolver` holds it; nothing this suite
// checks could stop anybody doing anything. What it checks is whether the panel tells the truth
// about what is already true — and every failure it catches is silent: a provenance line that says
// "granted here" about access nobody granted, a capped capability rendered as though it worked, a
// mutation control offered to somebody who cannot use it, an IP address in a payload.
//
// TWO HALVES. The pure rules — ordering, search, provenance, the guards — are exercised directly,
// because they are functions and a function is the honest unit for a rule. The RENDER half uses
// `react-dom/server` against the real components, and asserts ABSENCE rather than a disabled
// attribute: §8 rules out both `disabled` and `hidden` for an affordance a role cannot use, and a
// suite that accepted either would pass on the two shapes the section exists to forbid.
//
//   npm run test:access-tab

import React from "react";

import {
  accessBadge, cappedLine, chipKindFor, chipsFor, historyToCsv, matchesAccess, orderAccess,
  provenanceLine, revokeBlockedReason,
} from "./accessList.ts";
import { AGENT_CAPABILITIES, closeAgentCapabilities } from "./capabilities.ts";
import { markup, seed, sessionAs } from "./testRender.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { useAccessStore, type AccessPerson, type AgentAccess } from "../store/accessStore.ts";
import { AccessPeople } from "../components/AccessPeople.tsx";
import { GrantDialog } from "../components/GrantDialog.tsx";
import { AccessExposure } from "../components/AccessExposure.tsx";
import { AccessSessions } from "../components/AccessSessions.tsx";
import { AccessInvites } from "../components/AccessInvites.tsx";
import { AccessHistory } from "../components/AccessHistory.tsx";
import { InviteWithGrantDialog } from "../components/InviteWithGrantDialog.tsx";
import { AgentTabs } from "../components/AgentTabs.tsx";
import type { AgentCapability } from "./capabilities.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const AGENT = "11111111-1111-4111-8111-111111111111";

/** A row, with everything defaulted to the commonest case: a member on their workspace role. */
function person(over: Partial<AccessPerson> & { user_id: string }): AccessPerson {
  return {
    email: `${over.user_id}@example.test`,
    display_name: null,
    role: "member",
    capabilities: ["view", "run", "edit", "eval"],
    fromRole: ["view", "run", "edit", "eval"],
    granted: [],
    capped: [],
    provenance: "role",
    granted_by: null,
    granted_by_name: null,
    granted_at: null,
    expires_at: null,
    note: null,
    live: false,
    ...over,
  };
}

/** A fixed relative-time function, so no assertion here depends on the clock. */
const rel = (): string => "3 days ago";

// ---------------------------------------------------------------------------------------------
// §10.2 — every row states its provenance.
// ---------------------------------------------------------------------------------------------

console.log("\nevery person row says WHY they have what they have");
{
  const fromRole = person({ user_id: "a" });
  check(
    provenanceLine(fromRole, rel) === "from workspace role",
    `access with no grant says where it came from ("${provenanceLine(fromRole, rel)}")`,
  );

  const granted = person({
    user_id: "b",
    provenance: "grant",
    granted: ["view", "deploy"],
    capabilities: ["view", "deploy"],
    fromRole: ["view", "run", "edit", "eval"],
    granted_by_name: "Priya",
    granted_at: "2026-01-01T00:00:00.000Z",
    role: "admin",
  });
  const line = provenanceLine(granted, rel);
  check(line.includes("granted here"), `a grant says it was granted here ("${line}")`);
  // WHO, NOT JUST THAT. §10.2 asks for "granted here by [name]", and the name is the half that
  // makes the line actionable: an admin who does not recognise a grant needs somebody to ask.
  check(line.includes("Priya"), "...and by whom, which is who to ask about it");
  check(line.includes("3 days ago"), "...and when");

  const timed = person({ ...granted, user_id: "c", expires_at: "2026-06-01T00:00:00.000Z" });
  check(provenanceLine(timed, rel).includes("expires"), "a time-boxed grant says when it stops by itself");

  // AN EXPIRED GRANT READS AS THE ROLE CASE PLUS A REASON, because that is what it now is: the
  // person fell back to their workspace role. A line still saying "granted here" would describe a
  // row whose capabilities no longer come from the grant.
  const expired = person({ ...granted, user_id: "d", provenance: "expired", expires_at: "2026-01-02T00:00:00.000Z" });
  const expiredLine = provenanceLine(expired, rel);
  check(expiredLine.includes("expired"), `an expired grant says so ("${expiredLine}")`);
  check(expiredLine.includes("workspace role"), "...and that the workspace role is what is left");

  // §16 — SOMEBODY WHO HAS LEFT. Their grant persists and resolves to empty, and the row says the
  // thing an admin needs to decide about rather than simply vanishing.
  const gone = person({ user_id: "e", role: null, capabilities: [], fromRole: [] });
  check(
    provenanceLine(gone, rel) === "no longer in this workspace",
    "a grant belonging to somebody who has left says so",
  );
}

console.log("\na role that caps a grant is named, not hidden");
{
  const capped = person({
    user_id: "f",
    role: "member",
    provenance: "grant",
    granted: ["view", "run", "deploy", "admin"],
    capabilities: ["view", "run"],
    fromRole: ["view", "run", "edit", "eval"],
    capped: ["deploy", "admin"],
  });
  const line = cappedLine(capped);
  check(line.includes("member role"), `the row names the role doing the capping ("${line}")`);
  // NAMED, NOT COUNTED. "2 capabilities capped" is a number somebody has to investigate; the list
  // is the answer, and it also says which role change would lift it.
  check(line.includes("view, run"), "...and what they are actually left with");

  // AND THE CAPPED CAPABILITIES ARE STILL DRAWN. A row showing only what somebody CAN do would be
  // silent about the most confusing state in the panel — a grant that says deploy on a person who
  // cannot deploy — and an admin reading it would conclude the grant is working.
  const chips = chipsFor(capped, AGENT_CAPABILITIES);
  const kinds = Object.fromEntries(chips.map((c) => [c.capability, c.kind]));
  check(kinds["deploy"] === "capped", "a capability the role took away is drawn as capped, not dropped");
  check(kinds["view"] === "role", "one that comes with the role is drawn neutrally");

  const widened = person({
    user_id: "g",
    role: "admin",
    provenance: "grant",
    granted: ["view", "deploy"],
    capabilities: ["view", "deploy"],
    fromRole: ["view", "run", "edit", "eval", "deploy", "secrets", "admin"],
  });
  // GRANTED-HERE IS ONLY WHAT THE ROLE WOULD NOT HAVE GIVEN. Marking a capability `+` when
  // revoking the grant would not remove it tells an admin that a revocation does something it does
  // not — which is exactly the wrong-remedy failure the provenance line exists to prevent.
  check(chipKindFor(widened, "deploy") === "role", "a granted capability the role already had is not marked +");

  const narrow = person({
    user_id: "h",
    role: "member",
    provenance: "grant",
    granted: ["view"],
    capabilities: ["view"],
    fromRole: ["view", "run", "edit", "eval"],
  });
  check(chipsFor(narrow, AGENT_CAPABILITIES).length === 1, "a narrowing grant draws only what is left");
}

// ---------------------------------------------------------------------------------------------
// §10.3 — order and search.
// ---------------------------------------------------------------------------------------------

console.log("\nthe list is ordered by what people can actually do here");
{
  const wide = person({ user_id: "wide", display_name: "Zoe", role: "member" });
  const narrow = person({ user_id: "narrow", display_name: "Adam", role: "owner", capabilities: ["view"], fromRole: ["view"] });
  const order = orderAccess([narrow, wide]).map((p) => p.display_name);
  // BREADTH BEFORE ROLE, which is where this list deliberately disagrees with the Members panel:
  // an owner narrowed to `view` on this agent can do less about it than a member who cannot,
  // and a list sorted by rank would be ordered by a fact that is true somewhere else.
  check(order[0] === "Zoe", `capability breadth wins over workspace role (${order.join(", ")})`);

  const a = person({ user_id: "a", display_name: "adam", role: "admin" });
  const z = person({ user_id: "z", display_name: "Zara", role: "admin" });
  // `localeCompare`, not byte order: plain `<` puts every capitalised name above every lowercase
  // one, which is the ordering bug that only shows up once somebody's name is not capitalised.
  check(
    orderAccess([z, a]).map((p) => p.display_name).join(",") === "adam,Zara",
    "...then name, case-insensitively",
  );

  const nameless = person({ user_id: "n", display_name: null, email: "brian@example.test", role: "admin" });
  const named = person({ user_id: "m", display_name: "Alice", role: "admin" });
  // SORTED BY WHAT THE ROW SHOWS. A nameless person renders their address, so sorting them by
  // `display_name ?? ""` would put them at the top under a blank key — an ordering that reads as a
  // rendering bug.
  check(
    orderAccess([nameless, named]).map((p) => p.display_name ?? p.email).join(",") === "Alice,brian@example.test",
    "...from the string the row actually renders",
  );
}

console.log("\none search field answers both questions");
{
  const sam = person({ user_id: "s", display_name: "Sam", capabilities: ["view"] });
  const deployer = person({ user_id: "d", display_name: "Rohan", capabilities: ["view", "deploy"] });
  check(matchesAccess(sam, "sam"), "a name matches");
  check(!matchesAccess(deployer, "sam"), "...and only that person");
  check(matchesAccess(deployer, "deploy"), "a capability matches everybody who holds it");
  check(!matchesAccess(sam, "deploy"), "...and nobody who does not");
  check(matchesAccess(sam, ""), "an empty query matches everybody");

  // THE EFFECTIVE SET, NOT THE GRANTED ONE. Somebody whose grant says deploy and whose role capped
  // it away cannot deploy, and a search for deploy that surfaced them would be answering with the
  // row's history rather than with its state.
  const cappedDeployer = person({
    user_id: "c", display_name: "Kim", provenance: "grant",
    granted: ["view", "deploy"], capabilities: ["view"], capped: ["deploy"],
  });
  check(!matchesAccess(cappedDeployer, "deploy"), "a capped capability does not match — they cannot do it");
}

// ---------------------------------------------------------------------------------------------
// §11.4 — the last administrator.
// ---------------------------------------------------------------------------------------------

console.log("\nthe last admin cannot be revoked, and the control says why");
{
  const onlyAdmin = person({ user_id: "a", role: "member", provenance: "grant", capabilities: ["view", "admin"], granted: ["view", "admin"] });
  const other = person({ user_id: "b", capabilities: ["view", "run"] });
  const reason = revokeBlockedReason(onlyAdmin, [onlyAdmin, other]);
  check(reason !== null, "the only administrator's grant cannot be revoked");
  // A REASON, NOT A REFUSAL. §11.4: "the control disables with a reason". A control that simply
  // does nothing teaches somebody to click it twice.
  check(Boolean(reason && reason.length > 30), `...and the control carries the reason ("${(reason ?? "").slice(0, 40)}…")`);
  check(reason?.includes("grant admin to somebody else") === true, "...which names the way out");

  const secondAdmin = person({ user_id: "c", role: "admin", capabilities: ["view", "admin"] });
  check(
    revokeBlockedReason(onlyAdmin, [onlyAdmin, other, secondAdmin]) === null,
    "with a second administrator it is allowed again",
  );
  // THE COUNT IS OVER EFFECTIVE ACCESS, not over grant rows — most people who administer an agent
  // do so through their workspace role and have no grant at all. A guard counting rows would refuse
  // a revocation in a workspace full of admins.
  check(secondAdmin.provenance === "role", "...and that second administrator holds it through their role, with no grant row");

  check(revokeBlockedReason(other, [onlyAdmin, other]) === null, "a non-admin's grant is revocable");
}

// ---------------------------------------------------------------------------------------------
// The render. Structural, and the assertion is ABSENCE.
// ---------------------------------------------------------------------------------------------

const ACCESS: AgentAccess = {
  agentId: AGENT,
  agentSlug: "billing_bot",
  people: [
    person({ user_id: "owner", display_name: "Priya", role: "owner", capabilities: [...AGENT_CAPABILITIES], fromRole: [...AGENT_CAPABILITIES] }),
    person({
      user_id: "sam", display_name: "Sam", role: "member", provenance: "grant",
      granted: ["view"], capabilities: ["view"], granted_by_name: "Priya",
      granted_at: "2026-01-01T00:00:00.000Z", live: true,
    }),
  ],
  orphans: [],
  viewer: ["view"] as AgentCapability[],
  invites: [],
};

console.log("\na non-admin sees the whole panel and none of the verbs");
{
  seed(useAccessStore, { byAgent: { [AGENT]: ACCESS }, bySlug: { billing_bot: AGENT } });

  seed(useSessionStore, sessionAs("member"));
  const asMember = markup(
    React.createElement(AccessPeople, {
      access: ACCESS,
      canAdmin: false,
      onGrant: () => undefined,
      onEdit: () => undefined,
      onRevoke: () => undefined,
    }),
  );
  // THE PANEL IS THERE. §9.2 is explicit that a non-admin gets a full read-only render rather than
  // a locked tab — "who can deploy this" is a question a member should be able to answer without
  // asking an admin.
  check(asMember.includes("Priya"), "a member sees the people");
  check(asMember.includes("granted here"), "...and their provenance");
  // AND THE CONTROLS ARE ABSENT, not disabled and not hidden. Both of the shapes §8 rules out
  // would pass a test that looked only for a `disabled` attribute.
  check(!asMember.includes("Grant</button>"), "...and no Grant button");
  check(!asMember.includes("Revoke</button>"), "...and no Revoke");
  check(!asMember.includes("Edit</button>"), "...and no Edit");
  check(!/disabled/.test(asMember), "...and nothing merely disabled, which §8 rules out as well");

  const asAdmin = markup(
    React.createElement(AccessPeople, {
      access: ACCESS,
      canAdmin: true,
      onGrant: () => undefined,
      onEdit: () => undefined,
      onRevoke: () => undefined,
    }),
  );
  check(asAdmin.includes("Grant</button>"), "an admin does get Grant");
  // ONLY ON A ROW THAT HAS A GRANT. Somebody whose access is entirely their workspace role has
  // nothing here to revoke, and offering it would send an admin to this panel to do something only
  // the Members panel can do.
  check(asAdmin.split("Revoke</button>").length - 1 === 1, "...and Revoke on the one row that has a grant");
}

console.log("\nthe row's marks are not colour alone");
{
  const withGrant: AgentAccess = {
    ...ACCESS,
    people: [
      person({
        user_id: "kim", display_name: "Kim", role: "admin", provenance: "grant",
        granted: ["view", "deploy"], capabilities: ["view", "deploy"],
        fromRole: ["view", "run", "edit", "eval"],
        live: true,
      }),
      person({
        user_id: "lee", display_name: "Lee", role: "member", provenance: "grant",
        granted: ["view", "secrets"], capabilities: ["view"], capped: ["secrets"],
        fromRole: ["view", "run", "edit", "eval"],
      }),
    ],
  };
  const html = markup(
    React.createElement(AccessPeople, {
      access: withGrant,
      canAdmin: true,
      onGrant: () => undefined,
      onEdit: () => undefined,
      onRevoke: () => undefined,
    }),
  );
  // §17 — the `+` is IN THE LABEL rather than in a wrapper, so it survives a copy-paste and is read
  // aloud in order. A colour alone says nothing to a screen reader.
  check(html.includes("+deploy"), "a capability granted here carries a + in its own text");
  check(html.includes("caps this at"), "a capped capability carries a sentence, not only a strike");
  check(html.includes(">live</span>"), "the presence dot is accompanied by the word");
}

console.log("\nthe panel never renders an address it was not given");
{
  // §14.1 — NO IP ADDRESSES, ANYWHERE. The assertion is on the rendered markup rather than on the
  // payload type, because a type is a claim and markup is what somebody can read: an internal
  // access panel is not the place to expose colleagues' network locations, and the data is in
  // `audit_log` for anybody with a genuine investigative need.
  const html = markup(
    React.createElement(AccessPeople, {
      access: ACCESS,
      canAdmin: true,
      onGrant: () => undefined,
      onEdit: () => undefined,
      onRevoke: () => undefined,
    }),
  );
  check(!/\b\d{1,3}(\.\d{1,3}){3}\b/.test(html), "no dotted-quad appears in the people list");
  check(!/\bip\b/i.test(html.replace(/<[^>]*>/g, "")), "...and the word does not either");
}

// ---------------------------------------------------------------------------------------------
// §11 — the grant dialog.
// ---------------------------------------------------------------------------------------------

console.log("\ncapabilities above a person's role are disabled with a reason, never hidden");
{
  const html = markup(
    React.createElement(GrantDialog, {
      agentId: AGENT,
      agentSlug: "billing_bot",
      editing: null,
      candidates: [{ user_id: "sam", display_name: "Sam", email: "sam@example.test", role: "member" }],
      onClose: () => undefined,
    }),
  );
  // §11.1 — NEVER HIDDEN. Hiding them produces an admin who concludes the capability does not exist
  // and goes looking for it in the product rather than in the person's role.
  for (const capability of AGENT_CAPABILITIES) {
    check(html.includes(`>${capability}<`), `${capability} is on the form at all`);
  }
  check(html.includes("exceeds Sam"), "the ones a member cannot hold say whose role stops them");
  check(html.includes("change their"), "...and what would let them have it");
  // §17 — THE REASON IS AN ELEMENT THE CHECKBOX POINTS AT, not a `title`. A tooltip is unreachable
  // by keyboard, which is exactly how somebody arrives at a control they cannot use.
  check(/aria-describedby="ceiling-secrets"/.test(html), "and the checkbox points at the reason for assistive tech");
  check(/id="ceiling-secrets"/.test(html), "...which is a real element rather than a tooltip");

  // §17's dialog requirements. Asserted on the markup because a role attribute nobody rendered is
  // an accessibility claim in a comment.
  check(/role="dialog"/.test(html), "it is a dialog");
  check(/aria-modal="true"/.test(html), "...and says it is modal");
  check(/aria-label="[^"]*billing_bot/.test(html), "...and names the agent it is about");
}

console.log("\nthe implication rules come from the matrix, not from checkbox handlers");
{
  // Exercised through the same function the dialog calls, which is the point: if these two rules
  // lived in an onChange handler they would be a second copy of a table the server applies again,
  // and the two would drift the first time a capability was added.
  check(
    [...closeAgentCapabilities(["edit"])].sort().join(",") === "edit,run,view",
    "ticking edit brings run, and run brings view",
  );
  check(
    closeAgentCapabilities(["deploy"]).has("view"),
    "...and every capability brings view, so nothing can be granted invisibly",
  );
  // UNTICKING `view` CLEARS EVERYTHING, and it falls out of the same table rather than being a
  // special case: every capability implies `view`, so none survives its removal.
  const afterUnviewing = [...closeAgentCapabilities(["edit", "run", "view"])].filter(
    (c) => !closeAgentCapabilities([c]).has("view") || c === "view",
  );
  check(
    afterUnviewing.join(",") === "view",
    "and nothing survives view being removed — the rule is the table, not a handler",
  );
}

console.log("\na note is required for the three that need one six months later");
{
  const withDeploy = markup(
    React.createElement(GrantDialog, {
      agentId: AGENT,
      agentSlug: "billing_bot",
      editing: person({
        user_id: "kim", role: "admin", provenance: "grant",
        granted: ["view", "deploy"], capabilities: ["view", "deploy"],
      }),
      candidates: [{ user_id: "kim", display_name: "Kim", email: "kim@example.test", role: "admin" }],
      onClose: () => undefined,
    }),
  );
  check(withDeploy.includes("required for deploy"), "a deploy grant says the note is required");
  // AND THE BUTTON IS REFUSED UNTIL THERE IS ONE. The server refuses it too — this is what stops
  // somebody discovering that after filling the form in.
  check(/disabled=""[^>]*>Save|>Save<\/button>/.test(withDeploy), "the dialog renders its submit control");
  check(withDeploy.includes("disabled"), "...disabled while the note is empty");

  const viewOnly = markup(
    React.createElement(GrantDialog, {
      agentId: AGENT,
      agentSlug: "billing_bot",
      editing: null,
      candidates: [{ user_id: "sam", display_name: "Sam", email: "sam@example.test", role: "member" }],
      onClose: () => undefined,
    }),
  );
  check(!viewOnly.includes("required for"), "a view-only grant does not demand one");
}

// ---------------------------------------------------------------------------------------------
// §13 and §14 — Exposure, and the sessions list.
// ---------------------------------------------------------------------------------------------

console.log("\nexposure says what is reachable, in words, whether or not anything is");
{
  const deployed = markup(
    React.createElement(AccessExposure, {
      exposure: {
        agentId: AGENT,
        deployed: true,
        url: "https://billing-bot.up.railway.app",
        status: "live",
        version: 7,
        deployedByName: "Priya",
        deployedAt: "2026-01-01T00:00:00.000Z",
        auth: "No authentication — anyone with the URL can invoke this agent. Nothing above governs it.",
      },
    }),
  );
  check(deployed.includes("billing-bot.up.railway.app"), "the live URL is shown prominently");
  // §13.1 — A SENTENCE, NOT A PILL. The whole assertion is that the words are on screen: a client
  // that reduced this to a badge would pass any test that only checked for a truthy field.
  check(deployed.includes("No authentication"), "the auth posture is stated in plain language");
  check(deployed.includes("anyone with the URL"), "...naming who can reach it");
  check(deployed.includes("Nothing above governs it"), "...and that nothing in this panel covers it");
  check(deployed.includes("Priya"), "who deployed it");
  check(deployed.includes("View deploy") && deployed.includes("Take down"), "and §13.1's two actions");
  // NO DEPLOY LOGIC HERE. Both actions open the Deploy tab, which already has redeploy, cancel and
  // the build log — a second copy of a control is a second set of promises about what it does.
  check(!deployed.includes("Redeploy"), "...which are links rather than a second set of deploy controls");

  const idle = markup(
    React.createElement(AccessExposure, {
      exposure: {
        agentId: AGENT, deployed: false, url: null, status: null, version: null,
        deployedByName: null, deployedAt: null, auth: null,
      },
    }),
  );
  // §13.2 — THE SECTION DOES NOT DISAPPEAR. Its absence would be read as safety, which is the one
  // reading nobody should take from silence about what is on the internet.
  check(idle.includes("Not deployed"), "an undeployed agent gets an explicit line rather than nothing");
  check(idle.includes("only through Jaroku"), "...saying what that means");
  check(idle.length > 40, "...and the section renders at all rather than collapsing to empty");

  // AN UNRECORDED ACTOR SAYS SO. Migration 061 is never backfilled, and naming the workspace's
  // owner beside a public URL they may not have published would be a confident lie.
  const unrecorded = markup(
    React.createElement(AccessExposure, {
      exposure: {
        agentId: AGENT, deployed: true, url: "https://x.example", status: "live", version: null,
        deployedByName: null, deployedAt: null, auth: "No authentication — anyone with the URL can invoke this agent.",
      },
    }),
  );
  check(unrecorded.includes("unrecorded"), "a deploy from before the column existed names nobody");
}

console.log("\nthe sessions list carries no network location and no raw agent string");
{
  const sessions = [
    { id: "s1", userId: "sam", name: "Sam", device: "Chrome on macOS", startedAt: "2026-01-01T00:00:00.000Z", onThisAgent: true },
    { id: "s2", userId: "kim", name: "Kim", device: null, startedAt: "2026-01-01T00:10:00.000Z", onThisAgent: false },
  ];
  const asAdmin = markup(
    React.createElement(AccessSessions, { sessions, canAdmin: true, onEnd: () => undefined }),
  );
  check(asAdmin.includes("Sam") && asAdmin.includes("Kim"), "every open session is listed");
  check(asAdmin.includes("Chrome on macOS"), "...with two words about the browser");
  // §14.1 — NO IP ADDRESSES, IN THE UI OR THE PAYLOAD. Asserted on the markup because a type is a
  // claim and markup is what somebody can read.
  check(!/\b\d{1,3}(\.\d{1,3}){3}\b/.test(asAdmin), "and no address anywhere in the rendered list");
  // A NULL DEVICE RENDERS NOTHING rather than "Unknown", which beside somebody's name reads as a
  // warning about their session rather than as a missing header.
  check(!asAdmin.includes("Unknown"), "a session with no device string says nothing rather than `Unknown`");
  check(asAdmin.includes(">here<"), "the sessions on this agent are marked rather than the others hidden");
  check(asAdmin.includes("End session"), "an admin gets End session");
  // §17's polite live region on the COUNT rather than the list.
  check(/aria-live="polite"/.test(asAdmin), "the count is announced politely");
  check(/aria-live="polite"[^>]*>\s*<\/p>|2 sessions open/.test(asAdmin), "...and it is the count that is announced");

  const asMember = markup(
    React.createElement(AccessSessions, { sessions, canAdmin: false, onEnd: () => undefined }),
  );
  check(asMember.includes("Sam"), "a non-admin still sees who is connected");
  // ABSENT, not disabled — §8, and §14.1 says the button is admin-only.
  check(!asMember.includes("End session"), "...and no End session control");
  check(!/disabled/.test(asMember), "...not even a disabled one");

  const empty = markup(
    React.createElement(AccessSessions, { sessions: [], canAdmin: true, onEnd: () => undefined }),
  );
  check(empty.includes("Nobody has a session open"), "no sessions is a sentence rather than a blank");
}

// ---------------------------------------------------------------------------------------------
// §12, §15 and §9.3 — invitations, history, and the dot that sends somebody here.
// ---------------------------------------------------------------------------------------------

console.log("\nan invitation is to the workspace, and the section says so");
{
  const invites = [
    { id: "i1", email: "sam@example.test", role: "member", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-02-01T00:00:00.000Z", stale: true },
    { id: "i2", email: null, role: "admin", createdAt: "2026-01-20T00:00:00.000Z", expiresAt: "2026-02-20T00:00:00.000Z", stale: false },
  ];
  const html = markup(React.createElement(AccessInvites, { invites, canManage: true, onInvite: () => undefined }));
  // §12.1's warning, and it is the whole reason this section is careful with its words: an admin
  // must never think they have granted narrow agent access when they have widened the tenancy.
  check(html.includes("workspace"), "the section says these are invitations to the workspace");
  check(html.includes("ceiling over every agent"), "...and that the role they carry reaches every agent");
  // NULL IS A DIFFERENT SENTENCE, not a blank. An address is a reminder of who to chase; a link
  // invitation is a credential that works for whoever holds it, which is a warning.
  check(html.includes("Anyone with the link"), "a link invitation says what it is rather than showing a gap");
  check(html.includes("sam@example.test"), "...and an addressed one names the address");
  check(html.includes(">stale<") || html.includes("stale"), "an invitation older than seven days is marked");
  check(html.includes("Revoke"), "an owner can revoke one");

  const asMember = markup(React.createElement(AccessInvites, { invites, canManage: false, onInvite: () => undefined }));
  // ABSENT rather than disabled — and gated by `member:manage` rather than by this panel's own
  // agent-level `admin`, because withdrawing a workspace invitation reaches outside the agent.
  check(!asMember.includes("Revoke"), "somebody who cannot manage membership gets no Revoke");
  check(asMember.includes("Anyone with the link"), "...but still sees who is waiting");
}

console.log("\nhistory tells an agent change apart from a workspace one");
{
  const entries = [
    { id: 2, action: "access.granted", scope: "agent" as const, actorName: "Priya", summary: "granted sam view, deploy", createdAt: "2026-01-02T00:00:00.000Z" },
    { id: 1, action: "member.role_changed", scope: "workspace" as const, actorName: "Priya", summary: "role changed", createdAt: "2026-01-01T00:00:00.000Z" },
  ];
  const html = markup(React.createElement(AccessHistory, { entries, agentSlug: "billing_bot" }));
  check(html.includes("granted sam view, deploy"), "an agent-scoped row says what was granted");
  // §15's DISTINCT MARK, and the sentence beside it. An admin looking at "Sam can no longer
  // deploy" needs to know whether a grant was revoked or Sam was demoted, because only one of
  // those is fixable in this panel.
  check(html.includes("a workspace change"), "a workspace row says it was a workspace change");
  check(html.includes("rather than being about it"), "...and that it reached this agent rather than being about it");
  check(/aria-label="A workspace change/.test(html), "the two scopes carry different labels, not only different icons");
  check(html.includes("Export CSV"), "and §15's export is at the bottom of the section");

  const csv = historyToCsv(entries);
  // `scope` IS A COLUMN ON THE WAY OUT. On screen the distinction is an icon; in a spreadsheet an
  // icon is nothing, and a file that flattened the two would let somebody conclude a role change
  // three weeks ago was a grant nobody can find.
  check(csv.split(/\r\n/)[0] === "when,scope,actor,action,what", `the export has a scope column (${csv.split(/\r\n/)[0]})`);
  check(csv.includes('"granted sam view, deploy"'), "...and quotes a summary containing a comma");
  check(csv.split(/\r\n/).length === 3, "...one row per entry plus a header");

  check(
    markup(React.createElement(AccessHistory, { entries: [], agentSlug: "x" })).includes("Nothing has changed"),
    "an empty history is a sentence rather than a blank",
  );
}

console.log("\n§12.1 — the invite dialog says it is adding somebody to the WORKSPACE");
{
  const html = markup(
    React.createElement(InviteWithGrantDialog, {
      agentId: AGENT,
      agentSlug: "billing_bot",
      workspaceName: "Acme Corp",
      onClose: () => undefined,
    }),
  );
  // THE SENTENCE §12.1 ASKS FOR, assembled from the three real values. This is the whole reason the
  // dialog exists rather than a checkbox on the grant form: a dialog reached from an agent's Access
  // tab, headed "Invite", with that agent's capabilities under it, READS as inviting somebody to
  // the agent — and it is not. It adds a member to the workspace, with a role, which is a ceiling
  // over every agent in it.
  check(html.includes("to join the"), "the sentence says what joining means");
  check(html.includes("Acme Corp"), "...naming the workspace by name");
  check(html.includes("billing_bot"), "...and the agent the grant is on");
  check(html.includes("workspace</span> workspace") || /Acme Corp[\s\S]{0,60}workspace/.test(html),
    "...with the word `workspace` beside it rather than only the agent");
  // AND THE CEILING WARNING, which is the half an admin skimming would otherwise miss: the role
  // reaches every agent, and only the grant is narrow.
  check(html.includes("ceiling over"), "and it says the role is a ceiling over every agent");
  check(html.includes("narrows them on billing_bot only"), "...while the grant narrows this one");

  // A ROLE'S CEILING BOUNDS WHAT MAY BE STAGED, with the reason stated — the same rule the grant
  // dialog follows, at the one place a role and a grant are chosen together before either exists.
  check(html.includes("exceeds the member role"), "capabilities above the invited role are refused with a reason");
  check(/aria-describedby="invite-ceiling-deploy"/.test(html), "...and the checkbox points at it");
  // §13.4's link invitation is offered rather than hidden, and the placeholder says what an empty
  // address means — a shareable credential handed to somebody who thought they were writing to one
  // person is the worst version of this.
  check(html.includes("leave empty for a link"), "an empty address is offered as the choice it is");
  check(/role="dialog"/.test(html) && /aria-modal="true"/.test(html), "and it is a modal dialog");
}

console.log("\n§16 — the tab is absent in a personal workspace");
{
  // ENOUGH FOR THE DEFAULT PANEL TO RENDER, and no more. What is under test is which tabs are in
  // the strip; the Capabilities panel is simply what the strip opens on, so it gets the four empty
  // collections it reads and nothing else.
  const detail = {
    card: { uuid: AGENT, slug: "billing_bot", connectors: [], required_env: [], missing_env: [], default_provider: "fake" },
    tools: [],
    credentials: [],
  } as never;

  seed(useSessionStore, sessionAs("owner", { kind: "team" }));
  const inTeam = markup(React.createElement(AgentTabs, { detail }));
  check(inTeam.includes(">Access<"), "a team workspace gets the tab");

  seed(useSessionStore, sessionAs("owner", { kind: "personal" }));
  const inPersonal = markup(React.createElement(AgentTabs, { detail }));
  // ABSENT, NOT EMPTY. Every section of the tab is about people, and a workspace of one has none:
  // the People list is a row nobody can edit, the invite section offers to widen a tenancy that is
  // deliberately not shareable, and History is a log of things one person did to themselves. Four
  // empty sections is not a smaller feature — it teaches somebody the product has nothing here.
  check(!inPersonal.includes(">Access<"), "a personal workspace does not");
  // ...and the five that are about the AGENT rather than about people all stay, so the rule above
  // is one tab going rather than the strip being conditional.
  for (const label of ["Capabilities", "Health", "Deploy", "Evals"]) {
    check(inPersonal.includes(`>${label}<`), `...while ${label} stays, because it is about the agent`);
  }

  // Put the fixture back, so nothing after this block inherits a personal workspace.
  seed(useSessionStore, sessionAs("owner", { kind: "team" }));
}

console.log("\n§9.3's dot carries its own reason");
{
  // TWO CAUSES, ONE MARK, AND THE MARK SAYS WHICH. A badge somebody has to open a tab to interpret
  // has moved the question rather than answered it.
  const exposed = accessBadge({ deployed: true }, []);
  check(exposed !== null, "a publicly reachable agent raises the dot");
  check(exposed?.includes("no authentication") === true, `...and the dot says why ("${exposed}")`);

  const stale = accessBadge({ deployed: false }, [{ stale: true }, { stale: false }]);
  check(stale !== null, "so does an invitation older than seven days");
  check(stale?.includes("1 invitation") === true, `...naming how many ("${stale}")`);

  // EXPOSURE WINS WHEN BOTH ARE TRUE. There is one dot and it can say one thing; a public URL with
  // no authentication is the larger by a distance, and a stale invitation is still visible in its
  // own section.
  const both = accessBadge({ deployed: true }, [{ stale: true }]);
  check(both?.includes("public URL") === true, "a public URL outranks a stale invitation on the one dot");

  check(accessBadge({ deployed: false }, []) === null, "a private agent with no stale invites raises nothing");
  // NULL WHILE LOADING, so a warning is never drawn from an absent payload — a dot that flashed on
  // every agent that had not answered yet would teach people to ignore it.
  check(accessBadge(undefined, undefined) === null, "...and nothing is claimed before the data lands");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
