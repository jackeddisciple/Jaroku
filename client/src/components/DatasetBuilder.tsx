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
  sendLoadRubric,
  sendRenameDataset,
  sendSaveRubric,
  sendUpdateExample,
} from "../lib/socket.ts";
import { csvToExamples } from "../lib/csv.ts";
import { ICON } from "../lib/tokens.ts";
import { Chip } from "./Chip.tsx";
import { Truncate } from "./Truncate.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { ChevronDownIcon, ChevronRightIcon, DatabaseIcon, PencilIcon, PlusIcon, UndoIcon, XIcon } from "./panelIcons.tsx";
import { DownloadIcon } from "./agentIcons.tsx";
import { TrashIcon } from "./inboxIcons.tsx";
import type { DatasetExample, RubricCriterion } from "../types.ts";

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
        className="w-full resize-none bg-active text-ink rounded-control px-2 py-1 text-caption outline-none focus:shadow-focusring"
      />
    ) : (
      <button
        type="button"
        onClick={() => begin(which)}
        title="Click to edit"
        className={`w-full text-left text-caption rounded-control px-2 py-1 -mx-2 hover:bg-active/50 transition-colors whitespace-pre-wrap break-words ${
          text ? (which === "input" ? "text-ink" : "text-muted") : "text-faint italic"
        }`}
      >
        {text || placeholder}
      </button>
    );

  return (
    <div className="group flex gap-3 py-2">
      <span className="text-faint text-tiny tabular-nums pt-1 w-6 shrink-0 text-right select-none">
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
        className="text-faint hover:text-err opacity-0 group-hover:opacity-100 transition-opacity pt-1 shrink-0"
      >
        <XIcon size={ICON.xs} />
      </button>
    </div>
  );
}

/**
 * The rubric the judge scores against — §6.4's "editable rubric", finally editable.
 *
 * WHAT WAS MISSING WAS ONLY THIS. `rubrics` is a table, `loadRubric` and `saveRubric` are commands
 * with capability entries, the store has `rubric` / `rubricIsDefault` / `setRubric`, both senders
 * exist, and `EvalDrillDown` already renders per-criterion score breakdowns. No component read the
 * state and neither sender was ever called — so every eval in the product scored against the
 * built-in rubric, and the server validated two user errors ("a rubric needs at least one
 * criterion", "…with weight above zero") that no user could produce. ADR-012 is titled *with a
 * data-driven rubric*; the data was not user-supplied anywhere.
 *
 * IT LIVES BESIDE THE EXAMPLES, in the dataset builder, because a rubric is dataset-scoped: saving
 * one writes a row against THIS dataset and never touches the shared default. "Correct" for a refund
 * bot is not "correct" for a SQL agent, which is the whole reason the table exists.
 *
 * EDITED AS A DRAFT, saved in one command. Every other mutation in this panel is a full-snapshot
 * round trip per keystroke-ish action, and that is right for an example — one row, one meaning. A
 * rubric is one object whose parts only make sense together: a half-saved rubric is a scoring
 * standard nobody chose, and it would be applied to the next eval.
 */
function RubricEditor({ datasetId }: { datasetId: string }) {
  const rubric = useEvalStore((s) => s.rubric);
  const isDefault = useEvalStore((s) => s.rubricIsDefault);
  const connected = useTraceStore((s) => s.connection === "open");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<RubricCriterion[] | null>(null);

  // Loaded when the block is opened rather than with the dataset: the eval channel already carries
  // a snapshot per mutation, and a rubric nobody has looked at is a query per dataset click.
  useEffect(() => {
    if (open && connected) sendLoadRubric(datasetId);
  }, [open, connected, datasetId]);

  // The draft starts as whatever the server last said — which for a dataset with no rubric of its
  // own is the BUILT-IN one, so editing starts from the real criteria rather than from an empty
  // list somebody has to reinvent.
  const criteria = draft ?? rubric?.criteria ?? [];
  const dirty = draft !== null;
  const total = criteria.reduce((sum, c) => sum + (Number.isFinite(c.weight) ? c.weight : 0), 0);

  const edit = (index: number, patch: Partial<RubricCriterion>): void => {
    setDraft(criteria.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  };

  const save = (): void => {
    // The server refuses an empty rubric and one whose weights are all zero, in those words. Sent
    // anyway rather than pre-empted: its refusal is the authority, and a second copy of the rule
    // here is a second thing to get out of step.
    sendSaveRubric(datasetId, criteria, rubric?.name);
    setDraft(null);
  };

  return (
    <div className="shrink-0 border-b border-hair px-4 pb-2">
      <button
        className="flex w-full items-center gap-2 py-1.5 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-tiny uppercase tracking-wider text-faint">Judge rubric</span>
        <span className="text-tiny text-muted">
          {isDefault ? "built-in" : (rubric?.name ?? "custom")} · {criteria.length} criteria
        </span>
        <span className="ml-auto text-faint">
          {open ? <ChevronDownIcon size={ICON.xs} /> : <ChevronRightIcon size={ICON.xs} />}
        </span>
      </button>

      {open && (
        <div className="space-y-2 pb-1">
          <p className="text-tiny leading-[1.55] text-faint">
            Each criterion is scored 0–4 against shared anchors and combined by weight; weights are
            normalised, so they do not have to add up. Saving writes a rubric for{" "}
            <span className="text-muted">this dataset only</span> and never changes the built-in one.
          </p>
          {criteria.map((c, i) => (
            <div key={`${c.id}-${i}`} className="rounded-control border border-hair px-2 py-1.5">
              <div className="flex items-center gap-2">
                <input
                  value={c.label}
                  onChange={(e) => edit(i, { label: e.target.value })}
                  placeholder="name"
                  className="min-w-0 flex-1 rounded-control bg-active px-2 py-1 text-caption text-ink placeholder:text-faint outline-none focus-visible:shadow-focusring"
                />
                {/* THE ID IS NOT EDITABLE ONCE IT EXISTS. It is what a stored verdict's
                    per-criterion score is keyed by, so renaming it would orphan every score
                    already recorded against this dataset — the drill-down would show a column of
                    blanks beside a criterion that looks identical. The label is the display name
                    and is free to change. */}
                <span className="shrink-0 text-tiny text-faint" title="the key stored verdicts are recorded against">
                  {c.id}
                </span>
                <input
                  value={String(c.weight)}
                  onChange={(e) => edit(i, { weight: Number(e.target.value) })}
                  inputMode="decimal"
                  title="Relative weight"
                  className="w-14 shrink-0 rounded-control bg-active px-1.5 py-1 text-tiny text-ink outline-none focus-visible:shadow-focusring"
                />
                <button
                  onClick={() => setDraft(criteria.filter((_, j) => j !== i))}
                  title="Remove this criterion"
                  className="shrink-0 text-faint transition-colors hover:text-err"
                >
                  <XIcon size={ICON.xs} />
                </button>
              </div>
              <textarea
                value={c.description}
                onChange={(e) => edit(i, { description: e.target.value })}
                rows={2}
                placeholder="what the judge should look for, phrased so a higher score is better"
                className="mt-1 w-full resize-none rounded-control bg-active px-2 py-1 text-tiny leading-[1.5] text-muted placeholder:text-faint outline-none focus-visible:shadow-focusring"
              />
            </div>
          ))}

          <div className="flex flex-wrap items-center gap-2">
            <button
              className="rounded-control px-2 py-1 text-tiny text-muted transition-colors hover:text-ink"
              onClick={() =>
                setDraft([
                  ...criteria,
                  // A NEW ID FROM THE COUNT, not from the label. It has to be stable and it has to
                  // be a key, and deriving it from prose would change every time somebody edited
                  // the name — which is exactly what must not happen to the field verdicts are
                  // recorded against.
                  { id: `criterion_${criteria.length + 1}`, label: "", description: "", weight: 0.1 },
                ])
              }
            >
              + Criterion
            </button>
            <span className="text-tiny text-faint">weights total {total.toFixed(2)}</span>
            <button
              onClick={save}
              disabled={!connected || !dirty || criteria.length === 0}
              className="ml-auto rounded-control bg-active px-2.5 py-1 text-tiny text-ink transition-opacity disabled:opacity-30"
            >
              {dirty ? "Save rubric" : "Saved"}
            </button>
            {dirty && (
              <button
                onClick={() => setDraft(null)}
                title="Revert to the saved rubric"
                aria-label="Revert to the saved rubric"
                className="rounded-control p-1 text-faint transition-colors hover:bg-active active:bg-chrome hover:text-ink"
              >
                <UndoIcon size={ICON.xs} />
              </button>
            )}
          </div>
        </div>
      )}
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
      <EmptyState
        icon={DatabaseIcon}
        title="No agent selected"
        hint="Pick one in the sidebar to build it a dataset."
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* datasets */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-hair px-4 pb-2 pt-2">
        {datasets.map((d) => (
          <Chip
            key={d.id}
            size="lg"
            onClick={() => selectDataset(d.id)}
            selected={d.id === selectedDatasetId}
            title={d.name}
            // Names come from agent names, which are generated from prompts and can be long.
            // Truncate so one dataset can't push the row into a second line.
            className="max-w-[220px]"
            figure={d.example_count ?? 0}
          >
            <Truncate>{d.name}</Truncate>
          </Chip>
        ))}
        <button
          onClick={() => sendCreateDataset(activeAgentId, nextDatasetName())}
          disabled={!connected}
          className="rounded-control px-2.5 py-1 text-caption text-faint hover:text-ink transition-colors disabled:opacity-40 shrink-0"
        >
          + New dataset
        </button>
      </div>

      {selected && (
        /* THE DENSEST TEXT-BUTTON CLUSTER IN THE APP, as a glyph row. Five words-as-buttons in
            one strip — Rename, Import CSV, Delete dataset, plus Revert and Add nearby — read as a
            form toolbar rather than as the actions on a dataset. Every mark here already existed
            in the icon set; the words are the tooltips. */
        <div className="flex shrink-0 items-center gap-1 px-4 pb-2">
          <button
            onClick={() => {
              const name = window.prompt("Rename dataset", selected.name);
              if (name && name.trim()) sendRenameDataset(selected.id, name.trim());
            }}
            title="Rename this dataset"
            aria-label="Rename this dataset"
            className="rounded-control p-1 text-faint transition-colors hover:bg-active active:bg-chrome hover:text-ink"
          >
            <PencilIcon size={ICON.xs} />
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            title="Import examples from a CSV"
            aria-label="Import examples from a CSV"
            className="rounded-control p-1 text-faint transition-colors hover:bg-active active:bg-chrome hover:text-ink"
          >
            <DownloadIcon size={ICON.xs} className="rotate-180" />
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
            title="Delete this dataset"
            aria-label="Delete this dataset"
            className="ml-auto rounded-control p-1 text-faint transition-colors hover:bg-active active:bg-chrome hover:text-err"
          >
            <TrashIcon size={ICON.xs} />
          </button>
        </div>
      )}

      {/* The judge's rubric for THIS dataset. Under the dataset actions and above the examples,
          because it is the standard those examples will be scored against. */}
      {selected && <RubricEditor datasetId={selected.id} />}

      {(error || importNote) && (
        <div className="px-4 pb-2 shrink-0 flex items-center gap-2 text-tiny">
          <span className={error ? "text-err" : "text-muted"}>{error ?? importNote}</span>
          <button
            onClick={() => { setError(null); setImportNote(null); }}
            title="Dismiss"
            aria-label="Dismiss"
            className="shrink-0 text-faint transition-colors duration-fast hover:text-ink"
          >
            <XIcon size={ICON.xs} />
          </button>
        </div>
      )}

      {/* examples */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4">
        {!selected ? (
          <EmptyState
            icon={DatabaseIcon}
            title="No dataset yet"
            hint="Create one above, or press the bookmark in the composer while in Test mode to promote the input you just ran."
          />
        ) : examples.length === 0 ? (
          <EmptyState
            icon={DatabaseIcon}
            title="Empty dataset"
            hint="Add an input below, import a CSV, or promote a test input from the composer."
          />
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
            placeholder="an input the agent should handle"
            className="flex-1 bg-panel text-ink placeholder:text-faint rounded-control px-2.5 py-1.5 text-caption outline-none focus:shadow-focusring disabled:opacity-50"
          />
          <button
            onClick={addExample}
            disabled={!connected || !newInput.trim()}
            title="Add this example"
            aria-label="Add this example"
            className="rounded-control bg-active p-1.5 text-ink transition-opacity disabled:opacity-30"
          >
            <PlusIcon size={ICON.sm} />
          </button>
        </div>
      )}
    </div>
  );
}
