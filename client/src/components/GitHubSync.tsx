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
import type { GithubRefusal, GithubScanRefusal, GithubView } from "../types.ts";
import { ActionRow, type ActionState } from "./ActionRow.tsx";
import { SplitButton, type SplitAction } from "./SplitButton.tsx";
import { outlineBtn, quietBtn, secondaryBtn } from "./buttons.ts";
import { Truncate } from "./Truncate.tsx";
import {
  AlertTriangleIcon, ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, CheckIcon, ExternalLinkIcon,
  RefreshIcon,
} from "./panelIcons.tsx";
import { CheckboxField } from "./Checkbox.tsx";

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
  const scanRefusal = useGithubStore((s) => s.scanRefusals[view.agentId]);

  // IN THIS ORDER, and the order is the argument. A refusal is the most recent thing that happened
  // and is the thing the user has to act on; a rail is what is happening now; the verdict is the
  // settled state. Showing the verdict above a live rail would put a number that is about to change
  // over the thing changing it.
  if (progress) return <ProgressRail agentId={view.agentId} progress={progress} />;
  return (
    <div className="space-y-2">
      {refusal && <RefusalCard view={view} refusal={refusal} />}
      {/* ABOVE THE VERDICT, like the pull refusal and for the same reason: it is the most recent
          thing that happened and the thing to act on. Beside it rather than instead of it, because
          the two are about different directions — one refused code coming IN, one refused code
          going OUT — and an agent can genuinely be in both states at once. */}
      {scanRefusal && <ScanRefusalCard view={view} refusal={scanRefusal} />}
      <VerdictLine view={view} />
    </div>
  );
}

// --- §3.5 the verdict line --------------------------------------------------

function VerdictLine({ view }: { view: GithubView }) {
  const [squash, setSquash] = useState(false);
  const [forcing, setForcing] = useState(false);
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
        <PrimaryAction view={view} squash={squash} onForce={() => setForcing(true)} />
      </div>

      {forcing && <ForcePushConfirm view={view} squash={squash} onClose={() => setForcing(false)} />}

      {/* §2.3's opt-in, and it only exists where it can apply. Jaroku versions are fine-grained —
          every applied edit is one — and somebody who made six small edits usually wants one
          meaningful commit. The DEFAULT is one commit per version, because the lineage is the
          product's own record of how the agent got here and a default that collapsed it would be
          the feature undoing its own premise. */}
      {view.state === "ahead" && view.ahead > 1 && (
        <div className="mt-1.5 pl-6">
          <CheckboxField checked={squash} onChange={() => setSquash(!squash)}>
            push as a single squashed commit
          </CheckboxField>
        </div>
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
function PrimaryAction({
  view, squash, onForce,
}: {
  view: GithubView;
  squash: boolean;
  onForce: () => void;
}) {
  const progress = useGithubStore((s) => s.progress[view.agentId]);

  // §A.2's table, for the controls in this region.
  //
  // A REVOKED TOKEN DISABLES PUSH WITH A SENTENCE rather than hiding the button. Hiding it would
  // make a workspace whose credential expired look like a workspace that has nothing to push,
  // which is the most confusing possible reading of ↑2 sitting in the tab bar beside it.
  const revoked = view.reason === "token_revoked" ? "GitHub access was revoked — reconnect to push." : null;
  const validating =
    progress?.op === "pull" && progress.current !== null
      ? "A pull is already validating — wait for it to finish."
      : null;
  const pushing =
    progress?.op === "push" && progress.current !== null
      ? "A push is already running for this agent."
      : null;

  const push = (): void => sendPushGithub(view.agentId, { squash });
  const pull = (): void => sendPullGithub(view.agentId);
  const fetch = (): void => sendRefreshGithub(view.agentId, true);

  // §A.1's table, state by state. WRITTEN OUT RATHER THAN COMPUTED, so that "which commands does a
  // diverged agent offer" is answerable by reading five lines instead of by simulating a
  // conditional — the same reason the capability matrix is a table.
  const FETCH: SplitAction = {
    id: "fetch",
    label: "Fetch",
    onSelect: fetch,
    // Read-only: it updates what Jaroku last saw and touches neither the working tree nor the
    // divergence flow, which is why it carries none of the confirmation weight the rest do.
    title: "Re-read the branch. Changes nothing but what Jaroku last saw.",
  };
  const PUSH: SplitAction = { id: "push", label: "Push", onSelect: push, reason: revoked ?? pushing };
  const PULL: SplitAction = { id: "pull", label: "Pull", onSelect: pull, reason: revoked ?? validating };
  const FORCE: SplitAction = {
    id: "force",
    label: "Force push",
    danger: true,
    onSelect: onForce,
    reason: revoked,
    // The bar is not lowered by being discoverable. Typing the slug and the audit row apply here
    // exactly as they do to §3.6's Force — what changes is that somebody no longer has to already
    // know force push is possible before they would think to look for it.
    title: "Overwrites the branch. Requires typing the agent slug, and is recorded.",
  };

  switch (view.state) {
    case "in_sync":
      // NO PRIMARY. §3.5 gives ✓ no action and §A.1 has the button read "Sync" instead — the
      // command set is still one caret away, and inventing a suggested action for a state that
      // needs none would put a button in front of somebody with nothing to do.
      return <SplitButton className="shrink-0" primary={null} actions={[PUSH, PULL, FETCH]} />;
    case "ahead":
      return (
        <SplitButton
          className="shrink-0"
          primary={{
            label: `Push ${view.ahead} version${view.ahead === 1 ? "" : "s"}`,
            onSelect: push,
            reason: revoked ?? pushing,
          }}
          actions={[PULL, FETCH, FORCE]}
        />
      );
    case "behind":
      return (
        <SplitButton
          className="shrink-0"
          primary={{
            label: "Pull into Jaroku",
            onSelect: pull,
            reason: revoked ?? validating,
            title: "Stages the remote tree as a candidate version and validates it before anything is published.",
          }}
          actions={[PUSH, FETCH]}
        />
      );
    case "diverged":
      // NOT "MERGE". Jaroku does not ship a three-way merge editor — §3.7 — because every file
      // resolved in a hand-rolled merge UI is a file that bypassed the validator on the way in.
      // The panel's job here is precise detection and a clean handoff.
      return (
        <SplitButton
          className="shrink-0"
          primary={{
            label: "Review & resolve",
            onSelect: () =>
              window.open(`${view.repoUrl}/compare/${encodeURIComponent(view.link.branch)}`, "_blank", "noreferrer"),
            title: "Opens the comparison on GitHub, where review already works.",
          }}
          actions={[{ ...FETCH, label: "Fetch (re-check)" }, FORCE]}
        />
      );
    case "broken":
      // THE DROPDOWN IS DISABLED UNTIL RELINKED, per §A.1's last row. Every other command in the
      // set needs a working link to mean anything, and offering them would be offering five
      // actions that all fail the same way.
      return (
        <SplitButton
          className="shrink-0"
          disabled
          primary={{
            label: view.reason === "token_revoked" ? "Reconnect" : "Relink",
            onSelect: () => sendRefreshGithub(view.agentId, true),
          }}
          actions={[]}
        />
      );
    default:
      return null;
  }
}


/**
 * Force push, behind the same bar §3.6's Force sits behind.
 *
 * PUTTING IT IN THE MENU DOES NOT LOWER THE BAR — that is the whole argument of §A.1's last
 * paragraph, and this component is where it has to be true rather than merely stated. Typing the
 * agent slug and writing to `github_events` apply here identically; what changes is that the
 * escape hatch is discoverable from the same place as the everyday action, instead of requiring
 * somebody to already know force push exists before they would think to look for it.
 *
 * THE SENTENCE SAYS WHAT IS LOST, not that this is dangerous. "This cannot be undone" is a phrase
 * people click past; "the commits on the branch that Jaroku did not write will not be there
 * afterwards" is a fact they can weigh. The count comes from the panel's own remote-only list,
 * which is the honest number rather than a warning in the abstract.
 */
function ForcePushConfirm({
  view, squash, onClose,
}: {
  view: GithubView;
  squash: boolean;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const losing = view.remoteOnly.length;

  return (
    <div className="mt-2 rounded-card border p-2.5" style={{ borderColor: `${STATUS.error}55` }}>
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-err"><AlertTriangleIcon size={ICON.sm} /></span>
        <span className="text-[12px] font-medium text-ink">Force push to {view.link.branch}</span>
        <button className="ml-auto shrink-0 text-faint hover:text-ink" onClick={onClose}>dismiss</button>
      </div>

      <p className="mt-1.5 text-[11px] leading-[1.5] text-muted">
        {losing > 0 ? (
          <>
            <span className="text-ink">
              {losing} commit{losing === 1 ? "" : "s"} on GitHub that Jaroku did not write
            </span>{" "}
            will not be on the branch afterwards.{" "}
          </>
        ) : (
          <>Overwrites the branch with this agent's versions, whatever is on it now. </>
        )}
        Type <span className="font-mono text-ink">{view.agentSlug}</span> to confirm — it is
        recorded against your account.
      </p>

      <div className="mt-2 flex items-center gap-2">
        <input
          autoFocus
          className="min-w-0 flex-1 rounded-control bg-panel px-2 py-1 font-mono text-[11px] text-ink outline-none placeholder:text-faint"
          placeholder={view.agentSlug}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        <button
          className={`${outlineBtn} !text-err`}
          // The client checks it so the button reads honestly; the SERVER checks it again before
          // anything reaches the network, which is the check that matters.
          disabled={typed.trim() !== view.agentSlug}
          onClick={() => {
            sendPushGithub(view.agentId, { squash, force: true, confirmSlug: typed.trim() });
            onClose();
          }}
        >
          Force push
        </button>
      </div>
    </div>
  );
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
/**
 * §B.6.1's refusal: a push the scanner turned away.
 *
 * ITS OWN CARD RATHER THAN A SECOND USE OF THE PULL ONE, and the differences are the reason. A pull
 * refusal is about ONE file and one check and offers a force that publishes anyway; this one lists
 * SEVERAL findings, each with its own path and its own sentence, and the override is a different
 * action with a different consequence — a force pull publishes code that failed validation into
 * this workspace, and this pushes a credential into a repository, where it stays in the reflog
 * after anybody deletes it.
 *
 * WHICH IS WHY THE OVERRIDE SAYS "ROTATE IT" RATHER THAN "ARE YOU SURE". The honest thing to tell
 * somebody about to push a key is not that it is risky; it is that the key is now burned and the
 * fix is to replace it. §B.6.1 puts this under a kebab — available, never the path of least
 * resistance — and it is recorded in `secret_scan_findings` and in `audit_log` either way.
 */
function ScanRefusalCard({ view, refusal }: { view: GithubView; refusal: GithubScanRefusal }) {
  const [overriding, setOverriding] = useState(false);
  const clearScanRefusal = useGithubStore((s) => s.clearScanRefusal);
  const secrets = refusal.findings.filter((f) => f.kind === "secret");

  return (
    <div className="rounded-card border p-2.5" style={{ borderColor: `${STATUS.error}55` }}>
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-err"><AlertTriangleIcon size={ICON.sm} /></span>
        <span className="text-[12px] font-medium text-ink">{refusal.message}</span>
        <button className="ml-auto shrink-0 text-faint hover:text-ink" onClick={() => clearScanRefusal(view.agentId)}>
          dismiss
        </button>
      </div>

      <div className="mt-1.5 space-y-1.5">
        {refusal.findings.map((f) => (
          <div key={`${f.path} ${f.rule}`}>
            <div className="font-mono text-[11px] text-ink">
              <Truncate variant="path" title={f.path}>
                {f.path}{f.line === null ? "" : `:${f.line}`}
              </Truncate>
            </div>
            <div className="text-[11px] leading-[1.5] text-muted">→ {f.message}</div>
          </div>
        ))}
      </div>

      <p className="mt-2 text-[11px] leading-[1.5] text-ink">
        Nothing was pushed. <span className="text-muted">
          The branch is exactly where it was — the files were uploaded as loose objects nothing
          points at, and GitHub collects those.
        </span>
      </p>

      <div className="mt-2 flex items-center gap-2">
        <button className={`${quietBtn} ml-auto !text-err`} onClick={() => setOverriding((v) => !v)}>
          Ignore &amp; push anyway ⋯
        </button>
      </div>

      {overriding && (
        <div className="mt-2 border-t border-hair pt-2">
          <p className="text-[11px] leading-[1.5] text-muted">
            {secrets.length > 0 ? (
              <>
                A credential in a commit stays in the reflog after the commit is deleted, so the fix
                is to <span className="text-ink">rotate it</span> rather than to remove it later.
                Pushing anyway is recorded against your account.
              </>
            ) : (
              <>
                Large files make every clone of this repository slower, permanently. Pushing anyway
                is recorded against your account.
              </>
            )}
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <button
              className={`${outlineBtn} ml-auto !text-err`}
              onClick={() => sendPushGithub(view.agentId, { ignoreSecrets: true })}
            >
              Push anyway
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

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
              className={`${outlineBtn} !text-err`}
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
