// The tray that stands up behind the composer and says which agent it is working on.
//
// The product owner's design, 2026-09-10: a darker, narrower box behind the card, showing 32px above
// it and running 16px on underneath (`-mb-4` against the `pb-4`), so the card overlaps its lower edge
// and casts its shadow across it. 32px rather than the 28px it started at, so the 24px controls in it
// have 4px of tray above and below them instead of nearly touching the card — and no more than that,
// because a tray standing much taller stops reading as something behind the composer.
//
// It is `bg-chrome`, a step darker than the `bg-active` it started on, which read as barely there
// against the page; the controls on it darken further when hovered (`bg-grip` at 60%), the product
// owner's call — a tray that lightened under the pointer read as a hole punched in it rather than a
// control pressed into it. Its own mark is a closed folder (`composer.tray`), the product owner's
// pick: the tray is the context the composer works in, the way a project folder is. The agents
// listed in its dropdown keep the agent mark.
//
// AT ITS RIGHT END, WHILE A NEW AGENT IS BEING DESCRIBED, the connector picker — see TrayConnectors.
// The same selection the chips above the composer used to hold, which is why it appears exactly
// when they did and nowhere else: an existing agent's connectors are part of the agent, not a pick.
// At the far end rather than beside the agent, the product owner's call on 2026-09-11, so the two
// read as separate things — what the composer works on, and what the new agent gets.
//
// TWO STATES, AND THE TRAY IS HOW YOU MOVE BETWEEN THEM:
//
//   An agent is chosen — the tray names it. Hovering offers ×, which takes it out of the composer
//   the way New does (`startNewAgent`), so the next message plans a new agent.
//
//   None is — the tray says "Choose agent". Its dropdown opens on a search box and the two agents
//   last worked in (`recentAgents`); every other agent is a search away, which keeps the list short
//   in a workspace of forty. Picking a row selects that agent exactly as the sidebar would. In a
//   workspace with no agents yet, the dropdown says so and where the first one comes from.
//
// NOTHING IS EVER CHOSEN FOR YOU. The recents are offered, not opened: a composer that quietly
// started working on an agent nobody picked is the fault buildStore's `setAgents` records fixing.
//
// No tray in an operate thread: that conversation is bound to its deployed agent, and there is
// nothing to take out or put in.

import { useMemo, useRef, useState } from "react";
import type { AgentSummary } from "../../types.ts";
import { Icon } from "../../lib/icons/registry.ts";
import { ICON } from "../../lib/tokens.ts";
import { recentAgents } from "../../lib/recentAgent.ts";
import { selectAgent } from "../../lib/selection.ts";
import { startNewAgent } from "../../lib/newAgent.ts";
import { useThreadStore } from "../../store/threadStore.ts";
import { ChevronDownIcon, XIcon } from "../panelIcons.tsx";
import { Truncate } from "../Truncate.tsx";
import { Popover, PopoverNote, PopoverRow } from "./Popover.tsx";
import { TrayConnectors, type TrayConnector } from "./TrayConnectors.tsx";

/** How many agents the chooser offers before anybody types. The rest are a search away. */
const RECENT_SHOWN = 2;
/** How many matches a search lists. Past that the query is too loose to be worth scrolling. */
const MATCHES_SHOWN = 8;

export function AgentTray({
  agent,
  agents,
  operating,
  connectors,
}: {
  /** The agent the composer is working on, if one is chosen. */
  agent: AgentSummary | undefined;
  /** Every agent in the workspace, for the chooser. */
  agents: readonly AgentSummary[];
  operating: boolean;
  /** The connector picker, while a new agent is being described. See the header. */
  connectors?: {
    options: readonly TrayConnector[];
    selected: readonly string[];
    onToggle: (id: string) => void;
    disabled?: boolean;
  };
}) {
  // Pushed to the tray's right end by `ml-auto`, whatever the left holds.
  const picker = connectors && (
    <span className="ml-auto inline-flex shrink-0 pl-2">
      <TrayConnectors {...connectors} />
    </span>
  );
  if (agent) {
    return (
      <Tray>
        <span className="inline-flex shrink-0 text-muted" aria-hidden>
          <Icon.composer.tray size={ICON.sm} />
        </span>
        <Truncate>{agent.name}</Truncate>
        {!operating && (
          <button
            type="button"
            onClick={startNewAgent}
            aria-label={`Remove ${agent.name} from the composer`}
            title={`Remove ${agent.name} — the next message plans a new agent`}
            // Revealed by hovering the tray, and by keyboard focus, so it is never a control that
            // exists only for a pointer.
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-control text-muted opacity-0
              transition-opacity duration-fast hover:bg-grip/60 hover:text-ink group-hover:opacity-100
              focus-visible:opacity-100 focus-visible:outline-none focus-visible:shadow-focusring"
          >
            <XIcon size={ICON.xs} />
          </button>
        )}
        {picker}
      </Tray>
    );
  }
  if (operating) return null;
  return (
    <Tray>
      <Chooser agents={agents} />
      {picker}
    </Tray>
  );
}

function Tray({ children }: { children: React.ReactNode }) {
  return (
    <div className="group mx-4 -mb-4 rounded-t-xl bg-chrome px-3 pb-4 text-caption text-ink">
      <div className="flex h-8 items-center gap-1.5">{children}</div>
    </div>
  );
}

function Chooser({ agents }: { agents: readonly AgentSummary[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const threads = useThreadStore((s) => s.threads);

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => {
    if (q) return agents.filter((a) => a.name.toLowerCase().includes(q)).slice(0, MATCHES_SHOWN);
    return recentAgents(agents, threads)
      .slice(0, RECENT_SHOWN)
      .flatMap((id) => agents.filter((a) => a.agent_id === id));
  }, [agents, threads, q]);

  const close = (): void => {
    setOpen(false);
    setQuery("");
  };
  const choose = (agentId: string): void => {
    close();
    selectAgent(agentId);
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="menu"
        aria-expanded={open}
        className="-ml-1.5 inline-flex h-6 items-center gap-1.5 rounded-control px-1.5 text-muted transition-colors
          duration-fast hover:bg-grip/60 hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
      >
        <span className="inline-flex shrink-0" aria-hidden>
          <Icon.composer.tray size={ICON.sm} />
        </span>
        Choose agent
        <span className={`inline-flex transition-transform duration-fast ${open ? "rotate-180" : ""}`} aria-hidden>
          <ChevronDownIcon size={ICON.xs} />
        </span>
      </button>
      <Popover open={open} onClose={close} triggerRef={triggerRef} label="Choose an agent" width={280}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search agents"
          aria-label="Search agents"
          // Enter takes the first row, and ↓ steps into the list — the popover's own arrow keys
          // leave a text field alone, so the field has to hand focus over itself.
          onKeyDown={(e) => {
            if (e.key === "Enter" && shown[0]) {
              e.preventDefault();
              choose(shown[0].agent_id);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              listRef.current?.querySelector<HTMLElement>("button")?.focus();
            }
          }}
          className="mb-1 w-full rounded-input border border-edge bg-elevated px-2.5 py-1.5 text-caption text-ink
            outline-none placeholder:text-faint focus-visible:shadow-focusring"
        />
        <div ref={listRef}>
          {!q && shown.length > 0 && <div className="px-2 pb-0.5 pt-1 text-tiny text-faint">Recent</div>}
          {shown.map((a) => (
            <PopoverRow
              key={a.agent_id}
              label={a.name}
              icon={<Icon.nav.agents size={ICON.sm} />}
              onSelect={() => choose(a.agent_id)}
            />
          ))}
          {shown.length === 0 && (
            <PopoverNote>
              {q
                ? <>No agent matches “{query.trim()}”.</>
                : "No agents in this workspace yet — describe one below and Jaroku will build it."}
            </PopoverNote>
          )}
        </div>
      </Popover>
    </div>
  );
}
