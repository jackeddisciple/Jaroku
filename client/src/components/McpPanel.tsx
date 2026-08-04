// Connected MCP servers: add, inspect, re-discover, remove.
//
// This panel is where the trust model becomes visible. Its organising rule is that a user
// should never be able to look at it and forget these tools came from somewhere nobody
// audited — so the rose MCP accent is on every row, "unreviewed third-party code" is stated
// in words rather than implied by a colour, and every tool shows how it was classified AND
// the argument for that classification. A verdict you cannot see the reasoning behind is not
// something anyone can meaningfully disagree with, and disagreeing is the whole point of the
// override control beside it.
//
// Structure follows DatasetBuilder: a chip strip of entities, an action row, a detail list.
// Every mutation goes over the mcp channel and comes back as a full snapshot, so there is no
// optimistic local state here — the only local state is the add form and which row is open.

import { useEffect, useState } from "react";
import { useMcpStore } from "../store/mcpStore.ts";
import {
  sendAddMcpServer,
  sendListMcpServers,
  sendRediscoverMcpServer,
  sendRemoveMcpServer,
  sendSetMcpServerAuth,
  sendSetMcpToolImpact,
} from "../lib/socket.ts";
import { ACCENT, ICON, STATUS, TEXT } from "../lib/tokens.ts";
import { Chip } from "./Chip.tsx";
import { Truncate } from "./Truncate.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { primaryBtn, quietBtn, secondaryBtn } from "./buttons.ts";
import { StatusBadge, StatusDot } from "./StatusBadge.tsx";
import {
  AlertTriangleIcon, EyeIcon, KeyIcon, PlugIcon, PlusIcon, RefreshIcon, ShieldAlertIcon,
  UserCircleIcon, XIcon,
} from "./panelIcons.tsx";
import type { McpServer, McpTool } from "../types.ts";

/** What each status means, in the words a user would use to decide what to do next. */
const STATUS_COPY: Record<McpServer["status"], { state: "ok" | "error" | "pending"; label: string }> = {
  connected: { state: "ok", label: "connected" },
  unreachable: { state: "error", label: "unreachable" },
  auth_required: { state: "pending", label: "needs a credential" },
  error: { state: "error", label: "error" },
};

// --- one discovered tool -----------------------------------------------------

function ToolRow({ tool, serverId }: { tool: McpTool; serverId: string }) {
  const [open, setOpen] = useState(false);
  const high = tool.impact === "high";
  const Icon = high ? ShieldAlertIcon : EyeIcon;

  return (
    <div className="rounded-control px-2 py-1.5 hover:bg-active/40 transition-colors">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0" style={{ color: high ? STATUS.pending : TEXT.muted }}>
          <Icon size={ICON.sm} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-[12px] text-ink">{tool.name}</span>
            {high ? (
              <StatusBadge state="pending" label="high impact" icon={ShieldAlertIcon}
                title="A generated agent must ask before running this for the first time." />
            ) : (
              // The badge's default neutral icon is an ✕, which next to the word "read-only"
              // reads as a negation rather than a description. Both of these are properties
              // of the tool, so both say what they are.
              <StatusBadge state="neutral" variant="outline" label="read-only" icon={EyeIcon}
                title="Classified as information retrieval — it runs without stopping to ask." />
            )}
            {tool.overridden && (
              <StatusBadge state="neutral" variant="outline" label={`you set this to ${tool.impact}`}
                icon={UserCircleIcon}
                title={`Jaroku classified it ${tool.computed_impact}.`} />
            )}
            {/* A voided override is not a silent revert: the server changed the tool out
                from under a judgement that was made about a different version of it. */}
            {tool.override_voided && (
              <StatusBadge state="pending" label="your override no longer applies"
                icon={AlertTriangleIcon}
                title="This tool's schema changed since you set that, so the classification governs again." />
            )}
          </div>
          {tool.description && (
            <p className="mt-0.5 text-[11px] leading-[1.5] text-muted">{tool.description}</p>
          )}
          <p className="mt-0.5 text-[11px] leading-[1.5] text-faint">
            {tool.overridden ? `Jaroku said ${tool.computed_impact}: ` : ""}
            {tool.impact_reason}
          </p>

          <div className="mt-1 flex items-center gap-2">
            <button className={quietBtn + " !px-0 !text-[11px]"} onClick={() => setOpen((v) => !v)}>
              {open ? "hide schema" : "schema"}
            </button>
            <span className="text-faint">·</span>
            {/* Both directions, always. Raising is how you gate something the heuristic read
                as harmless; lowering is how you stop being asked about a search tool. */}
            <button
              className={quietBtn + " !px-0 !text-[11px]"}
              onClick={() => sendSetMcpToolImpact(serverId, tool.name, high ? "low" : "high")}
              title={high
                ? "Stop asking before this runs."
                : "Ask before this runs, even though it was classified read-only."}
            >
              {high ? "treat as read-only" : "treat as high impact"}
            </button>
            {tool.overridden && (
              <>
                <span className="text-faint">·</span>
                <button
                  className={quietBtn + " !px-0 !text-[11px]"}
                  onClick={() => sendSetMcpToolImpact(serverId, tool.name, null)}
                >
                  use Jaroku's classification
                </button>
              </>
            )}
          </div>

          {open && (
            <pre className="mt-1.5 overflow-x-auto rounded-control border border-hair bg-bg/60 p-2 font-mono text-[10px] leading-[1.5] text-muted">
              {JSON.stringify(tool.input_schema, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

// --- one server --------------------------------------------------------------

function ServerDetail({ server }: { server: McpServer }) {
  const discovering = useMcpStore((s) => Boolean(s.discovering[server.id]));
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const status = STATUS_COPY[server.status];
  const highCount = server.tools.filter((t) => t.impact === "high").length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-4 py-2">
        <div className="flex items-center gap-2 flex-wrap">
          <StatusBadge state={status.state} label={status.label} />
          {server.configured && (
            <StatusBadge state="neutral" variant="outline" label="credential stored" icon={KeyIcon}
              title={`Read from ${server.auth_env_key} in runtime/.env. Jaroku never displays it.`} />
          )}
          <Truncate className="font-mono text-[11px] text-faint" title={server.endpoint}>{server.endpoint}</Truncate>
        </div>

        {server.server_name && (
          <p className="mt-1 text-[11px] text-muted">
            Identifies itself as{" "}
            <span className="font-mono text-ink">
              {server.server_name}
              {server.server_version ? ` ${server.server_version}` : ""}
            </span>
            {server.protocol_version ? ` · MCP ${server.protocol_version}` : ""}
            {/* Everything on this line is the server's own claim about itself. */}
            <span className="text-faint"> — its own claim, unverified</span>
          </p>
        )}

        {server.last_error && (
          <p className="mt-1 break-words rounded-control border border-err/30 px-2 py-1.5 text-[11px] leading-[1.5] text-err">
            {server.last_error}
          </p>
        )}

        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <button className={secondaryBtn} disabled={discovering}
            onClick={() => sendRediscoverMcpServer(server.id)}
            title="Ask the server what it can do, again. A failure keeps the tools already discovered.">
            <RefreshIcon size={ICON.xs} />
            {discovering ? "checking…" : "re-check"}
          </button>
          <button className={secondaryBtn} onClick={() => setShowToken((v) => !v)}>
            <KeyIcon size={ICON.xs} />
            {server.configured ? "replace credential" : "add a credential"}
          </button>
          <button className={secondaryBtn + " ml-auto hover:!text-err"}
            onClick={() => sendRemoveMcpServer(server.id)}>
            <XIcon size={ICON.xs} />
            disconnect
          </button>
        </div>

        {showToken && (
          <div className="mt-2 rounded-card border border-edge bg-panel p-2 shadow-raised">
            <div className="flex items-center gap-2">
              <input
                type="password"
                autoComplete="off"
                className="min-w-0 flex-1 rounded-control bg-bg px-2 py-1 font-mono text-[11px] text-ink outline-none placeholder:text-faint"
                placeholder="bearer token or API key"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && token.trim()) {
                    sendSetMcpServerAuth(server.id, token.trim());
                    setToken("");
                    setShowToken(false);
                  }
                }}
              />
              <button className={primaryBtn} disabled={!token.trim()}
                onClick={() => {
                  sendSetMcpServerAuth(server.id, token.trim());
                  setToken("");
                  setShowToken(false);
                }}>
                Save
              </button>
              {server.configured && (
                <button className={quietBtn}
                  onClick={() => { sendSetMcpServerAuth(server.id, null); setShowToken(false); }}>
                  Remove
                </button>
              )}
            </div>
            {/* Saying where it goes matters more than saying it is safe. */}
            <p className="mt-1.5 text-[11px] leading-[1.5] text-faint">
              Stored in <span className="font-mono">runtime/.env</span> as{" "}
              <span className="font-mono">{server.auth_env_key ?? `JAROKU_MCP_${server.id.toUpperCase()}_TOKEN`}</span>,
              which is gitignored. It is never logged and never sent back to this page.
            </p>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {server.tools.length === 0 ? (
          <EmptyState
            size="inline"
            icon={PlugIcon}
            title={server.status === "connected" ? "No tools advertised" : "No tools discovered yet"}
            hint={
              server.status === "connected"
                ? "The handshake succeeded and this server offered nothing to call."
                : "Connect successfully to see what this server says it can do."
            }
          />
        ) : (
          <>
            <p className="px-2 py-1.5 text-[11px] text-faint">
              {server.tools.length} tool{server.tools.length === 1 ? "" : "s"}
              {highCount > 0 && `, ${highCount} needing confirmation before first use`}
              {server.discovered_at && ` · last checked ${new Date(server.discovered_at).toLocaleString()}`}
            </p>
            {server.tools.map((t) => (
              <ToolRow key={t.name} tool={t} serverId={server.id} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// --- the panel ---------------------------------------------------------------

export function McpPanel() {
  const servers = useMcpStore((s) => s.servers);
  const error = useMcpStore((s) => s.error);
  const notice = useMcpStore((s) => s.notice);
  const addingEndpoint = useMcpStore((s) => s.addingEndpoint);
  const setError = useMcpStore((s) => s.setError);
  const setNotice = useMcpStore((s) => s.setNotice);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");

  useEffect(() => sendListMcpServers(), []);

  // Keep the selection if it still exists, else fall back to the first — the same idiom as
  // evalStore's dataset selection and buildStore's agent selection.
  const selected = servers.find((s) => s.id === selectedId) ?? servers[0] ?? null;
  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);

  const submit = () => {
    if (!endpoint.trim()) return;
    sendAddMcpServer(endpoint.trim(), label.trim() || undefined, token.trim() || undefined);
    setEndpoint("");
    setLabel("");
    setToken("");
    setAdding(false);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* The standing reminder. It is worth the two lines it costs: everything below this
          came from code that was never reviewed, and that is easy to forget once a tool list
          looks as tidy as a connector list. */}
      <div className="shrink-0 px-4 pt-2">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 shrink-0" style={{ color: ACCENT.mcp }}>
            <PlugIcon size={ICON.sm} />
          </span>
          <p className="text-[11px] leading-[1.5] text-muted">
            <span className="text-ink">MCP servers are third-party code Jaroku has not reviewed.</span>{" "}
            What a server says it can do is its own claim. Tools from here are marked
            everywhere they appear, an agent only receives the ones its plan asked for, and a
            high-impact one stops for your confirmation before it runs.
          </p>
        </div>
      </div>

      {(error || notice) && (
        <div className="shrink-0 px-4 pt-2">
          <div className={`flex items-start gap-2 rounded-control border px-2 py-1.5 text-[11px] leading-[1.5] ${
            error ? "border-err/30 text-err" : "border-hair text-muted"}`}>
            <span className="min-w-0 flex-1 break-words">{error ?? notice}</span>
            <button className="shrink-0 text-faint hover:text-ink"
              onClick={() => (error ? setError(null) : setNotice(null))}>
              <XIcon size={ICON.xs} />
            </button>
          </div>
        </div>
      )}

      {/* Server chips */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-hair px-4 py-2">
        {servers.map((s) => (
          <Chip
            key={s.id}
            size="lg"
            onClick={() => setSelectedId(s.id)}
            selected={selected?.id === s.id}
            className="max-w-[220px] shrink-0"
            figure={s.tools.length}
            icon={
              <StatusDot
                state={STATUS_COPY[s.status].state}
                size={7}
                color={s.status === "connected" ? ACCENT.mcp : undefined}
              />
            }
          >
            <Truncate title={s.label}>{s.label}</Truncate>
          </Chip>
        ))}
        <button className={quietBtn + " shrink-0 inline-flex items-center gap-1"}
          onClick={() => setAdding((v) => !v)}>
          <PlusIcon size={ICON.xs} />
          Connect a server
        </button>
      </div>

      {adding && (
        <div className="shrink-0 px-4 pb-2">
          <div className="rounded-card border border-edge bg-panel p-2 shadow-raised">
            <input
              autoFocus
              className="w-full rounded-control bg-bg px-2 py-1 font-mono text-[11px] text-ink outline-none placeholder:text-faint"
              placeholder="https://example.com/mcp"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            <div className="mt-1.5 flex items-center gap-2">
              <input
                className="min-w-0 flex-1 rounded-control bg-bg px-2 py-1 text-[11px] text-ink outline-none placeholder:text-faint"
                placeholder="name (optional)"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
              <input
                type="password"
                autoComplete="off"
                className="min-w-0 flex-1 rounded-control bg-bg px-2 py-1 font-mono text-[11px] text-ink outline-none placeholder:text-faint"
                placeholder="token (if it needs one)"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
              <button className={primaryBtn} disabled={!endpoint.trim() || Boolean(addingEndpoint)}
                onClick={submit}>
                {addingEndpoint ? "connecting…" : "Connect"}
              </button>
            </div>
            <p className="mt-1.5 text-[11px] leading-[1.5] text-faint">
              Jaroku will ask the server what it can do and show you the answer. Nothing is
              granted to any agent until you select it while planning. Only http(s) endpoints
              are supported — stdio would mean running someone else's binary on your machine.
            </p>
          </div>
        </div>
      )}

      {servers.length === 0 ? (
        <EmptyState
          icon={PlugIcon}
          title="No MCP servers connected"
          hint="Connecting one discovers the tools it offers, so you can give an agent the specific ones it needs — and nothing else."
        />
      ) : selected ? (
        <ServerDetail key={selected.id} server={selected} />
      ) : null}
    </div>
  );
}
