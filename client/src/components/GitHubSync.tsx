// The verdict, and the two things that can be happening instead of it.
//
// §1's second region, which is the one the panel exists for: the most common question anybody
// brings to this tab is "am I okay?", and it is answered here without scrolling. Everything else
// in the panel explains this line.
//
// FIVE STATES, EACH WITH EXACTLY ONE PRIMARY ACTION. That constraint is what keeps the region a
// verdict rather than a control panel — a row of five equally-weighted buttons would make the user
// choose before they have been told anything. The full command set is reachable, and §A.1 is where
// that lands; what must not happen is the suggested action losing its weight among the others.
//
// THE WORDS COME FROM THE SERVER. `verdict` is a sentence `githubSync.verdictLine` already wrote,
// beside the numbers it wrote it from. Composing it here would mean the panel and the badge could
// describe the same state differently — and the badge is the one people read first.
//
// THE RAIL IS THE DEPLOY PANEL'S, deliberately. A push has stages, and the stages ARE the progress
// indicator: pending, active, done, in the same three tenses StreamingFileRow uses for files. No
// spinner and no percentage, because there is neither anywhere else in this app and a percentage
// would be a made-up number.

import { useEffect, useState } from "react";

import { sendPullGithub, sendPushGithub, sendRefreshGithub } from "../lib/socket.ts";
import { ICON, STATUS, TYPE } from "../lib/tokens.ts";
import { fmtDuration } from "../lib/format.ts";
import { useGithubStore, type GithubProgress } from "../store/githubStore.ts";
import type { GithubRefusal, GithubView } from "../types.ts";
import { ActionRow, type ActionState } from "./ActionRow.tsx";
import { primaryBtn, quietBtn, secondaryBtn } from "./buttons.ts";
import { Truncate } from "./Truncate.tsx";
import {
  AlertTriangleIcon, ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, CheckIcon, ExternalLinkIcon,
  RefreshIcon,
} from "./panelIcons.tsx";

/**
 * The stage vocabulary, client-side.
 *
 * A SECOND COPY OF THE IDS AND NOT OF THE DECISIONS, which is the same split DeployPanel makes: the
 * server owns the ORDER things happen in and emits an id per transition, and this owns the words a
 * person reads. The ids are the contract between them. Putting the prose on the wire instead would
 * mean the server deciding how a panel reads, and putting the order here would mean two lists that
 * can disagree about what happens next.
 */
const PUSH_STAGES: { id: string; active: string; done: string }[] = [
  { id: "read", active: "Reading versions", done: "Read versions" },
  { id: "remote", active: "Checking the branch", done: "Checked the branch" },
  { id: "blobs", active: "Uploading files", done: "Uploaded files" },
  { id: "tree", active: "Building tree", done: "Built tree" },
  { id: "commit", active: "Writing commits", done: "Wrote commits" },
  { id: "ref", active: "Updating ref", done: "Updated ref" },
];

const PULL_STAGES: { id: string; active: string; done: string }[] = [
  { id: "fetch", active: "Fetching tree", done: "Fetched tree" },
  { id: "stage", active: "Staging candidate", done: "Staged candidate" },
  { id: "validate", active: "Validating (parse · import · contract)", done: "Validated" },
  { id: "publish", active: "Publishing", done: "Published" },
];

/** A ticker, only while something is moving. The same shape DeployPanel's and TraceTimeline's use. */
function useTick(active: boolean, ms = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}

export function GitHubSyncRegion({ view }: { view: GithubView }) {
  const progress = useGithubStore((s) => s.progress[view.agentId]);
  const refusal = useGithubStore((s) => s.refusals[view.agentId]);

  // IN THIS ORDER, and the order is the argument. A refusal is the most recent thing that happened
  // and is the thing the user has to act on; a rail is what is happening now; the verdict is the
  // settled state. Showing the verdict above a live rail would put a number that is about to change
  // over the thing changing it.
  if (progress) return <ProgressRail agentId={view.agentId} progress={progress} />;
  return (
    <div className="space-y-2">
      {refusal && <RefusalCard view={view} refusal={refusal} />}
      <VerdictLine view={view} />
    </div>
  );
}

// --- §3.5 the verdict line --------------------------------------------------

function VerdictLine({ view }: { view: GithubView }) {
  const [squash, setSquash] = useState(false);
  const glyph = GLYPH[view.state];
  const tone = TONE[view.state];

  return (
    <div>
      <div className="flex items-start gap-2">
        <span className={`mt-[2px] shrink-0 ${tone}`} aria-hidden>{glyph}</span>
        <span className="min-w-0 flex-1 text-[12px] text-ink">
          <Truncate title={view.verdict}>{view.verdict}</Truncate>
          {/* The one detail the sentence cannot carry: WHICH file moved upstream. §3.5's mock puts
              it here — "1 commit behind — weather.py edited on GitHub" — because "behind" alone
              does not tell you whether to look before pulling. */}
          {view.state === "behind" && view.remoteOnly[0] && (
            <span className="block text-[11px] text-muted">
              <Truncate title={view.remoteOnly[0].message}>
                {view.remoteOnly[0].message}
                {view.remoteOnly[0].author ? ` · @${view.remoteOnly[0].author}` : ""}
              </Truncate>
            </span>
          )}
        </span>
        <PrimaryAction view={view} squash={squash} />
      </div>

      {/* §2.3's opt-in, and it only exists where it can apply. Jaroku versions are fine-grained —
          every applied edit is one — and somebody who made six small edits usually wants one
          meaningful commit. The DEFAULT is one commit per version, because the lineage is the
          product's own record of how the agent got here and a default that collapsed it would be
          the feature undoing its own premise. */}
      {view.state === "ahead" && view.ahead > 1 && (
        <label className="mt-1.5 flex cursor-pointer items-center gap-1.5 pl-6 text-[11px] text-muted">
          <input type="checkbox" checked={squash} onChange={(e) => setSquash(e.target.checked)} />
          push as a single squashed commit
        </label>
      )}
    </div>
  );
}

/**
 * The one action the verdict suggests.
 *
 * NOT RENDERED AT ALL when there is nothing to do. §3.5 gives `✓ in sync` no action, and a greyed
 * "Push" beside a tick would be a control whose only state is unavailable — which reads as broken
 * rather than as finished.
 */
function PrimaryAction({ view, squash }: { view: GithubView; squash: boolean }) {
  switch (view.state) {
    case "in_sync":
      return (
        <button
          className={`${quietBtn} shrink-0`}
          title="Re-read the branch. Moves nothing but what Jaroku last saw."
          onClick={() => sendRefreshGithub(view.agentId)}
        >
          <RefreshIcon size={ICON.xs} />
        </button>
      );
    case "ahead":
      return (
        <button className={`${primaryBtn} shrink-0`} onClick={() => sendPushGithub(view.agentId, { squash })}>
          Push {view.ahead} version{view.ahead === 1 ? "" : "s"}
        </button>
      );
    case "behind":
      return (
        <button
          className={`${primaryBtn} shrink-0`}
          title="Stages the remote tree as a candidate version and validates it before anything is published."
          onClick={() => sendPullGithub(view.agentId)}
        >
          Pull into Jaroku
        </button>
      );
    case "diverged":
      // NOT "MERGE". Jaroku does not ship a three-way merge editor — §3.7 — because every file
      // resolved in a hand-rolled merge UI is a file that bypassed the validator on the way in.
      // The panel's job here is precise detection and a clean handoff.
      return (
        <a
          className={`${secondaryBtn} shrink-0`}
          href={`${view.repoUrl}/compare/${encodeURIComponent(view.link.branch)}`}
          target="_blank"
          rel="noreferrer"
        >
          Review &amp; resolve <ExternalLinkIcon size={ICON.xs} />
        </a>
      );
    case "broken":
      return (
        <button className={`${primaryBtn} shrink-0`} onClick={() => sendRefreshGithub(view.agentId)}>
          {view.reason === "token_revoked" ? "Reconnect" : "Relink"}
        </button>
      );
    default:
      return null;
  }
}

const GLYPH: Record<GithubView["state"], React.ReactNode> = {
  unlinked: null,
  in_sync: <CheckIcon size={ICON.xs} />,
  ahead: <ArrowUpIcon size={ICON.xs} />,
  behind: <ArrowDownIcon size={ICON.xs} />,
  diverged: <ArrowUpDownIcon size={ICON.xs} />,
  broken: <AlertTriangleIcon size={ICON.xs} />,
  syncing: <RefreshIcon size={ICON.xs} />,
};

/**
 * The status vocabulary, applied.
 *
 * DIVERGED WEARS THE ERROR TONE AND NOT AMBER, which is the one entry here worth arguing for.
 * Amber means running or in flight everywhere else in this app; diverged is a STOPPED state
 * waiting on a person, and painting it amber would read as progress happening on its own.
 */
const TONE: Record<GithubView["state"], string> = {
  unlinked: "text-faint",
  in_sync: "text-ok",
  ahead: "text-muted",
  behind: "text-muted",
  diverged: "text-err",
  broken: "text-err",
  syncing: "text-run",
};

// --- §2.4 / §3.6 the rail ---------------------------------------------------

function ProgressRail({ agentId, progress }: { agentId: string; progress: GithubProgress }) {
  const stages = progress.op === "push" ? PUSH_STAGES : PULL_STAGES;
  const running = progress.current !== null;
  const now = useTick(running);
  const elapsed = Math.max(0, now - progress.startedAt);

  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-run"><RefreshIcon size={ICON.xs} /></span>
        <span className="min-w-0 flex-1 text-[12px] text-ink">
          {progress.op === "push" ? "Pushing" : "Pulling"}…
        </span>
        {/* A live timer rather than a bar. The stages say how far; this says how long, and one
            honest number beats a percentage nobody computed. */}
        <span className="shrink-0 text-[11px] tabular-nums text-muted">{fmtDuration(elapsed)}</span>
      </div>
      {/* The rail. Steps float on it — the trace timeline's shape, for the same reason: it is what
          makes a sequence read as one thing rather than as a table of rows. */}
      <div className="relative mt-2">
        <div className="absolute bottom-3 left-[9px] top-3 w-px bg-hair" />
        {stages.map((s) => {
          const status = progress.stages[s.id];
          const state: ActionState =
            status === "done" ? "done" : status === "error" ? "error" : status === "active" ? "active" : "pending";
          return (
            <ActionRow
              key={s.id}
              kind={state === "done" ? "done" : state === "error" ? "fail" : "wait"}
              state={state}
              verb={state === "done" ? s.done : s.active}
              object={null}
              className="pl-1"
            />
          );
        })}
      </div>
      {/* A failed stage leaves the previous state intact — §2.4 — and the panel says so rather
          than leaving somebody to wonder what half-landed. */}
      {Object.values(progress.stages).includes("error") && (
        <p className="mt-1.5 pl-1 text-[11px] leading-[1.5] text-muted">
          Stopped at the stage above. Nothing was written past it —
          {progress.op === "push" ? " the branch is where it was." : " your agent is unchanged."}
          <button className="ml-1.5 text-ink underline-offset-2 hover:underline" onClick={() => sendRefreshGithub(agentId)}>
            Re-check
          </button>
        </p>
      )}
    </div>
  );
}

// --- §3.6 the refusal -------------------------------------------------------

/**
 * A pull the validator turned away.
 *
 * A REFUSAL, NOT A WARNING, and the copy is the design. It names the file, it names the check, and
 * — the part that matters most — it says the agent is unchanged, because the first thing anybody
 * wants to know after a red box is what state their work is in.
 *
 * FORCE LIVES UNDER A DISCLOSURE, requires typing the agent slug, and is written to
 * `github_events`. A hosted multi-tenant product needs "who overrode a safety refusal" to be
 * answerable, and a confirmation you can click through without reading is not an answer.
 */
function RefusalCard({ view, refusal }: { view: GithubView; refusal: GithubRefusal }) {
  const [forcing, setForcing] = useState(false);
  const [typed, setTyped] = useState("");
  const clearRefusal = useGithubStore((s) => s.clearRefusal);

  return (
    <div className="rounded-card border p-2.5" style={{ borderColor: `${STATUS.error}55` }}>
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-err"><AlertTriangleIcon size={ICON.sm} /></span>
        <span className="text-[12px] font-medium text-ink">Pull refused — validation failed</span>
        <button className="ml-auto shrink-0 text-faint hover:text-ink" onClick={() => clearRefusal(view.agentId)}>
          dismiss
        </button>
      </div>

      {refusal.path && (
        <div className="mt-1.5 font-mono text-[11px] text-ink">
          {/* §A.3 applies here too: the whole card is about WHICH file, so the filename is the
              half that must survive the width. */}
          <Truncate variant="path">{refusal.path}</Truncate>
        </div>
      )}
      <div className="mt-0.5 text-[11px] leading-[1.5] text-muted">→ {refusal.message}</div>

      <p className="mt-2 text-[11px] leading-[1.5] text-ink">
        {refusal.check === "protected"
          ? "This would have replaced reviewed code Jaroku keeps read-only."
          : refusal.check === "contract"
            ? "This would have unwired a reviewed tool."
            : "This would not have run."}{" "}
        <span className="text-muted">Your agent is unchanged.</span>
      </p>

      <div className="mt-2 flex items-center gap-2">
        <a
          className={secondaryBtn}
          href={`${view.repoUrl}/tree/${encodeURIComponent(view.link.branch)}${refusal.path ? `/${refusal.path}` : ""}`}
          target="_blank"
          rel="noreferrer"
        >
          Open on GitHub <ExternalLinkIcon size={ICON.xs} />
        </a>
        <button className={`${quietBtn} ml-auto !text-err`} onClick={() => setForcing((v) => !v)}>
          Force ⋮
        </button>
      </div>

      {forcing && (
        <div className="mt-2 border-t border-hair pt-2">
          <p className="text-[11px] leading-[1.5] text-muted">
            Publishing a candidate that failed validation makes it this agent's current version.
            Type <span className="font-mono text-ink">{view.agentSlug}</span> to confirm — it is
            recorded against your account.
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <input
              className="min-w-0 flex-1 rounded-control bg-panel px-2 py-1 font-mono text-[11px] text-ink outline-none placeholder:text-faint"
              placeholder={view.agentSlug}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
            <button
              className={`${primaryBtn} !text-err`}
              disabled={typed.trim() !== view.agentSlug}
              onClick={() => sendPullGithub(view.agentId, { force: true, confirmSlug: typed.trim() })}
            >
              Publish anyway
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The region label, so the four headers read as one column. §A.5 gives them a shared shape. */
export function RegionLabel({ children }: { children: React.ReactNode }) {
  return <div className={TYPE.sectionLabel}>{children}</div>;
}
