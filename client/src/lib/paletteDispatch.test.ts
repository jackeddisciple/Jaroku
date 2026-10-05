// The palette's "Dispatch to <agent>", from the palette to a composer with the caret in it.
//
// THE BUG. Chosen while the Cockpit was open it did nothing: the palette closed, no agent filter was
// applied, nothing was focused — the tab only read its pointer's intent when it mounted. Chosen from
// another page it opened the Cockpit narrowed to the agent with the composer unfocused and pointed at
// nobody, so "Dispatch to" led to a list, not a dispatch.
//
// No suite here mounts components, so the store's half is driven and the two consumers are read: the
// tab must take an intent that arrives while it is open, and the composer must take the aim once.
//
//   npm run test:palette-dispatch

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const g = globalThis as unknown as Record<string, unknown>;
const store = new Map<string, string>();
g["localStorage"] = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
g["window"] = { location: { search: "", href: "http://localhost/", origin: "http://localhost" }, history: { replaceState() {} } };

const { useUiStore } = await import("../store/uiStore.ts");
const source = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

console.log("\nthe palette asks for a dispatch, not a list");
{
  useUiStore.getState().openNav("agents");
  useUiStore.getState().dispatchToAgent("agent-bruno");
  const s = useUiStore.getState();
  check(s.navView === "work", "it opens the Cockpit");
  check(s.cockpitAgentIntent === "agent-bruno", "...narrowed to the agent");
  check(s.composerAim?.agentId === "agent-bruno", "...with the composer pointed at it");
  check(s.takeCockpitAgentIntent() === "agent-bruno" && useUiStore.getState().cockpitAgentIntent === undefined,
    "the narrowing is taken once");

  // A POINTER STRIP OPENS THE LIST AND NOTHING MORE — it is not a dispatch.
  useUiStore.setState({ composerAim: null });
  useUiStore.getState().openCockpitForAgent("agent-margot");
  check(useUiStore.getState().composerAim === null, "a pointer that only opens the list aims nothing");
}

console.log("\nthe composer is one key away");
{
  // EIGHT JOBS WERE SIXTEEN TAB STOPS between the filters and the composer, with no way to jump.
  useUiStore.setState({ composerAim: null });
  useUiStore.getState().openNav("agents");
  useUiStore.getState().focusWorkComposer();
  const s = useUiStore.getState();
  check(s.navView === "work" && s.composerAim !== null && s.composerAim.agentId === null,
    "\"Write a job\" opens the Cockpit with the caret in the composer, leaving its agent as it was");
  const composer = source("../components/WorkComposer.tsx");
  check(/export const COMPOSER_KEY = "c"/.test(composer) && /viewOwnsBareKey\(e,/.test(composer),
    "C puts the caret there on the Cockpit, under the rule every view's bare letters follow");
  check(/onTop\(box\)/.test(composer), "...but not from under a dialog or a panel lying over it");
  check(/aria-keyshortcuts=/.test(composer), "...and the box says so to assistive tech");
  const list = source("../components/WorkList.tsx");
  check((list.match(/tabIndex=\{-1\}/g) ?? []).length >= 2, "a row's Stop and Retry are not extra Tab stops");
  useUiStore.setState({ composerAim: null });
}

console.log("\nchosen with the Cockpit already open");
{
  const view = source("../components/CockpitView.tsx");
  check(/useUiStore\(\(s\) => s\.cockpitAgentIntent\)/.test(view),
    "the open tab watches for a narrowing asked for after it mounted");
  const after = view.slice(view.indexOf("useUiStore((s) => s.cockpitAgentIntent)"));
  check(/takeCockpitAgentIntent\(\)/.test(after) && /sendListWork\(\)/.test(after),
    "...takes it and asks for the narrowed list");
}

console.log("\nthe composer is where it ends");
{
  const composer = source("../components/WorkComposer.tsx");
  const at = composer.indexOf("s.composerAim");
  const effect = composer.slice(at, at + 900);
  check(at > 0, "the composer reads the aim");
  check(/composerAim: null/.test(effect), "...takes it once, so a later visit is not re-aimed");
  check(/setAgentId\(aim\.agentId\)/.test(effect), "...points at the agent");
  check(/requestAnimationFrame\(\(\) => boxRef\.current\?\.focus\(\)\)/.test(effect),
    "...and puts the caret in the box once the palette's focus trap has gone");
  check(!/cancelAnimationFrame/.test(effect), "...which taking the aim does not cancel");

  const palette = source("../components/CommandPalette.tsx");
  check(/dispatchToAgent\(card\.agent_id\)/.test(palette), "the palette entry asks for the dispatch");
  check(/needsReconnect/.test(palette) && /dispatchable\.slice/.test(palette),
    "...and is offered only for agents that can take a job");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
