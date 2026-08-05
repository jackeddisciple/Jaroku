// Top bar (doc §4.1): brand, the active agent + its live status, the provider chip, and the
// Share / Deploy actions.
//
// Deploy is real now, and it does the smallest thing that is honest: it opens the Deploy
// panel, where the decisions live. A one-click button that started a deploy from here would
// be starting one without the user having seen which credentials it is about to hand over —
// and that is exactly the review the panel exists to give them. While a deploy is running the
// button becomes the way to stop it, the Run/Cancel swap EvalRunBar already uses.
//
// Share still has no backend, and is still an honest stub.

import { useEffect, useRef } from "react";
import { useBuildStore } from "../store/buildStore.ts";
import { useProviderStore } from "../store/providerStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { useDeployStore } from "../store/deployStore.ts";
import { sendCancelDeploy } from "../lib/socket.ts";
import { isDeployInFlight } from "../types.ts";
import { agentStatus } from "../lib/agentStatus.ts";
import { ProviderMark, BRAND_COLOR, JarokuGlyph } from "../lib/icons.tsx";
import { TYPE } from "../lib/tokens.ts";
import { ProviderKeyForm } from "./onboarding/ProviderKeyForm.tsx";
import { Truncate } from "./Truncate.tsx";
import { Chip } from "./Chip.tsx";
import { KeyIcon } from "./panelIcons.tsx";
import { StatusBadge } from "./StatusBadge.tsx";

function StatusDot({ status }: { status: string }) {
  const color = status === "running" ? "bg-run" : status === "draft" ? "bg-faint" : "bg-ok";
  const label = status === "running" ? "running" : status === "draft" ? "draft" : "ready";
  return (
    <span className="inline-flex items-center gap-1.5 text-muted text-[12px]">
      <span className={`w-1.5 h-1.5 rounded-full ${color} ${status === "running" ? "animate-stream-pulse motion-reduce:animate-none" : ""}`} />
      {label}
    </span>
  );
}

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: "Claude",
  openai: "OpenAI",
  fake: "Dry run",
};

/**
 * Where a provider key is added after onboarding — the app's "connect a provider" surface.
 *
 * It hangs off the chip that already names the provider, rather than living behind a Settings
 * screen that would exist for one field. The chip was previously a label; a control that says
 * which provider you are on is the obvious place to change what that provider can do.
 *
 * The form itself is the one onboarding uses, unmodified. A second copy would be a second set
 * of promises about what happens to the key.
 */
function ProviderMenu({ provider, model }: { provider: string; model: string }) {
  // Open state lives in uiStore, not here, because Settings in the sidebar opens this same
  // panel — the door a first-run user was pointed at.
  const open = useUiStore((s) => s.providerPanelOpen);
  const setOpen = useUiStore((s) => s.setProviderPanel);
  const providers = useProviderStore((s) => s.providers);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)} title="Provider keys">
        {/* provider chip — brand color only because it's the chosen provider */}
        <Chip size="lg" tone="ink" selected={open} icon={<ProviderMark provider={provider} />}>
          {PROVIDER_LABEL[provider] ?? provider}
          {/* A model id is an identifier; the provider's name is prose. */}
          {provider !== "fake" && <span className="font-mono text-faint">{model}</span>}
        </Chip>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-2 w-[440px] max-w-[calc(100vw-2rem)] rounded-card border border-edge bg-panel p-3 shadow-floating">
          <div className={TYPE.sectionLabel}>Provider keys</div>
          <p className="mt-1 text-[11px] leading-[1.55] text-faint">
            Written to <span className="font-mono text-muted">runtime/.env</span> on this machine.
            Never logged, never sent back to this page.
          </p>
          <div className="mt-2.5 space-y-3">
            {providers.map((p) => (
              <div key={p.id}>
                <div className="mb-1.5 flex items-center gap-2">
                  <ProviderMark provider={p.id} size={12} />
                  <span className="text-[12px] text-ink">{PROVIDER_LABEL[p.id] ?? p.id}</span>
                  {p.configured && (
                    <StatusBadge state="ok" variant="outline" label="connected" icon={KeyIcon} />
                  )}
                  {p.powers_jaroku && (
                    <span className="ml-auto text-[11px] text-faint">powers planning &amp; generation</span>
                  )}
                </div>
                <ProviderKeyForm provider={p} saveLabel="Save" />
              </div>
            ))}
            {providers.length === 0 && (
              <p className="text-[11px] text-faint">Not connected to the server.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function TopBar() {
  const agent = useBuildStore((s) => s.agents.find((a) => a.agent_id === s.activeAgentId));
  const runs = useTraceStore((s) => s.runs);
  const provider = useUiStore((s) => s.provider);
  const model = useUiStore((s) => s.model);

  const status = agent ? agentStatus(agent.agent_id, runs) : "draft";
  const setRightTab = useUiStore((s) => s.setRightTab);
  const inFlight = useDeployStore((s) => s.deployments.find((d) => isDeployInFlight(d.status)));

  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-hair px-4">
      {/* brand */}
      <JarokuGlyph />
      <span className="text-ink font-semibold">Jaroku</span>

      {/* active agent + status */}
      {agent && (
        <>
          <span className="text-faint">·</span>
          <Truncate className="max-w-[280px] text-[13px] text-ink" title={agent.name}>{agent.name}</Truncate>
          <StatusDot status={status} />
        </>
      )}

      <div className="ml-auto flex items-center gap-2">
        {/* The provider chip, now also the way in to the keys behind it. */}
        <ProviderMenu provider={provider} model={model} />

        <button
          title="Sharing isn't available yet"
          className="text-[12px] text-muted hover:text-ink rounded-control px-2.5 py-1 transition-colors"
        >
          Share
        </button>
        {inFlight ? (
          // Same swap EvalRunBar makes: while something is running, the button that started it
          // becomes the one that stops it, rather than sitting there disabled and useless.
          <button
            title={`Deploying ${inFlight.agent_id} — click to cancel`}
            className="rounded-control px-3 py-1 text-[12px] text-err transition-colors hover:bg-active"
            onClick={() => sendCancelDeploy(inFlight.id)}
          >
            Cancel deploy
          </button>
        ) : (
          <button
            title={agent ? `Deploy ${agent.name} to your own Railway account` : "Select an agent to deploy"}
            className="rounded-control px-3 py-1 text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            style={{ background: "#4f46e5", color: "#fff" }}
            disabled={!agent}
            onClick={() => setRightTab("deploy")}
          >
            Deploy
          </button>
        )}
      </div>
    </div>
  );
}

// Re-export so callers styling connector chips can reach brand colors without a second import.
export { BRAND_COLOR };
