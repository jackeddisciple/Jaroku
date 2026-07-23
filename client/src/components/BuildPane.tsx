// The center pane — the doc §4.1 conversation flow. One scrolling thread per agent:
// your message → Jaroku's response → inline diff cards, with a fixed prompt box at the
// bottom. The same box builds and fixes: no agent selected → generate a new one; agent
// selected → propose an edit to it (the fix loop). Generation becomes the first turn of
// the new agent's conversation.
//
// Connector selection stays explicit UI rather than something the model infers from the
// prompt: the reviewed templates are copied in verbatim, so which ones are included is a
// decision the user makes, not a guess the generation re-rolls each time.

import { useEffect, useRef, useState } from "react";
import { orderedFiles, useBuildStore } from "../store/buildStore.ts";
import { threadFor, useChatStore, type ChatTurn, type GenTurn } from "../store/chatStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { sendEdit, sendGenerate } from "../lib/socket.ts";
import { DiffCard } from "./DiffCard.tsx";

// Mirrors runtime/tool_templates/catalog.json. The server validates the ids it receives
// against the catalog, so a stale entry here can never inject an unreviewed connector.
const CONNECTORS = [
  { id: "gmail", label: "Gmail", hint: "search mail, draft replies" },
  { id: "slack", label: "Slack", hint: "read channels, post messages" },
  { id: "postgres", label: "Postgres", hint: "read-only SQL" },
];

function GenTurnView({ turn, isLive }: { turn: GenTurn; isLive: boolean }) {
  const files = useBuildStore((s) => s.files);
  const fileOrder = useBuildStore((s) => s.fileOrder);
  const streamingFile = useBuildStore((s) => s.streamingFile);

  if (turn.status === "error") {
    return (
      <div className="text-[12px]">
        <div className="text-err">Generation failed — {turn.error}</div>
        {turn.problems && turn.problems.length > 0 && (
          <ul className="mt-1.5 space-y-0.5 text-muted">
            {turn.problems.map((p, i) => (
              <li key={i} className="pl-3">· {p}</li>
            ))}
          </ul>
        )}
        <div className="mt-1.5 text-faint">Nothing was written — any previous agent is untouched.</div>
      </div>
    );
  }

  if (turn.status === "generating" && isLive) {
    const list = orderedFiles({ files, fileOrder });
    return (
      <div className="text-[12px]">
        <div className="text-run">Generating…</div>
        <div className="mt-1 space-y-0.5">
          {list.map((f) => (
            <div key={f.path} className="flex items-center gap-2 animate-slide-in">
              <span className={f.complete ? "text-ok" : "text-run animate-pulse"}>
                {f.complete ? "✓" : "●"}
              </span>
              <span className="text-muted truncate">{f.path}</span>
              <span className="ml-auto text-faint text-[11px] tabular-nums">
                {f.path === streamingFile ? "writing…" : `${f.content.length} B`}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Finished (or a generation from earlier in the session).
  return (
    <div className="text-[12px]">
      <span className="text-ok">Generated</span>{" "}
      <span className="text-muted">
        {turn.files.length} files
        {turn.usage && (
          <>
            {" · "}
            {turn.usage.output_tokens.toLocaleString()} output tokens · $
            {turn.usage.cost_usd.toFixed(4)}
            {turn.usage.cache_read_input_tokens > 0 && <span className="text-faint"> · cache hit</span>}
          </>
        )}
      </span>
    </div>
  );
}

function Turn({ turn, isLastGen }: { turn: ChatTurn; isLastGen: boolean }) {
  if (turn.role === "user") {
    return (
      <div className="flex gap-2">
        <span className="text-faint select-none">›</span>
        <span className="text-ink text-[13px] whitespace-pre-wrap break-words min-w-0">{turn.text}</span>
      </div>
    );
  }
  if (turn.kind === "gen") return <div className="pl-4"><GenTurnView turn={turn} isLive={isLastGen} /></div>;
  if (turn.kind === "proposal") return <div className="pl-4"><DiffCard turn={turn} /></div>;
  return (
    <div className={`pl-4 text-[12px] ${turn.tone === "error" ? "text-err" : "text-faint"}`}>
      {turn.text}
    </div>
  );
}

export function BuildPane() {
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const focusChatNonce = useUiStore((s) => s.focusChatNonce);

  // Cmd+/ (and the palette) focus the composer.
  useEffect(() => {
    if (focusChatNonce > 0) composerRef.current?.focus();
  }, [focusChatNonce]);

  const connected = useTraceStore((s) => s.connection === "open");
  const genStatus = useBuildStore((s) => s.status);
  const agents = useBuildStore((s) => s.agents);
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  const threads = useChatStore((s) => s.threads);
  const pendingThread = useChatStore((s) => s.pending);
  const streamingAgentId = useChatStore((s) => s.streamingAgentId);

  const agent = agents.find((a) => a.agent_id === activeAgentId);
  const mode: "generate" | "edit" = activeAgentId ? "edit" : "generate";
  const busy = genStatus === "generating" || streamingAgentId !== null;
  const turns = threadFor({ threads, pending: pendingThread }, activeAgentId);

  // Keep the newest turn in view — the conversation scrolls up like a terminal.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, genStatus]);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const submit = () => {
    const trimmed = text.trim();
    if (!connected || busy || !trimmed) return;
    if (mode === "generate") {
      sendGenerate(trimmed, selected, name.trim() || undefined);
    } else if (activeAgentId) {
      sendEdit(activeAgentId, trimmed);
    }
    setText("");
  };

  const lastGenId = [...turns].reverse().find((t) => t.role === "jaroku" && t.kind === "gen")?.id;

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="px-6 pt-4 pb-2 shrink-0 flex items-baseline gap-2">
        <span className="text-[11px] uppercase tracking-widest text-faint">
          {mode === "generate" ? "New agent" : "Fix"}
        </span>
        {agent && <span className="text-[12px] text-muted truncate">{agent.name}</span>}
      </div>

      {/* conversation */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-6 py-2 space-y-4">
        {turns.length === 0 && (
          <div className="text-[12px] text-muted pt-4">
            {mode === "generate" ? (
              <>Describe the agent you want and it will be generated as a real LangGraph project.</>
            ) : (
              <>
                Describe a change to this agent — e.g. “add Redis conversation memory” or
                “the SQL tool needs a LIMIT clause”. You’ll get a reviewable diff to apply or
                discard; nothing is changed until you apply it.
              </>
            )}
          </div>
        )}
        {turns.map((t) => (
          <Turn key={t.id} turn={t} isLastGen={t.id === lastGenId} />
        ))}
      </div>

      {/* composer */}
      <div className="px-6 pb-4 pt-2 shrink-0">
        {mode === "generate" && (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-faint mr-1">Connectors</span>
            {CONNECTORS.map((c) => {
              const on = selected.includes(c.id);
              return (
                <button
                  key={c.id}
                  onClick={() => toggle(c.id)}
                  disabled={busy}
                  title={c.hint}
                  className={`rounded px-2.5 py-1 text-[12px] transition-colors disabled:opacity-50 ${
                    on ? "bg-active text-ink" : "bg-panel text-muted hover:text-ink"
                  }`}
                >
                  {on ? "✓ " : ""}
                  {c.label}
                </button>
              );
            })}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              placeholder="name (optional)"
              className="ml-auto w-40 bg-panel text-ink placeholder:text-faint rounded px-2.5 py-1 text-[12px] outline-none focus:ring-1 focus:ring-[#2a2a2e] disabled:opacity-50"
            />
          </div>
        )}

        <div className="flex items-end gap-2">
          <textarea
            ref={composerRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            }}
            disabled={busy}
            rows={3}
            placeholder={
              mode === "generate"
                ? "Describe the agent you want — e.g. “a support agent that reads Gmail, looks up orders in Postgres, and drafts replies”"
                : `Describe a change to ${agent?.name ?? "this agent"} — ⌘↵ to send`
            }
            className="flex-1 resize-none bg-panel text-ink placeholder:text-faint rounded px-3 py-2.5 outline-none focus:ring-1 focus:ring-[#2a2a2e] disabled:opacity-50"
          />
          <button
            onClick={submit}
            disabled={!connected || busy || !text.trim()}
            className="rounded px-4 py-2.5 bg-panel text-ink hover:bg-active disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {busy ? "Working…" : mode === "generate" ? "Generate" : "Propose"}
          </button>
        </div>
      </div>
    </div>
  );
}
