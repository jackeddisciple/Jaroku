// §B.7's `[ Lines | Agent ]` toggle, and the rows behind Agent.
//
// WHAT THE TOGGLE ACTUALLY OFFERS. Lines is what every git client shows: a file moved, +18 −4. Agent
// is what only this product can show, because the facts behind it do not live in git — they live in
// the AST paths the validator already walks and in the impact classification stored on each MCP
// tool. "tools/weather.py +18 −4" tells somebody a file changed. "tool removed: gmail_search" tells
// them what their agent can no longer do.
//
// EVERY ROW ARRIVES AS A VERB AND AN OBJECT, and is rendered through `ActionRow` — deliberately, per
// §B.7.1, so that "tool added" here reads exactly like "tool added" would in a plan card. Nothing in
// this file composes a sentence, because a second sentence-composer would be a second vocabulary
// inside one product.
//
// AND THE ONE ORDERING RULE THE CLIENT MUST NOT UNDO: the rows arrive in the order §B.7.2 requires,
// with a widened MCP grant first. This file renders them in the order it is given. Sorting them —
// alphabetically, by kind, by anything — would put the one line that has to be read wherever the
// comparator happened to place it, which is the failure §B.7.2 names as being worse than not having
// the feature at all.

import { useEffect, useState } from "react";

import { sendSemanticDiffGithub } from "../lib/socket.ts";
import { ICON } from "../lib/tokens.ts";
import { useGithubStore } from "../store/githubStore.ts";
import type { GithubSemanticRow, GithubView } from "../types.ts";
import { ActionRow } from "./ActionRow.tsx";
import { Chip } from "./Chip.tsx";
import { Truncate } from "./Truncate.tsx";
import { AlertTriangleIcon } from "./panelIcons.tsx";

type Mode = "lines" | "agent";

/**
 * The toggle plus, when Agent is chosen, the rows.
 *
 * `lines` IS THE DEFAULT AND STAYS THE DEFAULT. The Changes region above is the Lines view and is
 * what somebody expects to see when they open a git panel; Agent is the thing they choose. Opening
 * on Agent would also mean a tree read from GitHub and two Python parses on every panel render, for
 * a view most opens do not want.
 */
export function SemanticDiffRegion({ view }: { view: GithubView }) {
  const [mode, setMode] = useState<Mode>("lines");
  const diff = useGithubStore((s) => s.semanticDiffs[view.agentId]);

  // Asked when the toggle flips, and again when the agent changes under a panel already showing
  // Agent — otherwise the rows on screen would describe the previous agent.
  useEffect(() => {
    if (mode === "agent") sendSemanticDiffGithub(view.agentId);
  }, [mode, view.agentId]);

  // Nothing to compare against: no commit on the branch means the Lines view has nothing either,
  // and a toggle over two empty views is a control with no states.
  if (!view.link.last_pushed_sha && view.pushed.length === 0) return null;

  const rows = diff && diff.agentId === view.agentId ? diff.rows : null;

  return (
    <section className="mt-3">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-faint">
          v{view.pushed[0]?.version ?? view.unpushed[0]?.version ?? "?"} → {view.link.branch}
        </span>
        <div className="ml-auto flex items-center gap-0.5 rounded-control bg-active p-0.5">
          {(["lines", "agent"] as const).map((m) => (
            <button
              key={m}
              className={`rounded-control px-2 py-0.5 text-[11px] transition-colors duration-fast ${
                mode === m ? "bg-panel text-ink" : "text-muted hover:text-ink"
              }`}
              onClick={() => setMode(m)}
              title={
                m === "lines"
                  ? "What text changed — the file list above"
                  : "What changed about the agent: its tools, its state, its graph, and what it is allowed to reach"
              }
            >
              {m === "lines" ? "Lines" : "Agent"}
            </button>
          ))}
        </div>
      </div>

      {mode === "agent" && (
        <div className="mt-1.5">
          {rows === null ? (
            <p className="text-[11px] text-muted">reading both trees…</p>
          ) : rows.length === 0 ? (
            // A REAL ANSWER RATHER THAN AN EMPTY LIST. Two trees can differ in every line and not at
            // all in the agent — a reformat, a docstring, a comment — and saying so is the most
            // useful thing this view does on that commit.
            <p className="text-[11px] leading-[1.5] text-muted">
              Nothing changed about the agent. The tools, the state, the graph and the MCP grant are
              the same on both sides — whatever moved, moved inside them.
            </p>
          ) : (
            rows.map((row, i) => <SemanticRow key={`${row.kind}:${row.object}:${i}`} row={row} />)
          )}

          {/* One side did not fully parse. The rows above are still real — losing them because a
              file is mid-edit would be the view refusing to be useful at the moment somebody is
              looking at a branch in progress. */}
          {diff?.partial && (
            <p className="mt-1.5 text-[11px] leading-[1.5] text-faint">
              One side did not fully parse ({diff.partial}), so this may be incomplete. The Lines
              view is unaffected.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function SemanticRow({ row }: { row: GithubSemanticRow }) {
  return (
    <ActionRow
      // §B.7.2's warning tone, on the one kind entitled to it. `fail` rather than a new kind: a
      // widened grant is the agent gaining a capability nobody in this workspace granted it, which
      // in this app's vocabulary is the thing that went wrong on this commit.
      kind={row.warn ? "fail" : row.kind.endsWith("_removed") ? "update" : "write"}
      state="done"
      hideVerb
      lead={
        row.warn ? (
          <span className="w-4 text-center text-err"><AlertTriangleIcon size={ICON.xs} /></span>
        ) : (
          <span className="w-4" />
        )
      }
      object={
        <span className={row.warn ? "text-err" : "text-muted"}>
          {row.verb}{" "}
          <span className={row.warn ? "text-err" : "text-ink"}>
            <Truncate title={row.object}>{row.object}</Truncate>
          </span>
        </span>
      }
      trailing={
        row.detail ? (
          // `ink` RATHER THAN A NEW ERROR TONE ON THE CHIP. The row already carries the warning —
          // the glyph, the verb and the object are all in `text-err` — and a red chip beside them
          // would be the fourth thing on one line saying the same thing. What the chip adds is the
          // classification, and on a warning row it earns emphasis rather than colour.
          <Chip size="sm" tone={row.warn ? "ink" : "faint"} caps>
            {row.detail}
          </Chip>
        ) : null
      }
    />
  );
}
