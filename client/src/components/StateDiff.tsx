import { diffState, summarizeItem, type DiffEntry } from "../lib/stateDiff.ts";
import { jsonPretty } from "../lib/format.ts";
import { DiffStat } from "./DiffStat.tsx";

/** One `+`/`-` line. Status colors only — `ok` for additions, `err` for removals. */
function Line({ sign, text }: { sign: "+" | "-"; text: string }) {
  const add = sign === "+";
  return (
    <div
      className={`flex gap-2 px-2 py-0.5 rounded-chip text-[12px] leading-relaxed ${
        add ? "bg-ok/[0.07] text-ok" : "bg-err/[0.07] text-err"
      }`}
    >
      <span className="shrink-0 select-none opacity-70">{sign}</span>
      <span className="break-words min-w-0 whitespace-pre-wrap">{text}</span>
    </div>
  );
}

function Entry({ entry }: { entry: DiffEntry }) {
  if (entry.kind === "unchanged") return null;

  // A list-valued field changed by some number of items, and that is a measurement — the same
  // measurement a diff card reports, so it gets the same green/red figures rather than the
  // sentence ("+3 items") it used to render in the same grey as everything else in the row.
  // A scalar field has no count to give: "changed" is the honest summary and stays a word.
  const added = entry.items?.reduce((n, i) => n + (i.kind === "added" ? 1 : 0), 0) ?? 0;
  const removed = entry.items?.reduce((n, i) => n + (i.kind === "removed" ? 1 : 0), 0) ?? 0;

  return (
    <div className="mt-2 first:mt-0">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-muted text-[12px]">{entry.key}</span>
        <span className="ml-auto">
          {entry.items ? (
            <DiffStat additions={added} deletions={removed} unit="items" />
          ) : (
            <span className="text-faint text-[11px]">{entry.summary}</span>
          )}
        </span>
      </div>

      <div className="mt-1 space-y-px">
        {entry.items
          ? entry.items.map((item, i) => (
              <Line
                key={i}
                sign={item.kind === "added" ? "+" : "-"}
                text={summarizeItem(item.value)}
              />
            ))
          : (
            <>
              {entry.before !== undefined && <Line sign="-" text={jsonPretty(entry.before)} />}
              {entry.after !== undefined && <Line sign="+" text={jsonPretty(entry.after)} />}
            </>
          )}
      </div>

      {entry.carriedOver ? (
        <div className="mt-1 px-2 text-faint text-[11px]">
          {entry.carriedOver} earlier {entry.carriedOver === 1 ? "item" : "items"} unchanged
          {entry.partial && " · partial update, reducer-merged"}
        </div>
      ) : null}
    </div>
  );
}

/** Git-diff style view of what a step changed. Returns null if the shapes aren't diffable. */
export function StateDiff({ before, after }: { before: unknown; after: unknown }) {
  const diff = diffState(before, after);
  if (!diff) return null;

  const visible = diff.entries.filter((e) => e.kind !== "unchanged");
  const unchangedCount = diff.entries.length - visible.length + diff.untouchedKeys.length;

  return (
    <div>
      {visible.length === 0 ? (
        <div className="text-faint text-[12px]">no state changes</div>
      ) : (
        visible.map((entry) => <Entry key={entry.key} entry={entry} />)
      )}
      {unchangedCount > 0 && (
        <div className="mt-2 text-faint text-[11px]">
          {unchangedCount} {unchangedCount === 1 ? "key" : "keys"} unchanged
        </div>
      )}
    </div>
  );
}

/** True when a diff view can be rendered for this pair. */
export function canDiff(before: unknown, after: unknown): boolean {
  return diffState(before, after) !== null;
}
