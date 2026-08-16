// §B.8.2's `[ List | Graph ]` — three lanes and one shared timeline.
//
// THE QUESTION THIS ANSWERS is the one §4's Synced filter can name a count for and not show: what is
// DEPLOYED versus what is on `main`, and how far apart are they. A list of commits cannot show that,
// because the three facts live in three different lists — the version lineage, the remote's
// commits, and the deploy — and holding three lists side by side in your head is the work this
// replaces.
//
// ENTIRELY READ-ONLY, AND THAT IS §B.8.2'S OWN RULE. Every node click-throughs into a surface that
// already exists: a version's diff card, a commit's page on GitHub, a check run's pull request. The
// canvas is a lens over data every earlier section already produces — there is no fetch in this
// file, no command, and no field it reads that some other region does not also render.
//
// AND IT REUSES GRAPH VIEW'S VOCABULARY RATHER THAN INVENTING A SECOND ONE. Circular nodes, thin
// connectors, JetBrains Mono labels — v0.1.1/v0.1.2 established those for the agent's own topology,
// and a second graph aesthetic inside one product would make two pictures that mean different
// things look like they mean the same thing.

import { useMemo } from "react";

import { relTime } from "../lib/format.ts";
import { useDeployStore } from "../store/deployStore.ts";
import type { GithubView } from "../types.ts";
import { Truncate } from "./Truncate.tsx";

/** One thing on a lane. Everything the canvas can draw reduces to this. */
interface CanvasNode {
  id: string;
  lane: "main" | "agent" | "deploys";
  /** Ordering key. ISO, because every source below already has one. */
  at: string;
  /** `v14`, `a1b2c3d`, `live`. Under the dot, in the app's mono. */
  label: string;
  /** The dot's fill. A version Jaroku wrote is filled; a commit it did not is hollow — §3.8. */
  filled: boolean;
  title: string;
  href?: string;
  /** §B.8.2's ⧫, beneath the commit it ran against. */
  marker?: { label: string; title: string; ok: boolean };
}

/**
 * Everything the canvas draws, assembled from what the panel already holds.
 *
 * NO NEW DATA MODEL, which is §B.8.2's closing sentence and is enforced here by construction: every
 * node below is built out of `view.pushed`, `view.unpushed`, `view.remoteOnly`, `view.checks` and
 * the deploy store. If a fact is not already rendered somewhere else in this app, it is not on the
 * canvas.
 *
 * THE `main` LANE IS THE COMMITS NO VERSION ACCOUNTS FOR — §3.8's hollow dots. That is not quite
 * "what is on main", and the difference is worth naming: what the panel can see of the default
 * branch is exactly the commits on the LINKED branch that Jaroku did not write, which for the
 * ordinary `jaroku/<slug>` → `main` arrangement is what a merge brought back. Drawing a lane of
 * commits fetched from `main` itself would be a second remote read on every panel open, for a lane
 * whose useful content is already here.
 */
function buildNodes(view: GithubView, liveSha: string | null): CanvasNode[] {
  const nodes: CanvasNode[] = [];
  const checksBySha = new Map<string, GithubView["checks"][number]>();
  // Newest first from the server, so the FIRST one seen for a sha is the newest — which is the one
  // a marker should show. A later check re-running the same commit supersedes the earlier one.
  for (const c of view.checks) if (!checksBySha.has(c.headSha)) checksBySha.set(c.headSha, c);

  for (const v of [...view.pushed, ...view.unpushed]) {
    const check = v.sha ? checksBySha.get(v.sha) : undefined;
    nodes.push({
      id: `v${v.version}`,
      lane: "agent",
      at: v.createdAt,
      label: `v${v.version}`,
      // A version Jaroku published is filled whether or not it has reached GitHub yet; what the
      // fill means is "this is ours", which is §3.8's own distinction.
      filled: true,
      title: `v${v.version} · ${v.summary}`,
      ...(v.shaUrl ? { href: v.shaUrl } : {}),
      ...(check
        ? {
            marker: {
              // NO PERCENTAGE WHEN NOTHING SCORED. §B.1's null-not-zero rule reaches the canvas:
              // a marker reading "0%" on an unscored eval would be the one place in this product
              // where an absent measurement renders as a bad one.
              label: check.passRate === null ? "⧫" : `⧫ ${Math.round(check.passRate * 100)}%`,
              title:
                check.passRate === null
                  ? `Eval check on #${check.prNumber} — nothing scored`
                  : `Eval check on #${check.prNumber} — ${Math.round(check.passRate * 100)}% · ${check.conclusion ?? "no verdict"}`,
              ok: check.conclusion !== "failure",
            },
          }
        : {}),
    });
  }

  for (const c of view.remoteOnly) {
    nodes.push({
      id: c.sha,
      lane: "main",
      at: c.at,
      label: c.sha.slice(0, 7),
      // HOLLOW, exactly as §3.8's History renders it: a commit no version accounts for is somebody
      // else's work, and the canvas must not make it look like ours.
      filled: false,
      title: `${c.message}${c.author ? ` — @${c.author}` : ""}`,
      href: c.url,
    });
  }

  if (liveSha) {
    const version = view.pushed.find((v) => v.sha === liveSha);
    nodes.push({
      id: `deploy:${liveSha}`,
      lane: "deploys",
      // Pinned to the COMMIT'S time and not the deploy's, so the ▼ sits under the thing it points
      // at rather than at the right-hand end of a timeline it was the last event on.
      at: version?.createdAt ?? new Date().toISOString(),
      label: "live",
      filled: true,
      title: version
        ? `v${version.version} is live in production`
        : `${liveSha.slice(0, 7)} is live in production`,
    });
  }

  return nodes.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

const LANES: { id: CanvasNode["lane"]; label: (view: GithubView) => string }[] = [
  { id: "main", label: () => "main" },
  { id: "agent", label: (v) => v.link.branch },
  { id: "deploys", label: () => "deploys" },
];

export function GraphCanvas({ view }: { view: GithubView }) {
  // The live deployment, from the store that already owns it (v0.2.3). Read rather than re-fetched
  // — the deploys lane is a lens over a fact the Deploy panel already renders.
  const deployments = useDeployStore((s) => s.deployments);
  const liveSha = useMemo(() => {
    const live = Object.values(deployments).find(
      (d) => d.agent_id === view.agentId && d.status === "live",
    );
    if (!live) return null;
    // WHICH VERSION IS LIVE IS INFERRED FROM WHEN THE DEPLOY WAS MADE, and that is an approximation
    // this comment exists to be honest about. A `deployments` row records the agent, the host and
    // the status; it does not record the version it built from, so the closest available answer is
    // the newest pushed version that existed when it was created. It is right whenever nobody
    // published a version between the deploy starting and finishing, which is the ordinary case —
    // and it is a lens over existing data rather than a new column, which is the trade §B.8.2 makes
    // for the whole canvas. The day `deployments` carries a version id, this becomes a lookup.
    const version = view.pushed
      .filter((v) => v.sha && v.createdAt <= live.created_at)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    // Null draws no ▼ at all rather than one under nothing — an agent deployed from a version that
    // was never pushed has no commit for the marker to sit beneath.
    return version?.sha ?? null;
  }, [deployments, view.agentId, view.pushed]);

  const nodes = useMemo(() => buildNodes(view, liveSha), [view, liveSha]);
  const columns = useMemo(() => [...new Set(nodes.map((n) => n.at))].sort(), [nodes]);

  if (nodes.length === 0) {
    return (
      <p className="text-[11px] leading-[1.5] text-muted">
        Nothing on the timeline yet. Versions, commits and deploys appear here as they happen.
      </p>
    );
  }

  return (
    // ONE HORIZONTAL SCROLLER AROUND THE WHOLE THING, so a long history scrolls as one picture. Three
    // lanes that scrolled independently would let the deploy marker slide out from under its commit,
    // which is the one alignment the canvas exists to show.
    <div className="overflow-x-auto">
      <div className="min-w-full" style={{ minWidth: `${Math.max(columns.length * 56 + 80, 240)}px` }}>
        {LANES.map((lane) => {
          const row = nodes.filter((n) => n.lane === lane.id);
          // A lane with nothing on it is not drawn. An agent that has never been deployed has no
          // deploys lane, rather than an empty rail explaining that it is empty.
          if (row.length === 0) return null;
          return (
            <div key={lane.id} className="flex items-start gap-2 py-1.5">
              <span className="w-20 shrink-0 truncate pt-1 font-mono text-[10px] text-faint" title={lane.label(view)}>
                {lane.label(view)}
              </span>
              <div className="relative flex-1">
                {/* The connector, behind the dots. One line per lane rather than per pair, which is
                    v0.1.1's own treatment and is what makes a lane read as continuous. */}
                <div className="absolute left-0 right-0 top-[5px] h-px bg-hair" aria-hidden />
                <div className="relative flex items-start">
                  {columns.map((at) => {
                    const node = row.find((n) => n.at === at);
                    return (
                      <div key={at} className="flex w-14 shrink-0 flex-col items-center">
                        {node ? <CanvasDot node={node} /> : <span className="h-[11px]" aria-hidden />}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CanvasDot({ node }: { node: CanvasNode }) {
  const dot = (
    <span
      className={`inline-block h-[9px] w-[9px] rounded-full border ${
        node.filled ? "border-ink bg-ink" : "border-muted bg-transparent"
      }`}
      aria-hidden
    />
  );
  return (
    <span className="flex flex-col items-center gap-0.5" title={node.title}>
      {node.href ? (
        <a href={node.href} target="_blank" rel="noreferrer" className="leading-none">
          {dot}
        </a>
      ) : (
        <span className="leading-none">{dot}</span>
      )}
      <Truncate className="max-w-[52px] font-mono text-[9px] text-faint">{node.label}</Truncate>
      {node.marker && (
        // BENEATH THE COMMIT IT RAN AGAINST, which is §B.8.2's placement and the reason the whole
        // canvas is worth drawing: one glance answers which commit is live, which scored best, and
        // how far main is from either.
        <span className={`font-mono text-[9px] ${node.marker.ok ? "text-ok" : "text-err"}`} title={node.marker.title}>
          {node.marker.label}
        </span>
      )}
      {node.lane === "deploys" && <span className="text-[9px] text-ok" aria-hidden>▼</span>}
      <span className="sr-only">{relTime(node.at)}</span>
    </span>
  );
}
