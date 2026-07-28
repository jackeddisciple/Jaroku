// Provider picker, pre-run cost estimate, and the run control.
//
// An eval multiplies cost by examples × providers, and the judge adds one more paid call
// per cell. Three examples on two providers is eight calls; fifty on three is three
// hundred. So a real-provider eval cannot be started from a single click:
//
//   pick providers → see an estimate → set a ceiling → confirm
//
// The dry run skips all of it, because it is genuinely free. That asymmetry is the point —
// the free path stays one click, and only spending money asks for a decision.
//
// The estimate informs; the CEILING enforces. An estimate that reads low must never be the
// only thing between a user and a large bill, so the confirm step requires a ceiling and
// the server aborts on true spend regardless of what was predicted.

import { useEffect, useState } from "react";
import { useBuildStore } from "../store/buildStore.ts";
import { examplesOf, useEvalStore } from "../store/evalStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { RUN_PROVIDERS } from "../store/uiStore.ts";
import { sendCancelEval, sendEstimateEval, sendStartEval } from "../lib/socket.ts";
import { fmtCost } from "../lib/format.ts";
import type { EvalTarget } from "../types.ts";

const key = (t: EvalTarget) => `${t.provider}/${t.model}`;
const FREE: EvalTarget = { provider: "fake", model: "fake-dry-run" };

/** Default ceiling offered alongside an estimate: comfortably above the high end. */
function suggestedCeiling(high: number): number {
  // Round up to something legible — a ceiling of $0.1837 invites nobody to think about it.
  const padded = Math.max(high * 1.5, 0.05);
  const magnitude = 10 ** Math.floor(Math.log10(padded));
  return Math.ceil(padded / magnitude) * magnitude;
}

export function EvalRunBar() {
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  const connected = useTraceStore((s) => s.connection === "open");
  const selectedDatasetId = useEvalStore((s) => s.selectedDatasetId);
  const examplesByDataset = useEvalStore((s) => s.examplesByDataset);
  const progress = useEvalStore((s) => s.progress);
  const estimate = useEvalStore((s) => s.estimate);
  const setEstimate = useEvalStore((s) => s.setEstimate);

  const [targets, setTargets] = useState<EvalTarget[]>([FREE]);
  const [confirming, setConfirming] = useState(false);
  const [ceiling, setCeiling] = useState<string>("");

  const examples = examplesOf(examplesByDataset, selectedDatasetId);
  const running = progress !== null && progress.status === undefined;
  const paid = targets.filter((t) => t.provider !== "fake");
  const needsConfirm = paid.length > 0;

  // Changing the selection invalidates any estimate on screen — a stale number next to a
  // different set of providers is worse than none.
  useEffect(() => {
    setEstimate(null);
    setConfirming(false);
  }, [targets.map(key).join(","), selectedDatasetId]);

  useEffect(() => {
    if (estimate && !ceiling) setCeiling(String(suggestedCeiling(estimate.totalHighUsd)));
  }, [estimate]);

  if (!selectedDatasetId) return null;

  const toggle = (t: EvalTarget) =>
    setTargets((cur) =>
      cur.some((x) => key(x) === key(t)) ? cur.filter((x) => key(x) !== key(t)) : [...cur, t],
    );

  const beginRun = () => {
    if (!activeAgentId || !examples.length || !targets.length) return;
    if (!needsConfirm) {
      // Free by construction — nothing to estimate, nothing to confirm.
      sendStartEval(selectedDatasetId, activeAgentId, targets, null);
      return;
    }
    sendEstimateEval(selectedDatasetId, activeAgentId, targets);
    setConfirming(true);
  };

  const confirmRun = () => {
    if (!activeAgentId) return;
    const budget = Number(ceiling);
    if (!Number.isFinite(budget) || budget <= 0) return;
    sendStartEval(selectedDatasetId, activeAgentId, targets, budget);
    setConfirming(false);
    setEstimate(null);
  };

  return (
    <div className="px-4 py-3 shrink-0 space-y-2">
      {/* provider selection */}
      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
        {RUN_PROVIDERS.flatMap((p) =>
          p.models.map((m) => {
            const t: EvalTarget = { provider: p.id, model: m };
            const on = targets.some((x) => key(x) === key(t));
            const free = p.id === "fake";
            return (
              <button
                key={key(t)}
                onClick={() => toggle(t)}
                disabled={running}
                title={free ? "Free — no API calls" : `${p.label} · billed per token`}
                className={`rounded px-2 py-1 text-[11px] whitespace-nowrap transition-colors disabled:opacity-40 ${
                  on ? "bg-active text-ink" : "text-muted hover:text-ink"
                }`}
              >
                {free ? "Dry run (free)" : m}
              </button>
            );
          }),
        )}
      </div>

      {/* the estimate — shown only when money is involved, and always as a range */}
      {confirming && (
        <div className="rounded bg-panel px-3 py-2 space-y-1.5">
          {!estimate ? (
            <div className="text-[11px] text-muted">estimating…</div>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px]">
                <span className="text-ink">
                  {estimate.examples} example{estimate.examples === 1 ? "" : "s"} ×{" "}
                  {estimate.targets} provider{estimate.targets === 1 ? "" : "s"} ={" "}
                  {estimate.totalRuns} run{estimate.totalRuns === 1 ? "" : "s"}
                </span>
                {/* A RANGE, never a point value — this is a projection, not a quote. */}
                <span className="text-run">
                  roughly {fmtCost(estimate.totalLowUsd)}–{fmtCost(estimate.totalHighUsd)}
                </span>
                {estimate.judgeHighUsd > 0 && (
                  <span className="text-faint">
                    incl. {fmtCost(estimate.judgeLowUsd)}–{fmtCost(estimate.judgeHighUsd)} judge
                  </span>
                )}
              </div>

              {estimate.notes.map((n, i) => (
                <div key={i} className="text-[10px] text-faint">· {n}</div>
              ))}

              <div className="flex items-center gap-2 pt-1">
                <label className="text-[11px] text-muted">Stop at</label>
                <span className="text-muted text-[11px]">$</span>
                <input
                  value={ceiling}
                  onChange={(e) => setCeiling(e.target.value)}
                  inputMode="decimal"
                  className="w-20 bg-active text-ink rounded px-2 py-1 text-[11px] tabular-nums outline-none focus:ring-1 focus:ring-[#2a2a2e]"
                />
                <span className="text-[10px] text-faint">
                  hard ceiling — checked against real spend, not this estimate
                </span>
                <button
                  onClick={() => { setConfirming(false); setEstimate(null); }}
                  className="ml-auto text-[11px] text-faint hover:text-ink transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmRun}
                  disabled={!(Number(ceiling) > 0)}
                  className="rounded px-3 py-1 text-[11px] whitespace-nowrap transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
                  style={{ background: "#e4e4e7", color: "#0d0d0f" }}
                >
                  Run for real
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* run control */}
      {!confirming && (
        <div className="flex items-center gap-2.5 text-[12px]">
          <span className="text-faint tabular-nums whitespace-nowrap">
            {examples.length} × {targets.length} = {examples.length * targets.length} run
            {examples.length * targets.length === 1 ? "" : "s"}
          </span>
          {needsConfirm && (
            <span className="text-run text-[11px] whitespace-nowrap">real providers — billed</span>
          )}
          <span className="ml-auto" />
          {running ? (
            <button
              onClick={() => progress && sendCancelEval(progress.evalId)}
              className="rounded px-3 py-1.5 text-[12px] text-err hover:bg-active transition-colors whitespace-nowrap"
            >
              Cancel
            </button>
          ) : (
            <button
              onClick={beginRun}
              disabled={!connected || !examples.length || !targets.length}
              className="rounded px-3 py-1.5 text-[12px] whitespace-nowrap shrink-0 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ background: "#e4e4e7", color: "#0d0d0f" }}
            >
              {needsConfirm ? "Estimate cost…" : "Run eval"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
