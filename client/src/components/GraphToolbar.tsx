// The Graph tab's toolbar: a pill along the top of the canvas, marks only.
//
// RUN IS HERE BECAUSE THE GRAPH IS WHERE A RUN IS WATCHED. Starting one from the composer and then
// switching to this tab to see it move was two places for one act; the button runs exactly what the
// composer's Test mode runs — the same command, the same model, the same last input, and the same
// way to a key when there is none — and while the run is on screen it becomes Pause and Stop.
//
// NO WORDS ON THE CONTROLS. Each is a mark with a tooltip and an accessible name from one string,
// so the canvas stays a picture.

import { useEffect, useRef, useState, type ReactElement } from "react";

import { Icon } from "../lib/icons/registry.ts";
import { keyHint } from "../lib/modKey.ts";
import { ICON } from "../lib/tokens.ts";
import { sendCancelRun, sendPauseRun, sendResumeRun, sendRun } from "../lib/socket.ts";
import { isRunnable, useProviderStore } from "../store/providerStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { inputKey, useUiStore } from "../store/uiStore.ts";
import { iconBtn } from "./buttons.ts";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "./ui/dropdown-menu.tsx";
import { Tip } from "./ui/tooltip.tsx";

/** One control: a mark, its name as both tooltip and accessible name. */
export function ToolButton({
  label, onClick, disabled, children, pressed,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  pressed?: boolean;
  children: ReactElement;
}) {
  return (
    <Tip label={label} side="bottom">
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
        className={`${iconBtn} h-7 w-7 ${pressed ? "bg-active text-ink" : ""}`}
      >
        {children}
      </button>
    </Tip>
  );
}

/** A hairline between groups of controls. */
export function ToolDivider() {
  return <span className="mx-0.5 h-4 w-px bg-hair" aria-hidden />;
}

function readLastInput(agentId: string): string {
  try {
    return localStorage.getItem(inputKey(agentId)) ?? "";
  } catch {
    return "";
  }
}

/** Run ▶, and while this agent's run is on screen, Pause/Resume and Stop. */
export function RunControls({ agentId, runnable }: { agentId: string; runnable: boolean }) {
  const connected = useTraceStore((s) => s.connection === "open");
  const run = useTraceStore((s) => (s.activeRunId ? s.runs[s.activeRunId] : undefined));
  const provider = useUiStore((s) => s.provider);
  const model = useUiStore((s) => s.model);
  const providers = useProviderStore((s) => s.providers);
  const providersLoaded = useProviderStore((s) => s.loaded);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");

  const mine = run && run.agent_id === agentId ? run : undefined;
  const live = mine && (mine.status === "running" || mine.status === "paused");

  const start = () => {
    // NO KEY, NO RUN — and no dead end: the way to the key opens instead, as the composer's does.
    if (providersLoaded && !isRunnable(providers, provider)) {
      setOpen(false);
      useUiStore.getState().openSecretsForProvider(provider || "anthropic");
      return;
    }
    try {
      localStorage.setItem(inputKey(agentId), input);
    } catch {
      /* the last input is a convenience; the run does not need it kept */
    }
    sendRun(input.trim(), provider || undefined, model || undefined, agentId);
    setOpen(false);
  };

  if (live) {
    return (
      <>
        {mine.status === "paused" ? (
          <ToolButton label="Resume" onClick={() => sendResumeRun(mine.id)}>
            <Icon.graphControl.run size={ICON.sm} />
          </ToolButton>
        ) : (
          <ToolButton label="Pause" onClick={() => sendPauseRun(mine.id)}>
            <Icon.graphControl.pause size={ICON.sm} />
          </ToolButton>
        )}
        <ToolButton label="Stop" onClick={() => sendCancelRun(mine.id)}>
          <Icon.graphControl.stop size={ICON.sm} />
        </ToolButton>
      </>
    );
  }

  const why = !connected ? "Run — not connected" : !runnable ? "Run — this agent cannot run yet" : "Run";
  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        if (v) setInput(readLastInput(agentId));
        setOpen(v);
      }}
    >
      <PopoverTrigger asChild>
        <span className="inline-flex">
          <ToolButton label={why} disabled={!connected || !runnable}>
            <Icon.graphControl.run size={ICON.sm} />
          </ToolButton>
        </span>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="center" className="w-72 rounded-card border border-edge bg-elevated p-2 shadow-floating">
        <form
          className="flex items-end gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            start();
          }}
        >
          <textarea
            autoFocus
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                start();
              }
            }}
            placeholder="What to give the agent"
            aria-label="Input for this run"
            className="min-h-[44px] flex-1 resize-none rounded-input border border-edge bg-panel px-2 py-1.5 text-caption text-ink placeholder:text-faint focus:outline-none focus-visible:shadow-focusring"
          />
          <ToolButton label="Run" onClick={start}>
            <Icon.graphControl.run size={ICON.sm} />
          </ToolButton>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Find a step: a mark that opens into a field. Enter (or ↓) steps to the next match and Shift+Enter
 * (or ↑) to the one before; each is centred and pulsed by `onFocus`. Esc closes it.
 *
 * `openSignal` is bumped by ⌘F on the canvas, so the shortcut and the mark open the same thing.
 */
export function FindControl({
  find, onFocus, openSignal,
}: {
  find: (query: string) => string[];
  onFocus: (id: string) => void;
  openSignal: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const hits = open ? find(query) : [];

  useEffect(() => {
    if (openSignal > 0) setOpen(true);
  }, [openSignal]);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open, openSignal]);

  const go = (i: number) => {
    if (hits.length === 0) return;
    const next = (i + hits.length) % hits.length;
    setAt(next);
    onFocus(hits[next]!);
  };

  if (!open) {
    return (
      <ToolButton label={`Find a step (${keyHint("⌘F")})`} onClick={() => setOpen(true)}>
        <Icon.graphControl.find size={ICON.sm} />
      </ToolButton>
    );
  }
  return (
    <span className="flex items-center gap-0.5">
      <span className="flex items-center gap-1 rounded-control bg-panel px-1.5 py-0.5">
        <Icon.graphControl.find size={ICON.xs} />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setAt(0);
            const first = find(e.target.value)[0];
            if (first) onFocus(first);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
              setQuery("");
            } else if (e.key === "Enter" || e.key === "ArrowDown") {
              e.preventDefault();
              go(e.shiftKey ? at - 1 : at + 1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              go(at - 1);
            }
          }}
          placeholder="Find a step"
          aria-label="Find a step"
          className="w-28 bg-transparent text-caption text-ink placeholder:text-faint focus:outline-none"
        />
        {query.trim() && (
          <span className="text-tiny tabular-nums text-faint" aria-live="polite">
            {hits.length ? `${at + 1}/${hits.length}` : "0/0"}
          </span>
        )}
      </span>
      <ToolButton label="Previous match" onClick={() => go(at - 1)} disabled={hits.length === 0}>
        <Icon.graphControl.findPrev size={ICON.sm} />
      </ToolButton>
      <ToolButton label="Next match" onClick={() => go(at + 1)} disabled={hits.length === 0}>
        <Icon.graphControl.findNext size={ICON.sm} />
      </ToolButton>
      <ToolButton
        label="Close find"
        onClick={() => {
          setOpen(false);
          setQuery("");
        }}
      >
        <Icon.graphControl.close size={ICON.sm} />
      </ToolButton>
    </span>
  );
}

/**
 * Which version of the agent the graph shows, and — once an earlier one is chosen — whether to draw
 * it against the current one. Versions run 1..latest; nothing is offered for an agent with one.
 */
export function VersionControl({
  latest, viewing, comparing, onPick, onCompare,
}: {
  latest: number;
  viewing: number | null;
  comparing: boolean;
  onPick: (version: number | null) => void;
  onCompare: (on: boolean) => void;
}) {
  if (latest < 2) return null;
  const shown = viewing ?? latest;
  return (
    <>
      <DropdownMenu>
        <Tip label="Version" side="bottom">
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label={`Version ${shown} of ${latest}`} className={`${iconBtn} h-7 gap-1 px-1.5`}>
              <Icon.graphControl.versions size={ICON.sm} />
              <span className="text-tiny tabular-nums">v{shown}</span>
            </button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent align="center" aria-label="Versions">
          <DropdownMenuRadioGroup
            value={String(shown)}
            onValueChange={(v) => onPick(Number(v) === latest ? null : Number(v))}
          >
            {Array.from({ length: latest }, (_, i) => latest - i).map((v) => (
              <DropdownMenuRadioItem key={v} value={String(v)}>
                v{v}
                {v === latest && <span className="ml-2 text-tiny text-faint">current</span>}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {viewing !== null && (
        <ToolButton
          label={comparing ? "Stop comparing" : `Compare v${viewing} with v${latest}`}
          pressed={comparing}
          onClick={() => onCompare(!comparing)}
        >
          <Icon.graphControl.compare size={ICON.sm} />
        </ToolButton>
      )}
    </>
  );
}

export type GraphExport = "copy" | "png" | "svg";

/** The graph as a picture: a mark that opens into three — copy it, or save it as a PNG or an SVG. */
export function ExportControl({ onExport }: { onExport: (kind: GraphExport) => void }) {
  const [open, setOpen] = useState(false);
  const pick = (kind: GraphExport) => {
    setOpen(false);
    onExport(kind);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <span className="inline-flex">
          <ToolButton label="Export as an image" pressed={open}>
            <Icon.graphControl.export size={ICON.sm} />
          </ToolButton>
        </span>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="center"
        aria-label="Export as an image"
        className="flex w-auto items-center gap-0.5 rounded-card border border-edge bg-elevated p-1 shadow-floating"
      >
        <ToolButton label="Copy image" onClick={() => pick("copy")}>
          <Icon.graphControl.copyImage size={ICON.sm} />
        </ToolButton>
        <ToolButton label="Save as PNG" onClick={() => pick("png")}>
          <Icon.graphControl.savePng size={ICON.sm} />
        </ToolButton>
        <ToolButton label="Save as SVG" onClick={() => pick("svg")}>
          <Icon.graphControl.saveSvg size={ICON.sm} />
        </ToolButton>
      </PopoverContent>
    </Popover>
  );
}

/** The pill itself, at the top of the canvas. Its groups are passed in, in order. */
export function GraphToolbar({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="toolbar"
      aria-label="Graph"
      className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-card border border-edge bg-elevated/90 px-1 py-1 shadow-floating backdrop-blur"
    >
      {children}
    </div>
  );
}
