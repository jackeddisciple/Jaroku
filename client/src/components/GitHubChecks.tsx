// §B.1.2's opt-in: which dataset a pull request runs, and whose money it may spend.
//
// WHAT WAS UNREACHABLE. `checkRunner`, `checkPolicy`, `evalCheck`, `githubChecksLine`, two
// migrations, a webhook branch and four passing suites all sat behind one row in `agent_ci_config`,
// and nothing in the product could write it: `ChecksRepository.setConfig` had no caller anywhere, so
// `ci_dataset_id` was always null and `checkRunner.open` returned "no dataset is linked for CI on
// this agent" on every pull request, for every agent, always.
//
// TWO SEPARATE DECISIONS, SO TWO SEPARATE SENDS. The dataset says whether checks happen at all; the
// policy says whose provider balance a stranger's pull request may spend. Sending both together
// would mean every policy change re-states the dataset — which is how one of them gets lost when two
// tabs are open — and the server patches field by field for exactly that reason.
//
// THE POLICY IS THREE POSITIONS AND NEVER A BOOLEAN. The middle one is the interesting case: a
// collaborator's pull request may spend, a stranger's may not. Collapsing it to a checkbox would
// force every deployment to choose between "CI is useless on forks" and "anybody who can open a
// pull request can spend our balance".

import { useEffect, useState } from "react";
import { useEvalStore } from "../store/evalStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { sendListDatasets, sendSetAgentCiConfig } from "../lib/socket.ts";
import { fmtPercent, relTime } from "../lib/format.ts";
import { ICON } from "../lib/tokens.ts";
import { RegionLabel } from "./GitHubSync.tsx";
import { CheckIcon, XIcon } from "./panelIcons.tsx";
import type { GithubProviderPolicy, GithubView } from "../types.ts";

/** §B.1.3's three positions, in the words that describe what each one lets happen. */
const POLICIES: { id: GithubProviderPolicy; label: string; what: string }[] = [
  { id: "dry_run_only", label: "Dry run", what: "Checks run on the free dry-run provider. Nobody's money." },
  {
    id: "collaborators_paid",
    label: "Collaborators",
    what: "A collaborator's pull request may spend this workspace's balance; a stranger's runs dry.",
  },
  { id: "always_paid", label: "Anybody", what: "Any pull request may spend this workspace's provider balance." },
];

export function ChecksRegion({ view }: { view: GithubView }) {
  const datasets = useEvalStore((s) => s.datasets);
  const connected = useTraceStore((s) => s.connection === "open");
  const [open, setOpen] = useState(false);

  // The dataset list is per agent and this panel never asks for it — the Evals tab does. Asked here
  // when the section is opened, because a picker with nothing in it reads as "no datasets exist"
  // rather than as "nobody has listed them".
  useEffect(() => {
    if (open && connected) sendListDatasets(view.agentId);
  }, [open, connected, view.agentId]);

  const ci = view.ci;
  const policy = ci?.policy ?? "collaborators_paid";
  const on = Boolean(ci?.datasetId);
  const dataset = datasets.find((d) => d.id === ci?.datasetId);
  // The most recent check on this agent, from the markers the snapshot already carries. It is the
  // proof the configuration did something: an opt-in with no result yet and an opt-in that is
  // working look identical without it.
  const latest = view.checks[0];

  return (
    <div className="mt-4">
      <RegionLabel>
        <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpen((v) => !v)}>
          <span>Pull-request checks</span>
          <span className={`text-[11px] ${on ? "text-ok" : "text-faint"}`}>
            {on ? (dataset ? `on · ${dataset.name}` : "on") : "off"}
          </span>
          <span className="ml-auto text-faint">{open ? "−" : "+"}</span>
        </button>
      </RegionLabel>

      {open && (
        <div className="mt-1.5 space-y-2">
          <p className="text-[11px] leading-[1.55] text-faint">
            When a pull request touches this agent, run a dataset against it and post the pass rate,
            the cost per run and the latency as a check — with the delta against the base branch.
            Off by default: unbounded spend on every push to a pull request is not a default.
          </p>

          {/* THE DATASET IS THE SWITCH. There is no separate "enable" toggle, because there is
              nothing to enable without one — and two controls where one decides would let somebody
              turn checks on and have nothing happen. */}
          <label className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-muted">Dataset</span>
            <select
              value={ci?.datasetId ?? ""}
              disabled={!connected}
              onChange={(e) =>
                sendSetAgentCiConfig(view.agentId, { datasetId: e.target.value === "" ? null : e.target.value })
              }
              className="min-w-0 flex-1 rounded-control border border-hair bg-panel px-2 py-1 text-[12px] text-ink outline-none disabled:opacity-40"
            >
              <option value="">Off — post nothing</option>
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.example_count != null ? ` (${d.example_count})` : ""}
                </option>
              ))}
            </select>
          </label>
          {datasets.length === 0 && (
            <p className="text-[11px] text-faint">
              This agent has no datasets yet — build one in Evals and it will appear here.
            </p>
          )}

          <div>
            <div className="text-[11px] text-muted">Who may spend</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {POLICIES.map((p) => (
                <button
                  key={p.id}
                  disabled={!connected}
                  onClick={() => sendSetAgentCiConfig(view.agentId, { policy: p.id })}
                  title={p.what}
                  className={`rounded-control px-2 py-1 text-[11px] transition-colors disabled:opacity-40 ${
                    policy === p.id ? "bg-active text-ink" : "text-muted hover:text-ink"
                  }`}
                >
                  {p.id === policy && <span className="mr-1 align-middle text-ok"><CheckIcon size={ICON.xs} /></span>}
                  {p.label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] leading-[1.55] text-faint">
              {POLICIES.find((p) => p.id === policy)?.what}
            </p>
          </div>

          {/* WHAT ACTUALLY HAPPENED, from the markers already on the snapshot. Without this the
              section says what it is configured to do and nothing about whether it does it. */}
          {latest && (
            <div className="flex items-center gap-2 border-t border-hair pt-2 text-[11px]">
              <span className={latest.conclusion === "failure" ? "text-err" : "text-muted"}>
                {latest.conclusion === "failure" ? <XIcon size={ICON.xs} /> : <CheckIcon size={ICON.xs} />}
              </span>
              <span className="text-muted">
                #{latest.prNumber} · {latest.passRate == null ? "unscored" : fmtPercent(latest.passRate)}
              </span>
              <span className="text-faint">{relTime(latest.createdAt)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
