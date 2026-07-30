// Plan card — the pre-generation gate's trust surface, and the sibling of DiffCard.
//
// DiffCard exists because the AI never silently edits files (doc §4.4). This exists for the
// same reason one step earlier: the AI never silently *builds* one. It shows what the agent
// would be — its tools, its state, its graph — while that is still an opinion rather than a
// project on disk, and generation does not start until the user says so.
//
// The one distinction the whole card is organised around is reviewed-connector vs bespoke.
// Reviewed templates are audited code copied in verbatim and read-only; bespoke tools are
// about to be invented by a model. A user deciding whether to spend a generation is really
// deciding whether they trust that second list, so it is never mixed into the first.
//
// That distinction now carries a colour: teal for reviewed, violet for bespoke (see lib/tokens.ts).
// They are category accents, not status — they say what kind of thing a tool is, never how it is
// doing. State types moved onto the third accent for the same reason: they were amber, which in
// this app means "running", and a type annotation is not a state of progress.

import { useState } from "react";
import type { PlanTurn } from "../store/chatStore.ts";
import { sendDiscardPlan, sendGenerate } from "../lib/socket.ts";
import { useUiStore } from "../store/uiStore.ts";
import { ACCENT, ICON } from "../lib/tokens.ts";
import { noteKind } from "../lib/noteKind.ts";
import { BRAND_COLOR } from "../lib/icons.tsx";
import { primaryBtn, quietBtn } from "./buttons.ts";
import { ChevronDownIcon } from "./composerIcons.tsx";
import { CHIP, Prose } from "./InlineCode.tsx";
import { StatusBadge, StatusDot } from "./StatusBadge.tsx";
import {
  AlertTriangleIcon,
  DatabaseIcon,
  GitBranchIcon,
  InfoIcon,
  LightbulbIcon,
  LockIcon,
  PlugIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "./panelIcons.tsx";
import { HighImpactBadge, McpBadge } from "./McpBadge.tsx";
import { allMcpTools, useMcpStore } from "../store/mcpStore.ts";

/**
 * Which sections the user has folded away, for as long as the panel is open.
 *
 * A section's open state is a fact about the reader, not about the plan, and it was living in the
 * component — so it evaporated every time the card unmounted. Switching to another agent and back
 * re-expanded everything you had just put away, which makes the control feel like it didn't work.
 *
 * Module-level rather than in uiStore on purpose. Nothing outside this file needs to know or ask,
 * nothing re-renders when it changes, and this pass is not supposed to add anything to a store. It
 * lives as long as the tab does and no longer, which is exactly the promised lifetime: a reload
 * starts fresh, because a plan you come back to tomorrow should show you all of itself.
 *
 * Keyed per plan, not per label, so folding "reviewed tools" on one plan doesn't hide the reviewed
 * tools of the next one — the section a gate exists to show should never arrive pre-hidden.
 *
 * Only non-default state is stored: an open section deletes its key rather than writing `false`, so
 * a long session doesn't accumulate an entry per section per plan.
 */
const foldedSections = new Map<string, true>();

/**
 * A titled block of the plan.
 *
 * The label was a 10px uppercase grey run-on that carried its own explanation inside it
 * ("Reviewed connector tools — audited, copied in as-is"), which made the heading the longest
 * line in the section and buried the one word you actually scan for. Now the heading is just the
 * noun, and the explanation sits under it as a subordinate line — visibly a caption rather than
 * part of the title.
 *
 * `accent` colours the icon only, never the text. The icon is the thing being scanned for; a
 * coloured heading would compete with the rows underneath it.
 *
 * The fold behaviour here is local to the plan card, but it is the generic thing: a labelled block
 * with a count that can be put away. The step-detail panel has the same problem with a long tool
 * output, and the graph view's node inspector will. Lifting this into a shared component is the
 * obvious next step whenever a second caller appears — it is not lifted now because one caller does
 * not tell you which parts are general.
 */
function Section({
  icon,
  label,
  note,
  accent,
  count,
  scope,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  note?: string;
  accent?: string;
  /** Identifies the plan this section belongs to, so folds are remembered per plan. */
  scope: string;
  /**
   * How many rows follow. Shown because "how much of this plan is invented code?" is the question
   * the gate exists to answer, and counting rows to find out is work the heading can do. It also
   * gives a long list a size before the user starts scrolling it.
   */
  count?: number;
  children: React.ReactNode;
}) {
  const key = `${scope}:${label}`;
  const [open, setOpen] = useState(() => !foldedSections.has(key));
  const toggle = () =>
    setOpen((wasOpen) => {
      if (wasOpen) foldedSections.set(key, true);
      else foldedSections.delete(key);
      return !wasOpen;
    });
  return (
    <div className="mt-5 first:mt-0">
      {/* The whole header is the control, not just the chevron — a 12px target for a thing you
          will hit repeatedly is a target you miss. */}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="group flex w-full items-center gap-1.5 text-left"
        title={open ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
      >
        <span className="shrink-0 flex items-center" style={accent ? { color: accent } : undefined}>
          {icon}
        </span>
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted">{label}</span>
        {/* Normally the count is only worth showing for more than one row. Collapsed, it is the
            only thing left saying how much is behind the header, so it always shows. */}
        {count !== undefined && (count > 1 || !open) && (
          <span className="font-mono text-[11px] text-faint tabular-nums">{count}</span>
        )}
        {/* Right-aligned rather than leading, so opening a section doesn't shift the icon and
            label the rest of the card is aligned to. Rotation rather than two glyphs: the same
            mark turning is what says these are two states of one thing. */}
        <span
          className={`ml-auto shrink-0 flex items-center text-faint transition-transform duration-150 group-hover:text-muted ${
            open ? "" : "-rotate-90"
          }`}
          aria-hidden
        >
          <ChevronDownIcon size={ICON.xs} />
        </span>
      </button>
      {open && (
        <>
          {note && <div className="mt-1 text-[11px] text-faint">{note}</div>}
          <div className="mt-2.5">{children}</div>
        </>
      )}
    </div>
  );
}

/**
 * One step of the graph.
 *
 * The graph section is the only ordered list in the plan — "the agent reads the request, the tools
 * run, the agent loops until it can answer" is a sequence, and the steps are meaningless in any
 * other order. It rendered with the same faint `·` as the notes section, which says the opposite:
 * a bulleted list is by definition a set, where order is incidental.
 *
 * So the marker carries the ordinal, and a hairline rail joins consecutive steps into one run. The
 * rail is what makes it read as a flow rather than a numbered list — it says these steps are
 * connected, not merely counted. It stops after the last step, so the sequence visibly ends.
 *
 * The number is mono and tabular so a two-digit step doesn't shift the text column beside it.
 */
function GraphStep({
  n,
  last,
  children,
}: {
  n: number;
  last: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-2 text-[12px]">
      <span className="flex shrink-0 flex-col items-center" aria-hidden>
        <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-active font-mono text-[10px] leading-none text-muted tabular-nums">
          {n}
        </span>
        {!last && <span className="mt-1 w-px flex-1 bg-hair" />}
      </span>
      {/* Padding under every step but the last: the rail needs room to be visible between two
          markers, and a one-line step would otherwise leave it nothing to draw. */}
      <span className={`min-w-0 text-muted ${last ? "" : "pb-2.5"}`}>{children}</span>
    </div>
  );
}

/**
 * Which reviewed connector a tool came out of.
 *
 * This is provenance, not description — "gmail" here means "this is the audited Gmail template",
 * which is the whole reason the tool is trustworthy. As flowing faint text it read as an
 * afterthought trailing the name. A chip makes it a label attached to the tool, and picks up the
 * connector's own brand colour so it matches the connector buttons in the composer below.
 */
function ConnectorChip({ id }: { id: string }) {
  const brand = BRAND_COLOR[id];
  return (
    // Same CHIP as an identifier in a sentence — one declaration, so the two can never drift.
    // Muted rather than ink because this is a label *about* the tool, not the tool's own name.
    <span className={`inline-flex items-center gap-1.5 ${CHIP} text-muted`}>
      {brand && (
        <span
          className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
          style={{ background: brand }}
          aria-hidden
        />
      )}
      {id}
    </span>
  );
}

/**
 * One tool in the plan.
 *
 * Both lists were inline text: a glyph, a name and a description flowing together in one flex
 * line, so a tool and its explanation were the same object and neither had a fixed place to look.
 * This gives every tool the same four slots in the same order — icon, name, description, status —
 * so the eye can track down a column instead of re-reading each line.
 *
 * Sizing is the part that matters, and the naive version of it is wrong. Making the name shrink-0
 * and the description min-w-0 protects the name, but a 60-character tool name then squeezes the
 * description to zero width and it disappears entirely — the row silently loses information rather
 * than running out of room.
 *
 * So name and description share one flowing container instead of competing for the row. The
 * description wraps under a long name rather than vanishing, and the name only breaks internally
 * when it genuinely cannot fit on a line by itself (overflow-wrap: anywhere), which beats
 * overflowing the card. Icon and status stay fixed-width outside the flow, so the status column
 * stays aligned no matter how tall a row grows.
 */
function ToolRow({
  icon,
  accent,
  name,
  description,
  status,
}: {
  icon: React.ReactNode;
  accent: string;
  name: string;
  description?: React.ReactNode;
  status?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2 py-1">
      <span className="shrink-0 flex items-center h-[19px]" style={{ color: accent }} aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1 text-[12px]">
        <span className="font-mono font-medium text-ink [overflow-wrap:anywhere]">{name}</span>
        {description && <span className="ml-2 text-muted">{description}</span>}
      </span>
      {status && (
        <span className="shrink-0 flex items-center h-[19px] pl-1">{status}</span>
      )}
    </div>
  );
}

/**
 * One "worth knowing" note.
 *
 * The section held two different kinds of statement under one grey bullet. A rule — "drafts replies
 * only; never sends" — bounds what the agent can do, and missing it is how a user is surprised
 * later. A description — "current_email is cleared between requests" — is a fact about how it
 * works. Rendering them identically made the reader classify every line themselves.
 *
 * A lock for the rules, an info glyph for the rest (see lib/noteKind.ts for how they're told
 * apart), and one step of text contrast: constraints in ink, notes in muted. The icons stay grey
 * rather than taking an accent — the accents mean "what kind of thing is this" for tools and state,
 * and a note is neither. The distinction here is weight, not category.
 */
function Note({ text, vocabulary }: { text: string; vocabulary: readonly string[] }) {
  const constraint = noteKind(text) === "constraint";
  return (
    <div className="flex gap-2 py-1 text-[12px]">
      <span
        className={`shrink-0 flex items-center h-[19px] ${constraint ? "text-muted" : "text-faint"}`}
        title={constraint ? "A rule this agent will follow" : "Worth knowing about how it works"}
      >
        {constraint ? <LockIcon size={ICON.xs} /> : <InfoIcon size={ICON.xs} />}
      </span>
      <span className={`min-w-0 ${constraint ? "text-ink" : "text-muted"}`}>
        <Prose text={text} vocabulary={vocabulary} />
      </span>
    </div>
  );
}

/**
 * The card the plan lives in — every status, including streaming and error.
 *
 * A proposal and its execution are two different moments, and they were rendering as one
 * continuous column: the plan ran straight into "Generated 7 files" with nothing between them.
 * This bounds the proposal so the eye can tell where the opinion ends and the thing that actually
 * happened begins.
 *
 * A hairline and one step of elevation, per doc §4.2 — enough to bound the block, not enough to
 * read as a box. Every branch shares it so the card settles in place as it streams rather than
 * changing shape underneath the text (doc §4.3).
 */
function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[10px] border border-hair bg-panel/40 px-3.5 py-3 text-[12px]">
      {children}
    </div>
  );
}

export function PlanCard({ turn }: { turn: PlanTurn }) {
  const prefillChat = useUiStore((s) => s.prefillChat);

  // Discarding is "not this — something else", not "never mind". Handing the brief back to the
  // composer (the same prefill One-Click Fix uses) means redirecting is an edit to what you
  // already wrote rather than retyping it from memory.
  const discard = () => {
    if (!turn.planId) return;
    sendDiscardPlan(turn.planId);
    prefillChat(turn.prompt);
  };

  // Streaming: raw prose with a caret, in the same container the settled card uses, so the
  // structured render settles in place instead of jumping (doc §4.3 — everything streams).
  if (turn.status === "streaming") {
    return (
      <Card>
        <div className="text-run">{turn.revision > 1 ? "Revising the plan…" : "Planning…"}</div>
        {turn.raw && (
          <div className="mt-2 whitespace-pre-wrap break-words text-muted">
            {turn.raw}
            <span className="text-faint animate-pulse">▋</span>
          </div>
        )}
      </Card>
    );
  }

  if (turn.status === "error") {
    return (
      <Card>
        <div className="text-err">Couldn’t write a plan — {turn.error}</div>
        <div className="mt-2 text-faint">Nothing was generated — no files were written.</div>
      </Card>
    );
  }

  const plan = turn.plan;
  const mcpServers = useMcpStore((s) => s.servers);
  const connectorTools = plan?.tools.filter((t) => t.origin === "connector") ?? [];
  const bespokeTools = plan?.tools.filter((t) => t.origin === "bespoke") ?? [];
  const mcpTools = plan?.tools.filter((t) => t.origin === "mcp") ?? [];
  // The impact classification lives in the registry, not in the plan text — the plan says
  // WHICH tools, the registry says what each one costs to run.
  const mcpImpact = new Map(
    allMcpTools(mcpServers).map((t) => [t.name, t] as const),
  );
  // The parser makes nothing of a response that ignored the protocol. Rather than hide it,
  // fall back to the raw text — a plan the user can read is worth more than a tidy blank.
  const degraded = !plan || (plan.tools.length === 0 && plan.state.length === 0 && plan.graph.length === 0);
  const decided = turn.status !== "pending" && turn.status !== "stale";

  // Folds are remembered against the plan, not the turn, so a revision that supersedes this one
  // does not inherit what the reader hid on a plan they were still deciding about.
  const scope = turn.planId ?? turn.id;

  // What this plan calls things. Every prose slot below is tokenized against it, so a tool named in
  // a note is recognised rather than guessed at — see lib/inlineCode.ts.
  const vocabulary = [
    ...(plan?.tools.map((t) => t.name) ?? []),
    ...(plan?.state.map((f) => f.name) ?? []),
  ];

  return (
    <Card>
      <div className="flex items-center gap-2 pb-2.5 border-b border-hair animate-slide-in">
        <span className="text-ink font-medium">Here’s the plan</span>
        {turn.revision > 1 && (
          <span className="font-mono text-faint text-[11px] tabular-nums">
            revision {turn.revision}
          </span>
        )}
        {turn.status === "accepted" && (
          <StatusBadge state="ok" label="approved" title="Generated from this plan" />
        )}
        {turn.status === "superseded" && (
          <StatusBadge
            state="neutral"
            label="superseded"
            title="A newer revision of this plan replaced it"
          />
        )}
        {turn.status === "discarded" && (
          <StatusBadge state="neutral" label="discarded" title="This plan was not generated" />
        )}
        {turn.status === "stale" && (
          // Amber, not red — nothing failed. The plan simply no longer describes what would be
          // built, and needs re-planning before it can be spent.
          <StatusBadge
            state="pending"
            icon={AlertTriangleIcon}
            label="out of date"
            title="The connectors changed after this plan was written"
          />
        )}
      </div>

      <div className={`mt-4 ${decided || turn.status === "stale" ? "opacity-60" : ""}`}>
        {degraded ? (
          <div className="whitespace-pre-wrap break-words text-muted">
            {turn.raw}
          </div>
        ) : (
          <>
            {connectorTools.length > 0 && (
              <Section
                scope={scope}
                icon={<ShieldCheckIcon />}
                label="Reviewed tools"
                note="Audited connector templates, copied in as-is."
                accent={ACCENT.reviewed}
                count={connectorTools.length}
              >
                {connectorTools.map((t) => (
                  <ToolRow
                    key={t.name}
                    icon={<ShieldCheckIcon />}
                    accent={ACCENT.reviewed}
                    name={t.name}
                    description={t.connectorId && <ConnectorChip id={t.connectorId} />}
                    status={
                      <StatusDot
                        state="ok"
                        color={ACCENT.reviewed}
                        title="Audited — this template is copied in unchanged"
                      />
                    }
                  />
                ))}
              </Section>
            )}

            {bespokeTools.length > 0 && (
              <Section
                scope={scope}
                icon={<SparklesIcon />}
                label="Bespoke tools"
                note="Will be written by the model for this agent."
                accent={ACCENT.bespoke}
                count={bespokeTools.length}
              >
                {bespokeTools.map((t) => (
                  <ToolRow
                    key={t.name}
                    icon={<SparklesIcon />}
                    accent={ACCENT.bespoke}
                    name={t.name}
                    description={
                      <Prose
                        text={t.summary.replace(/^bespoke[;:]?\s*/i, "")}
                        vocabulary={vocabulary}
                      />
                    }
                    // Deliberately not a check. The reviewed rows earn theirs by having been
                    // audited; this code does not exist yet, and a tick here would say the one
                    // thing about a bespoke tool that is never true.
                    status={
                      <span
                        className="text-[10px] uppercase tracking-wider"
                        style={{ color: ACCENT.bespoke }}
                        title="Not yet written — this tool will be generated, and is worth reading"
                      >
                        new
                      </span>
                    }
                  />
                ))}
              </Section>
            )}

            {mcpTools.length > 0 && (
              <Section
                scope={scope}
                icon={<PlugIcon />}
                label="External MCP tools"
                note="Third-party code Jaroku has not reviewed. Only what you selected is given to this agent."
                accent={ACCENT.mcp}
                count={mcpTools.length}
              >
                {mcpTools.map((t) => {
                  const known = mcpImpact.get(t.name);
                  return (
                    <ToolRow
                      key={t.name}
                      icon={<PlugIcon />}
                      accent={ACCENT.mcp}
                      name={t.name}
                      description={
                        <span className="inline-flex flex-wrap items-center gap-1.5">
                          {/* Which server, always. Two servers can advertise one name and
                              mean entirely different things by it. */}
                          {(known?.serverLabel ?? t.mcpServerId) && (
                            <span className="text-muted">{known?.serverLabel ?? t.mcpServerId}</span>
                          )}
                          <Prose
                            text={t.summary.replace(/^mcp[;:]?\s*/i, "")}
                            vocabulary={vocabulary}
                          />
                        </span>
                      }
                      // Two marks, answering two questions: where it came from, and whether
                      // running it will stop and ask. A tool can be external and read-only,
                      // and one combined mark would make every MCP tool look alarming.
                      status={
                        <span className="inline-flex items-center gap-1">
                          {known?.impact === "high" && (
                            <HighImpactBadge reason={known.impact_reason} />
                          )}
                          <McpBadge />
                        </span>
                      }
                    />
                  );
                })}
              </Section>
            )}

            {plan.state.length > 0 && (
              <Section scope={scope} icon={<DatabaseIcon />} label="State" accent={ACCENT.state} count={plan.state.length}>
                {/* Same flowing shape as a tool row, for the same reason: a long field name must
                    not be able to squeeze the purpose out of existence. */}
                {plan.state.map((f) => (
                  <div key={f.name} className="py-1 text-[12px]">
                    <span className="font-mono text-ink [overflow-wrap:anywhere]">{f.name}</span>
                    {f.type && (
                      <span className="ml-2 font-mono text-stateful [overflow-wrap:anywhere]">
                        {f.type}
                      </span>
                    )}
                    {f.purpose && (
                      <span className="ml-2 text-muted">
                        <Prose text={f.purpose} vocabulary={vocabulary} />
                      </span>
                    )}
                  </div>
                ))}
              </Section>
            )}

            {plan.graph.length > 0 && (
              <Section scope={scope} icon={<GitBranchIcon />} label="Graph" count={plan.graph.length}>
                {plan.graph.map((g, i) => (
                  <GraphStep key={i} n={i + 1} last={i === plan.graph.length - 1}>
                    <Prose text={g} vocabulary={vocabulary} />
                  </GraphStep>
                ))}
              </Section>
            )}

            {plan.notes.length > 0 && (
              <Section scope={scope} icon={<LightbulbIcon />} label="Worth knowing" count={plan.notes.length}>
                {plan.notes.map((n, i) => (
                  <Note key={i} text={n} vocabulary={vocabulary} />
                ))}
              </Section>
            )}

            {!plan.complete && (
              <div className="mt-5 flex gap-2 text-[11px] text-faint">
                <span className="shrink-0 mt-[3px]">
                  <AlertTriangleIcon size={ICON.xs} />
                </span>
                <span>The plan was cut short — it may be missing a section.</span>
              </div>
            )}
          </>
        )}

        {/* Mismatches between the plan and the connectors actually ticked. These are the
            wrong-direction warnings the whole gate exists to surface. */}
        {turn.warnings.length > 0 && (
          <div className="mt-5 space-y-1">
            {turn.warnings.map((w, i) => (
              <div key={i} className="flex gap-2 text-[11px] text-run">
                <span className="shrink-0 mt-[3px]">
                  <AlertTriangleIcon size={ICON.xs} />
                </span>
                <span className="min-w-0">
                  <Prose text={w} vocabulary={vocabulary} />
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {turn.status === "stale" && (
        <div className="mt-4 text-[11px] text-muted">
          The connectors changed after this was written — say what you want and it will be
          re-planned against the new selection.
        </div>
      )}

      {(turn.status === "pending" || turn.status === "stale") && (
        // The decision is the card's footer, not another line of its body — it sits on a divider
        // for the same reason the title does.
        <div className="mt-5 pt-3.5 border-t border-hair flex items-center gap-2">
          <button
            className={primaryBtn}
            disabled={turn.status === "stale"}
            title={
              turn.status === "stale"
                ? "This plan no longer matches the selected connectors — re-plan first"
                : "Generate the agent this plan describes"
            }
            onClick={() =>
              // The server rebuilds every field from the pending record; these are sent so
              // the command is well-formed, and the plan's own brief is the honest value.
              turn.planId && sendGenerate(turn.prompt, [], undefined, turn.planId)
            }
          >
            Generate
          </button>
          <button
            className={quietBtn}
            onClick={discard}
          >
            Discard
          </button>
          <span className="text-faint text-[11px]">or say what to change</span>
          {turn.usage && (
            <span className="ml-auto font-mono text-faint text-[11px] tabular-nums">
              ${turn.usage.cost_usd.toFixed(4)}
            </span>
          )}
        </div>
      )}
    </Card>
  );
}
