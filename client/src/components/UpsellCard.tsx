// What a tier just refused, said where the refusal happened.
//
// AN INLINE CARD AND NEVER A MODAL, which is the specification's own instruction and is worth
// keeping the reason for: a modal mid-flow takes the screen away from somebody who was in the
// middle of something, to tell them they cannot finish it. What they need instead is the sentence
// next to the button that did not work, and their context left exactly where it was so they can
// decide — upgrade, wait for the month to turn, archive an agent — without losing the thing they
// were doing. Every dark pattern in this area starts by taking the screen.
//
// THE FIGURES COME FROM THE SERVER AND NOTHING IS COMPUTED HERE, the same rule `billingStore`'s
// header states: the number in this card is the number the refusal was made with. A client that
// recalculated "3 of 3" would eventually disagree with the refusal the user is reading, and a
// billing surface that argues with a refusal is worse than no billing surface.
//
// IT ANSWERS TO ONE CHANNEL. A refused invite must not put a card on the composer, beside a button
// that works fine — so each mount names the channel it speaks for and stays absent otherwise. That
// is also what makes several of these safe to place around the app at once: at most one is ever
// looking at a given refusal.
//
// DISMISSIBLE, unlike the enforcement strip above it, and the difference is deliberate. An
// enforcement is a state the workspace is IN and stays true whether or not it is being looked at; a
// quota refusal is about one action somebody just tried. Once they have read it, insisting on it is
// nagging.

import { useEntitlementStore, type EntitlementRefusal } from "../store/entitlementStore.ts";
import { ICON, TYPE } from "../lib/tokens.ts";
import { primaryBtn, quietBtn } from "./buttons.ts";
import { AlertTriangleIcon, XIcon } from "./panelIcons.tsx";

/**
 * What each limit is called where a person reads it.
 *
 * The wire names the LIMIT (`runs_per_month`) because that is what the server bounds; this names
 * the thing somebody ran out of. A kind with no entry falls back to its own name with the
 * underscores taken out, so a limit added on the server renders as something readable rather than
 * as nothing — a card that said "undefined" would be worse than one that said `mcp_servers`.
 */
const LIMIT_LABEL: Record<string, string> = {
  agents: "agents",
  runs_per_month: "runs this month",
  eval_runs_per_month: "eval runs this month",
  live_deployments: "live deployments",
  mcp_servers: "connected MCP servers",
  members: "members",
  workspaces: "workspaces",
  githubPhase1: "GitHub",
  githubPhase2: "GitHub sync",
};

const TIER_LABEL: Record<string, string> = { free: "Free", pro: "Pro", team: "Team" };

function label(kind: string): string {
  return LIMIT_LABEL[kind] ?? kind.replace(/_/g, " ");
}

/** Free's next step is Pro, and a paid tier's is Team — the same rule the server's URL carries. */
function nextTier(tier: string): string {
  return tier === "free" ? "Pro" : "Team";
}

export function UpsellCard({ channel, onUpgrade }: { channel: string; onUpgrade?: () => void }) {
  const refusal = useEntitlementStore((s) => s.refusal);
  const on = useEntitlementStore((s) => s.channel);
  const clear = useEntitlementStore((s) => s.clear);
  if (!refusal || on !== channel) return null;

  return (
    <div className="rounded-card border border-run/40 bg-run/[0.06] px-3 py-2.5">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 text-run">
          <AlertTriangleIcon size={ICON.sm} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className={TYPE.title}>{headline(refusal)}</span>
            <span className={TYPE.meta}>on {TIER_LABEL[refusal.tier] ?? refusal.tier}</span>
          </div>

          {/* THE METER, AND ONLY FOR A QUOTA. A feature gate has no numbers — "GitHub is not on
              Free" is not zero of zero — and a bar sitting at 0/0 reads as something that fills up
              again next month, which is the opposite of true. */}
          {refusal.error === "quota_exceeded" && (
            <div className="mt-1.5">
              <div className="h-1 w-full overflow-hidden rounded-chip bg-chrome">
                <div className="h-full rounded-chip bg-run" style={{ width: "100%" }} />
              </div>
              <p className="mt-1 text-tiny tabular-nums text-muted">
                {refusal.current} of {refusal.limit} {label(refusal.kind)} used
              </p>
            </div>
          )}

          {/* THE PROMISE THAT MAKES THIS NOT A THREAT. The specification's second principle is that
              nothing is ever destroyed for stopping paying, and the moment somebody most needs to
              hear it is the moment they have just been refused. */}
          <p className="mt-1 text-tiny leading-[1.55] text-muted">
            {refusal.error === "quota_exceeded"
              ? `${nextTier(refusal.tier)} raises this limit. Everything you have already made stays exactly as it is.`
              : `${nextTier(refusal.tier)} turns this on. Nothing you have already made changes.`}
          </p>

          <div className="mt-2 flex items-center gap-1.5">
            {/* No pre-selected billing period, no countdown, no "you will be charged unless".
                The button opens the comparison and the person decides there. */}
            <button type="button" className={primaryBtn} onClick={() => { clear(); onUpgrade?.(); }}>
              See {nextTier(refusal.tier)}
            </button>
            <button type="button" className={quietBtn} onClick={clear}>
              Not now
            </button>
          </div>
        </div>
        <button
          type="button"
          title="Dismiss"
          aria-label="Dismiss"
          className="-mr-1 -mt-1 shrink-0 rounded-control p-1 text-faint transition-colors hover:bg-active hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
          onClick={clear}
        >
          <XIcon size={ICON.xs} />
        </button>
      </div>
    </div>
  );
}

/** The first line: what happened, in the words somebody would use about their own workspace. */
function headline(r: EntitlementRefusal): string {
  if (r.error === "feature_unavailable") return `${label(r.kind)} is not part of this plan`;
  if (r.kind === "members") return "This plan is single-user";
  return `You have used all your ${label(r.kind)}`;
}
