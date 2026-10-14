import { diffState, summarizeItem, type DiffEntry } from "../lib/stateDiff.ts";
import { jsonPretty } from "../lib/format.ts";
import { CODE } from "../lib/tokens.ts";
import { codeTokenStyle } from "../lib/highlight.ts";
import { useCodeTokens } from "../lib/useCodeTokens.ts";
import { DiffStat } from "./DiffStat.tsx";

/** Whether a line's text is a JSON value — what a state field's before and after usually are. */
function isJson(text: string): boolean {
  if (!/^[[{"\d-]|^(true|false|null)$/.test(text.trim())) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * One `+`/`-` line. The sign and the tint say added or removed — `ok`, `err` — and a JSON value is in
 * the code palette, as code is everywhere else; anything else stays in the sign's colour.
 */
function Line({ sign, text }: { sign: "+" | "-"; text: string }) {
  const add = sign === "+";
  const tokens = useCodeTokens(text, isJson(text) ? "json" : null);
  return (
    <div
      className={`flex gap-2 px-2 py-0.5 rounded-xs text-caption leading-relaxed ${
        add ? "bg-ok/[0.07] text-ok" : "bg-err/[0.07] text-err"
      }`}
    >
      <span className="shrink-0 select-none opacity-70">{sign}</span>
      <span className="break-words min-w-0 whitespace-pre-wrap">
        {tokens
          ? tokens.map((runs, li) => (
              <span key={li}>
                {li > 0 && "\n"}
                {runs.map((t, ti) => <span key={ti} style={codeTokenStyle(t)}>{t.content}</span>)}
              </span>
            ))
          : text}
      </span>
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
        {/* A state key is a property, in the code palette as everywhere else code appears. */}
        <span className="font-mono text-caption" style={{ color: CODE.variable }}>{entry.key}</span>
        <span className="ml-auto">
          {entry.items ? (
            <DiffStat additions={added} deletions={removed} unit="items" />
          ) : (
            <span className="text-faint text-tiny">{entry.summary}</span>
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
        <div className="mt-1 px-2 text-faint text-tiny">
          {entry.carriedOver} earlier {entry.carriedOver === 1 ? "item" : "items"} unchanged
          {/* Plain words for a reducer merge: the step returned only its new items. */}
          {entry.partial && " · this step sent only what it added, and the rest were kept"}
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
        <div className="text-faint text-caption">no state changes</div>
      ) : (
        visible.map((entry) => <Entry key={entry.key} entry={entry} />)
      )}
      {unchangedCount > 0 && (
        <div className="mt-2 text-faint text-tiny">
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
