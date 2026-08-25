// §B.3's PROBLEMS list, and the hook that keeps it current.
//
// WHAT THIS SURFACE IS ALLOWED TO DO, stated where the code is rather than only in the spec: it
// draws. It never blocks typing, never blocks saving, never blocks staging a file mid-edit — the
// file might be half-written, and a linter that fought a person mid-sentence is a linter they turn
// off. What blocks is exactly what blocked before any of this existed: Commit & Push, and the ✦
// generate path for a hand-staged subset, both of which route through the real validator on the
// real file set. This changes WHEN somebody learns about a problem. It does not change what stops a
// bad file from being committed.
//
// A PROTECTED FILE IS READ-ONLY HERE, never an editable buffer that refuses to save. §3.3 already
// decided nobody may edit `tools/mcp_bridge.py`; a new way to SEE the codebase must not become a
// new way to reach a file the rest of the product has already closed. That decision arrives from
// the server on the file itself — the block list is not computed in the browser, for the reason
// §3.3 gives at length: a block list an attacker can edit is not one.

import { useEffect, useRef } from "react";

import { sendDiagnoseFile } from "../lib/socket.ts";
import { diagnosticsFor, useDiagnosticsStore } from "../store/diagnosticsStore.ts";
import type { Diagnostic } from "../types.ts";
import { Truncate } from "./Truncate.tsx";
import { ICON } from "../lib/tokens.ts";
import { AlertTriangleIcon } from "./panelIcons.tsx";

/**
 * §B.3.1's number, restated on this side of the wire.
 *
 * 400ms: long enough that typing a line is one request rather than forty, short enough that the
 * answer lands while somebody is still looking at the line they wrote. The server names the same
 * number for the same reason; neither is derived from the other, because they are debouncing
 * different things — this one debounces the SEND, and the server's is documentation of when the
 * checks are meant to run.
 */
const DEBOUNCE_MS = 400;

/**
 * Ask for diagnostics whenever a buffer settles.
 *
 * NOTHING IS ASKED FOR A FILE NOBODY HAS OPENED, and nothing is asked while text is still arriving:
 * a streaming file is a file the model is halfway through writing, and annotating it would put
 * squiggles under every incomplete statement in turn as it appears. The gate would say the same
 * things at the end, and the person watching a generation is not editing anything.
 *
 * THE TIMER IS CLEARED ON EVERY CHANGE, which is what makes this a debounce rather than a throttle:
 * a burst of keystrokes produces one request, at the end, about the text that survived.
 */
export function useLiveDiagnostics(
  agentId: string | null,
  path: string | null,
  source: string,
  ready: boolean,
): void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!agentId || !path || !ready) return;
    // Only Python has rules to check. Sending a `.md` would cost a round trip to be told nothing,
    // and the server would agree — but agreeing costs the request.
    if (!path.endsWith(".py")) return;
    timer.current = setTimeout(() => sendDiagnoseFile(agentId, path, source), DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [agentId, path, source, ready]);
}

/** The diagnostics for one buffer, for a caller that renders them in a gutter. */
export function useDiagnostics(agentId: string | null, path: string | null): Diagnostic[] {
  const byFile = useDiagnosticsStore((s) => s.byFile);
  return diagnosticsFor(byFile, agentId, path);
}

/**
 * The list under the editor.
 *
 * RENDERS NOTHING WHEN THERE IS NOTHING, rather than an empty frame saying "0 problems". A clean
 * file's most useful property is that it is quiet, and a permanent strip announcing its own
 * emptiness is the thing people learn to stop reading — after which the strip announcing a real
 * problem is in the same place, in the same shape, and is not read either.
 */
export function ProblemsPanel({
  diagnostics, onSelect,
}: {
  diagnostics: Diagnostic[];
  onSelect?: (line: number) => void;
}) {
  if (diagnostics.length === 0) return null;

  return (
    <div className="shrink-0 border-t border-hair">
      <div className="flex items-center gap-2 px-6 py-1.5">
        <span className="text-tiny uppercase tracking-wider text-faint">Problems</span>
        <span className="text-tiny text-faint tabular-nums">{diagnostics.length}</span>
        {/* Said once, at the top, rather than on every row. A person who has read it knows; a row
            that repeated it would be nine-tenths disclaimer. */}
        <span className="ml-auto text-tiny text-faint">
          advisory — Commit &amp; Push runs the full validator
        </span>
      </div>
      <div className="max-h-32 overflow-auto px-6 pb-2">
        {diagnostics.map((d, i) => (
          <button
            key={`${d.line}:${d.column ?? 0}:${i}`}
            className="flex w-full items-baseline gap-2 py-0.5 text-left text-tiny transition-colors duration-fast hover:text-ink"
            onClick={() => onSelect?.(d.line)}
          >
            {/* MUTED, NOT A STATUS COLOUR. The palette reserves ok/err/run for meaning — green is
                "this passed", red is "this failed", amber is "this is running" — and an advisory
                diagnostic is none of those: nothing has failed, nothing is blocked, and the same
                file may commit cleanly. Borrowing a status colour would say something the surface
                is explicitly not allowed to say. */}
            <span className="shrink-0 text-muted" aria-hidden><AlertTriangleIcon size={ICON.xs} /></span>
            <span className="shrink-0 text-faint tabular-nums">
              {d.line}
              {d.column === undefined ? "" : `:${d.column}`}
            </span>
            <Truncate className="min-w-0 flex-1 text-muted" title={d.message}>
              {d.message}
            </Truncate>
            {/* The rule number, exactly as §B.3's mock renders it, so a reader can go and find the
                rule rather than only the symptom. Absent for the contract checks, which are not
                numbered — calling them rule 12 would invent a number the prompt does not use. */}
            {d.rule !== null && (
              <span className="shrink-0 text-faint">rule {d.rule}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The gutter marks beside the code.
 *
 * ONE ROW PER LINE THAT HAS A DIAGNOSTIC, absolutely positioned against a monospace line height, so
 * the highlighted code underneath is untouched. Drawing into the highlighted HTML would mean
 * re-tokenising a file to move a squiggle, which is the work `CodeViewer`'s own header explains it
 * avoids by highlighting only completed files.
 */
export function DiagnosticGutter({
  diagnostics, lineHeightPx,
}: {
  diagnostics: Diagnostic[];
  lineHeightPx: number;
}) {
  if (diagnostics.length === 0) return null;
  // One mark per line, even where two rules fired on it: the mark says "look here", and two marks
  // in the same place say it twice.
  const lines = [...new Set(diagnostics.map((d) => d.line))];
  return (
    <div className="pointer-events-none absolute inset-y-0 left-0 w-4" aria-hidden>
      {lines.map((line) => (
        <span
          key={line}
          className="absolute left-0 text-muted"
          style={{ top: (line - 1) * lineHeightPx }}
          aria-hidden
        >
          <AlertTriangleIcon size={ICON.badge} />
        </span>
      ))}
    </div>
  );
}
