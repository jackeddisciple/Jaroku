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
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.tsx";
import { useBuildStore } from "../store/buildStore.ts";
import { providerLabelOf, useProviderStore } from "../store/providerStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { useDeployStore } from "../store/deployStore.ts";
import { sendCancelDeploy, sendSetOwnKeyForPlatform } from "../lib/socket.ts";
import { isDeployInFlight } from "../types.ts";
import { agentStatus } from "../lib/agentStatus.ts";
import { fmtPercent } from "../lib/format.ts";
import { ProviderMark, BRAND_COLOR, JarokuGlyph } from "../lib/icons.tsx";
import { BRAND, ICON, TYPE } from "../lib/tokens.ts";

import { Truncate } from "./Truncate.tsx";
import { Chip } from "./Chip.tsx";
import { GitBranchIcon, GithubIcon, KeyIcon, StopIcon } from "./panelIcons.tsx";
import { useGithubStore } from "../store/githubStore.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { useEvalStore } from "../store/evalStore.ts";
import { StatusBadge } from "./StatusBadge.tsx";
import { ShareIcon } from "./activityIcons.tsx";
import { iconBtn, outlineBtn } from "./buttons.ts";
import { RunFigures } from "./StatusBar.tsx";

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

// THE LABELS USED TO BE HERE, as a three-entry record with no `google` key that fell back to the
// raw id — so a provider the product fully supports was "Gemini" in the composer's model selector,
// which had its own copy, and `google` in this menu, which is where you go to configure it. They come
// from the server's own table now, beside the models they belong to: see providerStore.

/**
 * Which providers this workspace has a key for — and the one door to changing that.
 *
 * IT USED TO BE A PLACE TO PASTE ONE, AND THAT WAS THE HOLE. The form here sent the key over the
 * WebSocket, and elevation travels on a request header that a WebSocket cannot carry: the passcode
 * gate the whole Secrets surface is built on could be walked around by opening this popover. §5.1
 * had already asked for one home for a credential and named the cost of two — two rotation paths,
 * two validation paths — and this was the path that classified nothing, stored no mask, and wrote
 * no audit row, so a key added here landed in the Secrets tab's Custom group.
 *
 * So it reads and does not write. What it keeps is the useful half: the chip that names the
 * provider is still where you find out whether it is connected, and now it is also where you are
 * sent to the tab that can change it.
 */
function ProviderMenu({ provider, model }: { provider: string; model: string }) {
  // Open state lives in uiStore, not here, because Settings in the sidebar opens this same
  // panel — the door a first-run user was pointed at.
  const open = useUiStore((s) => s.providerPanelOpen);
  const setOpen = useUiStore((s) => s.setProviderPanel);
  const setRightTab = useUiStore((s) => s.setRightTab);
  const providers = useProviderStore((s) => s.providers);
  const models = useProviderStore((s) => s.models);
  const ownKeyForPlatform = useProviderStore((s) => s.ownKeyForPlatform);
  // The one provider this preference can spend: planning, generation, the fix loop, explain and
  // the judge are Anthropic-only, so an OpenAI key opted in would buy the workspace nothing.
  const anthropicReady = providers.some((p) => p.id === "anthropic" && p.configured);
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
          {providerLabelOf(models, provider)}
          {/* A model id is an identifier; the provider's name is prose. */}
          {provider !== "fake" && <span className="font-mono text-faint">{model}</span>}
        </Chip>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-2 w-[440px] max-w-[calc(100vw-2rem)] rounded-card border border-edge bg-panel p-3 shadow-floating">
          <div className={TYPE.sectionLabel}>Provider keys</div>
          <p className="mt-1 text-[11px] leading-[1.55] text-faint">
            Kept in Secrets with every other credential, behind the passcode. Never logged, never
            sent back to this page.
          </p>
          <div className="mt-2.5 space-y-2">
            {providers.map((p) => (
              <div key={p.id} className="flex items-center gap-2">
                <ProviderMark provider={p.id} size={12} />
                <span className="text-[12px] text-ink">{providerLabelOf(models, p.id)}</span>
                {p.configured ? (
                  <StatusBadge state="ok" variant="outline" label="connected" icon={KeyIcon} />
                ) : (
                  // DISABLED WITH A STATED REASON RATHER THAN ABSENT, the same rule the model
                  // selector follows: a provider that vanishes reads as one the product does not
                  // support.
                  <span className="text-[11px] text-faint">no key</span>
                )}
                {p.powers_jaroku && (
                  <span className="ml-auto text-[11px] text-faint">powers planning &amp; generation</span>
                )}
              </div>
            ))}
            {providers.length === 0 && (
              <p className="text-[11px] text-faint">Not connected to the server.</p>
            )}
          </div>
          {/* WHO PAYS FOR JAROKU'S OWN THINKING, beside the row that says which provider does it.
              The server has accepted this command since BYOK shipped and nothing ever sent it, so
              the preference was permanently false and the Usage panel's note about it was
              unreachable — while the other branch of that note told people to "connect your own to
              run past" a ceiling, pointing at a control that did not exist.

              Disabled with a stated reason rather than hidden when there is no Anthropic key: that
              is the same refusal the server makes, made here so the answer arrives before the
              click rather than as an error strip after it. */}
          <label
            className={`mt-3 flex items-start gap-2 border-t border-hair pt-2.5 text-[11px] ${
              anthropicReady ? "cursor-pointer text-muted" : "cursor-not-allowed text-faint"
            }`}
          >
            <input
              type="checkbox"
              className="mt-0.5 shrink-0"
              checked={ownKeyForPlatform}
              disabled={!anthropicReady}
              onChange={(e) => sendSetOwnKeyForPlatform(e.target.checked)}
            />
            <span className="min-w-0 flex-1">
              Pay for planning &amp; generation with my Anthropic key
              <span className="block text-faint">
                {anthropicReady
                  ? "Off by default — Jaroku's own calls bill to us unless you say otherwise."
                  : "Needs an Anthropic key in this workspace — that is the key this would spend."}
              </span>
            </span>
          </label>

          <button
            type="button"
            className="mt-2.5 w-full rounded-control border-t border-hair pt-2.5 text-left text-[12px] text-muted transition-colors duration-fast hover:text-ink"
            onClick={() => {
              setRightTab("secrets");
              setOpen(false);
            }}
          >
            Add or rotate a key in Secrets →
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * What this agent is linked to — §A.7.
 *
 * THE TAB BADGE AND THIS CHIP ANSWER DIFFERENT QUESTIONS, and that is why they are two elements
 * rather than one. The badge (↑2 / ↓1 / ↕ / ⚠) says HOW OUT OF SYNC an agent is right now; it is
 * the live half, changing constantly. This says WHAT it is linked to; it is close to static,
 * changing only on a relink or a branch switch. Collapsing them would mean either the identity
 * gets buried under a number that changes every minute, or the number gets buried in a string that
 * mostly does not — and each stays legible only on its own update cadence.
 *
 * AN UNLINKED AGENT SHOWS NO CHIP AT ALL, not an empty placeholder. §2.1's principle: describe what
 * is true rather than what is missing.
 *
 * The click is a shortcut into the specific action it implies — the branch switcher — rather than
 * merely the tab, because somebody who clicked the element naming their branch was reaching for
 * the branch.
 */
function GithubChip({ agentId }: { agentId: string }) {
  const view = useGithubStore((s) => s.views[agentId]);
  const openGithubBranches = useUiStore((s) => s.openGithubBranches);
  if (!view) return null;
  return (
    <Chip
      size="sm"
      tone="faint"
      mono
      variant="bare"
      icon={<GithubIcon size={ICON.badge} />}
      onClick={openGithubBranches}
      title={`${view.link.repo_full_name} · ${view.link.branch} — open the branch switcher`}
      className="max-w-[320px]"
    >
      {/* owner/repo SHRINKS BEFORE branch does, because the branch is the more decision-relevant
          half day to day — you switch branches far more often than you switch repositories. Two
          Truncates rather than one over the joined string, so the shrinking is allocated rather
          than left to whichever half happens to be on the right. */}
      <Truncate variant="path" className="min-w-0 max-w-[160px]">{view.link.repo_full_name}</Truncate>
      <span className="shrink-0 text-faint">·</span>
      <Truncate className="min-w-0 shrink-0">{view.link.branch}</Truncate>
    </Chip>
  );
}

/**
 * Where you are, under what you are looking at: `workspace ⑂ branch`.
 *
 * TEN PIXELS AND FAINT, deliberately. It is not something to read — it is something to have
 * already read by the time you wonder. Both halves are optional and the line disappears entirely
 * when neither is known, because a breadcrumb with nothing in it is worse than none.
 *
 * It does not duplicate the GitHub chip beside it. The chip is a control that opens the branch
 * switcher and names the repository; this is the sentence that says which workspace the agent
 * above it belongs to, which nothing in the chrome said before.
 */
function Breadcrumb({ agentId }: { agentId: string }) {
  const view = useGithubStore((s) => s.views[agentId]);
  const workspaces = useSessionStore((s) => s.workspaces);
  const workspaceId = useSessionStore((s) => s.workspaceId);
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const branch = view?.link.branch;
  if (!workspace && !branch) return null;
  return (
    <span className="flex min-w-0 items-center gap-1 text-[10px] text-faint">
      {workspace && <Truncate className="min-w-0 max-w-[160px]">{workspace.name}</Truncate>}
      {workspace && branch && <span aria-hidden>·</span>}
      {branch && (
        <>
          <span className="shrink-0" aria-hidden><GitBranchIcon size={9} /></span>
          <Truncate className="min-w-0 max-w-[140px]">{branch}</Truncate>
        </>
      )}
    </span>
  );
}

/**
 * A ring and a percentage for the one thing in this product that has a real denominator.
 *
 * The chrome had no persistent progress readout at all — a run in flight said "Step 4" with no
 * idea how many steps there are, because a graph does not know its own length, and a deploy
 * reports named stages rather than a fraction. Inventing a percentage for either would be exactly
 * the fabricated placeholder this product refuses everywhere else.
 *
 * An eval drain does have one: `total` and `done`, counted by the server. So that is what this
 * shows, and it shows nothing at all the rest of the time — which is the honest version of a
 * persistent status readout, and the same rule the GitHub badge follows about absence meaning
 * there is nothing to do.
 */
function SyncRing() {
  const progress = useEvalStore((s) => s.progress);
  if (!progress || progress.total === 0) return null;
  const ratio = Math.min(1, progress.done / progress.total);
  const done = ratio >= 1;
  // 2πr for r = 7, which is the circle drawn below. `strokeDasharray` walks it.
  const circumference = 2 * Math.PI * 7;

  return (
    <span
      className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted"
      title={`Evaluating — ${progress.done} of ${progress.total} done${progress.failed > 0 ? `, ${progress.failed} failed` : ""}`}
    >
      <svg width={16} height={16} viewBox="0 0 16 16" className="-rotate-90 align-middle" aria-hidden>
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth={1.75} className="text-hair" />
        <circle
          cx="8"
          cy="8"
          r="7"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeDasharray={`${circumference * ratio} ${circumference}`}
          className={done ? "text-ok" : "text-accent"}
        />
      </svg>
      <span className="font-mono tabular-nums">{fmtPercent(ratio)}</span>
    </span>
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
      {/* brand — the mark alone, no wordmark beside it. A logo that has to be captioned with
          its own name is a logo the product doesn't trust, and the name is already on the tab.
          Sized up from the inline default because it is now carrying the slot by itself, and
          labelled because the glyph is aria-hidden: the brand still has to reach a reader. */}
      <span role="img" aria-label="Jaroku" className="flex items-center text-ink">
        <JarokuGlyph size={BRAND.chrome} />
      </span>

      {/* active agent + status, as a two-line title block.
          THE SECOND LINE IS THE CHEAPEST ORIENTATION CUE THERE IS and the app had none: nothing in
          the chrome said, persistently, which workspace and which branch you were working in. The
          workspace switcher on the right knows the first and the GitHub chip knows the second, but
          both are controls you go and read rather than facts you are already looking at. */}
      {agent && (
        <>
          <span className="text-faint">·</span>
          <span className="flex min-w-0 flex-col justify-center leading-tight">
            <Truncate className="max-w-[280px] text-[13px] text-ink" title={agent.name}>{agent.name}</Truncate>
            <Breadcrumb agentId={agent.agent_id} />
          </span>
          <StatusDot status={status} />
          <GithubChip agentId={agent.agent_id} />
        </>
      )}

      {/* WHAT THE RUN IS DOING, WHILE IT DOES IT — promoted out of the bottom strip. It sits
          against the left group rather than in the right one because it belongs to the agent
          named beside it, not to the workspace controls. */}
      <span className="ml-auto min-w-0 shrink"><RunFigures /></span>

      <div className="flex shrink-0 items-center gap-2">
        <SyncRing />
        {/* Which workspace this tab is in, and the way out of it. Furthest left of the right
            group because it is the widest scope on screen: everything to its right is a fact
            about one workspace, and this is which one. */}
        <WorkspaceSwitcher />

        {/* The provider chip, now also the way in to the keys behind it. */}
        <ProviderMenu provider={provider} model={model} />

        {/* A GLYPH. The title bar carries no other word, and "Share" was the only text button in
            it — a five-letter label on a control whose mark is unambiguous, sitting in the one
            strip that is on screen on every surface of the app. */}
        <button
          title="Share — not available yet"
          aria-label="Share"
          className={iconBtn}
        >
          <ShareIcon size={ICON.sm} />
        </button>
        {inFlight ? (
          // Same swap EvalRunBar makes: while something is running, the button that started it
          // becomes the one that stops it, rather than sitting there disabled and useless.
          <button
            title={`Cancel deploy — ${inFlight.agent_id}`}
            aria-label={`Cancel deploy — ${inFlight.agent_id}`}
            className={`${iconBtn} text-err hover:text-err`}
            onClick={() => sendCancelDeploy(inFlight.id)}
          >
            <StopIcon size={ICON.sm} />
          </button>
        ) : (
          /* OUTLINE, NOT FILLED. This was pure #e4e4e7 on a near-black page, top right, present
              on every screen, and merely dropped to 40% opacity when there was nothing to deploy
              — which made the visual centre of gravity of the entire application a button the
              user is usually not reaching for. Worse, it was one of three ink-filled controls
              visible at once on the default screen, and the rule is one per view: on the composer
              screen that one is the send control.

              A fill is reserved for the act a screen is actually asking for. Deploying is a
              deliberate, reviewed thing you go to the panel for; the button that opens that panel
              does not need to shout. */
          <button
            title={agent ? `Deploy ${agent.name} to your own Railway account` : "Select an agent to deploy"}
            className={outlineBtn}
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
