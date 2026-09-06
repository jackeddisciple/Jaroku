// §5: two components, because these are two things — and the construction rules that make either
// of them read as one control rather than as three buttons that happen to be touching.
//
// THE DISTINCTION IS THE POINT AND IT IS NOT DECORATION. A cluster holds actions that spring back;
// a segmented control holds a MODE and the chosen one stays down. If the two look identical, a
// grid/table toggle looks like a refresh button, and somebody learns that pressing refresh changes
// a mode — a lesson they only unlearn by losing their place. So the suite checks that they are
// distinguishable in both directions: by what a screen reader hears, and by what is on screen.
//
// AND THE HAIRLINE, WHICH IS THE FAILURE THAT ACTUALLY SHIPS. Two bordered buttons side by side put
// two 1px edges against each other, and a 2px seam in an application whose entire structure is drawn
// in single hairlines reads as a rendering fault. It is invisible in a diff, obvious on screen, and
// nobody can say what is wrong with it.
//
//   npm run test:toolbar-cluster

import { createElement } from "react";

import { markup } from "../lib/testRender.ts";
import { check, done } from "../lib/icons/harness.ts";
import { Icon } from "../lib/icons/registry.ts";
import { HIT_TARGET } from "./icons.ts";
import { ToolbarCluster } from "./ToolbarCluster.tsx";
import { Segmented } from "./Segmented.tsx";

const cluster = (n: number): string =>
  markup(
    createElement(ToolbarCluster, {
      members: [
        { icon: Icon.threads.refresh, label: "Ask again" },
        { icon: Icon.threads.new, label: "New thread" },
        { icon: Icon.agents.fork, label: "Fork agent" },
      ].slice(0, n),
    }),
  );

const marks = markup(
  createElement(Segmented, {
    ariaLabel: "Grid density",
    value: "comfortable",
    onChange: () => {},
    options: [
      { value: "comfortable", label: "Comfortable", icon: Icon.agents.viewGrid },
      { value: "compact", label: "Compact", icon: Icon.agents.viewTable },
    ],
  }),
);

const words = markup(
  createElement(Segmented, {
    ariaLabel: "Date range",
    value: "7d",
    onChange: () => {},
    options: [
      { value: "24h", label: "Show the last 24 hours", text: "24h" },
      { value: "7d", label: "Show the last 7 days", text: "7d" },
      { value: "30d", label: "Show the last 30 days", text: "30d" },
    ],
  }),
);

// --- 1. one hairline between neighbours ---------------------------------------------------------

console.log("\nmembers share one hairline, never two");
{
  for (const [name, m] of [["a cluster", cluster(3)], ["a segmented control", marks], ["a text segmented control", words]] as const) {
    // `divide-x` IS THE RULE, not an implementation detail: a border on every child but the first is
    // exactly "one hairline between neighbours", expressed once for the whole group rather than as
    // a `border-l` each member has to remember and the first has to be excused from.
    check(`${name} divides its members once`, m.includes("divide-x"), m.slice(0, 200));
    // AND NOBODY DRAWS A SECOND ONE. A member carrying its own border is the 2px seam.
    const memberTags = [...m.matchAll(/<button\b[^>]*>/g)].map((x) => x[0]!);
    check(`${name}'s members carry no border of their own`,
      memberTags.every((t) => !/\bborder(-[lrtb]|\b)/.test(t)), memberTags.join(" | ").slice(0, 240));
  }
}

// --- 2. the radius is the group's ---------------------------------------------------------------

console.log("\nthe radius is on the outer corners only");
{
  for (const [name, m] of [["a cluster", cluster(3)], ["a segmented control", marks], ["a text segmented control", words]] as const) {
    const wrapper = m.slice(0, m.indexOf(">") + 1);
    check(`${name} rounds its own corners`, wrapper.includes("rounded-control"), wrapper);
    // `overflow-hidden` IS WHAT MAKES THE INTERIOR SQUARE. Without it a member's own rounding and its
    // hover fill both peek out of a corner the group meant to be a straight edge.
    check(`${name} clips its members to it`, wrapper.includes("overflow-hidden"), wrapper);
  }
  // AND THE MARK MEMBERS GIVE UP THEIRS. `IconButton` rounds itself, which is right for a lone
  // control and wrong for a cell in a strip.
  check("a cluster's members are square", (cluster(3).match(/rounded-none/g) ?? []).length === 3, cluster(3));
  check("a segmented control's members are too", (marks.match(/rounded-none/g) ?? []).length === 2, marks);
}

// --- 3. every member is named -------------------------------------------------------------------

console.log("\nevery member carries one string, twice");
{
  for (const [name, m, n] of [["a cluster", cluster(3), 3], ["a segmented control", marks, 2], ["a text segmented control", words, 3]] as const) {
    check(`${name} names all ${n} members`, (m.match(/<button\b[^>]*aria-label="/g) ?? []).length === n, m.slice(0, 300));
    // ONE STRING, TWO JOBS — I5. A tooltip and an accessible name that can disagree is two strings.
    // MEMBER LABELS ONLY. The group's own `aria-label` names what is being chosen between — "Date
    // range" — and is a heading for the set rather than a tooltip on anything pressable.
    const labels = [...m.matchAll(/<button\b[^>]*aria-label="([^"]*)"/g)].map((x) => x[1]!);
    const titles = [...m.matchAll(/title="([^"]*)"/g)].map((x) => x[1]!);
    check(`...and every one of them is also its tooltip`,
      labels.every((l) => titles.includes(l)), `${labels.join(" | ")} vs ${titles.join(" | ")}`);
    check(`...and none of them is empty`, labels.every((l) => l.length > 0));
  }
  // 32×32 WHATEVER IS INSIDE, including the text segments — three durations set in `text-tiny` would
  // otherwise be a 16px-tall row of things to miss.
  check("mark members are 32px", /min-width:32px/.test(cluster(3)) && /min-height:32px/.test(cluster(3)));
  check("text segments are too", new RegExp(`min-height:${HIT_TARGET}px`).test(words), words.slice(0, 300));
}

// --- 4. the two are not the same control --------------------------------------------------------

console.log("\na mode picker is not a row of buttons");
{
  // WHAT A SCREEN READER HEARS. `radiogroup` plus `aria-checked` is "2 of 3, selected"; three
  // `aria-pressed` buttons are three toggles somebody has to try one at a time.
  check("a segmented control is a radiogroup", marks.includes('role="radiogroup"'), marks.slice(0, 200));
  check("...and its members are radios", (marks.match(/role="radio"/g) ?? []).length === 2, marks);
  check("...with exactly one checked",
    (marks.match(/aria-checked="true"/g) ?? []).length === 1 && (marks.match(/aria-checked="false"/g) ?? []).length === 1, marks);
  check("the text variant carries the same semantics",
    words.includes('role="radiogroup"') && (words.match(/aria-checked="true"/g) ?? []).length === 1, words.slice(0, 300));

  // AND AN ACTION CLUSTER CARRIES NONE OF IT. §5.2 is explicit: an action cluster does not. Nothing
  // in it is selected, so announcing a relationship would be announcing one that is not there.
  const c = cluster(3);
  check("a cluster is not a radiogroup", !c.includes("radiogroup"), c.slice(0, 200));
  check("...and no member is a radio", !c.includes('role="radio"'), c);
  check("...and nothing in it is checked", !c.includes("aria-checked"), c);
  // NOR PRESSED, because these are not toggles either — pressing one does a thing and it springs back.
  check("...and nothing in it is pressed", !c.includes("aria-pressed"), c);

  // WHAT AN EYE SEES. The chosen segment sits on a filled surface; nothing in a cluster ever does.
  check("the chosen segment is held down", marks.includes("bg-active"), marks);
  check("nothing in a cluster is held down",
    !/class="[^"]*\bbg-active\b[^"]*"/.test(c.replace(/hover:bg-active/g, "")), c);
}

// --- 5. a cluster of one is not a cluster -------------------------------------------------------

console.log("\na cluster of one is a button");
{
  const one = cluster(1);
  check("one member draws no wrapper", !one.includes("divide-x") && !one.includes("overflow-hidden"), one);
  check("...and is a real button", one.trimStart().startsWith("<button"), one.slice(0, 80));
  check("...still named", one.includes('aria-label="Ask again"'), one);
  // TWO IS THE FLOOR. A lone button inside a border is a group with one thing in it, which reads as
  // a control that has lost its siblings — four of §5.3's sites are singles for exactly this reason.
  check("two members do draw one", cluster(2).includes("divide-x"), cluster(2).slice(0, 200));
  check("and none draws nothing at all", cluster(0) === "", cluster(0));
}

done();
