// Read-only code viewer with shiki highlighting (doc §8).
//
// Two deliberate choices:
//   * shiki is dynamically imported and loads only the four grammars a generated project
//     can contain. The highlighter is a module-level singleton — creating one per mount
//     would re-parse the grammars on every file switch.
//   * While a file is still streaming it renders as plain text and only gets highlighted
//     once complete. Re-tokenizing a whole file on every delta is wasted work, and
//     half-written Python highlights wrong anyway (an unclosed string colours the rest of
//     the file). Streaming stays fast; the highlight lands the moment the file closes.

import { useEffect, useState } from "react";
import { orderedFiles, useBuildStore } from "../store/buildStore.ts";
import { ICON } from "../lib/tokens.ts";
import { Truncate } from "./Truncate.tsx";
import { StatusDot } from "./StatusBadge.tsx";
import { CheckIcon, ChevronDownIcon, LockIcon } from "./panelIcons.tsx";
import { CopyIcon } from "./agentIcons.tsx";
import { iconForPath } from "./fileIcons.tsx";
import { iconBtn } from "./buttons.ts";
import { ProblemsPanel, useDiagnostics, useLiveDiagnostics } from "./ProblemsPanel.tsx";

const LANGS = ["python", "json", "markdown", "toml"] as const;
// The syntax theme, and it is the one thing in this pass that would have SHIPPED BROKEN rather than
// merely looked wrong. Shiki writes its own colours — including a background — into the HTML it
// returns, so a dark theme survives a palette change untouched: every other surface in the client
// would have gone light around a code pane that stayed near-black, and no token, class or variable
// in the system reaches inside that markup to say otherwise.
//
// `vitesse-light` rather than one of the several light themes available, because it is the same
// author's companion to the `vitesse-dark` this replaces — the same hue assignments at the same low
// saturation, which is what "muted, close to the app's palette" meant when the app was dark and
// still means now that it is not.
const THEME = "vitesse-light";

type Highlighter = { codeToHtml: (code: string, opts: { lang: string; theme: string }) => string };

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then((shiki) =>
      shiki.createHighlighter({ themes: [THEME], langs: [...LANGS] }),
    ) as Promise<Highlighter>;
  }
  return highlighterPromise;
}

function langFor(path: string): string {
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md")) return "markdown";
  if (path.endsWith(".toml")) return "toml";
  return "text";
}

// Slim file rail — the switcher that used to be BuildPane's FileTree before the center
// pane became the conversation (fix loop). Same row styling as the old tree.
function FileRail() {
  const files = useBuildStore((s) => s.files);
  const fileOrder = useBuildStore((s) => s.fileOrder);
  const activeFile = useBuildStore((s) => s.activeFile);
  const streamingFile = useBuildStore((s) => s.streamingFile);
  const selectFile = useBuildStore((s) => s.selectFile);
  const list = orderedFiles({ files, fileOrder });

  if (list.length < 2) return null;

  return (
    <div className="w-48 shrink-0 overflow-y-auto border-r border-hair py-1">
      {list.map((f) => {
        const active = f.path === activeFile;
        return (
          <button
            key={f.path}
            onClick={() => selectFile(f.path)}
            title={f.readOnly ? `${f.path} (read-only)` : f.path}
            className={`relative flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-tiny transition-colors duration-fast ${
              active ? "bg-active text-ink" : "text-muted hover:text-ink"
            }`}
          >
            {active && <span className="absolute left-0 top-1 bottom-1 w-0.5 bg-accent" />}
            {f.path === streamingFile && (
              <StatusDot state="pending" pulse size={ICON.xs} title="Still writing" />
            )}
            {/* THE TYPE GLYPH. `iconForPath` exists to do exactly this and is used by `FileList`
                and `GitHubStaging`; this was the one file list in the app that skipped it, so it
                was also the one where every row began with the same nothing. */}
            {(() => {
              const TypeIcon = iconForPath(f.path);
              return (
                <span className="shrink-0 text-faint" aria-hidden><TypeIcon size={ICON.xs} /></span>
              );
            })()}
            <Truncate variant="path" className="flex-1 font-mono">{f.path}</Truncate>
            {/* Was a `⌀` character. A reviewed template is locked, and the app has a lock. */}
            {f.readOnly && (
              <span className="shrink-0 text-faint" title="Read-only — a reviewed template">
                <LockIcon size={ICON.xs} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function CodeViewer() {
  const activeFile = useBuildStore((s) => s.activeFile);
  const file = useBuildStore((s) => (s.activeFile ? s.files[s.activeFile] : undefined));
  const agentId = useBuildStore((s) => s.activeAgentId);
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [wrapped, setWrapped] = useState(false);

  const content = file?.content ?? "";
  const complete = file?.complete ?? false;
  const lang = activeFile ? langFor(activeFile) : "text";

  // §B.3. Asked only for a file that has finished arriving: a streaming file is one a model is
  // halfway through writing, and annotating it would put a squiggle under every incomplete
  // statement in turn as it appears — for a person who is watching a generation rather than
  // editing anything.
  useLiveDiagnostics(agentId, activeFile, content, complete);
  const diagnostics = useDiagnostics(agentId, activeFile);

  useEffect(() => {
    // Only highlight finished files in a supported language.
    if (!complete || lang === "text" || !content) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    getHighlighter()
      .then((h) => {
        if (!cancelled) setHtml(h.codeToHtml(content, { lang, theme: THEME }));
      })
      .catch(() => {
        if (!cancelled) setHtml(null); // fall back to plain text; never blank the pane
      });
    return () => {
      cancelled = true;
    };
  }, [content, complete, lang]);

  if (!file) {
    return (
      // Inline, at the top of the pane. A full-height centred sentence for a condition that
      // clears the moment somebody clicks a row is a screen announcing its own emptiness.
      <div className="px-6 py-3 text-caption text-muted">Select a file to view it.</div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <FileRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 px-6 py-2 shrink-0 border-b border-hair">
          <Truncate className="text-caption text-ink" title={file.path}>{file.path}</Truncate>
          <span className="text-faint text-tiny shrink-0">{lang}</span>
          {/* §B.3.2: a PROTECTED file opens READ-ONLY, never as an editable buffer that merely
              refuses to save. The flag arrives on the file from the server — the block list is
              §3.3's, not a second one computed here, for the reason a block list a browser owns is
              a block list an attacker owns. */}
          {/* THE LOCK, not the word. The file rail ninety lines above says this same fact with
              `LockIcon`; one component was carrying one fact in two vocabularies. */}
          {file.readOnly && (
            <span
              className="shrink-0 text-faint"
              role="img"
              aria-label="Read-only"
              title="Reviewed code Jaroku keeps read-only. The edit loop cannot touch it and neither can this view."
            >
              <LockIcon size={ICON.xs} />
            </span>
          )}
          {!complete && <span className="shrink-0 animate-stream-pulse text-tiny text-run motion-reduce:animate-none">writing…</span>}
          <span className="ml-auto text-faint text-tiny shrink-0 tabular-nums">
            {content.split("\n").length} lines
          </span>
        </div>

        {/* A DISCRETE OBJECT, NOT THE BACKGROUND OF A DRAWER. The code was a full-bleed pane
            sitting flush in the overlay with no border of its own — so the thing you came to read
            had no edges, while every card in the conversation two panes over does.

            The gutter is the other half. A code viewer with no line numbers cannot answer "line
            42", which is what every diagnostic under it is addressed to; the numbers are faint,
            mono and `select-none` so copying the code does not copy them.

            `leading-[1.5]` rather than Tailwind's `leading-relaxed` (1.625): the rhythm this app
            names is 1.5, and code should be visibly TIGHTER than prose, not looser. */}
        <div className="scroll-fade min-h-0 flex-1 overflow-auto p-3">
          <div className="min-h-full overflow-hidden rounded-card border border-hair bg-panel">
            <div className="flex items-center gap-1 border-b border-hair px-2 py-1">
              <span className="text-tiny text-faint">{lang}</span>
              <button
                className={`${iconBtn} ml-auto`}
                title={copied ? "Copied" : "Copy this file"}
                aria-label="Copy this file"
                onClick={() => {
                  void navigator.clipboard?.writeText(content).then(
                    () => { setCopied(true); window.setTimeout(() => setCopied(false), 1400); },
                    () => setCopied(false),
                  );
                }}
              >
                {copied ? <CheckIcon size={ICON.xs} /> : <CopyIcon size={ICON.xs} />}
              </button>
              <button
                className={iconBtn}
                title={wrapped ? "Stop wrapping long lines" : "Wrap long lines"}
                aria-label={wrapped ? "Stop wrapping long lines" : "Wrap long lines"}
                aria-pressed={wrapped}
                onClick={() => setWrapped((v) => !v)}
              >
                <ChevronDownIcon size={ICON.xs} />
              </button>
            </div>
            <div className="flex min-w-0 text-caption leading-[1.5]">
              <div
                className="shrink-0 select-none border-r border-hair px-2 py-3 text-right font-mono text-tiny leading-[1.5] text-faint"
                aria-hidden
              >
                {content.split("\n").map((_, i) => (
                  <div key={i}>{i + 1}</div>
                ))}
              </div>
              <div className={`min-w-0 flex-1 overflow-x-auto px-3 py-3 ${wrapped ? "whitespace-pre-wrap" : ""}`}>
                {html ? (
                  <div className="shiki-host [&_pre]:!bg-transparent" dangerouslySetInnerHTML={{ __html: html }} />
                ) : (
                  <pre className={wrapped ? "whitespace-pre-wrap text-ink" : "whitespace-pre text-ink"}>{content}</pre>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Under the code rather than over it. §B.3's mock puts PROBLEMS at the foot of the pane,
            and that is where a list of things to go and look at belongs — a strip across the top
            would push the line somebody is reading down by its own height every time it changed. */}
        <ProblemsPanel diagnostics={diagnostics} />
      </div>
    </div>
  );
}
