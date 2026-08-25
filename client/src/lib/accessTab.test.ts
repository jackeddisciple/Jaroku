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
  cappedLine, chipKindFor, chipsFor, matchesAccess, orderAccess, provenanceLine,
  revokeBlockedReason,
} from "./accessList.ts";
import { AGENT_CAPABILITIES } from "./capabilities.ts";
import { markup, seed, sessionAs } from "./testRender.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { useAccessStore, type AccessPerson, type AgentAccess } from "../store/accessStore.ts";
import { AccessPeople } from "../components/AccessPeople.tsx";
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

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
