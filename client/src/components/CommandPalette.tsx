// Command palette + keyboard nav (doc §4.5, Week 5). One place for every fast action, with the
// shortcuts shown inline so they teach themselves. The global key handler also drives J/K trace
// navigation and Enter-to-expand, which work whether or not the palette is open.
//
//   Cmd+K  palette            J / K   prev / next trace step
//   Cmd+P  file switcher      Enter   expand selected step
//   Cmd+/  focus chat         R       re-run (owned by RunTrigger)

import { useEffect, useMemo, useState } from "react";
import { Command } from "cmdk";
import { orderedSteps, useTraceStore } from "../store/traceStore.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { runProviders, useProviderStore } from "../store/providerStore.ts";
import { inputKey } from "../store/uiStore.ts";
import { Truncate } from "./Truncate.tsx";
import { chipClass } from "./Chip.tsx";
import {
  sendCreateThread, sendListAgentGrid, sendListAgents, sendListProviders, sendListThreads,
  sendListWork, sendRun,
} from "../lib/socket.ts";
import { useThreadStore } from "../store/threadStore.ts";
import { useAgentGridStore } from "../store/agentGridStore.ts";
import { useWorkStore } from "../store/workStore.ts";
import { openThread } from "../lib/threadNav.ts";
import { openAgentDetail } from "../lib/agentNav.ts";
import { relTime } from "../lib/format.ts";
import { paneOwnsBareKey } from "../lib/bareKeys.ts";
import { keyHint } from "../lib/modKey.ts";
import { Icon } from "../lib/icons/registry.ts";
import { ICON } from "../lib/tokens.ts";

/** Move the trace selection by ±1 in seq order (J/K). */
function moveStep(delta: 1 | -1): void {
  const st = useTraceStore.getState();
  if (!st.activeRunId) return;
  const steps = orderedSteps(st.stepsByRun[st.activeRunId]);
  if (steps.length === 0) return;
  const idx = steps.findIndex((s) => s.id === st.selectedStepId);
  const next = idx === -1 ? (delta === 1 ? 0 : steps.length - 1) : Math.min(steps.length - 1, Math.max(0, idx + delta));
  const target = steps[next];
  if (target) st.selectStep(target.id);
}

/** Expand (or collapse) the currently-selected step (Enter). */
function toggleExpandSelected(): void {
  const st = useTraceStore.getState();
  if (!st.selectedStepId) return;
  st.setExpandedStep(st.expandedStepId === st.selectedStepId ? null : st.selectedStepId);
}

function runActiveAgent(): void {
  const { provider, model } = useUiStore.getState();
  const agentId = useBuildStore.getState().activeAgentId;
  if (!agentId) return;
  const input = localStorage.getItem(inputKey(agentId)) ?? "";
  sendRun(input.trim(), provider, model, agentId);
}

export function CommandPalette() {
  const open = useUiStore((s) => s.paletteOpen);
  const setOpen = useUiStore((s) => s.setPaletteOpen);
  const setRightTab = useUiStore((s) => s.setRightTab);
  const setProvider = useUiStore((s) => s.setProvider);
  const focusChat = useUiStore((s) => s.focusChat);
  // Which providers exist is the server's answer, off the same price sheet the composer's picker
  // reads — see providerStore. Memoised against the snapshot's array rather than regrouped on every
  // keystroke in the palette's own filter box.
  const providerModels = useProviderStore((s) => s.models);
  const catalogue = useMemo(() => runProviders(providerModels), [providerModels]);

  // Files for the "Jump to file" switcher come straight from the loaded project.
  const fileOrder = useBuildStore((s) => s.fileOrder);
  const openInCode = useBuildStore((s) => s.openInCode);
  const agent = useBuildStore((s) => s.agents.find((a) => a.agent_id === s.activeAgentId));

  const [mode, setMode] = useState<"root" | "files" | "threads" | "agents">("root");
  /**
   * WHAT IS TYPED, HELD HERE, so the root list can decide what to offer rather than only how to
   * filter what it already offers.
   *
   * The palette's placeholder says "Type a command or search…" and the sidebar's magnifier says
   * "Search agents — ⌘K opens the palette", and typing an agent's name into the root returned "No
   * results." — the root list was commands only, and agent search was a mode behind *Go to
   * agent…*. Two surfaces described the root as a search and the root was not one.
   */
  const [query, setQuery] = useState("");
  /**
   * §5.5's `⌘K` fuzzy jump to any agent by name.
   *
   * THE PALETTE IS WHERE IT LIVES, which is what "extend that binding layer rather than adding a
   * second one" means: ⌘K already opens this, `cmdk` already fuzzy-matches what is typed, and the
   * entries are read from the grid store rather than from a second list — so what the palette offers
   * and what the Agents tab shows can never be two different sets.
   *
   * LIVE AGENTS ONLY. §4 hides archived ones behind a filter, and "jump to an agent" is a default
   * list; an archived row appearing here would undo the one thing archiving is for. Same reasoning,
   * same exclusion, as the thread entries above.
   */
  const agentCards = useAgentGridStore((s) => s.cards).filter((c) => c.archived_at === null);
  // §20s dispatch verb needs the LIVE fleet rather than the agent grid: the Cockpit is about agents
  // that are already deployed, and offering to dispatch to a draft would be an entry that opens a
  // composer with nothing to send to.
  const fleet = useWorkStore((s) => s.fleet);
  // §4.7: reaching a thread never requires opening the tab at all. The list is the store's own
  // snapshot, so what the palette offers and what the tab shows can never be two different lists.
  // ACTIVE ROWS ONLY. The snapshot deliberately carries archived threads so the Archived chip has
  // something to show, and everywhere else in the view they are excluded by `archived_at === null`.
  // §3.4 is explicit that an archived thread "leaves the default list" — and "Go to thread…" is a
  // default list, so an archived row appearing here undoes the one thing archiving is for.
  const threads = useThreadStore((s) => s.threads).filter((t) => t.archived_at === null);

  // Global shortcuts. Registered once; reads live store state so no stale closures.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setMode("root");
        useUiStore.getState().setPaletteOpen(!useUiStore.getState().paletteOpen);
        return;
      }
      if (mod && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setMode("files");
        useUiStore.getState().setPaletteOpen(true);
        return;
      }
      // ⌘N — A NEW THREAD, AND IT LIVES HERE NOW.
      //
      // The palette draws this keycap, and the palette is reachable from everywhere. The only
      // handler for it was `useThreadKeys`, which `ThreadsView` mounts — so on the three-pane view,
      // the Agents grid, the Inbox and Activity the chord did nothing at all, and on Windows
      // Ctrl+N fell through to the browser and opened a new window. A keycap with no binding behind
      // it is decoration, and this one was decoration four screens out of five.
      //
      // BESIDE ⌘K AND ⌘P, for the reason those are here: a chord is about the application, not
      // about what is on screen. Removed from `useThreadKeys` in the same change rather than added
      // alongside it — a chord with two owners is a chord whose behaviour depends on which listener
      // ran first, which is the argument this file already makes about ⌘/.
      if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        sendCreateThread();
        // The palette's own row closes it on the way; the chord does the same, so pressing it with
        // the palette open does not leave the list sitting over the thread it just made.
        useUiStore.getState().setPaletteOpen(false);
        return;
      }
      // ⌘/ BELONGS TO THE COMPOSER NOW. The composer spec (§3.3) assigns it to the ⊕ attach
      // menu, and BuildPane binds it at the window. It is not handled here any more, and it is
      // not handled in two places either — a chord with two owners is a chord whose behaviour
      // depends on which listener ran first.
      //
      // Nothing is lost: ⊕ lives in the composer, so the chord still puts the user there, with
      // the menu it was asked to open already open. "Focus chat" stays reachable as a palette
      // item, now without a chord beside it that would be a lie.
      // Non-modified keys are trace navigation — but never while typing or in the palette.
      //
      // AND NEVER WHILE A FULL-SCREEN VIEW IS UP. J/K move a thread row there exactly as they move a
      // trace step here, which is deliberate (§4.7: "same binding as trace-step navigation") — and it
      // only works if one surface at a time is listening. The view that owns the screen owns the bare
      // keys; the chords above stay the app's, because ⌘K and ⌘P are not about what is on screen.
      //
      // THE RULE IS lib/bareKeys NOW rather than two conditions written here. It was written here,
      // correctly, and the `R` listener in BuildPane was written without it — which is what a rule
      // kept at its call sites costs. Both handlers ask the same function now.
      const ui = useUiStore.getState();
      if (!paneOwnsBareKey(e, { navView: ui.navView, paletteOpen: ui.paletteOpen })) return;
      if (e.key === "j" || e.key === "J") { e.preventDefault(); moveStep(1); }
      else if (e.key === "k" || e.key === "K") { e.preventDefault(); moveStep(-1); }
      else if (e.key === "Enter") { toggleExpandSelected(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A FRESH BOX EACH TIME. The palette is opened to do one thing, and reopening it onto the last
  // thing somebody searched for would filter the command list against a word they have forgotten
  // typing. Cleared on mode changes too, since *Go to agent…* is entered to type a different word.
  useEffect(() => { setQuery(""); }, [open, mode]);

  const run = (fn: () => void) => () => {
    fn();
    setOpen(false);
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      // THE CARD HAD NO PERCEPTIBLE EDGE. `bg-panel` behind a `black/50` scrim over a `#0d0d0f`
      // page lands within a couple of percent of the dimmed background it floats on, so the app's
      // primary navigation surface read as unbordered text hanging in space — a contrast problem
      // rather than a markup one, since every class it needed was already declared.
      //
      // The scrim goes to the app's own `void` at a real opacity, and the card comes up a step. A
      // modal earns the strongest dim in the app: nothing behind it is meant to be read.
      //
      // AND `className` IS NOT ONE OF THE THREE. `Command.Dialog` spreads everything it does not
      // name onto the `Command` ROOT, which is a child of the content — so the positioning this
      // dialog needs was being applied one level too deep: the root took `fixed inset-0` and left
      // the content box, which is the thing carrying the surface, the border, the radius and the
      // width, with nothing to give it a size. The card was therefore never painted at all, and
      // the list rendered straight over the app with the conversation legible between its rows.
      // Every class is the same class; the only change is which of the two elements wears it.
      overlayClassName="fixed inset-0 z-50 bg-ink/40"
      contentClassName="fixed inset-x-0 top-[12vh] z-50 mx-auto w-[min(560px,92vw)] bg-elevated rounded-modal overflow-hidden border border-edge shadow-overlay"
    >
      <Command loop>
        <Command.Input
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder={
            mode === "files" ? "Jump to file…"
              : mode === "threads" ? "Go to thread…"
              : mode === "agents" ? "Go to agent…"
              : "Type a command or search…"
          }
          // A VISIBLE FIELD. It was transparent on the card, so the one control that is focused
          // the instant this opens had no box at all — you could see the placeholder and not the
          // thing you were typing into.
          className="w-full border-b border-edge bg-bg px-4 py-3 text-label text-ink outline-none focus-visible:shadow-focusring placeholder:text-faint"
        />
        <Command.List className="max-h-[52vh] overflow-auto p-2">
          <Command.Empty className="px-3 py-6 text-center text-muted text-caption">No results.</Command.Empty>

          {mode === "agents" ? (
            <Command.Group heading="Agents" className="mb-1">
              {agentCards.map((a) => (
                // The name and the slug, because those are the two fields the grid searches and the
                // two a person would type. The health word rides along for the same reason a
                // thread's fragment does: an entry showing only a name would make somebody open two
                // agents to find the one that is failing.
                <Item
                  key={a.slug}
                  onSelect={run(() => openAgentDetail(a.slug))}
                  meta={a.health === "healthy" ? undefined : a.health}
                >
                  <Truncate>{a.name}</Truncate>
                  <span className="shrink-0 text-tiny text-faint">{a.slug}</span>
                </Item>
              ))}
            </Command.Group>
          ) : mode === "threads" ? (
            <Command.Group heading="Threads" className="mb-1">
              {threads.map((t) => (
                // The row's own vocabulary, in one line: what it is called, and the one fact §4.3 puts
                // beside it. A palette entry that showed only the title would make a person open two
                // threads to find the one with the pending diff.
                <Item key={t.id} onSelect={run(() => openThread(t))} meta={relTime(t.last_activity_at)}>
                  <Truncate>{t.title}</Truncate>
                  {t.fragment && <span className="shrink-0 text-faint text-tiny">{t.fragment}</span>}
                </Item>
              ))}
            </Command.Group>
          ) : mode === "files" ? (
            <Command.Group heading="Files" className="mb-1">
              {fileOrder.map((path) => (
                <Item key={path} onSelect={run(() => openInCode(path))}>
                  {/* A list of paths, which is the case §A.3 was written about — `tools/we…` and
                      `tools/tr…` are the same string to somebody scanning for a filename. */}
                  <Truncate variant="path">{path}</Truncate>
                </Item>
              ))}
            </Command.Group>
          ) : (
            <>
              <Command.Group heading="Run" className="mb-1">
                <Item onSelect={run(runActiveAgent)} disabled={!agent?.runnable} kbd="R">
                  Run {agent?.name ?? "agent"}
                </Item>
              </Command.Group>

              <Command.Group heading="Provider" className="mb-1">
                {catalogue.map((p) => (
                  <Item key={p.id} onSelect={run(() => setProvider(p.id))}>
                    Switch to {p.label}
                  </Item>
                ))}
              </Command.Group>

              {/* ASK EVERY SNAPSHOT AGAIN — the manual refresh this product had none of.
                  `sendListAgents`, `sendListProviders` and `sendListThreads` have all existed since
                  the surfaces they feed did, and no component called any of them: every list is
                  pushed on the transitions that change it, so a transition that pushed nothing left
                  the only remedy as reloading the page. One entry rather than three, because
                  "something on screen looks stale" is one thought and does not name a channel. */}
              {/* AGENTS, IN THE ROOT, ONCE THERE IS SOMETHING TO MATCH THEM AGAINST.
                  Typing an agent's name here returned "No results." while the agent sat visible in
                  the sidebar and two labels pointed at this box to find it. Folded in rather than
                  relabelled, because the labels are describing the right thing — a palette that
                  says "or search" should search what the product is made of.

                  ONLY WITH A QUERY. With an empty box the root is the command list, which is what
                  it is for; eight agent rows under it before anybody has typed would push the
                  commands off the first screen of a surface whose whole value is that the thing you
                  want is one keystroke and one Enter away. */}
              {query.trim() && agentCards.length > 0 && (
                <Command.Group heading="Agents" className="mb-1">
                  {agentCards.map((a) => (
                    <Item
                      key={`root-agent-${a.slug}`}
                      onSelect={run(() => openAgentDetail(a.slug))}
                      meta={a.health === "healthy" ? undefined : a.health}
                    >
                      <Truncate>{a.name}</Truncate>
                      <span className="shrink-0 text-tiny text-faint">{a.slug}</span>
                    </Item>
                  ))}
                </Command.Group>
              )}

              <Command.Group heading="Refresh" className="mb-1">
                <Item
                  onSelect={run(() => {
                    sendListAgents();
                    sendListAgentGrid();
                    sendListProviders();
                    sendListThreads();
                  })}
                >
                  Refresh agents, providers and threads
                </Item>
              </Command.Group>

              <Command.Group heading="View" className="mb-1">
                <Item onSelect={run(() => setRightTab("graph"))}>Open Graph</Item>
                <Item onSelect={run(() => setRightTab("trace"))}>Open Trace</Item>
                <Item onSelect={run(() => setRightTab("deploy"))}>Open Deploy</Item>
                <Item onSelect={run(() => setRightTab("github"))}>Open GitHub</Item>
                {/* Tabs are reached from here rather than by a dedicated chord — the palette is
                    where this app puts view navigation, and a secrets shortcut would be one more
                    key to collide with while the composer has focus. */}
                <Item onSelect={run(() => setRightTab("secrets"))}>Open Secrets</Item>
                <Item onSelect={run(() => { setMode("files"); })} kbd={keyHint("⌘P")}>Jump to file…</Item>
                {/* Switching mode rather than closing: `run` would dismiss the dialog, and the whole
                    point of this entry is the list that comes next. */}
                <Item onSelect={() => setMode("threads")}>Go to thread…</Item>
                {/* Switching mode rather than closing, like the two above it: the whole point of the
                    entry is the list that comes next. */}
                <Item onSelect={() => setMode("agents")}>Go to agent…</Item>
                <Item onSelect={run(() => useUiStore.getState().openNav("agents"))}>Open Agents</Item>
                <Item onSelect={run(() => useUiStore.getState().openNav("threads"))}>Open Threads</Item>
                {/* The palette is where this app puts view navigation — the comment eight lines up
                    says so — and a destination reachable only by finding its icon in the rail is one
                    keyboard users do not have. Beside Agents and Threads rather than after the
                    thread verbs, so the three navigations read as a group. */}
                <Item onSelect={run(() => useUiStore.getState().openNav("work"))}>Open the Cockpit</Item>
                {/* §20: THE COCKPIT'S VERBS, REGISTERED. "An operator surface whose actions are
                    unreachable from the palette is one the keyboard users will not adopt." Three
                    of them, which is what §20 names: go to the Cockpit (above), show what is
                    waiting, and dispatch to a named agent.

                    "SHOW WHAT IS WAITING" IS THE ONE WORTH HAVING. It is the tab's only urgent
                    question, and reaching it by hand is three controls — open the tab, switch the
                    scope, press the `waiting` chip — of which the middle one is the one people
                    forget, so they see their own waiting jobs and not the workspace's.

                    THE FILTER IS SET BEFORE THE NAVIGATION, which is `CockpitView`'s own rule:
                    asking unfiltered first renders the whole workspace's work for a frame, and on
                    a busy workspace that is a list somebody starts reading before it is replaced. */}
                <Item
                  onSelect={run(() => {
                    useWorkStore.getState().setFilters({ scope: "all", status: "waiting", agentId: null });
                    useUiStore.getState().openNav("work");
                    sendListWork();
                  })}
                >
                  Show what is waiting
                </Item>
                {/* AND DISPATCHING TO A NAMED AGENT, which is a NAVIGATION rather than a dispatch:
                    it opens the Cockpit filtered to that agent, with the composer pointed at it.
                    The palette does not send the job — §8's gate is between the composer and the
                    container for a reason, and a palette entry that dispatched would be a way to
                    spend money without ever seeing what it was about to run on. */}
                {query.trim() && fleet.length > 0 && (
                  <>
                    {fleet.slice(0, 5).map((card) => (
                      <Item
                        key={`cockpit-${card.agent_id}`}
                        onSelect={run(() => useUiStore.getState().openCockpitForAgent(card.agent_id))}
                      >
                        Dispatch to <Truncate>{card.agent_name}</Truncate>
                      </Item>
                    ))}
                  </>
                )}
                <Item onSelect={run(() => sendCreateThread())} kbd={keyHint("⌘N")}>New thread</Item>
                {/* No chord: ⌘/ opens the composer's ⊕ menu as of the composer spec. A keycap on a row that
                    no longer answers to it is worse than no keycap. */}
                <Item onSelect={run(focusChat)}>Focus chat</Item>
              </Command.Group>
            </>
          )}
        </Command.List>
      </Command>
    </Command.Dialog>
  );
}

function Item({
  children,
  onSelect,
  kbd,
  meta,
  disabled,
}: {
  children: React.ReactNode;
  onSelect: () => void;
  /**
   * A keyboard shortcut, and only that. Drawn as a keycap.
   *
   * IT USED TO TAKE ANYTHING. An agent's health word went in here, and so did a thread's relative
   * timestamp — so the right-hand column read `⌘P` on one row and `degraded` or `26m ago` on the
   * next, which teaches somebody scanning the palette that the column means nothing. A slot that
   * accepts two kinds of thing ends up meaning neither.
   */
  kbd?: string;
  /** Trailing metadata — a state, a timestamp. Not a key, and drawn as prose. */
  meta?: string;
  disabled?: boolean;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      disabled={disabled}
      className="flex items-center justify-between gap-3 px-3 py-2 rounded-control text-label text-muted cursor-pointer data-[selected=true]:bg-active data-[selected=true]:text-ink data-[disabled=true]:opacity-40"
    >
      <span className="flex items-center gap-2 min-w-0">{children}</span>
      {meta && <span className="shrink-0 text-tiny tabular-nums text-faint">{meta}</span>}
      {/* A KEY LOOKS LIKE A KEY. Unstyled grey text reads as metadata, which is precisely the
          confusion this slot was already in; the app has a chip primitive with a hairline for
          exactly this shape of thing. */}
      {kbd && (
        <kbd className={`${chipClass({ size: "sm", mono: true, tone: "faint" })} shrink-0 shadow-[inset_0_0_0_1px_theme(colors.hair)]`}>
          {kbd}
        </kbd>
      )}
      {/* D7: ONE AFFORDANCE ON THE ROW COMPONENT, NOT TWENTY-ONE REGISTRY ENTRIES.
          Every row in this palette does the same thing — it takes you somewhere — so what the
          mark says is "this navigates", which is a property of the ROW rather than of any of the
          twenty-one verbs in it. A leading mark saying WHAT each row opens is a different piece of
          work with its own reasoning, and starting it here by accident is exactly what §4 asks
          this comment to prevent.

          `aria-hidden`, because the row's own text is already its accessible name and a screen
          reader announcing "opens" after every one of twenty-one items is noise. */}
      <span className="shrink-0 text-faint" aria-hidden>
        <Icon.palette.jump size={ICON.badge} />
      </span>
    </Command.Item>
  );
}
