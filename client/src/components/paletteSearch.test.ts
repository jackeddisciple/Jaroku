// TWO LABELS POINTING AT A BOX THAT DID NOT DO WHAT THEY SAID.
//
// The sidebar's magnifier reads "Search agents — ⌘K opens the palette". The palette's own
// placeholder reads "Type a command or search…". Typing `working` into it, in a workspace
// containing **Working agent** / `working_agent`, with that agent visible in the sidebar the whole
// time, returned:
//
//   Command palette | No results.
//
// The root list was commands only; agent search was a mode behind *Go to agent…*. So the documented
// route to finding an agent reported that the agent did not exist.
//
// FOLDED IN RATHER THAN RELABELLED, which is the choice this suite records. Correcting the two
// labels would have been the smaller change and the wrong one: a palette that says "or search"
// should search what the product is made of, and the sidebar is right that this is where you look
// for an agent.
//
// AND ONLY WITH A QUERY, which is the assertion that keeps the fix from costing what it fixed. The
// root with an empty box is the command list; eight agent rows above the commands, before anybody
// has typed anything, would push them off the first screen of a surface whose entire value is that
// the thing you want is one keystroke and one Enter away.
//
//   npm run test:palette-search

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PALETTE = readFileSync(`${HERE}CommandPalette.tsx`, "utf8");
const SIDEBAR = readFileSync(`${HERE}Sidebar.tsx`, "utf8");

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("\nthe root can see what is typed into it");
{
  // The root list could only FILTER what it already offered, so what it offered could never depend
  // on the search. That is the whole mechanism of the bug.
  check("the input is controlled", /value=\{query\}/.test(PALETTE) && /onValueChange=\{setQuery\}/.test(PALETTE));
  check("...and the query is state the list can read", /const \[query, setQuery\] = useState\(""\)/.test(PALETTE));
}

console.log("\nagents are in the root result set");
{
  check("the root renders an Agents group", /query\.trim\(\) && agentCards\.length > 0/.test(PALETTE),
    "the root list is still commands only");
  check("...from the same cards the dedicated mode uses", PALETTE.includes("agentCards.map"));
  // Both the name and the slug, because those are the two fields somebody would type and the two
  // the Agents grid already searches.
  check("...offering the name", PALETTE.includes("<Truncate>{a.name}</Truncate>"));
  check("...and the slug", PALETTE.includes("{a.slug}"));
  check("...and opening the agent", PALETTE.includes("openAgentDetail(a.slug)"));
}

console.log("\nbut not before anything is typed");
{
  check("the group is gated on a non-empty query", PALETTE.includes("query.trim() && agentCards.length > 0"));
  // The commands are not gated — the root with an empty box is still the command list it was.
  check("the Run group is not gated", /heading="Run"/.test(PALETTE) && !/query\.trim\(\) && [^)]*heading="Run"/.test(PALETTE));
  check("the Refresh group is not gated", /heading="Refresh"/.test(PALETTE));
}

console.log("\nthe box starts empty every time it opens");
{
  // A palette reopened onto the last thing somebody searched for would filter the command list
  // against a word they have forgotten typing.
  check("the query resets", /useEffect\(\(\) => \{ setQuery\(""\); \}, \[open, mode\]\);/.test(PALETTE),
    "the query survives an open or a mode change");
}

console.log("\nand the two labels that pointed here still point here");
{
  // The fix has to leave them true rather than making them true by deleting them.
  check("the sidebar still sends people to the palette to find an agent",
    /Search agents — \$\{keyHint\("⌘K"\)\} opens the palette/.test(SIDEBAR), "the sidebar tooltip changed");
  check("the placeholder still offers a search", PALETTE.includes("Type a command or search…"));
  // And the dedicated mode is untouched: it is still reachable, and it is still the way to browse
  // agents rather than to find one.
  check("*Go to agent…* still exists", PALETTE.includes("Go to agent…"));
  check("...and its own mode still lists every agent", /mode === "agents" \?/.test(PALETTE));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
