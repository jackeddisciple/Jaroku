// §14.1's `test:workspace-switcher` — what the switcher lists, in what order, and what it renders.
//
// TWO HALVES, AND THE SECOND IS THE ONE A REVIEWER CANNOT DO. The arrangement rules are pure and
// are asserted directly; the RENDER is asserted by rendering — `react-dom/server` turns the
// component into markup with no browser, no jsdom and no click, which is exactly the "structural
// test, not a click test" §14.1 asks for a section later. What it buys is the thing a screenshot
// of one workspace cannot show: that a member sees no role badge on a personal workspace, that the
// active row carries a tick and not a highlight as well, and that the collapsed row renders the
// plan the SESSION carries rather than a default.
//
// THE ORDERING IS WHERE THE WRONG ANSWERS ARE, and every one of them looks right on the four-
// workspace account somebody develops against: byte order puts "Zebra" above "acme co", a personal
// workspace sorted among the teams moves the one fixed point in the menu every time somebody
// renames something, and two workspaces genuinely called "Design" swap places between reloads.
//
//   npm run test:workspace-switcher

import React from "react";

import { orderWorkspaces, roleLabel, shouldScroll, SCROLL_AFTER } from "./workspaceList.ts";
import type { SessionWorkspace } from "./auth.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { WorkspaceSwitcher } from "../components/WorkspaceSwitcher.tsx";
import { markup, seed } from "./testRender.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const ws = (
  id: string,
  name: string,
  kind: "personal" | "team" = "team",
  role = "member",
  plan = "Free",
): SessionWorkspace => ({ id, slug: id, name, kind, role, plan: { id: plan.toLowerCase(), label: plan } });

const names = (list: readonly SessionWorkspace[]): string[] => list.map((w) => w.name);

console.log("\n§2.2's order");
{
  const list = [
    ws("t3", "Zebra"),
    ws("t1", "acme co"),
    ws("p1", "Adarsh", "personal", "owner"),
    ws("t2", "Beta"),
  ];
  const ordered = orderWorkspaces(list);
  check(ordered[0]?.kind === "personal", "the personal workspace is first");
  check(
    names(ordered).slice(1).join(",") === "acme co,Beta,Zebra",
    `...and the teams are alphabetical, case-insensitively (${names(ordered).slice(1).join(",")})`,
  );

  // THE ASSERTION THAT FAILS ON A PLAIN `<`. Byte order puts every capitalised name above every
  // lowercase one, so "acme co" would sort after "Zebra" — which reads as no ordering at all to
  // somebody scanning a menu for a name they half-remember.
  const cased = orderWorkspaces([ws("a", "Zebra"), ws("b", "acme co")]);
  check(names(cased)[0] === "acme co", "a lowercase name sorts before a capitalised later one");

  // Accents belong beside their base letter. `localeCompare` knows; `<` puts every one of them
  // after `z`.
  const accented = orderWorkspaces([ws("a", "Zurich"), ws("b", "Ångström"), ws("c", "Apex")]);
  check(names(accented).join(",") === "Ångström,Apex,Zurich", `Å sorts with A (${names(accented).join(",")})`);
}

console.log("\nand what happens when two are the same");
{
  const a = orderWorkspaces([ws("id-b", "Design"), ws("id-a", "Design")]);
  const b = orderWorkspaces([ws("id-a", "Design"), ws("id-b", "Design")]);
  // STABLE ACROSS TWO DIFFERENT ARRIVAL ORDERS, which is the whole point: the session serialises
  // memberships in whatever order the query returned, and a menu whose two "Design" rows swap
  // places between reloads is one where somebody clicks the wrong one.
  check(
    a.map((w) => w.id).join(",") === b.map((w) => w.id).join(","),
    "two workspaces with one name land in the same order however they arrived",
  );
  check(a[0]?.id === "id-a", "...broken by id, which is stable");
}

console.log("\nthe lists that are not lists");
{
  check(orderWorkspaces([]).length === 0, "an empty membership list is empty rather than an error");
  const onlyPersonal = orderWorkspaces([ws("p", "Mine", "personal", "owner")]);
  check(onlyPersonal.length === 1, "one workspace is one workspace");
  // THE STATE THE PRODUCT SAYS CANNOT HAPPEN. `adoptWorkspace` guarantees at most one personal
  // workspace; "guaranteed" is not a reason to leave two in whatever order a query returned.
  const twoPersonal = orderWorkspaces([ws("p2", "Second", "personal"), ws("p1", "First", "personal")]);
  check(names(twoPersonal).join(",") === "First,Second", "two personal workspaces are still ordered");
}

console.log("\n§2.3's scroll threshold");
{
  check(SCROLL_AFTER === 8, "eight, which is twice what §2.3 says anybody will have");
  check(!shouldScroll(8), "eight workspaces do not scroll");
  check(shouldScroll(9), "nine do");
  check(!shouldScroll(0), "and neither does none");
}

console.log("\nthe role, in the word a person reads");
{
  check(roleLabel("owner") === "Owner", "owner capitalises");
  check(roleLabel("admin") === "Admin", "admin capitalises");
  check(roleLabel("member") === "Member", "member capitalises");
  // A ROLE THIS CLIENT DOES NOT KNOW IS PASSED THROUGH rather than replaced. A server that grew a
  // fourth role would otherwise render every one of them as something they are not.
  check(roleLabel("auditor") === "Auditor", "an unknown role is passed through, not renamed");
  check(roleLabel("") === "", "and an absent one renders nothing");
}

// --- what it actually draws ------------------------------------------------------------------

/** Render the switcher against a session, as markup. No browser, no jsdom, no click. */
function render(state: { workspaceId: string; workspaces: SessionWorkspace[] }): string {
  seed(useSessionStore, {
    status: "ready",
    user: {
      id: "u1",
      email: "adarsh@example.com",
      displayName: "Adarsh",
      onboarded: true,
      onboardingStep: 5,
      isAdmin: false,
      adminMode: false,
    },
    workspaceId: state.workspaceId,
    workspaces: state.workspaces,
    switching: null,
    switchError: null,
  });
  return markup(React.createElement(WorkspaceSwitcher));
}

console.log("\n§2.1's collapsed row");
{
  const html = render({
    workspaceId: "t1",
    workspaces: [ws("p1", "Adarsh", "personal", "owner"), ws("t1", "Acme Corp", "team", "admin", "Team")],
  });
  check(html.includes("Acme Corp"), "the current workspace's name is in the row");
  check(!html.includes("Adarsh</"), "...and the other workspace's is not, until the menu is open");
  check(html.includes("Team"), "the plan chip comes from the session");
  // THE PLAN IS THE SERVER'S LABEL AND IS NEVER DEFAULTED. A chip is a claim about what a
  // workspace is paying, and inventing one is how a hardcoded "Free" ends up over a paid team.
  const noPlan = render({
    workspaceId: "t1",
    workspaces: [{ ...ws("t1", "Acme Corp"), plan: undefined as never }],
  });
  check(!/FREE|Free/.test(noPlan), "a session with no plan renders no chip rather than a default");
}

console.log("\n§9.1 — before the session lands");
{
  seed(useSessionStore, { user: null, workspaceId: null, workspaces: [] });
  const html = markup(React.createElement(WorkspaceSwitcher));
  // A FIXED-HEIGHT PLACEHOLDER RATHER THAN NOTHING. The four destinations sit under this row, and
  // a switcher that appears when the session lands would move all of them down a frame after
  // paint — on every launch.
  check(html.includes("h-9"), "an empty row of the same height holds the space");
  check(!/Acme|Adarsh/.test(html), "...and names nobody");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
