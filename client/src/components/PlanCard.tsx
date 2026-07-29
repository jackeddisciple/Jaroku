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

import type { PlanTurn } from "../store/chatStore.ts";
import { sendDiscardPlan, sendGenerate } from "../lib/socket.ts";
import { useUiStore } from "../store/uiStore.ts";
import { ACCENT } from "../lib/tokens.ts";
import { BRAND_COLOR } from "../lib/icons.tsx";
import { StatusBadge, StatusDot } from "./StatusBadge.tsx";
import {
  AlertTriangleIcon,
  DatabaseIcon,
  GitBranchIcon,
  LightbulbIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "./panelIcons.tsx";

const btn =
  "rounded px-3 py-1.5 text-[12px] bg-panel text-ink hover:bg-active transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

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
 */
function Section({
  icon,
  label,
  note,
  accent,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  note?: string;
  accent?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-5 first:mt-0">
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 flex items-center" style={accent ? { color: accent } : undefined}>
          {icon}
        </span>
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted">{label}</span>
      </div>
      {note && <div className="mt-0.5 text-[11px] text-faint">{note}</div>}
      <div className="mt-2">{children}</div>
    </div>
  );
}

function Line({ children }: { children: React.ReactNode }) {
  return <div className="flex gap-2 text-[12px]">{children}</div>;
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
    <span className="inline-flex items-center gap-1.5 rounded bg-active px-1.5 py-[1px] font-mono text-[11px] text-muted align-middle">
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
 * Sizing is the part that matters. The name is shrink-0 so an identifier is never broken across
 * lines (a wrapped tool name reads as two tools), and the description is min-w-0 so it is the
 * thing that gives when space runs out. The icon and status slots are fixed width, which is what
 * keeps the name column aligned whether or not a row has a status.
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
    <div className="flex items-baseline gap-2 py-[3px]">
      <span
        className="shrink-0 flex items-center self-center"
        style={{ color: accent }}
        aria-hidden
      >
        {icon}
      </span>
      <span className="shrink-0 font-mono text-[12px] font-medium text-ink">{name}</span>
      {description && (
        <span className="min-w-0 text-[12px] text-muted">{description}</span>
      )}
      {status && <span className="ml-auto shrink-0 self-center flex items-center">{status}</span>}
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
          <div className="mt-1.5 whitespace-pre-wrap break-words text-muted">
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
        <div className="mt-1.5 text-faint">Nothing was generated — no files were written.</div>
      </Card>
    );
  }

  const plan = turn.plan;
  const connectorTools = plan?.tools.filter((t) => t.origin === "connector") ?? [];
  const bespokeTools = plan?.tools.filter((t) => t.origin === "bespoke") ?? [];
  // The parser makes nothing of a response that ignored the protocol. Rather than hide it,
  // fall back to the raw text — a plan the user can read is worth more than a tidy blank.
  const degraded = !plan || (plan.tools.length === 0 && plan.state.length === 0 && plan.graph.length === 0);
  const decided = turn.status !== "pending" && turn.status !== "stale";

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

      <div className={`mt-3 ${decided || turn.status === "stale" ? "opacity-60" : ""}`}>
        {degraded ? (
          <div className="whitespace-pre-wrap break-words text-muted">
            {turn.raw}
          </div>
        ) : (
          <>
            {connectorTools.length > 0 && (
              <Section
                icon={<ShieldCheckIcon />}
                label="Reviewed tools"
                note="Audited connector templates, copied in as-is."
                accent={ACCENT.reviewed}
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
                icon={<SparklesIcon />}
                label="Bespoke tools"
                note="Will be written by the model for this agent."
                accent={ACCENT.bespoke}
              >
                {bespokeTools.map((t) => (
                  <ToolRow
                    key={t.name}
                    icon={<SparklesIcon />}
                    accent={ACCENT.bespoke}
                    name={t.name}
                    description={t.summary.replace(/^bespoke[;:]?\s*/i, "")}
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

            {plan.state.length > 0 && (
              <Section icon={<DatabaseIcon />} label="State" accent={ACCENT.state}>
                {plan.state.map((f) => (
                  <Line key={f.name}>
                    <span className="font-mono text-ink shrink-0">{f.name}</span>
                    {f.type && <span className="font-mono text-stateful shrink-0">{f.type}</span>}
                    <span className="text-muted min-w-0">{f.purpose}</span>
                  </Line>
                ))}
              </Section>
            )}

            {plan.graph.length > 0 && (
              <Section icon={<GitBranchIcon />} label="Graph">
                {plan.graph.map((g, i) => (
                  <Line key={i}>
                    <span className="text-faint shrink-0">·</span>
                    <span className="text-muted min-w-0">{g}</span>
                  </Line>
                ))}
              </Section>
            )}

            {plan.notes.length > 0 && (
              <Section icon={<LightbulbIcon />} label="Worth knowing">
                {plan.notes.map((n, i) => (
                  <Line key={i}>
                    <span className="text-faint shrink-0">·</span>
                    <span className="text-muted min-w-0">{n}</span>
                  </Line>
                ))}
              </Section>
            )}

            {!plan.complete && (
              <div className="mt-4 flex gap-2 text-[11px] text-faint">
                <span className="shrink-0 mt-[3px]">
                  <AlertTriangleIcon size={12} />
                </span>
                <span>The plan was cut short — it may be missing a section.</span>
              </div>
            )}
          </>
        )}

        {/* Mismatches between the plan and the connectors actually ticked. These are the
            wrong-direction warnings the whole gate exists to surface. */}
        {turn.warnings.length > 0 && (
          <div className="mt-4 space-y-1">
            {turn.warnings.map((w, i) => (
              <div key={i} className="flex gap-2 text-[11px] text-run">
                <span className="shrink-0 mt-[3px]">
                  <AlertTriangleIcon size={12} />
                </span>
                <span className="min-w-0">{w}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {turn.status === "stale" && (
        <div className="mt-2 text-[11px] text-muted">
          The connectors changed after this was written — say what you want and it will be
          re-planned against the new selection.
        </div>
      )}

      {(turn.status === "pending" || turn.status === "stale") && (
        // The decision is the card's footer, not another line of its body — it sits on a divider
        // for the same reason the title does.
        <div className="mt-3.5 pt-3 border-t border-hair flex items-center gap-2">
          <button
            className={btn}
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
            className="rounded px-3 py-1.5 text-[12px] text-muted hover:text-ink transition-colors"
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
