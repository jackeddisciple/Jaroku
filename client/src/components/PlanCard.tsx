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
import {
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
      {note && <div className="mt-0.5 text-[11px] text-faint leading-relaxed">{note}</div>}
      <div className="mt-2">{children}</div>
    </div>
  );
}

function Line({ children }: { children: React.ReactNode }) {
  return <div className="flex gap-2 text-[12px] leading-relaxed">{children}</div>;
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
      <div className="text-[12px]">
        <div className="text-run">{turn.revision > 1 ? "Revising the plan…" : "Planning…"}</div>
        {turn.raw && (
          <div className="mt-1.5 whitespace-pre-wrap break-words text-muted leading-relaxed">
            {turn.raw}
            <span className="text-faint animate-pulse">▋</span>
          </div>
        )}
      </div>
    );
  }

  if (turn.status === "error") {
    return (
      <div className="text-[12px]">
        <div className="text-err">Couldn’t write a plan — {turn.error}</div>
        <div className="mt-1.5 text-faint">Nothing was generated — no files were written.</div>
      </div>
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
    <div className="text-[12px] animate-slide-in">
      <div className="flex items-center gap-2">
        <span className="text-ink">Here’s the plan</span>
        {turn.revision > 1 && <span className="text-faint text-[11px]">revision {turn.revision}</span>}
        {turn.status === "accepted" && <span className="text-ok text-[11px]">approved</span>}
        {turn.status === "superseded" && <span className="text-faint text-[11px]">superseded</span>}
        {turn.status === "discarded" && <span className="text-faint text-[11px]">discarded</span>}
        {turn.status === "stale" && <span className="text-run text-[11px]">out of date</span>}
      </div>

      <div className={decided || turn.status === "stale" ? "opacity-60" : ""}>
        {degraded ? (
          <div className="mt-2 whitespace-pre-wrap break-words text-muted leading-relaxed">
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
                  <Line key={t.name}>
                    <span className="text-reviewed shrink-0">✓</span>
                    <span className="font-mono text-ink">{t.name}</span>
                    {t.connectorId && <span className="font-mono text-faint">{t.connectorId}</span>}
                  </Line>
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
                  <Line key={t.name}>
                    <span className="text-bespoke shrink-0">+</span>
                    <span className="font-mono text-ink shrink-0">{t.name}</span>
                    <span className="text-muted min-w-0">{t.summary.replace(/^bespoke[;:]?\s*/i, "")}</span>
                  </Line>
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
              <div className="mt-2 text-[11px] text-faint">
                The plan was cut short — it may be missing a section.
              </div>
            )}
          </>
        )}

        {/* Mismatches between the plan and the connectors actually ticked. These are the
            wrong-direction warnings the whole gate exists to surface. */}
        {turn.warnings.length > 0 && (
          <div className="mt-2.5 space-y-0.5">
            {turn.warnings.map((w, i) => (
              <div key={i} className="flex gap-2 text-[11px] text-run leading-relaxed">
                <span className="shrink-0">!</span>
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
        <div className="mt-3 flex items-center gap-2">
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
    </div>
  );
}
