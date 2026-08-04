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
import { LockIcon } from "./panelIcons.tsx";

const LANGS = ["python", "json", "markdown", "toml"] as const;
const THEME = "vitesse-dark"; // muted, close to the app's near-black palette

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
            className={`relative flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] transition-colors duration-fast ${
              active ? "bg-active text-ink" : "text-muted hover:text-ink"
            }`}
          >
            {active && <span className="absolute left-0 top-1 bottom-1 w-0.5 bg-ink" />}
            {f.path === streamingFile && (
              <StatusDot state="pending" pulse size={ICON.xs} title="Still writing" />
            )}
            <Truncate className="flex-1">{f.path}</Truncate>
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
  const [html, setHtml] = useState<string | null>(null);

  const content = file?.content ?? "";
  const complete = file?.complete ?? false;
  const lang = activeFile ? langFor(activeFile) : "text";

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
      <div className="flex h-full items-center justify-center px-6 text-[12px] text-muted">
        Select a file to view it.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <FileRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 px-6 py-2 shrink-0 border-b border-hair">
          <Truncate className="text-[12px] text-ink" title={file.path}>{file.path}</Truncate>
          <span className="text-faint text-[11px] shrink-0">{lang}</span>
          {file.readOnly && <span className="text-faint text-[11px] shrink-0">read-only</span>}
          {!complete && <span className="text-run text-[11px] animate-pulse shrink-0">writing…</span>}
          <span className="ml-auto text-faint text-[11px] shrink-0 tabular-nums">
            {content.split("\n").length} lines
          </span>
        </div>

        <div className="flex-1 overflow-auto px-6 py-4 text-[12px] leading-relaxed">
          {html ? (
            <div className="shiki-host [&_pre]:!bg-transparent" dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <pre className="whitespace-pre text-ink">{content}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
