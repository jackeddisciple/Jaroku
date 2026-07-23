// Top bar (doc §4.1): brand, the active agent + its live status, the provider chip, and the
// Share / Deploy actions. Share and Deploy have no backend in the MVP, so they're honest
// stubs — visible affordances that say "not yet" rather than pretending to work.

import { useBuildStore } from "../store/buildStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { agentStatus } from "../lib/agentStatus.ts";
import { ProviderMark, BRAND_COLOR } from "../lib/icons.tsx";

function StatusDot({ status }: { status: string }) {
  const color = status === "running" ? "bg-run" : status === "draft" ? "bg-faint" : "bg-ok";
  const label = status === "running" ? "running" : status === "draft" ? "draft" : "ready";
  return (
    <span className="inline-flex items-center gap-1.5 text-muted text-[12px]">
      <span className={`w-1.5 h-1.5 rounded-full ${color} ${status === "running" ? "animate-pulse" : ""}`} />
      {label}
    </span>
  );
}

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: "Claude",
  openai: "OpenAI",
  fake: "Dry run",
};

export function TopBar() {
  const agent = useBuildStore((s) => s.agents.find((a) => a.agent_id === s.activeAgentId));
  const runs = useTraceStore((s) => s.runs);
  const provider = useUiStore((s) => s.provider);
  const model = useUiStore((s) => s.model);

  const status = agent ? agentStatus(agent.agent_id, runs) : "draft";

  return (
    <div className="flex items-center gap-3 px-4 h-11 shrink-0 bg-panel">
      {/* brand */}
      <span className="text-run text-[15px] leading-none" aria-hidden>◭</span>
      <span className="text-ink font-semibold">Jaroku</span>

      {/* active agent + status */}
      {agent && (
        <>
          <span className="text-faint">·</span>
          <span className="text-ink text-[13px] truncate max-w-[280px]">{agent.name}</span>
          <StatusDot status={status} />
        </>
      )}

      <div className="ml-auto flex items-center gap-2">
        {/* provider chip — brand color only because it's the chosen provider */}
        <span className="flex items-center gap-2 text-[12px] text-muted bg-active rounded px-2.5 py-1">
          <ProviderMark provider={provider} />
          <span className="text-ink">{PROVIDER_LABEL[provider] ?? provider}</span>
          {provider !== "fake" && <span className="text-faint">{model}</span>}
        </span>

        <button
          title="Sharing isn't available yet"
          className="text-[12px] text-muted hover:text-ink rounded px-2.5 py-1 transition-colors"
        >
          Share
        </button>
        <button
          title="Deploy isn't available yet"
          className="text-[12px] rounded px-3 py-1 transition-colors"
          style={{ background: "#4f46e5", color: "#fff" }}
        >
          Deploy
        </button>
      </div>
    </div>
  );
}

// Re-export so callers styling connector chips can reach brand colors without a second import.
export { BRAND_COLOR };
