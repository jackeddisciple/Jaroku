// The ⊕ menu's picker — §4.2's "searchable picker built on the existing Cmd+K palette
// infrastructure. Same component, different data source. Do not build five bespoke modals."
//
// ONE PICKER, FIVE SOURCES, AND THE SOURCE IS A PARAMETER. The five differ in what they list and
// in nothing else: the same dialog, the same search field, the same keyboard model, the same
// multi-select rules. Five modals would be five places to get the Escape ordering wrong, and the
// user would have to learn each of them.
//
// SEARCH IS SERVER-SIDE (§8: "powers every picker; paginated, server-filtered"). The alternative —
// fetch everything once and filter in the browser — is fine for an agent with twelve files and
// wrong for one with two thousand, and the difference does not show up until somebody has one.
// So `cmdk`'s own filtering is turned OFF (`shouldFilter={false}`) and the query goes to the
// server: leaving it on would filter the server's already-filtered page again, which quietly
// hides rows that matched a query the server understood better than the browser does.
//
// MULTI-SELECT IS PER KIND, per §4.2's table. Files, dataset cases and tool schemas are yes; runs
// and GitHub refs are no. That is not an arbitrary split — you compare several files or several
// cases, and you ask about ONE run.
//
// EVERY ROW CARRIES ITS TOKEN COST, measured by the server. It is shown because the budget is a
// thing somebody has to steer by rather than discover at send: §4.4 blocks a send that does not
// fit, and a picker that hid the cost would make that block arrive as a surprise.

import { useEffect, useRef, useState } from "react";
import { Command } from "cmdk";
import { apiRequest } from "../../lib/http.ts";
import { Glyph, GLYPH } from "../icons.ts";
import { Icon, type IconComponent } from "../../lib/icons/registry.ts";
import { Truncate } from "../Truncate.tsx";
import { fmtTokens } from "../../lib/format.ts";

export type AttachKind = "file" | "run" | "dataset_case" | "tool_schema" | "github";

/** One candidate, exactly as the server describes it. Nothing here is derived in the browser. */
export interface AttachableRow {
  ref: Record<string, unknown>;
  label: string;
  detail: string | null;
  token_estimate: number;
  /** §4.2: a protected file attaches with a lock and a tooltip. Never a reason to hide it. */
  protected: boolean;
}

/** §4.2's table, as data. The icon is the same one the ⊕ menu's own row uses. */
export const SOURCES: {
  kind: AttachKind;
  label: string;
  hint: string;
  icon: IconComponent;
  multi: boolean;
  placeholder: string;
}[] = [
  { kind: "file", label: "File", hint: "any project file", icon: Icon.attach.file, multi: true, placeholder: "Find a file…" },
  { kind: "run", label: "Run", hint: "a past trace", icon: Icon.attach.run, multi: false, placeholder: "Find a run…" },
  { kind: "dataset_case", label: "Dataset", hint: "an eval case", icon: Icon.attach.dataset, multi: true, placeholder: "Find a case…" },
  { kind: "tool_schema", label: "Tool schema", hint: "connector/MCP tool", icon: Icon.attach.tool, multi: true, placeholder: "Find a tool…" },
  { kind: "github", label: "GitHub", hint: "commit, PR, file", icon: Icon.attach.github, multi: false, placeholder: "Find a commit or PR…" },
];

/** A stable identity for a row, so a selection survives a re-fetch. Key order must not matter. */
export function refKey(ref: Record<string, unknown>): string {
  return Object.keys(ref).sort().map((k) => `${k}=${String(ref[k])}`).join("&");
}

export function AttachPicker({
  kind,
  agentId,
  open,
  onClose,
  onPick,
}: {
  kind: AttachKind;
  agentId: string | null;
  open: boolean;
  onClose: () => void;
  /** One call with everything chosen, so a multi-select is one attachment event rather than five. */
  onPick: (rows: AttachableRow[]) => void;
}) {
  const source = SOURCES.find((s) => s.kind === kind)!;
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<AttachableRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Record<string, AttachableRow>>({});
  // Guards against a slow response for an old query landing after a fast one for a new query and
  // replacing it — the classic search race, and the one that makes a picker feel haunted.
  const seq = useRef(0);

  useEffect(() => {
    if (!open) { setQuery(""); setChosen({}); setRows([]); setError(null); }
  }, [open]);

  useEffect(() => {
    if (!open || !agentId) return;
    const mine = ++seq.current;
    setLoading(true);
    const timer = setTimeout(() => {
      void apiRequest<{ rows: AttachableRow[] }>(
        "GET",
        `/v1/agents/${encodeURIComponent(agentId)}/attachables?kind=${kind}&q=${encodeURIComponent(query)}&limit=50`,
      )
        .then((body) => {
          if (seq.current !== mine) return;
          setRows(body.rows ?? []);
          setError(null);
        })
        .catch((err: Error) => {
          if (seq.current !== mine) return;
          setRows([]);
          // Named rather than left as an empty list. "No results" and "the server did not answer"
          // look identical on screen and mean opposite things.
          setError(err?.message ?? "Couldn't reach the server.");
        })
        .finally(() => { if (seq.current === mine) setLoading(false); });
      // Debounced, because the query goes to the server on every keystroke otherwise. 120ms is the
      // app's `fast` motion duration — long enough to coalesce a word, short enough to feel live.
    }, 120);
    return () => clearTimeout(timer);
  }, [open, agentId, kind, query]);

  if (!open) return null;

  const take = (row: AttachableRow): void => {
    if (!source.multi) { onPick([row]); onClose(); return; }
    const key = refKey(row.ref);
    setChosen((c) => {
      const next = { ...c };
      if (next[key]) delete next[key];
      else next[key] = row;
      return next;
    });
  };

  const picked = Object.values(chosen);

  return (
    <Command.Dialog
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      label={`Attach a ${source.label.toLowerCase()}`}
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]"
      overlayClassName="fixed inset-0 bg-ink/40"
      contentClassName="relative w-[min(560px,92vw)] overflow-hidden rounded-modal border border-edge bg-elevated shadow-overlay"
    >
      {/* `shouldFilter={false}` — the server already filtered. See the header for why filtering the
          filtered page again is worse than it sounds. */}
      <Command loop shouldFilter={false}>
        <Command.Input
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder={source.placeholder}
          className="w-full border-b border-edge bg-bg px-4 py-3 text-label text-ink outline-none placeholder:text-faint focus-visible:shadow-focusring"
        />
        <Command.List className="max-h-[52vh] overflow-auto p-2">
          <Command.Empty className="px-3 py-6 text-center text-caption text-muted">
            {loading ? "Searching…" : error ? error : `Nothing matches “${query}”.`}
          </Command.Empty>

          {rows.map((row) => {
            const key = refKey(row.ref);
            const on = Boolean(chosen[key]);
            return (
              <Command.Item
                key={key}
                value={key}
                onSelect={() => take(row)}
                className="flex cursor-pointer items-center gap-2 rounded-control px-3 py-2 text-caption text-muted data-[selected=true]:bg-active data-[selected=true]:text-ink"
              >
                {/* A fixed slot whether or not it is ticked — a row that grew when you chose it
                    would reflow the list under the pointer. */}
                <span className="inline-flex w-3 shrink-0 justify-center text-accent" aria-hidden>
                  {source.multi ? (on ? "✓" : "") : ""}
                </span>
                <span className="shrink-0 text-faint">
                  <Glyph icon={source.icon} size={GLYPH.meta} />
                </span>
                <span className="min-w-0 flex-1">
                  <Truncate className="block text-ink">{row.label}</Truncate>
                  {row.detail && <Truncate className="block text-tiny text-faint">{row.detail}</Truncate>}
                </span>
                {/* §4.2: a protected file is attachable and says it cannot be edited. The lock is
                    on the row rather than only on the chip, so the fact is known BEFORE choosing. */}
                {row.protected && (
                  <span className="shrink-0 text-tiny text-faint" title="Read-only — attaching it never implies write access">
                    🔒
                  </span>
                )}
                {/* The cost, so the budget is something to steer by rather than discover at send. */}
                <span className="shrink-0 tabular-nums text-tiny text-faint">
                  {fmtTokens(row.token_estimate)}
                </span>
              </Command.Item>
            );
          })}
        </Command.List>

        {source.multi && (
          <div className="flex items-center gap-2 border-t border-edge px-3 py-2 text-tiny text-muted">
            <span className="min-w-0 flex-1">
              {picked.length === 0 ? "Pick one or more" : `${picked.length} selected`}
            </span>
            <button
              type="button"
              disabled={picked.length === 0}
              onClick={() => { onPick(picked); onClose(); }}
              className="rounded-control bg-ink px-2.5 py-1 text-tiny text-bg transition-opacity disabled:cursor-not-allowed disabled:opacity-30"
            >
              Attach
            </button>
          </div>
        )}
      </Command>
    </Command.Dialog>
  );
}
