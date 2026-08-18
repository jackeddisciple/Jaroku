// §6's five tabs: Capabilities · Health · Deploy · Evals · Threads & Runs.
//
// THE RULE THAT DECIDES WHAT IS IN HERE is §3's, and it runs both ways: "If something appears as a
// small signal on a card, it expands into a full panel in the detail view. Nothing appears on a card
// that has no home in the detail view." So the card's one warning line about a missing credential is
// Capabilities in full; its one health pill is Health; its drift badge is Deploy. Nothing here is a
// fact the grid could not have shown a hint of, and nothing the grid hints at is missing here.
//
// CAPABILITIES IS THE DEFAULT, which §6 says and which is right for the same reason the tab exists:
// "everything this agent can touch, in one place" is the question somebody opening an agent is most
// often asking, and it is the one no other surface in this product answers whole.
//
// WHAT IS DELIBERATELY NOT HERE (§1): the live trace, the plan card, the diff card, and the MCP
// server registry itself. The first three live where they already live — the trace tab is one click
// away in the same panel. The registry is workspace-level configuration rather than an agent-level
// fact, so this shows the agent's GRANTS and links to the servers rather than restating them.

import { useState } from "react";
import { Chip } from "./Chip.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { McpBadge, HighImpactBadge } from "./McpBadge.tsx";
import { Truncate } from "./Truncate.tsx";
import { AgentSparkline } from "./AgentSparkline.tsx";
import { LayersIcon } from "./agentIcons.tsx";
import {
  ActivityIcon, DatabaseIcon, ExternalLinkIcon, HashIcon, KeyIcon, RocketIcon,
} from "./panelIcons.tsx";
import { openThreadAgent } from "../lib/threadNav.ts";
import { selectRun } from "../lib/selection.ts";
import { fmtCostPerRun } from "../lib/agentFormat.ts";
import { fmtLatency, relTime } from "../lib/format.ts";
import { ACCENT, ICON, STATUS, TEXT, TYPE } from "../lib/tokens.ts";
import { useUiStore } from "../store/uiStore.ts";
import { useThreadStore } from "../store/threadStore.ts";
import type { AgentDetailView } from "../types.ts";

type TabId = "capabilities" | "health" | "deploy" | "evals" | "threads";

const TABS: { id: TabId; label: string; icon: (p: { size?: number }) => React.ReactElement }[] = [
  { id: "capabilities", label: "Capabilities", icon: LayersIcon },
  { id: "health", label: "Health", icon: ActivityIcon },
  { id: "deploy", label: "Deploy", icon: RocketIcon },
  { id: "evals", label: "Evals", icon: DatabaseIcon },
  { id: "threads", label: "Threads & runs", icon: HashIcon },
];

/** A labelled block inside a tab. §9's middle nesting level: card → SECTION → well. */
function Section({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <section className="min-w-0">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className={TYPE.sectionLabel}>{label}</span>
        {hint && <span className="text-[10px] text-faint">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

/** One figure with its name under it. The `well` level. */
function Stat({ label, value, title }: { label: string; value: React.ReactNode; title?: string }) {
  return (
    <div className="min-w-0 rounded-control border border-hair px-2.5 py-2" title={title}>
      <div className="truncate text-[13px] tabular-nums text-ink">{value}</div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wider text-faint">{label}</div>
    </div>
  );
}

/** Tab 1 — everything this agent can touch, in one place. */
function Capabilities({ detail }: { detail: AgentDetailView }) {
  const a = detail.card;
  return (
    <div className="space-y-5 p-4">
      <Section label="Reviewed connectors" hint="audited templates, copied in verbatim">
        {a.connectors.length === 0 ? (
          <div className="text-[11px] text-faint">None.</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {a.connectors.map((c) => (
              <Chip key={c} size="sm" mono color={ACCENT.reviewed} title="A reviewed connector template">
                {c}
              </Chip>
            ))}
          </div>
        )}
      </Section>

      <Section label="Granted MCP tools" hint="third-party code Jaroku has not reviewed">
        {detail.tools.length === 0 ? (
          <div className="text-[11px] text-faint">None granted.</div>
        ) : (
          <div className="space-y-1">
            {detail.tools.map((t) => (
              <div key={t.ref} className="flex min-w-0 flex-col gap-1 rounded-control border border-hair px-2.5 py-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  {/* THE SAME BADGE THAT APPEARS EVERYWHERE AN MCP TOOL DOES. A second version of it
                      here would be a second thing to learn about the one mark whose whole job is to
                      be recognised instantly. */}
                  <McpBadge variant="compact" />
                  <Truncate className="min-w-0 flex-1 font-mono text-[11px] text-ink" title={t.ref}>
                    {t.ref}
                  </Truncate>
                  {t.impact === "high" && <HighImpactBadge reason={t.reason ?? undefined} />}
                  {/* A REF WHOSE SERVER IS GONE IS SHOWN, NOT DROPPED. It is why a tool the agent's
                      code calls will fail, which is exactly the thing worth seeing here. */}
                  {t.impact === null && (
                    <Chip size="sm" caps color={STATUS.error} className="shrink-0" title="This server is no longer in the workspace">
                      unresolved
                    </Chip>
                  )}
                </div>
                {/* THE STORED REASON, printed as stored. A classification summarised into one word
                    is a classification somebody has to take on trust. */}
                {t.reason && <div className="text-[11px] leading-[1.5] text-muted">{t.reason}</div>}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section label="Credentials" hint="names only — no value is ever carried here">
        {detail.credentials.length === 0 ? (
          <div className="text-[11px] text-faint">This agent requires none.</div>
        ) : (
          <div className="space-y-0.5">
            {detail.credentials.map((c) => (
              <div key={c.name} className="flex min-w-0 items-center gap-2 rounded-control px-2 py-1">
                <KeyIcon size={ICON.xs} className="shrink-0 text-faint" />
                <Truncate className="min-w-0 flex-1 font-mono text-[11px] text-ink">{c.name}</Truncate>
                {c.scope && (
                  <span className="shrink-0 text-[10px] text-faint" title={`Scoped to the ${c.scope}`}>
                    {c.scope}
                  </span>
                )}
                {/* ROSE, NOT AMBER, for the same reason the card's warning line is: amber means
                    running, and a missing credential is a problem rather than progress. */}
                <span
                  className="shrink-0 text-[10px] uppercase tracking-wider"
                  style={{ color: c.configured ? STATUS.ok : STATUS.error }}
                >
                  {c.configured ? "configured" : "missing"}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section label="Model">
        <div className="flex flex-wrap gap-1.5">
          <Chip size="sm" mono tone="muted" title="The provider this agent runs on by default">
            {a.default_provider}
          </Chip>
        </div>
      </Section>
    </div>
  );
}

/** Tab 2 — the validator's verdict on what is live, and what has happened since. */
function Health({ detail }: { detail: AgentDetailView }) {
  const a = detail.card;
  const settled = a.outcomes.filter((o) => o.outcome === "ok" || o.outcome === "error");
  const errorRate = settled.length === 0 ? null : a.outcomes.filter((o) => o.outcome === "error").length / settled.length;

  return (
    <div className="space-y-5 p-4">
      <Section label="Validator" hint="the verdict on the live version">
        <div className="rounded-control border border-hair px-2.5 py-2 text-[12px]">
          {a.version_source === null ? (
            <span className="text-muted">
              Nothing has been published, so nothing has been validated.
            </span>
          ) : a.version_source === "import" ? (
            <span style={{ color: TEXT.muted }}>
              v{a.current_version} was published as-is and never went through the validator.
            </span>
          ) : (
            <span style={{ color: STATUS.ok }}>
              v{a.current_version} passed the validator when it was published.
            </span>
          )}
        </div>
      </Section>

      <Section label="Recent runs" hint="the last ~20 — click a bar to open its trace">
        {a.outcomes.length === 0 ? (
          <div className="text-[11px] text-faint">Nothing has run yet.</div>
        ) : (
          <AgentSparkline outcomes={a.outcomes} height={20} />
        )}
      </Section>

      <div className="grid grid-cols-2 gap-2">
        <Stat
          label="Error rate"
          value={errorRate === null ? <span className="text-faint">—</span> : `${Math.round(errorRate * 100)}%`}
          title={settled.length === 0 ? "No settled runs to compute one from" : `${settled.length} settled runs`}
        />
        <Stat label="Runs, 7 days" value={a.runs_7d} />
        {/* NULL IS UNKNOWN, NEVER `0 ms`. A p95 of zero is a claim about speed rather than an
            admission that nothing has been measured. */}
        <Stat label="p50 latency" value={fmtLatency(detail.p50_ms)} />
        <Stat label="p95 latency" value={fmtLatency(detail.p95_ms)} />
        <Stat
          label="Cost per run, 7d"
          value={fmtCostPerRun(detail.cost_per_run_7d)}
          title="An agent that has not run in the window has no cost per run — that is unknown, not zero"
        />
        <Stat label="Cost per run, 30d" value={fmtCostPerRun(detail.cost_per_run_30d)} />
      </div>

      {/* §6: "A model with no pricing entry shows cost unknown and is excluded from any ranking." */}
      {!a.spend_known && (
        <div className="rounded-control border border-hair px-2.5 py-2 text-[11px]" style={{ color: STATUS.error }}>
          Something here ran on a model with no price entry, so every figure above is a floor.
        </div>
      )}

      {a.last_error && (
        <Section label="Last error">
          <pre className="max-h-40 overflow-auto rounded-control border border-hair px-2.5 py-2 font-mono text-[11px] leading-[1.6] text-muted">
            {a.last_error}
          </pre>
        </Section>
      )}
    </div>
  );
}

/** Tab 3 — where it is serving, from which version, and how far behind that is. */
function Deploy({ detail }: { detail: AgentDetailView }) {
  const a = detail.card;
  const setTab = useUiStore((s) => s.setRightTab);

  if (!a.deployment) {
    return (
      <EmptyState
        icon={RocketIcon}
        title="Not deployed"
        hint={
          <button onClick={() => setTab("deploy")} className="text-muted underline decoration-dotted hover:text-ink">
            Open the Deploy tab to put it on a URL
          </button>
        }
      />
    );
  }

  return (
    <div className="space-y-5 p-4">
      <Section label="Live URL">
        {a.deployment.url ? (
          <a
            href={a.deployment.url}
            target="_blank"
            rel="noreferrer noopener"
            className="flex min-w-0 items-center gap-1.5 rounded-control border border-hair px-2.5 py-2 text-[12px] text-ink transition-colors hover:border-edge"
          >
            <Truncate className="min-w-0 flex-1 font-mono">{a.deployment.url}</Truncate>
            <ExternalLinkIcon size={ICON.xs} className="shrink-0 text-faint" />
          </a>
        ) : (
          // NEVER A GUESS AT WHAT THE URL WILL BE. The deploy store is explicit about this and the
          // panel has to be too: a URL that has not been issued is not a URL.
          <div className="text-[11px] text-faint">The host has not issued one yet.</div>
        )}
      </Section>

      <div className="grid grid-cols-2 gap-2">
        <Stat label="Status" value={a.deployment.status} />
        <Stat
          label="Deployed from"
          value={a.deployment.version === null ? <span className="text-faint">unrecorded</span> : `v${a.deployment.version}`}
          title={
            a.deployment.version === null
              ? "This deploy predates the column that records it — never backfilled, because a guess would be a confident lie"
              : undefined
          }
        />
      </div>

      {a.drift && (
        <div
          className="rounded-control border border-hair px-2.5 py-2 text-[12px]"
          style={{ color: STATUS.error }}
        >
          Serving v{a.drift.deployed}; this agent is now at v{a.drift.current}. Redeploy to catch it up.
        </div>
      )}

      <Section label="Environment" hint="names only">
        {a.required_env.length === 0 ? (
          <div className="text-[11px] text-faint">None.</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {a.required_env.map((name) => (
              <Chip key={name} size="sm" mono tone={a.missing_env.includes(name) ? "ink" : "faint"}
                color={a.missing_env.includes(name) ? STATUS.error : undefined}>
                {name}
              </Chip>
            ))}
          </div>
        )}
      </Section>

      {/* REDEPLOY, CANCEL AND THE STREAMING BUILD LOG LIVE IN THE DEPLOY TAB, which already has all
          three and already targets the existing Railway service rather than creating a project. §1
          puts the trace, the plan and the diff out of scope for this tab on the same grounds: a
          second copy of a control is a second set of promises about what it does. */}
      <button
        onClick={() => setTab("deploy")}
        className="flex w-full items-center justify-center gap-1.5 rounded-control border border-hair px-2 py-1.5 text-[12px] text-muted transition-colors hover:border-edge hover:bg-active hover:text-ink"
      >
        <RocketIcon size={ICON.xs} /> Redeploy, cancel or read the build log
      </button>
    </div>
  );
}

/** Tab 4 — the datasets this agent is scored against, and the last comparison. */
function Evals({ detail }: { detail: AgentDetailView }) {
  const setTab = useUiStore((s) => s.setRightTab);
  const { datasets, last } = detail.evals;

  if (datasets.length === 0 && !last) {
    return (
      <EmptyState
        icon={DatabaseIcon}
        title="No datasets yet"
        hint={
          <button onClick={() => setTab("evals")} className="text-muted underline decoration-dotted hover:text-ink">
            Build one in the Evals tab
          </button>
        }
      />
    );
  }

  return (
    <div className="space-y-5 p-4">
      <Section label="Datasets" hint="belonging to this agent">
        {datasets.length === 0 ? (
          <div className="text-[11px] text-faint">None.</div>
        ) : (
          <div className="space-y-0.5">
            {datasets.map((d) => (
              <div key={d.id} className="flex min-w-0 items-center gap-2 rounded-control px-2 py-1">
                <Truncate className="min-w-0 flex-1 text-[12px] text-ink">{d.name}</Truncate>
                <span className="shrink-0 text-[10px] tabular-nums text-faint">
                  {d.example_count} example{d.example_count === 1 ? "" : "s"}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {last && (
        <Section label="Last eval">
          <div className="flex min-w-0 items-center gap-2 rounded-control border border-hair px-2.5 py-2">
            <span className="text-[12px] text-ink">{last.status}</span>
            <span className="text-[11px] text-faint">{relTime(last.started_at)}</span>
            {/* THE WINNING PROVIDER IS THE AGGREGATE'S ANSWER AND IS NOT RE-DERIVED HERE. §6 asks for
                it, and the eval dashboard computes it from per-leg scores; a second computation would
                be a second answer to "which provider won", and the two would disagree the first time
                a leg was retried. Null until the aggregate says. */}
            {last.winner && (
              <Chip size="sm" color={STATUS.ok} className="ml-auto" title="The winning provider">
                {last.winner}
              </Chip>
            )}
          </div>
        </Section>
      )}

      <button
        onClick={() => setTab("evals")}
        className="flex w-full items-center justify-center gap-1.5 rounded-control border border-hair px-2 py-1.5 text-[12px] text-muted transition-colors hover:border-edge hover:bg-active hover:text-ink"
      >
        <DatabaseIcon size={ICON.xs} /> Run an eval
      </button>
    </div>
  );
}

/**
 * Tab 5 — the only link from the artifact back to the conversation (§6).
 *
 * "THE ONLY LINK" IS WHY THIS TAB IS WORTH ITS SPACE. Everything else here describes what an agent
 * IS; this is where somebody goes back to what was said about it. Clicking a thread does exactly what
 * clicking one in the Threads tab does — `openThreadAgent` is the shared route — so there is one
 * behaviour for opening a session rather than two that could diverge.
 */
function ThreadsAndRuns({ detail }: { detail: AgentDetailView }) {
  const selectThread = useThreadStore((s) => s.selectThread);
  const requestResume = useThreadStore((s) => s.requestResume);
  const setTab = useUiStore((s) => s.setRightTab);

  return (
    <div className="space-y-5 p-4">
      <Section label="Threads" hint="sessions on this agent">
        {detail.threads.length === 0 ? (
          <div className="text-[11px] text-faint">Nothing has been started on it yet.</div>
        ) : (
          <div className="space-y-0.5">
            {detail.threads.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  selectThread(t.id);
                  requestResume();
                  openThreadAgent(detail.card.slug);
                }}
                className={`flex w-full min-w-0 items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors duration-fast hover:bg-active/40 ${
                  t.archived ? "opacity-60" : ""
                }`}
              >
                <Truncate className="min-w-0 flex-1 text-[12px] text-ink">{t.title}</Truncate>
                {t.archived && (
                  <span className="shrink-0 text-[10px] uppercase tracking-wider text-faint">archived</span>
                )}
                <span className="shrink-0 text-[10px] text-faint">{relTime(t.last_activity_at)}</span>
              </button>
            ))}
          </div>
        )}
      </Section>

      <Section label="Recent runs">
        {detail.runs.length === 0 ? (
          <div className="text-[11px] text-faint">None.</div>
        ) : (
          <div className="space-y-0.5">
            {detail.runs.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => {
                  // `selectRun` follows the run to its agent and closes any full-screen view, which
                  // is `lib/selection.ts`'s one invariant. Reaching into the trace store here would
                  // produce the chimera that module exists to prevent.
                  selectRun(r.id);
                  setTab("trace");
                }}
                className="flex w-full min-w-0 items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors duration-fast hover:bg-active/40"
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{
                    background:
                      r.status === "error" ? STATUS.error : r.status === "running" ? STATUS.pending : STATUS.ok,
                  }}
                  aria-hidden
                />
                <Truncate className="min-w-0 flex-1 font-mono text-[11px] text-muted">{r.model}</Truncate>
                <span className="shrink-0 text-[10px] text-faint">{relTime(r.started_at)}</span>
              </button>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

export function AgentTabs({ detail }: { detail: AgentDetailView }) {
  // CAPABILITIES IS THE DEFAULT (§6), and the state is per mount rather than global: which tab
  // somebody last read about ONE agent is not a preference about the next one.
  const [tab, setTab] = useState<TabId>("capabilities");

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-hair px-3 py-2">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            // §8: every tab is an icon, and every icon-only control carries a label and a tooltip.
            // The label rides beside the icon rather than replacing it, and the strip scrolls
            // horizontally when five of them do not fit — a label that disappeared at a width
            // nobody chose would leave somebody hunting five unnamed glyphs, which is the failure
            // "an icon nobody can name is a worse button than a text button" describes.
            title={label}
            aria-label={label}
            aria-pressed={tab === id}
            className={`flex shrink-0 items-center gap-1.5 rounded-control px-2.5 py-1.5 text-[12px] transition-colors duration-fast ${
              tab === id ? "bg-active text-ink" : "text-muted hover:text-ink"
            }`}
          >
            <Icon size={ICON.sm} />
            <span className="whitespace-nowrap">{label}</span>
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "capabilities" ? <Capabilities detail={detail} />
          : tab === "health" ? <Health detail={detail} />
          : tab === "deploy" ? <Deploy detail={detail} />
          : tab === "evals" ? <Evals detail={detail} />
          : <ThreadsAndRuns detail={detail} />}
      </div>
    </div>
  );
}
