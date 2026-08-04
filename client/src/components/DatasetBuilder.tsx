// Dataset builder — the Evals tab's first surface (doc §6.4: "manual entries, CSV import,
// promote test input to dataset").
//
// A dataset is a list of agent inputs. That's the whole primitive: an eval runs the agent
// over each input on every selected provider, and the judge scores what comes back. Ground
// truth (`expected`) is optional — a dataset of inputs with no expected output is still a
// perfectly good comparison, because the judge scores against the rubric, not a diff.
//
// Every mutation goes over the eval channel and comes back as a full snapshot, so nothing
// here keeps optimistic local state; the only local state is which row is being edited.

import { useEffect, useRef, useState } from "react";
import { useBuildStore } from "../store/buildStore.ts";
import { examplesOf, useEvalStore } from "../store/evalStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import {
  sendAddExample,
  sendCreateDataset,
  sendDeleteDataset,
  sendDeleteExample,
  sendListDatasets,
  sendLoadDataset,
  sendRenameDataset,
  sendUpdateExample,
} from "../lib/socket.ts";
import { csvToExamples } from "../lib/csv.ts";
import type { DatasetExample } from "../types.ts";

/** An input/expected pair, editable in place. Commits on blur; Escape reverts. */
function ExampleRow({
  example,
  index,
  datasetId,
}: {
  example: DatasetExample;
  index: number;
  datasetId: string;
}) {
  const [editing, setEditing] = useState<null | "input" | "expected">(null);
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const begin = (field: "input" | "expected") => {
    setDraft(field === "input" ? example.input : (example.expected ?? ""));
    setEditing(field);
  };

  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus();
      ref.current.select();
    }
  }, [editing]);

  const commit = () => {
    if (!editing) return;
    const value = draft.trim();
    const unchanged =
      editing === "input" ? value === example.input : value === (example.expected ?? "");
    // An empty input would be a run with nothing to do — the server rejects it anyway,
    // so don't even send it.
    if (!unchanged && !(editing === "input" && !value)) {
      sendUpdateExample(datasetId, example.id,
        editing === "input" ? { input: value } : { expected: value || null });
    }
    setEditing(null);
  };

  const field = (which: "input" | "expected", text: string, placeholder: string) =>
    editing === which ? (
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); }
        }}
        rows={Math.min(draft.split("\n").length + 1, 6)}
        className="w-full resize-none bg-active text-ink rounded-control px-2 py-1 text-[12px] outline-none focus:ring-1 focus:ring-[#2a2a2e]"
      />
    ) : (
      <button
        type="button"
        onClick={() => begin(which)}
        title="Click to edit"
        className={`w-full text-left text-[12px] rounded-control px-2 py-1 -mx-2 hover:bg-active/50 transition-colors whitespace-pre-wrap break-words ${
          text ? (which === "input" ? "text-ink" : "text-muted") : "text-faint italic"
        }`}
      >
        {text || placeholder}
      </button>
    );

  return (
    <div className="group flex gap-3 py-2">
      <span className="text-faint text-[11px] tabular-nums pt-1 w-6 shrink-0 text-right select-none">
        {index + 1}
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        {field("input", example.input, "(empty)")}
        {field("expected", example.expected ?? "", "+ expected output (optional)")}
      </div>
      <button
        type="button"
        onClick={() => sendDeleteExample(datasetId, example.id)}
        title="Remove this example"
        className="text-faint hover:text-err opacity-0 group-hover:opacity-100 transition-opacity text-[13px] pt-1 shrink-0"
      >
        ×
      </button>
    </div>
  );
}

export function DatasetBuilder() {
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  const connected = useTraceStore((s) => s.connection === "open");

  const datasets = useEvalStore((s) => s.datasets);
  const examplesByDataset = useEvalStore((s) => s.examplesByDataset);
  const selectedDatasetId = useEvalStore((s) => s.selectedDatasetId);
  const selectDataset = useEvalStore((s) => s.selectDataset);
  const error = useEvalStore((s) => s.error);
  const setError = useEvalStore((s) => s.setError);

  const [newInput, setNewInput] = useState("");
  const [importNote, setImportNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const examples = examplesOf(examplesByDataset, selectedDatasetId);
  const selected = datasets.find((d) => d.id === selectedDatasetId);

  // Datasets are per-agent; re-list whenever the agent (or the connection) changes.
  useEffect(() => {
    if (connected && activeAgentId) sendListDatasets(activeAgentId);
  }, [connected, activeAgentId]);

  // Examples load on demand — a dataset list shouldn't drag every example over the wire.
  useEffect(() => {
    if (connected && selectedDatasetId) sendLoadDataset(selectedDatasetId);
  }, [connected, selectedDatasetId]);

  // Agent names are generated from prompts and run long ("a support agent that looks up
  // orders in Postgres and checks…"), so a name derived from one overflows every chip it
  // appears in. Number them instead; the agent is already established by the sidebar.
  const nextDatasetName = () =>
    datasets.length === 0 ? "Test set" : `Test set ${datasets.length + 1}`;

  const addExample = () => {
    const input = newInput.trim();
    if (!input || !selectedDatasetId) return;
    sendAddExample(selectedDatasetId, input);
    setNewInput("");
  };

  const importCsv = async (file: File) => {
    const { examples: rows, warnings } = csvToExamples(await file.text());
    if (!selectedDatasetId) return;
    for (const r of rows) sendAddExample(selectedDatasetId, r.input, r.expected);
    setImportNote(
      rows.length
        ? `imported ${rows.length} example${rows.length === 1 ? "" : "s"}${warnings.length ? ` · ${warnings.join("; ")}` : ""}`
        : `nothing imported${warnings.length ? ` — ${warnings.join("; ")}` : ""}`,
    );
  };

  if (!activeAgentId) {
    return (
      <div className="flex h-full items-center justify-center text-center px-6">
        <div className="text-muted">
          <div className="text-ink mb-1">Evals</div>
          <div className="text-[12px]">Select an agent to build a dataset for it.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* datasets */}
      <div className="px-4 pb-2 shrink-0 flex flex-wrap items-center gap-1.5">
        {datasets.map((d) => (
          <button
            key={d.id}
            onClick={() => selectDataset(d.id)}
            title={d.name}
            // Names come from agent names, which are generated from prompts and can be long.
            // Truncate so one dataset can't push the row into a second line.
            className={`flex items-center gap-1.5 max-w-[220px] rounded-control px-2.5 py-1 text-[12px] transition-colors ${
              d.id === selectedDatasetId ? "bg-active text-ink" : "text-muted hover:text-ink"
            }`}
          >
            <span className="truncate">{d.name}</span>
            <span className="text-faint tabular-nums shrink-0">{d.example_count ?? 0}</span>
          </button>
        ))}
        <button
          onClick={() => sendCreateDataset(activeAgentId, nextDatasetName())}
          disabled={!connected}
          className="rounded-control px-2.5 py-1 text-[12px] text-faint hover:text-ink transition-colors disabled:opacity-40 shrink-0"
        >
          + New dataset
        </button>
      </div>

      {selected && (
        <div className="px-4 pb-2 shrink-0 flex items-center gap-3 text-[11px]">
          <button
            onClick={() => {
              const name = window.prompt("Rename dataset", selected.name);
              if (name && name.trim()) sendRenameDataset(selected.id, name.trim());
            }}
            className="text-faint hover:text-ink transition-colors"
          >
            Rename
          </button>
          <button onClick={() => fileRef.current?.click()} className="text-faint hover:text-ink transition-colors">
            Import CSV
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importCsv(f);
              e.target.value = ""; // let the same file be re-imported
            }}
          />
          <button
            onClick={() => sendDeleteDataset(selected.id, activeAgentId)}
            className="text-faint hover:text-err transition-colors ml-auto"
          >
            Delete dataset
          </button>
        </div>
      )}

      {(error || importNote) && (
        <div className="px-4 pb-2 shrink-0 flex items-center gap-2 text-[11px]">
          <span className={error ? "text-err" : "text-muted"}>{error ?? importNote}</span>
          <button
            onClick={() => { setError(null); setImportNote(null); }}
            className="text-faint hover:text-ink"
          >
            ×
          </button>
        </div>
      )}

      {/* examples */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4">
        {!selected ? (
          <div className="text-[12px] text-muted pt-6">
            No dataset yet. Create one here, or press the bookmark in the composer while in
            Test mode to promote the input you just ran.
          </div>
        ) : examples.length === 0 ? (
          <div className="text-[12px] text-muted pt-6">
            Empty dataset. Add an input below, import a CSV, or promote a test input from the
            composer.
          </div>
        ) : (
          examples.map((e, i) => (
            <ExampleRow key={e.id} example={e} index={i} datasetId={selected.id} />
          ))
        )}
      </div>

      {/* add */}
      {selected && (
        <div className="px-4 py-3 shrink-0 flex items-center gap-2">
          <input
            value={newInput}
            onChange={(e) => setNewInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addExample(); } }}
            disabled={!connected}
            placeholder="Add an input the agent should handle…"
            className="flex-1 bg-panel text-ink placeholder:text-faint rounded-control px-2.5 py-1.5 text-[12px] outline-none focus:ring-1 focus:ring-[#2a2a2e] disabled:opacity-50"
          />
          <button
            onClick={addExample}
            disabled={!connected || !newInput.trim()}
            className="rounded-control px-2.5 py-1.5 text-[12px] bg-active text-ink transition-opacity disabled:opacity-30"
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}
