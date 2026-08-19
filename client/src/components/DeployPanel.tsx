// The deploy, as it happens.
//
// Structure follows McpPanel, which follows DatasetBuilder: a standing notice, an error strip,
// a chip strip of entities, and a detail pane. What is different is that the detail pane here
// is a live narrative rather than a list, so the vocabulary comes from the trace timeline
// instead — a vertical rail, ActionRows with three tenses, and a raw output well.
//
// No spinner and no progress bar, because there is neither anywhere else in this app. A deploy
// has stages, and the stages ARE the progress indicator: pending, active, done, in the same
// three tenses StreamingFileRow uses for files. A percentage would be a made-up number; a list
// of named stages is the truth and is more useful besides.
//
// Two things this panel is careful about.
//
// The build log is somebody else's text. It renders in a mono well with no interpretation, and
// it has already been scrubbed of every secret the deploy handled, server-side, before it ever
// reached this process.
//
// The serve token is the one credential this product ever sends to a browser. It appears once,
// in a card that says so, with a copy button — and it is in memory only. Reloading loses it,
// which is correct and is stated on the card rather than discovered.

import { useEffect, useMemo, useRef, useState } from "react";

import {
  sendCancelDeploy, sendDeploy, sendForgetDeployment, sendListDeployments, sendLoadDeployLogs,
  sendPlanDeploy, sendSetRailwayToken, sendTestRailwayToken,
} from "../lib/socket.ts";
import { ACCENT, ICON, STATUS, SURFACE, TEXT, TYPE } from "../lib/tokens.ts";
import { fmtDuration } from "../lib/format.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { useDeployStore, selectedDeployment } from "../store/deployStore.ts";
import { runProviders, useProviderStore } from "../store/providerStore.ts";
import type { Deployment, DeployLogLine, DeployStatus } from "../types.ts";
import { isDeployInFlight } from "../types.ts";
import { ActionRow, type ActionState } from "./ActionRow.tsx";
import { primaryBtn, quietBtn, secondaryBtn } from "./buttons.ts";
import { Chip } from "./Chip.tsx";
import { EmptyState, LoadingLine } from "./EmptyState.tsx";
import { StatusDot, type BadgeState } from "./StatusBadge.tsx";
import { Truncate } from "./Truncate.tsx";
import {
  AlertTriangleIcon, CheckIcon, GlobeIcon, KeyIcon, RocketIcon, XIcon,
} from "./panelIcons.tsx";

/**
 * The stages of a deploy, in order, with the words used for each tense.
 *
 * A data table rather than a switch, so the list a user reads and the list the code walks are
 * the same list. `active`/`done` mirror the ActionRow vocabulary: a live row says "Packaging",
 * a settled one says "Packaged", and nothing rewrites its own sentence on the way past.
 */
const STAGES: { id: string; active: string; done: string; detail: string }[] = [
  { id: "packaging", active: "Packaging", done: "Packaged", detail: "writing the Dockerfile and serve wrapper into the project" },
  { id: "provisioning", active: "Provisioning", done: "Provisioned", detail: "creating a project and service in your Railway account" },
  { id: "variables", active: "Setting variables", done: "Set variables", detail: "handing the agent's credentials to Railway" },
  { id: "uploading", active: "Uploading", done: "Uploaded", detail: "sending the project to Railway" },
  { id: "building", active: "Building", done: "Built", detail: "Railway is building the image" },
  { id: "publishing", active: "Publishing", done: "Published", detail: "pointing a public URL at the service" },
];

const STATUS_COPY: Record<DeployStatus, { state: BadgeState; label: string }> = {
  queued: { state: "pending", label: "queued" },
  packaging: { state: "pending", label: "packaging" },
  uploading: { state: "pending", label: "uploading" },
  building: { state: "pending", label: "building" },
  deploying: { state: "pending", label: "deploying" },
  live: { state: "ok", label: "live" },
  failed: { state: "error", label: "failed" },
  cancelled: { state: "error", label: "cancelled" },
  interrupted: { state: "error", label: "interrupted" },
  // Not an error: it worked, and then a later deploy of the same agent replaced it.
  superseded: { state: "neutral", label: "replaced" },
  removed: { state: "error", label: "removed" },
};

/** A stable empty array — a fresh `[]` per render would defeat every memo below it. */
const EMPTY_LINES: DeployLogLine[] = [];

/** A ticker, only while something is moving. Same shape as TraceTimeline's. */
function useTick(active: boolean, ms = 500): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}

export function DeployPanel() {
  // Field by field rather than the whole store. `useDeployStore()` with no selector
  // re-renders on ANY change, and during a build the store changes once per log line — so a
  // noisy dependency install re-rendered the form, the chip strip, the stage rail and the
  // whole log well a thousand times over, while the user was trying to read it.
  const deployments = useDeployStore((s) => s.deployments);
  const railwayConfigured = useDeployStore((s) => s.railwayConfigured);
  const loaded = useDeployStore((s) => s.loaded);
  const plan = useDeployStore((s) => s.plan);
  const planning = useDeployStore((s) => s.planning);
  const serveToken = useDeployStore((s) => s.serveToken);
  const error = useDeployStore((s) => s.error);
  const notice = useDeployStore((s) => s.notice);
  const setError = useDeployStore((s) => s.setError);
  const setNotice = useDeployStore((s) => s.setNotice);
  const dismissServeToken = useDeployStore((s) => s.dismissServeToken);
  const select = useDeployStore((s) => s.select);
  const selectedId = useDeployStore((s) => s.selectedId);
  const agentId = useBuildStore((s) => s.activeAgentId);
  const agents = useBuildStore((s) => s.agents);

  useEffect(() => {
    // McpPanel's precedent: ask on mount rather than relying only on the connect snapshot,
    // so opening the tab after a reconnect shows the truth.
    sendListDeployments();
  }, []);

  const selected = selectedDeployment({ deployments, selectedId });

  // A deployment the user opened but has no lines for yet — reloaded, or connected mid-build.
  // Read imperatively rather than subscribed: this only needs the answer at the moment the
  // selection changes, and subscribing to `logs` here would undo the point of the selectors
  // above.
  useEffect(() => {
    if (selected && !useDeployStore.getState().logs[selected.id]) sendLoadDeployLogs(selected.id);
  }, [selected?.id]);

  if (!loaded) {
    // Not a spinner: "we have not been told yet" is a real state, and claiming nothing is
    // deployed before the first snapshot would be a lie the sidebar then repeats.
    return <LoadingLine label="Loading deployments…" />;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 border-b border-hair px-4 py-3">
        <div className="flex items-start gap-2">
          <span style={{ color: ACCENT.mcp }} className="mt-[1px] shrink-0">
            <RocketIcon size={ICON.sm} />
          </span>
          <p className="text-[11px] leading-[1.5] text-muted">
            <span className="text-ink">A deploy goes to your own Railway account.</span> Jaroku
            packages the agent, hands your credentials to Railway over HTTPS, and returns the
            URL. It hosts nothing and keeps no copy of anything it sends.
          </p>
        </div>
      </div>

      {(error || notice) && (
        <div className="shrink-0 px-4 pt-2">
          <div
            className={`flex items-start gap-2 rounded-control border px-2 py-1.5 text-[11px] leading-[1.5] ${
              error ? "border-err/30 text-err" : "border-hair text-muted"
            }`}
          >
            <span className="min-w-0 flex-1 break-words">{error ?? notice}</span>
            <button
              className="shrink-0 text-faint hover:text-ink"
              onClick={() => (error ? setError(null) : setNotice(null))}
            >
              <XIcon size={ICON.xs} />
            </button>
          </div>
        </div>
      )}

      {serveToken && <ServeTokenCard onDismiss={dismissServeToken} />}

      <RailwayTokenRow configured={railwayConfigured} />

      {deployments.length > 0 && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-hair px-4 py-2">
          {deployments.map((d) => {
            const agent = agents.find((a) => a.agent_id === d.agent_id);
            return (
              <Chip
                key={d.id}
                size="lg"
                selected={selected?.id === d.id}
                onClick={() => select(d.id)}
                className="max-w-[220px] shrink-0"
                icon={
                  <StatusDot
                    state={STATUS_COPY[d.status].state}
                    size={7}
                    pulse={isDeployInFlight(d.status)}
                    title={STATUS_COPY[d.status].label}
                  />
                }
              >
                <Truncate title={`${agent?.name ?? d.agent_id} — ${STATUS_COPY[d.status].label}`}>
                  {agent?.name ?? d.agent_id}
                </Truncate>
              </Chip>
            );
          })}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {selected ? (
          <DeployDetail key={selected.id} deployment={selected} />
        ) : agentId ? (
          <DeployForm
            agentId={agentId}
            plan={plan?.agentId === agentId ? plan : null}
            planning={planning}
            railwayConfigured={railwayConfigured}
          />
        ) : (
          <EmptyState
            size="line"
            icon={RocketIcon}
            title="Nothing deployed yet"
            hint="Select an agent, then deploy it to your own Railway account."
          />
        )}
      </div>
    </div>
  );
}

// --- the form --------------------------------------------------------------

function DeployForm({
  agentId,
  plan,
  planning,
  railwayConfigured,
}: {
  agentId: string;
  plan: ReturnType<typeof useDeployStore.getState>["plan"];
  planning: boolean;
  railwayConfigured: boolean;
}) {
  const [provider, setProvider] = useState("anthropic");
  const [model, setModel] = useState("claude-haiku-4-5");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  // Which models a deploy may be configured with is the server's price sheet — see providerStore.
  // A hardcoded list here meant a priced model could not be deployed with, which is the same drift
  // in the one place it costs a running service rather than a run.
  const providerModels = useProviderStore((s) => s.models);
  const catalogue = useMemo(() => runProviders(providerModels), [providerModels]);
  const [allowMissing, setAllowMissing] = useState(false);
  const [publicEndpoint, setPublicEndpoint] = useState(false);

  // Re-plan whenever anything the plan depends on changes. It creates nothing and spends
  // nothing, so there is no reason to make the user ask for it.
  useEffect(() => {
    sendPlanDeploy(agentId, provider, model);
  }, [agentId, provider, model, railwayConfigured, allowMissing]);

  const models: readonly string[] = catalogue.find((p) => p.id === provider)?.models ?? [];
  const secrets = plan?.secrets ?? [];
  const chosen = secrets.filter((s) => !excluded.has(s.name)).map((s) => s.name);
  // A required credential the user has unticked leaves the container in exactly the state a
  // missing one does — the template raises on every call — so it is shown the same way and
  // cleared by the same override, rather than being discovered after a green deploy.
  const withheld = secrets
    .filter((s) => s.required && s.configured && excluded.has(s.name))
    .map((s) => s.name);
  const blocking = (plan?.problems ?? []).filter(
    (p) => !allowMissing || !p.startsWith("not set on this machine"),
  );
  const canDeploy = Boolean(plan) && blocking.length === 0 && (allowMissing || withheld.length === 0);

  return (
    <div className="space-y-4 p-4">
      <div>
        <div className={TYPE.sectionLabel}>Runs on</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {catalogue.filter((p) => p.id !== "fake").map((p) => (
            <Chip
              key={p.id}
              size="md"
              selected={provider === p.id}
              onClick={() => {
                setProvider(p.id);
                setModel(p.models[0] ?? "");
              }}
            >
              {p.label}
            </Chip>
          ))}
          <span className="mx-1 text-hair">|</span>
          {models.map((m) => (
            <Chip key={m} size="md" selected={model === m} onClick={() => setModel(m)}>
              <span className="font-mono">{m}</span>
            </Chip>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] leading-[1.5] text-faint">
          The dry-run provider is not deployable — it answers with placeholder text, so a
          deployed one would be a URL that looks like it works.
        </p>
      </div>

      <div>
        <div className={TYPE.sectionLabel}>Credentials to hand over</div>
        {planning && !plan ? (
          <p className="mt-1.5 text-[11px] text-muted">checking…</p>
        ) : secrets.length === 0 ? (
          <p className="mt-1.5 text-[11px] text-muted">This agent needs none.</p>
        ) : (
          <div className="mt-1.5 space-y-0.5">
            {secrets.map((s) => {
              const on = !excluded.has(s.name);
              return (
                <ActionRow
                  key={s.name}
                  kind="connect"
                  state={s.configured ? "done" : s.required ? "error" : "pending"}
                  hideVerb
                  object={
                    <span className={`font-mono ${on ? "text-ink" : "text-faint line-through"}`}>
                      {s.name}
                    </span>
                  }
                  detail={<span className="text-faint">{s.reason}</span>}
                  trailing={
                    <button
                      className="text-[11px] text-muted hover:text-ink"
                      onClick={() =>
                        setExcluded((prev) => {
                          const next = new Set(prev);
                          if (next.has(s.name)) next.delete(s.name);
                          else next.add(s.name);
                          return next;
                        })
                      }
                    >
                      {on ? (s.configured ? "send" : "not set") : "skip"}
                    </button>
                  }
                />
              );
            })}
          </div>
        )}
        {/* The same promise the MCP panel and the provider form make, in the same words. */}
        <p className="mt-1.5 text-[11px] leading-[1.5] text-faint">
          Values are read from <span className="font-mono">runtime/.env</span> at the moment
          they are sent, go straight into an HTTPS request body to Railway, and are never
          logged, written to Jaroku's database, or sent back to this page. Only the names are.
        </p>
      </div>

      {withheld.length > 0 && !allowMissing && (
        <div className="flex items-start gap-2 text-[11px] leading-[1.5] text-err">
          <span className="mt-[2px] shrink-0"><AlertTriangleIcon size={ICON.xs} /></span>
          <span className="min-w-0 flex-1">
            not sending: {withheld.join(", ")}. The agent's tools raise without them, so it
            would deploy successfully and then fail every request.
          </span>
        </div>
      )}

      {plan?.problems.length ? (
        <div className="space-y-1">
          {plan.problems.map((p) => (
            <div key={p} className="flex items-start gap-2 text-[11px] leading-[1.5] text-err">
              <span className="mt-[2px] shrink-0"><AlertTriangleIcon size={ICON.xs} /></span>
              <span className="min-w-0 flex-1">{p}</span>
            </div>
          ))}
        </div>
      ) : null}

      {(withheld.length > 0 || plan?.problems.some((p) => p.startsWith("not set on this machine"))) && (
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted">
          <input
            type="checkbox"
            checked={allowMissing}
            onChange={(e) => setAllowMissing(e.target.checked)}
          />
          Deploy anyway — I will set the rest in Railway myself
        </label>
      )}

      {plan?.warnings.map((w) => (
        <div key={w} className="flex items-start gap-2 text-[11px] leading-[1.5] text-run">
          <span className="mt-[2px] shrink-0"><AlertTriangleIcon size={ICON.xs} /></span>
          <span className="min-w-0 flex-1">{w}</span>
        </div>
      ))}

      {plan?.redeploy && (
        // "Replace what is live" and "put a second one up" are different decisions, and only
        // the user knows which they meant. Said before the button, not after.
        <p className="text-[11px] leading-[1.5] text-muted">
          This agent already has a Railway service. Deploying replaces what is running there —
          same project, same URL — rather than creating a second one you would also be billed
          for.
        </p>
      )}

      <div className="flex items-center gap-2 border-t border-hair pt-3">
        <label
          className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted"
          title="Anyone who finds the URL could run this agent on your provider key."
        >
          <input
            type="checkbox"
            checked={publicEndpoint}
            onChange={(e) => setPublicEndpoint(e.target.checked)}
          />
          No bearer token
        </label>
        <button
          className="ml-auto rounded-control px-3 py-1.5 text-[12px] transition-opacity disabled:cursor-not-allowed disabled:opacity-30"
          style={{ background: TEXT.ink, color: SURFACE.bg }}
          disabled={!canDeploy}
          onClick={() =>
            sendDeploy({ agentId, provider, model, envKeys: chosen, allowMissing, publicEndpoint })
          }
        >
          {plan?.redeploy ? "Redeploy" : "Deploy"}
        </button>
      </div>
    </div>
  );
}

// --- the live detail -------------------------------------------------------

function DeployDetail({ deployment }: { deployment: Deployment }) {
  // Subscribed here rather than passed down, so a log line re-renders the detail pane and
  // nothing above it.
  const lines = useDeployStore((s) => s.logs[deployment.id]) ?? EMPTY_LINES;
  const stage = useDeployStore((s) => s.stage[deployment.id]) ?? null;
  const running = isDeployInFlight(deployment.status);
  const now = useTick(running);
  const scrollRef = useRef<HTMLPreElement>(null);
  const select = useDeployStore((s) => s.select);

  const elapsed = useMemo(() => {
    const start = Date.parse(deployment.created_at);
    const end = deployment.ended_at ? Date.parse(deployment.ended_at) : now;
    return Math.max(0, end - start);
  }, [deployment.created_at, deployment.ended_at, now]);

  // Depends on lines.length, not on the deployment: a build log grows without anything else
  // changing, and a pane that stops following mid-build is a pane you cannot watch.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  // How far it got. A live deploy has finished every stage whether or not the last `stage`
  // event arrived; a failed one stopped AT the phase it last reported, and saying which is
  // most of what a failure has to communicate.
  const at = stage ? STAGES.findIndex((s) => s.id === stage) : -1;
  const reached = deployment.status === "live" ? STAGES.length : at;
  const stageState = (i: number): ActionState => {
    if (i < reached) return "done";
    if (i > reached) return "pending";
    return running ? "active" : "error";
  };
  // Split once per change of the log, not once per render of the panel.
  const { buildLines, narration } = useMemo(() => ({
    buildLines: lines.filter((l) => l.stream !== "jaroku"),
    narration: lines.filter((l) => l.stream === "jaroku"),
  }), [lines]);

  return (
    <div className="p-4">
      <div className="flex items-center gap-2">
        <StatusDot
          state={STATUS_COPY[deployment.status].state}
          pulse={running}
          title={STATUS_COPY[deployment.status].label}
        />
        <span className="text-[13px] font-medium text-ink">{deployment.agent_id}</span>
        <span className="font-mono text-[11px] text-faint">
          {deployment.provider}/{deployment.model}
        </span>
        <span className="ml-auto text-[11px] tabular-nums text-muted">
          {running ? (
            <span className="text-run">Deploying {fmtDuration(elapsed)}</span>
          ) : (
            `${STATUS_COPY[deployment.status].label} in ${fmtDuration(elapsed)}`
          )}
        </span>
      </div>

      {deployment.url && (
        <a
          href={deployment.url}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex items-center gap-1.5 font-mono text-[12px] text-ink hover:underline"
        >
          <span style={{ color: STATUS.ok }}><GlobeIcon size={ICON.xs} /></span>
          {deployment.url}
        </a>
      )}

      {deployment.error && (
        <div className="mt-2 rounded-control border border-err/30 px-2 py-1.5 text-[11px] leading-[1.5] text-err">
          {deployment.error}
        </div>
      )}

      {/* The rail. Steps float on it — the trace timeline's shape, for the same reason: it is
          what makes a sequence read as one thing rather than as a table of rows. */}
      <div className="relative mt-3">
        <div className="absolute bottom-3 left-[9px] top-3 w-px bg-hair" />
        {STAGES.map((s, i) => {
          const state = stageState(i);
          return (
            <ActionRow
              key={s.id}
              kind={state === "done" ? "done" : state === "error" ? "fail" : "wait"}
              state={state}
              verb={state === "active" ? s.active : state === "done" ? s.done : s.active}
              object={null}
              detail={<span className="text-faint">{s.detail}</span>}
              className="pl-1"
            />
          );
        })}
      </div>

      {narration.length > 0 && (
        <div className="mt-3 space-y-0.5">
          {narration.map((l) => (
            <div key={l.seq} className="text-[11px] leading-[1.5] text-muted [overflow-wrap:anywhere]">
              {l.text}
            </div>
          ))}
        </div>
      )}

      {buildLines.length > 0 && (
        <div className="mt-3">
          <div className={TYPE.sectionLabel}>
            Build output
            <span className="ml-2 font-normal normal-case tracking-normal text-faint">
              {buildLines.length} lines · already stripped of every credential this deploy sent
            </span>
          </div>
          {/* Somebody else's text, rendered with no interpretation. */}
          <pre
            ref={scrollRef}
            className="mt-1 max-h-72 overflow-auto rounded-control border border-hair bg-bg/60 p-2.5 font-mono text-[11px] leading-[1.55] text-ink"
          >
            {buildLines.map((l) => (
              <div key={l.seq} className={l.stream === "build-err" ? "text-run" : undefined}>
                {l.text}
              </div>
            ))}
          </pre>
        </div>
      )}

      <div className="mt-3 flex items-center gap-2 border-t border-hair pt-3">
        {running ? (
          <button
            className="rounded-control px-3 py-1.5 text-[12px] text-err transition-colors hover:bg-active"
            onClick={() => sendCancelDeploy(deployment.id)}
          >
            Cancel deploy
          </button>
        ) : (
          <button className={quietBtn} onClick={() => select(null)}>
            Deploy another
          </button>
        )}
        {!running && (
          <button
            className={`${secondaryBtn} ml-auto hover:!text-err`}
            title="Removes the record from Jaroku. Nothing in your Railway account is touched."
            onClick={() => sendForgetDeployment(deployment.id)}
          >
            Forget
          </button>
        )}
      </div>
    </div>
  );
}

// --- the one-shot token ----------------------------------------------------

function ServeTokenCard({ onDismiss }: { onDismiss: () => void }) {
  const reveal = useDeployStore((s) => s.serveToken);
  const [copied, setCopied] = useState(false);
  if (!reveal) return null;

  return (
    <div className="shrink-0 px-4 pt-2">
      <div
        className="rounded-card border p-2.5"
        style={{ borderColor: `${STATUS.ok}55` }}
      >
        <div className="flex items-center gap-2">
          <span style={{ color: STATUS.ok }}><KeyIcon size={ICON.sm} /></span>
          <span className="text-[12px] font-medium text-ink">Your endpoint's bearer token</span>
          <button className="ml-auto text-faint hover:text-ink" onClick={onDismiss}>
            <XIcon size={ICON.xs} />
          </button>
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-control bg-bg/60 px-2 py-1 font-mono text-[11px] text-ink">
            {reveal.token}
          </code>
          <button
            className={primaryBtn}
            onClick={() => {
              void navigator.clipboard?.writeText(reveal.token);
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        {/* Saying it is shown once matters more than saying it is secret. */}
        <p className="mt-1.5 text-[11px] leading-[1.5] text-faint">
          Shown once. Jaroku generated it, set it on Railway, and kept no copy — reloading this
          page loses it. Send it as{" "}
          <span className="font-mono">Authorization: Bearer …</span> to{" "}
          <span className="font-mono">{reveal.url}/run</span>.
        </p>
      </div>
    </div>
  );
}

// --- the Railway credential ------------------------------------------------

function RailwayTokenRow({ configured }: { configured: boolean }) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const testing = useDeployStore((s) => s.testing);
  const testResult = useDeployStore((s) => s.testResult);

  return (
    <div className="shrink-0 border-b border-hair px-4 py-2">
      <div className="flex items-center gap-2">
        <StatusDot
          state={configured ? "ok" : "pending"}
          title={configured ? "a Railway token is set" : "no Railway token"}
        />
        <span className="text-[11px] text-muted">
          {configured ? "Railway connected" : "No Railway token"}
        </span>
        <button className={`${quietBtn} ml-auto`} onClick={() => setOpen((v) => !v)}>
          {configured ? "Replace" : "Connect Railway"}
        </button>
        {configured && (
          <button
            className={quietBtn}
            onClick={() => sendSetRailwayToken(null)}
            title="Removes it from runtime/.env"
          >
            Remove
          </button>
        )}
      </div>

      {open && (
        <div className="mt-2">
          <div className="flex items-center gap-2">
            <input
              autoFocus
              type="password"
              autoComplete="off"
              className="min-w-0 flex-1 rounded-control bg-bg px-2 py-1 font-mono text-[11px] text-ink outline-none placeholder:text-faint"
              placeholder="Railway account token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && token.trim()) {
                  sendSetRailwayToken(token.trim());
                  setToken("");
                  setOpen(false);
                }
              }}
            />
            {/* Two buttons, not one: a test that wrote first would put a credential on disk
                before the user pressed Save. Same split as the provider form. */}
            <button
              className={secondaryBtn}
              disabled={!token.trim() || testing}
              onClick={() => sendTestRailwayToken(token.trim())}
            >
              {testing ? "testing…" : "Test"}
            </button>
            <button
              className={primaryBtn}
              disabled={!token.trim()}
              onClick={() => {
                sendSetRailwayToken(token.trim());
                setToken("");
                setOpen(false);
              }}
            >
              Save
            </button>
          </div>
          {testResult && (
            <div
              className={`mt-1.5 flex items-center gap-1.5 text-[11px] ${
                testResult.ok ? "text-ok" : "text-err"
              }`}
            >
              {testResult.ok ? <CheckIcon size={ICON.xs} /> : <XIcon size={ICON.xs} />}
              {testResult.message ?? (testResult.ok ? "connected" : "rejected")}
            </div>
          )}
          <p className="mt-1.5 text-[11px] leading-[1.5] text-faint">
            Create one at{" "}
            <span className="font-mono">railway.com/account/tokens</span> (an account token,
            not a project token). Stored in <span className="font-mono">runtime/.env</span> as{" "}
            <span className="font-mono">RAILWAY_API_TOKEN</span>, which is gitignored. It is
            never logged and never sent back to this page.
          </p>
        </div>
      )}
    </div>
  );
}
