// The commit box: a message, and the two weights of action that can carry it.
//
// THE MESSAGE PRE-FILLS FROM DATA THE VERSION ALREADY HOLDS — the instruction the user typed and
// the summary the model wrote, both on `agent_versions` since migration 014 — so the default path
// makes no model call at all. That matters more than it sounds: a commit box that had to generate
// would be a commit box that costs money, fails for reasons unrelated to git, and does not work at
// all in a workspace with no provider key.
//
// ✨ GENERATE IS FOR THE CASE THE PRE-FILL CANNOT COVER: a run of versions that do not map cleanly
// onto one message, or a post-pull merge. It routes through the same generation infrastructure the
// plan step uses rather than a separate pathway, which is what keeps one place deciding the model,
// the no-key fallback and the metering.
//
// EVERY CONTROL HERE FOLLOWS §A.2. A disabled button renders the reason in its place, and the
// reason names the exact thing that is wrong — because "why can't I click this" is the silent
// failure the rest of this product goes out of its way to avoid.

import { useEffect, useState } from "react";

import { sendCommitGithub, sendGenerateGithubMessage } from "../lib/socket.ts";
import { useGithubStore } from "../store/githubStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { ICON } from "../lib/tokens.ts";
import type { GithubView } from "../types.ts";
import { DisabledReason, ENABLED, firstReason, type DisabledState } from "./DisabledReason.tsx";
import { quietBtn } from "./buttons.ts";
import { ArrowUpIcon, SparklesIcon } from "./panelIcons.tsx";
import { keyHint } from "../lib/modKey.ts";

export function GitHubCommitBox({ view }: { view: GithubView }) {
  const generated = useGithubStore((s) => s.generated[view.agentId]);
  const generating = useGithubStore((s) => s.generating[view.agentId]);
  const clearGenerated = useGithubStore((s) => s.clearGenerated);
  const setRightTab = useUiStore((s) => s.setRightTab);
  // §A.2's second kind of disabled: a condition somewhere else. A run in flight is reading this
  // agent's files, and a commit that moved them mid-run would change what the run is executing.
  const runInFlight = useTraceStore((s) =>
    Object.values(s.runs).some((r) => r.agent_id === view.agentId && r.status === "running"),
  );

  const [message, setMessage] = useState("");
  const [touched, setTouched] = useState(false);

  // The pre-fill, and only until somebody types. Re-filling a box the user has edited is the
  // fastest way to lose a sentence they were halfway through writing.
  const prefill = defaultMessage(view);
  useEffect(() => {
    if (!touched) setMessage(prefill);
  }, [prefill, touched]);

  // A generated message REPLACES the box, because that is the entire point of pressing the button
  // — and it clears the one-shot so a later re-render cannot re-apply it over subsequent edits.
  useEffect(() => {
    if (generated === undefined) return;
    setMessage(generated);
    setTouched(true);
    clearGenerated(view.agentId);
  }, [generated, view.agentId, clearGenerated]);

  // NOT "STAGED", because nothing here stages. There is no index and no checkbox — this is the
  // set of files the unpushed versions touched, which is the whole of what the push will carry.
  // "Stage a file to enable commit" told somebody to operate a control this surface does not have
  // and, by §A.2's own rule, a reason that names an action the user cannot take is worse than no
  // reason at all.
  const included = view.changes.filter((c) => !c.locked).length;
  const nothingStaged: DisabledState =
    included === 0 ? { reason: "Nothing has changed since the last push." } : ENABLED;
  const runBlocking: DisabledState = runInFlight
    ? {
        reason: "Commit blocked — a run is using this agent's files.",
        // The cause is in another panel, so the reason is the way there — the same move §3.6's
        // refusal makes with [View diff].
        onReveal: () => setRightTab("trace"),
      }
    : ENABLED;
  const noMessage: DisabledState = message.trim() ? ENABLED : { reason: "Write a message to commit." };
  const notLinked: DisabledState = view.link ? ENABLED : { reason: "Link a repository first." };

  // ORDER IS PRECEDENCE. A blocking run outranks an empty box: it is the one the user cannot fix
  // from here, and telling them to write a message they then cannot send would be a wasted step.
  const commitState = firstReason(runBlocking, nothingStaged, noMessage);
  const pushState = firstReason(runBlocking, notLinked, nothingStaged, noMessage);

  const commit = (push: boolean): void => {
    if ((push ? pushState : commitState).reason) return;
    sendCommitGithub(view.agentId, message.trim(), push);
  };

  return (
    <div>
      <textarea
        rows={4}
        className="w-full resize-y rounded-control bg-panel px-2.5 py-2 text-caption leading-[1.55] text-ink outline-none focus-visible:shadow-focusring placeholder:text-faint"
        placeholder="what changed, and why"
        value={message}
        onChange={(e) => {
          setMessage(e.target.value);
          setTouched(true);
        }}
        onKeyDown={(e) => {
          // §0's binding, unchanged. Cmd+Shift+Enter is §A.8's — commit and push in one step, a
          // natural extension of the existing modifier rather than a new binding family.
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            commit(e.shiftKey);
          }
        }}
      />

      <div className="mt-1.5 flex items-center gap-2">
        <button
          type="button"
          className={`${quietBtn} !px-0`}
          disabled={generating || included === 0}
          onClick={() => sendGenerateGithubMessage(view.agentId)}
          title="For when a run of versions does not map onto one message — several small edits, or a post-pull merge."
        >
          <span className="inline-flex items-center gap-1.5">
            <SparklesIcon size={ICON.xs} />
            {generating ? "writing…" : "generate"}
          </span>
        </button>
        {/* The count, in the same numeric weight the region headers use. Zero is a real answer
            here and is shown as one — it is what the disabled reasons below are about. */}
        <span className="text-tiny tabular-nums text-faint">
          {included} file{included === 1 ? "" : "s"} in this push
        </span>
      </div>

      {/* §A.8. `[ Commit ] [ Commit & push ]` repeated the word "commit" in both labels, which
          takes a beat longer to scan than it should — and worse, it phrased two meaningfully
          different weights of action (one local, one that reaches GitHub) as variations on the
          same verb rather than as a base action plus an escalation. */}
      <div className="mt-2 flex items-start gap-3">
        <DisabledReason state={commitState}>
          {/* CONNECTED AS A PAIR: one rounded box, a hairline between the halves rather than a
              gap, so they read as "commit, optionally also →" and not as two unrelated buttons
              competing for attention. */}
          <span className="inline-flex overflow-hidden rounded-control bg-panel">
            <button
              className="px-3 py-1.5 text-caption text-ink transition-colors hover:bg-active active:bg-chrome disabled:cursor-not-allowed disabled:opacity-40"
              disabled={Boolean(commitState.reason)}
              onClick={() => commit(false)}
            >
              Commit
            </button>
            <span className="w-px shrink-0 bg-hair" aria-hidden />
            {/* ICON-ONLY, and the same ↑ the tab badge already uses for "ahead". The glyph carries
                the meaning once learned; the tooltip carries it for the first few uses. */}
            <button
              className="px-2.5 py-1.5 text-ink transition-colors hover:bg-active active:bg-chrome disabled:cursor-not-allowed disabled:opacity-40"
              disabled={Boolean(pushState.reason)}
              onClick={() => commit(true)}
              title={`push after commit — ${keyHint("⌘⇧↵")}`}
              aria-label="push after commit"
            >
              <ArrowUpIcon size={ICON.xs} />
            </button>
          </span>
        </DisabledReason>
        {/* THE ONE PLACE THE TWO DISABLED STATES LEGITIMATELY DIVERGE, and making that visible is
            part of why they are split rather than merged into one two-state button: changed but
            unlinked leaves Commit enabled — a local commit needs no repository — while the push
            half says "Link a repository first." */}
        {pushState.reason && pushState.reason !== commitState.reason && (
          <DisabledReason state={pushState}>
            <span className="sr-only">push after commit</span>
          </DisabledReason>
        )}
      </div>
    </div>
  );
}

/**
 * The message the box opens with.
 *
 * ONE VERSION IS ITS OWN SENTENCE; a run of them is a subject and a list. That mirrors exactly what
 * a push writes — `githubPush.messageFor` and `squashMessageFor` — so the message somebody reads
 * here is the message that lands, rather than a preview of something else.
 */
function defaultMessage(view: GithubView): string {
  const versions = view.unpushed;
  if (versions.length === 0) return "";
  const first = versions[versions.length - 1];
  const newest = versions[0];
  if (!first || !newest) return "";
  if (versions.length === 1) return first.summary;
  return [
    `Agent updates: v${first.version}–v${newest.version}`,
    "",
    // Oldest first, so the body reads in the order the work happened.
    ...[...versions].reverse().map((v) => `- v${v.version} ${v.summary}`),
  ].join("\n");
}
