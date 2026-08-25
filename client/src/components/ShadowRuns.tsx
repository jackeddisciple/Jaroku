// §B.2.2's transient list, and the sentence that has to be on it.
//
// THE ONE THING THIS SURFACE MUST SAY, before anything else it says: this run does not affect the
// published version. That is not reassurance — it is the whole reason somebody is willing to press
// a button next to Switch, which §3.2 spends three paragraphs warning them about. So it is the
// first line of the region rather than a tooltip, and it is written as a fact about what happened
// rather than as a promise about what will.
//
// AND WHERE THESE ROWS ARE NOT. §B.2.2 requires that shadow runs never appear in the agent's
// ordinary run history sidebar, and nothing in this file could put them there: they arrive on their
// own message, into their own store field, and are rendered by their own component inside the GitHub
// panel. The sidebar's history reads `traceStore`, which never sees any of this.
//
// A SWEPT RUN IS STILL OPENABLE, which is the property that makes a fifteen-minute sweep window
// safe rather than aggressive. The sweep reclaims the materialised PROJECT; the trace is an
// ordinary run on retention's own schedule. So a row an hour old has no directory and still has its
// steps, and the row says which of those two it has lost.

import { useEffect } from "react";

import { sendListShadowRuns } from "../lib/socket.ts";
import { relTime } from "../lib/format.ts";
import { useGithubStore } from "../store/githubStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import type { GithubShadowRun, GithubView } from "../types.ts";
import { ActionRow } from "./ActionRow.tsx";
import { Chip } from "./Chip.tsx";
import { RegionLabel } from "./GitHubSync.tsx";
import { Truncate } from "./Truncate.tsx";
import { quietBtn } from "./buttons.ts";

/**
 * How a shadow run's status maps onto the vocabulary ActionRow already speaks.
 *
 * `fail` AND NOT A NEW KIND. A shadow run that errored is a run that did not finish, which is
 * exactly what `fail` means everywhere else in this app — and §B.2.2's whole framing is that a
 * broken ref surfaces as an ordinary failed run rather than as a refusal with its own vocabulary.
 * Inventing a twelfth ActionKind for it would say the opposite.
 */
function kindFor(status: string): "done" | "wait" | "fail" {
  if (status === "completed") return "done";
  if (status === "error" || status === "cancelled") return "fail";
  return "wait";
}

export function ShadowRunsRegion({ view }: { view: GithubView }) {
  const runs = useGithubStore((s) => s.shadowRuns[view.agentId]);

  // Asked on mount and on agent change, for the reason the panel asks for its own snapshot: relying
  // on whatever arrived during the last action means opening the tab shows what was true before it.
  useEffect(() => {
    sendListShadowRuns(view.agentId);
  }, [view.agentId]);

  if (!runs || runs.length === 0) return null;

  return (
    <section className="mt-4">
      <RegionLabel>
        Shadow runs
        <span className="ml-2 font-normal normal-case tracking-normal text-faint">{runs.length}</span>
      </RegionLabel>

      {/* FIRST, AND NOT IN A TOOLTIP. Somebody pressing a button next to Switch is asking exactly
          this, and §3.2 has spent three paragraphs teaching them that branch operations are heavy. */}
      <p className="mt-1 text-tiny leading-[1.5] text-muted">
        Not published — none of these affects{" "}
        <span className="text-ink">{view.agentSlug}</span>'s live version. They are swept
        after a while; their traces are not.
      </p>

      <div className="mt-1.5">
        {runs.map((run) => <ShadowRow key={run.id} run={run} />)}
      </div>
    </section>
  );
}

function ShadowRow({ run }: { run: GithubShadowRun }) {
  const selectRun = useTraceStore((s) => s.selectRun);
  const setRightTab = useUiStore((s) => s.setRightTab);

  return (
    <ActionRow
      kind={kindFor(run.status)}
      state={run.status === "staging" || run.status === "running" ? "active" : "done"}
      hideVerb
      lead={<span className="w-4 text-center text-tiny text-faint">◆</span>}
      object={
        <span className="text-ink">
          <Truncate title={`${run.ref} at ${run.headSha}`}>{run.ref}</Truncate>
        </span>
      }
      detail={
        <span className="text-faint">
          {/* The sha, because a ref moves and this run was of one commit. Somebody comparing two
              shadow runs of the same branch a day apart needs to see which is which. */}
          <span className="">{run.headSha.slice(0, 7)}</span> · {relTime(run.createdAt)}
          {run.error && <span className="text-err"> · {run.error}</span>}
        </span>
      }
      trailing={
        <>
          {!run.staged && run.runId && (
            <Chip
              size="sm"
              tone="faint"
              caps
              title="The materialised project was swept. The trace is an ordinary run and is still here."
            >
              swept
            </Chip>
          )}
          {run.runId && (
            <button
              className={quietBtn}
              title="Open this run's trace"
              onClick={() => {
                selectRun(run.runId!);
                setRightTab("trace");
              }}
            >
              Trace
            </button>
          )}
        </>
      }
    />
  );
}
