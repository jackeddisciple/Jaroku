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
import { relTime } from "../lib/format.ts";
import type { GraphVersionInfo } from "../types.ts";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "./ui/dropdown-menu.tsx";
import { Tip } from "./ui/tooltip.tsx";

/**
 * One control: a mark, its name as both tooltip and accessible name. `hide` quiets the tooltip while
 * the control's own popover is open, where it would sit over what the popover holds.
 */
export function ToolButton({
  label, onClick, onBlur, disabled, children, pressed, hide, danger,
}: {
  label: string;
  hide?: boolean;
  onClick?: () => void;
  onBlur?: () => void;
  disabled?: boolean;
  pressed?: boolean;
  /** Armed for something that cannot be undone: the second press does it. */
  danger?: boolean;
  children: ReactElement;
}) {
  return (
    <Tip label={label} side="bottom" hide={hide}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
        onBlur={onBlur}
        className={`${iconBtn} h-7 w-7 ${pressed ? "bg-active text-ink" : ""} ${danger ? "bg-err/10 text-err hover:text-err" : ""}`}
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

/**
 * An input typed into the Run field and not run yet, per workspace and agent (`inputKey`). In memory:
 * the field is gone the moment the popover closes or the panel shows another tab, and what was typed
 * has to outlive both.
 */
const runDrafts = new Map<string, string>();

/** Run ▶, and while this agent's run is on screen, Pause/Resume and Stop. */
export function RunControls({
  agentId, runnable, olderVersion = null, onBeforeRun,
}: {
  agentId: string;
  runnable: boolean;
  /** The earlier version on screen, if one is: a run is always of the current version. */
  olderVersion?: number | null;
  /** Called as a run is sent — the graph goes back to the version the run will move through. */
  onBeforeRun?: () => void;
}) {
  const connected = useTraceStore((s) => s.connection === "open");
  const run = useTraceStore((s) => (s.activeRunId ? s.runs[s.activeRunId] : undefined));
  const provider = useUiStore((s) => s.provider);
  const model = useUiStore((s) => s.model);
  const providers = useProviderStore((s) => s.providers);
  const providersLoaded = useProviderStore((s) => s.loaded);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  // AN EMPTY INPUT IS ASKED ABOUT, NOT RUN. ⌘↵ on a cleared field started a real, paid run with ""
  // — some agents want nothing, most were simply not given anything yet — so the first press says
  // so and the second runs it.
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  const mine = run && run.agent_id === agentId ? run : undefined;
  const live = mine && (mine.status === "running" || mine.status === "paused");

  const start = () => {
    if (!input.trim() && !confirmEmpty) {
      setConfirmEmpty(true);
      return;
    }
    // NO KEY, NO RUN — and no dead end: the way to the key opens instead, as the composer's does.
    if (providersLoaded && !isRunnable(providers, provider)) {
      // KEPT ACROSS THE DETOUR. Secrets takes the panel and this field with it, and the input was
      // written nowhere — so coming back to run it found the field empty.
      runDrafts.set(inputKey(agentId), input);
      setOpen(false);
      useUiStore.getState().openSecretsForProvider(provider || "anthropic");
      return;
    }
    try {
      localStorage.setItem(inputKey(agentId), input);
    } catch {
      /* the last input is a convenience; the run does not need it kept */
    }
    runDrafts.delete(inputKey(agentId));
    onBeforeRun?.();
    sendRun(input.trim(), provider || undefined, model || undefined, agentId);
    setOpen(false);
  };

  // STOP KEEPS ITS PLACE whether or not there is anything to stop, so a run starting or ending never
  // moves the controls after it — the one you were reaching for stays under the pointer.
  //
  // AND IT ASKS, as the Trace header's does and for its reason: it sits next to Pause, and a stopped
  // run cannot be resumed, so a mis-click would read as a pause that silently killed the run. The
  // first press arms it; the second, while it is still armed, stops the run.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!live) setArmed(false);
  }, [live]);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(t);
  }, [armed]);
  const stop = (
    <ToolButton
      label={!live ? "Stop — no run in progress" : armed ? "Stop this run? Press again — it cannot be resumed" : "Stop"}
      disabled={!live}
      danger={armed}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!live) return;
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        sendCancelRun(mine.id);
      }}
    >
      <Icon.graphControl.stop size={ICON.sm} />
    </ToolButton>
  );

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
        {stop}
      </>
    );
  }

  const why = !connected
    ? "Run — not connected"
    : !runnable
      ? "Run — this agent cannot run yet"
      : olderVersion !== null ? `Run — runs the current version, not v${olderVersion}` : "Run";
  return (
    <>
    <Popover
      open={open}
      onOpenChange={(v) => {
        if (v) setInput(runDrafts.get(inputKey(agentId)) ?? readLastInput(agentId));
        setConfirmEmpty(false);
        setOpen(v);
      }}
    >
      <PopoverTrigger asChild>
        <span className="inline-flex">
          <ToolButton label={why} disabled={!connected || !runnable} hide={open}>
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
            onChange={(e) => {
              setInput(e.target.value);
              setConfirmEmpty(false);
              // AN EDIT IS KEPT WHEN THE POPOVER CLOSES (Esc, a click away) — opening it again used
              // to put back the last run's input over what had been typed since. Typed back to that
              // input exactly, there is nothing to keep.
              if (e.target.value === readLastInput(agentId)) runDrafts.delete(inputKey(agentId));
              else runDrafts.set(inputKey(agentId), e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                start();
              }
            }}
            placeholder="What to give the agent"
            aria-label="Input for this run"
            // VERBATIM. macOS turned `---` into an em dash and straight quotes into curly ones as they
            // were typed — a separator the agent looks for, and any JSON, gone without a trace.
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            className="min-h-[44px] flex-1 resize-none rounded-input border border-edge bg-panel px-2 py-1.5 text-caption text-ink placeholder:text-faint focus:outline-none focus-visible:shadow-focusring"
          />
          <ToolButton label={confirmEmpty ? "Run with no input" : "Run"} onClick={start}>
            <Icon.graphControl.run size={ICON.sm} />
          </ToolButton>
        </form>
        {confirmEmpty && (
          <p role="status" className="mt-1.5 px-0.5 text-tiny text-muted">
            No input. Press Run again to run it with nothing.
          </p>
        )}
      </PopoverContent>
    </Popover>
    {stop}
    </>
  );
}

/**
 * Find a step: a mark that opens a field in a row of its own under the toolbar. Enter (or ↓) steps
 * to the next match and Shift+Enter (or ↑) to the one before; each is centred and pulsed by
 * `onFocus`. Esc closes it.
 *
 * A ROW OF ITS OWN, NOT A WIDER TOOLBAR. The field used to open inside the bar, which made the bar
 * nearly as wide as the panel: on a narrow panel Run was cut off on the left and Zoom out, Fit and
 * Reset layout on the right, out of reach, and on any panel every other control moved as it opened.
 *
 * `openSignal` is bumped by ⌘F on the canvas, so the shortcut and the mark open the same thing.
 */
export function FindControl({
  find, onFocus, openSignal, onOpenChange,
}: {
  find: (query: string) => string[];
  onFocus: (id: string) => void;
  openSignal: number;
  /** Told when the row opens or closes — what sits under the toolbar has to make room for it. */
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpenState] = useState(false);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const hits = open ? find(query) : [];
  const setOpen = (v: boolean) => {
    setOpenState(v);
    onOpenChange?.(v);
  };
  // Closed when this goes away (an agent switch remounts it), so nothing waits on a row that is gone.
  useEffect(() => () => onOpenChange?.(false), []);

  // A ⌘F SINCE THIS MOUNTED, not a ⌘F ever. The signal lives in GraphView and stays above zero, and
  // this control remounts whenever the canvas gives way to a loading state — an agent switch does
  // that — so reading the value reopened Find after every switch, caret in the field, taking the
  // keystrokes meant for somewhere else.
  const seenSignal = useRef(openSignal);
  useEffect(() => {
    if (openSignal === seenSignal.current) return;
    seenSignal.current = openSignal;
    setOpen(true);
    inputRef.current?.focus();
  }, [openSignal]);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const go = (i: number) => {
    if (hits.length === 0) return;
    const next = (i + hits.length) % hits.length;
    setAt(next);
    onFocus(hits[next]!);
  };
  const close = () => {
    setOpen(false);
    setQuery("");
  };

  return (
    <>
      <ToolButton label={`Find a step (${keyHint("⌘F")})`} pressed={open} onClick={() => (open ? close() : setOpen(true))}>
        <Icon.graphControl.find size={ICON.sm} />
      </ToolButton>
      {open && (
        <div
          role="search"
          aria-label="Find a step"
          className="graph-glass absolute left-0 top-full mt-1.5 flex items-center gap-0.5 rounded-card px-1 py-1 shadow-floating backdrop-blur-md backdrop-saturate-150"
        >
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
                  close();
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
              // Step names are snake_case identifiers: no correction bubble, no capital first letter.
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              className="w-28 bg-transparent text-caption text-ink placeholder:text-faint focus:outline-none"
            />
            {/* Its width held, so the buttons after it do not move as the count grows. */}
            <span className="min-w-[4ch] text-right text-tiny tabular-nums text-faint" aria-live="polite">
              {query.trim() ? (hits.length ? `${at + 1}/${hits.length}` : "0/0") : ""}
            </span>
          </span>
          <ToolButton label="Previous match" onClick={() => go(at - 1)} disabled={hits.length === 0}>
            <Icon.graphControl.findPrev size={ICON.sm} />
          </ToolButton>
          <ToolButton label="Next match" onClick={() => go(at + 1)} disabled={hits.length === 0}>
            <Icon.graphControl.findNext size={ICON.sm} />
          </ToolButton>
          <ToolButton label="Close find" onClick={close}>
            <Icon.graphControl.close size={ICON.sm} />
          </ToolButton>
        </div>
      )}
    </>
  );
}

/**
 * Which version of the agent the graph shows, and — once an earlier one is chosen — whether to draw
 * it against the current one. Versions run 1..latest; nothing is offered for an agent with one.
 */
export function VersionControl({
  latest, viewing, comparing, versions = [], publisherOf, onPick, onCompare,
}: {
  latest: number;
  viewing: number | null;
  comparing: boolean;
  /** What each version is, when the server said. */
  versions?: GraphVersionInfo[];
  /** A member's name for a version's publisher, in a team workspace; null otherwise. */
  publisherOf?: (userId: string | null) => string | null;
  onPick: (version: number | null) => void;
  onCompare: (on: boolean) => void;
}) {
  if (latest < 2) return null;
  const shown = viewing ?? latest;
  const info = new Map(versions.map((v) => [v.version, v]));
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
        <DropdownMenuContent align="center" aria-label="Versions" className="max-w-[18rem]">
          <DropdownMenuRadioGroup
            value={String(shown)}
            onValueChange={(v) => onPick(Number(v) === latest ? null : Number(v))}
          >
            {Array.from({ length: latest }, (_, i) => latest - i).map((v) => {
              // WHEN, AND WHAT IT CHANGED. Bare numbers made choosing one to look at or compare
              // guesswork; the history already knows each version's date and summary.
              const row = info.get(v);
              const by = row ? publisherOf?.(row.created_by) ?? null : null;
              const what = row ? row.summary ?? SOURCE_WORD[row.source] ?? row.source : null;
              return (
                <DropdownMenuRadioItem key={v} value={String(v)}>
                  <span className="flex min-w-0 flex-col">
                    <span>
                      v{v}
                      {v === latest && <span className="ml-2 text-tiny text-faint">current</span>}
                      {row?.undone && <span className="ml-2 text-tiny text-faint">undone</span>}
                    </span>
                    {row && (
                      <span className="truncate text-tiny text-faint" title={what ?? undefined}>
                        {relTime(row.created_at)}
                        {by ? ` · ${by}` : ""}
                        {what ? ` · ${what}` : ""}
                      </span>
                    )}
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Always in its place once there are versions, so picking one does not move what follows. */}
      <ToolButton
        label={
          viewing === null
            ? "Compare — pick an earlier version first"
            : comparing ? "Stop comparing" : `Compare v${viewing} with v${latest}`
        }
        pressed={comparing}
        disabled={viewing === null}
        onClick={() => viewing !== null && onCompare(!comparing)}
      >
        <Icon.graphControl.compare size={ICON.sm} />
      </ToolButton>
    </>
  );
}

/** What made a version, in a word, for a version with no summary of its own. */
const SOURCE_WORD: Record<string, string> = {
  generation: "generated",
  edit: "edited",
  import: "imported",
  deploy: "deploy files added",
};

export type GraphExport = "copy" | "png" | "svg";

/** The graph as a picture: a mark that opens into three — copy it, or save it as a PNG or an SVG. */
export function ExportControl({ onExport, disabled }: { onExport: (kind: GraphExport) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const pick = (kind: GraphExport) => {
    setOpen(false);
    onExport(kind);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <span className="inline-flex">
          <ToolButton label="Export as an image" pressed={open} hide={open} disabled={disabled}>
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
export function GraphToolbar({ children, barRef }: { children: React.ReactNode; barRef?: React.Ref<HTMLDivElement> }) {
  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label="Graph"
      // NEVER WIDER THAN THE CANVAS: past that its own controls are cut off and cannot be reached, so
      // on a panel too narrow for one row it takes two.
      className="graph-glass absolute left-1/2 top-3 z-10 flex w-max max-w-[calc(100%-1.5rem)] -translate-x-1/2 flex-wrap items-center gap-0.5 rounded-card px-1 py-1 shadow-floating backdrop-blur-md backdrop-saturate-150"
    >
      {children}
    </div>
  );
}
