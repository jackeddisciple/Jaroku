// §B.5.1's REVIEW region: a reviewer's comment, and the one button on it.
//
// WHAT "FIX IN JAROKU" DOES, AND — MORE IMPORTANTLY — WHAT IT DOES NOT. It attaches two chips. It
// does not inject the comment's text into the composer, it does not start an edit, and it does not
// send anything. §B.5.1 is explicit about why: a review comment is CONTEXT, not an instruction, and
// treating it as an attach keeps it exactly as inert as every other chip §7 defines — grounding,
// never a shortcut to a write. Pasting a stranger's sentence into the box where a user's own
// instruction goes would make the two indistinguishable at the moment the model reads them.
//
// SO THE BUTTON LEAVES A PERSON WITH A COMPOSER TO TYPE INTO, holding the comment and the diff. What
// they type is theirs; what the reviewer said is beside it, labelled. The edit that follows goes
// through the ordinary edit loop, produces the ordinary diff card, and requires the ordinary Apply
// — §B.5.3's "nothing here shortcuts the ordinary safeguards", including the PROTECTED file list: a
// comment asking to "just tweak the MCP bridge" gets the identical refusal a typed request would.
//
// AND THE ROW SAYS WHAT HAPPENED TO IT. `applied` with a version is the loop having closed;
// `proposed` is an edit on screen that nobody has applied yet. Rendering those the same would make
// the region a list of things somebody thinks they have dealt with.

import { ICON } from "../lib/tokens.ts";
import { relTime } from "../lib/format.ts";
import { sendResolveReviewComment } from "../lib/socket.ts";
import { useUiStore } from "../store/uiStore.ts";
import type { GithubReviewRow, GithubView } from "../types.ts";
import { Chip } from "./Chip.tsx";
import { RegionLabel } from "./GitHubSync.tsx";
import { Truncate } from "./Truncate.tsx";
import { secondaryBtn } from "./buttons.ts";
import { CheckIcon } from "./panelIcons.tsx";

export function ReviewRegion({ view }: { view: GithubView }) {
  // A review exists only while somebody is reviewing. With no open pull request, or none of its
  // comments synced, the region is simply not there — rather than an empty frame explaining itself.
  if (!view.pr || view.review.length === 0) return null;

  const open = view.review.filter((c) => c.resolution === "open").length;

  return (
    <section className="mt-3">
      <RegionLabel>
        Review
        <span className="ml-2 font-normal normal-case tracking-normal text-faint">
          {view.review.length} comment{view.review.length === 1 ? "" : "s"}
          {/* The count that matters is the one with something to do in it, which is why it is said
              separately rather than being the only number. Four comments of which none is open is a
              finished conversation, and a bare "4" reads as four things to look at. */}
          {open > 0 && open !== view.review.length ? ` · ${open} open` : ""}
        </span>
      </RegionLabel>

      <div className="mt-1.5 space-y-1.5">
        {view.review.map((c) => <ReviewCard key={c.id} view={view} comment={c} />)}
      </div>
    </section>
  );
}

function ReviewCard({ view, comment }: { view: GithubView; comment: GithubReviewRow }) {
  const requestAttach = useUiStore((s) => s.requestGithubAttach);

  const fixInJaroku = (): void => {
    // TWO CHIPS, exactly as §B.5.1 specifies: the comment, and the diff it was written against. The
    // second is what makes the first actionable — "this retry has no backoff cap" is a remark about
    // code, and the model needs the code to say anything about it.
    //
    // A REQUEST RATHER THAN A CALL, because the attachment list is local state in the composer's
    // own column. See `uiStore.githubAttachRequest` for why that is worth a one-shot intent instead
    // of lifting a per-composer working set into global state.
    requestAttach([{ kind: "reviewComment", commentId: comment.id }, { kind: "unpushed" }]);
  };

  return (
    <div className="rounded-control border border-hair p-2">
      <div className="flex items-baseline gap-2 text-[11px]">
        <span className="shrink-0 text-ink">@{comment.author ?? "someone"}</span>
        {comment.path && (
          <Truncate variant="path" className="min-w-0 flex-1 font-mono text-faint" title={comment.path}>
            {comment.path}{comment.line === null ? "" : `:${comment.line}`}
          </Truncate>
        )}
        <span className="ml-auto shrink-0 text-faint">{relTime(comment.createdAt)}</span>
      </div>

      {/* The reviewer's own words, quoted rather than paraphrased and never edited. */}
      <p className="mt-1 text-[11px] leading-[1.5] text-muted">{comment.body}</p>

      <div className="mt-1.5 flex items-center gap-2">
        {comment.resolution === "applied" ? (
          <span className="flex items-center gap-1 text-[11px] text-ok">
            <CheckIcon size={ICON.xs} />
            applied{comment.resolvedVersion === null ? "" : ` as v${comment.resolvedVersion}`}
            {/* §B.5.3's other half. An edit that landed and a reply that did not are two different
                states, and a row that showed only the first would claim the teammate was told. */}
            {comment.repliedAt === null && (
              <span className="text-faint"> · the reply did not reach GitHub</span>
            )}
          </span>
        ) : comment.resolution === "proposed" ? (
          <Chip size="sm" tone="muted" caps title="An edit is on screen and has not been applied">
            proposed
          </Chip>
        ) : comment.resolution === "dismissed" ? (
          <Chip size="sm" tone="faint" caps>dismissed</Chip>
        ) : (
          <>
            <button
              className={secondaryBtn}
              title="Attach this comment and the current diff to the composer. It does not start an edit."
              onClick={fixInJaroku}
            >
              Fix in Jaroku
            </button>
            {/* Deciding NOT to change anything is a decision, and one worth recording — otherwise a
                comment somebody read and thought about is indistinguishable from one nobody opened.
                It posts nothing: what to say back, if anything, is a conversation for GitHub. */}
            <button
              className="text-[11px] text-faint hover:text-ink"
              title="Close this here without changing anything. Nothing is posted to GitHub."
              onClick={() => sendResolveReviewComment(view.agentId, comment.id, "dismissed")}
            >
              dismiss
            </button>
          </>
        )}
        <a
          className="ml-auto shrink-0 text-[11px] text-faint hover:text-ink"
          href={view.pr?.url}
          target="_blank"
          rel="noreferrer"
        >
          on GitHub ↗
        </a>
      </div>
    </div>
  );
}
