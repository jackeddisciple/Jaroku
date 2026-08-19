// §10: the Team pulse, or the personal summary. One or the other, never both.
//
// "Render one or the other by scope; do not show an empty Team card in a Personal workspace." The
// scope is decided on the SERVER and travels on the payload, which is why this component branches on
// `scope` rather than on the member count: a per-member table in a workspace with one member is a
// table with one row and a column header explaining who that is.
//
// AND THE ABSENCE IS PART OF THE CARD. §10 asks for five columns and this schema records three:
// nothing anywhere says who started a run or who pressed deploy, so the card shows what is recorded
// and says what is not. A "0 deploys" beside somebody's name is a claim about that person; a line
// saying deploys are not attributed is a claim about the schema, which is the true one.

import { EMPTY_FIGURE, formatMetric } from "../lib/activityMetrics.ts";
import { RANGE_PROSE } from "../lib/activityRange.ts";
import { selectAgent } from "../lib/selection.ts";
import { ICON, TEXT } from "../lib/tokens.ts";
import { useActivityStore } from "../store/activityStore.ts";
import { useMemberStore } from "../store/memberStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { Card, CardSkeleton } from "./ActivityView.tsx";
import { FreshnessNote } from "./ActivityFigures.tsx";
import { Truncate } from "./Truncate.tsx";
import { StreakIcon, TeamPulseIcon } from "./activityIcons.tsx";

const CARD_HEIGHT = 220;

export function TeamPulseCard() {
  const scope = useActivityStore((s) => s.teamScope);
  const fresh = useActivityStore((s) => s.teamFresh);
  if (!fresh) return <CardSkeleton height={CARD_HEIGHT} label="Team pulse" />;
  return scope === "team" ? <TeamCard /> : <PersonalCard />;
}

function TeamCard() {
  const members = useActivityStore((s) => s.members);
  const fresh = useActivityStore((s) => s.teamFresh);
  const range = useActivityStore((s) => s.range);
  // The member LIST comes from its own channel, with its own capability behind it. This card carries
  // ids and resolves the names here rather than putting email addresses on the one payload built to
  // be screenshotted — see the server's `boundActor`.
  const people = useMemberStore((s) => s.members);
  const nameOf = (userId: string | null): string =>
    people.find((m) => m.user_id === userId)?.display_name
      ?? people.find((m) => m.user_id === userId)?.email
      ?? "a member";

  return (
    <Card
      title="Team pulse"
      icon={TeamPulseIcon}
      freshness={<FreshnessNote fresh={fresh} />}
      context={members.length > 0 ? `contribution, ${RANGE_PROSE[range]}` : undefined}
    >
      {members.length === 0 ? (
        <div className="flex h-[64px] items-center gap-2 text-[12px] text-muted">
          <span className="font-mono text-[15px] text-faint">{EMPTY_FIGURE}</span>
          nobody built anything in {RANGE_PROSE[range]}
        </div>
      ) : (
        <>
          <table className="mt-2 w-full border-collapse">
            <thead>
              <tr className="border-b border-hair text-[10px] uppercase tracking-wider text-faint">
                <th className="pb-1 text-left font-normal">Member</th>
                <th className="pb-1 text-right font-normal" title="agents created in this range">Agents</th>
                <th className="pb-1 text-right font-normal" title="versions published whose source is an edit">Edits</th>
                <th className="pb-1 text-right font-normal" title="build sessions started">Threads</th>
              </tr>
            </thead>
            <tbody>
              {members.slice(0, 8).map((m) => (
                <tr key={m.user_id ?? "unknown"} className="border-b border-hair/50">
                  <td className="max-w-0 py-1.5 pr-2">
                    <Truncate className="text-[12px] text-ink" title={nameOf(m.user_id)}>
                      {nameOf(m.user_id)}
                    </Truncate>
                  </td>
                  <td className="py-1.5 text-right font-mono text-[11px] tabular-nums text-muted">{m.agents_created}</td>
                  <td className="py-1.5 text-right font-mono text-[11px] tabular-nums text-muted">{m.edits_applied}</td>
                  <td className="py-1.5 text-right font-mono text-[11px] tabular-nums text-muted">{m.threads_started}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* THE HONEST GAP, ON THE CARD. Two of §10's five columns cannot be filled by anything in
              this schema, and saying so is better than four zeros nobody can act on. */}
          <div className="mt-2 text-[10px] text-faint">
            runs, spend and deploys record no author, so they are not attributed here
          </div>
        </>
      )}
    </Card>
  );
}

function PersonalCard() {
  const me = useActivityStore((s) => s.personal);
  const fresh = useActivityStore((s) => s.teamFresh);
  const range = useActivityStore((s) => s.range);
  const closeNav = useUiStore((s) => s.closeNav);

  if (!me) return <CardSkeleton height={CARD_HEIGHT} label="Your range" />;
  const quiet = me.runs === 0;

  return (
    <Card
      title="Your range"
      icon={TeamPulseIcon}
      freshness={<FreshnessNote fresh={fresh} />}
      context={quiet ? undefined : `${RANGE_PROSE[range]}`}
    >
      {quiet ? (
        <div className="flex h-[64px] items-center gap-2 text-[12px] text-muted">
          <span className="font-mono text-[15px] text-faint">{EMPTY_FIGURE}</span>
          nothing ran in {RANGE_PROSE[range]}
        </div>
      ) : (
        <div className="mt-2 space-y-2.5">
          {me.mostActiveAgent && (
            <button
              onClick={() => { selectAgent(me.mostActiveAgent!.agentId); closeNav(); }}
              className="flex w-full items-baseline gap-2 text-left"
              title={`Open ${me.mostActiveAgent.name}`}
            >
              <span className="text-[10px] uppercase tracking-wider text-faint">Most active</span>
              <Truncate className="min-w-0 flex-1 text-[12px] text-ink" title={me.mostActiveAgent.name}>
                {me.mostActiveAgent.name}
              </Truncate>
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted">
                {me.mostActiveAgent.runs}
              </span>
            </button>
          )}

          <div className="grid grid-cols-3 gap-3">
            <Figure label="Runs" value={String(me.runs)} />
            <Figure
              label="Spend"
              value={formatMetric("usd", me.usd)}
              hint={me.costKnown ? undefined : "a floor — an unpriced model ran in this range"}
              suffix={me.costKnown ? undefined : "+"}
            />
            <Figure
              label="Streak"
              value={me.streakDays > 0 ? `${me.streakDays}d` : EMPTY_FIGURE}
              icon={me.streakDays > 0}
              hint={
                me.streakDays > 0
                  ? "consecutive days ending today with at least one run"
                  : "a streak ends the first day nothing runs"
              }
            />
          </div>
        </div>
      )}
    </Card>
  );
}

/** One small figure. Same tabular discipline as the hero, one size down. */
function Figure({
  label,
  value,
  hint,
  suffix,
  icon,
}: {
  label: string;
  value: string;
  hint?: string;
  suffix?: string;
  icon?: boolean;
}) {
  return (
    <div title={hint}>
      <div className="flex items-baseline gap-1">
        {icon && (
          <span className="text-faint" aria-hidden>
            <StreakIcon size={ICON.xs} />
          </span>
        )}
        <span className="font-mono text-[15px] tabular-nums leading-none" style={{ color: TEXT.ink }}>
          {value}
        </span>
        {suffix && <span className="text-[11px] text-faint">{suffix}</span>}
      </div>
      <div className="mt-1 text-[10px] uppercase tracking-wider text-faint">{label}</div>
    </div>
  );
}
