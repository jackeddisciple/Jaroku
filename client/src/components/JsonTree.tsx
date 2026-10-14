// A step's payload, readable at any size: JSON as a tree that folds, text as text, and a model's
// messages as the conversation they are.
//
// IT WAS `JSON.stringify(value, null, 2)` IN A <pre>. Fine for `{"city": "Lisbon"}`; for a node's state
// — forty messages, each with its own metadata — it was a wall several screens tall that had to be
// scrolled past to reach the output underneath, with nothing to fold and no way to tell a 12-item
// array from a 400-item one without counting braces.
//
// THREE LIMITS KEEP ANY PAYLOAD CHEAP TO OPEN, and each one says what it is holding back rather than
// cutting silently: a branch below `openDepth` starts folded with its size on it, a long string shows
// its first few hundred characters with a count of the rest, and a long array shows its first fifty
// items with a button for the next fifty. Nothing is dropped — every limit is one click from lifted.
//
// MONOSPACE, because these are literal payloads: keys and values line up, and a stack of nested
// objects is read by its indentation. IN THE CODE PALETTE (`CODE`, the product owner's, 2026-10-14),
// as every other piece of code in the app is: keys as properties, strings, numbers, and `true`,
// `false` and `null` as the language's own words; braces and colons are plain code text.

import { useMemo, useState } from "react";

import { CODE, ICON } from "../lib/tokens.ts";
import { Icon } from "../lib/icons/registry.ts";
import { has, holds, jsonLines, jsonMatches, jsonType } from "../lib/jsonShape.ts";
import { tabBtn } from "./buttons.ts";

/** Characters of a string shown before "show more". */
const STRING_SHOWN = 320;
/** Characters of a text payload shown before "show all". */
const TEXT_SHOWN = 1600;
/** Items of an array, or keys of an object, shown per page. */
const PAGE = 50;
/** Deeper than this and a value is summarised rather than walked — a guard, never reached by real state. */
const MAX_DEPTH = 40;

const plural = (n: number, word: string): string => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

function MoreButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xs font-sans text-tiny text-muted underline decoration-hair underline-offset-2 transition-colors hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
    >
      {children}
    </button>
  );
}

// ── Lines, types and search (2026-10-14) ────────────────────────────────────
//
// A PROPER VIEWER, the product owner's list asked: line numbers, search, a Raw / Pretty toggle and
// type badges ("string", "array[3]") — in the code palette's teal, faint. The numbers are the lines
// the value has pretty-printed, so a folded branch skips them as an editor's gutter does, and a line
// read in Pretty is the same line in Raw. The tools come in from TOOLS_FROM lines: a three-key object
// needs no search box.

/** From this many pretty-printed lines, a tree gets its toolbar and its gutter. */
const TOOLS_FROM = 16;

/** The searched-for text marked wherever it occurs, as the step search marks a name. */
function Marked({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, at)) {
    if (i > at) parts.push(text.slice(at, i));
    parts.push(<mark key={i} className="rounded-xs bg-ink/10 text-inherit">{text.slice(i, i + q.length)}</mark>);
    at = i + q.length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/** A value's type, faint, in the code palette's teal. */
function TypeBadge({ value, hover = false }: { value: unknown; hover?: boolean }) {
  return (
    <span
      className={`ml-1.5 inline-block rounded-xs px-1 align-baseline font-sans text-tiny leading-tight ${hover ? "opacity-0 transition-opacity group-hover:opacity-100" : ""}`}
      style={{ color: CODE.type, backgroundColor: `color-mix(in srgb, ${CODE.type} 9%, transparent)` }}
    >
      {jsonType(value)}
    </span>
  );
}

/** The gutter's number for a row: pinned to the viewer's left edge, level with the row's first line. */
function LineNo({ n, gutter }: { n: number; gutter: number }) {
  if (!gutter) return null;
  return (
    <span aria-hidden className="absolute left-0 select-none pr-2 text-right text-faint" style={{ width: gutter }}>
      {n}
    </span>
  );
}

interface Walk {
  depth: number;
  openDepth: number;
  /** The row's line, pretty-printed. */
  line: number;
  gutter: number;
  /** The search, lower-cased; "" for none. */
  q: string;
}

function JsonString({ value, q }: { value: string; q: string }) {
  const [all, setAll] = useState(false);
  const long = value.length > STRING_SHOWN;
  // A string the search found in is shown whole, so the mark is never in the part held back.
  const whole = all || has(value, q);
  const shown = long && !whole ? value.slice(0, STRING_SHOWN) : value;
  return (
    <span className="whitespace-pre-wrap" style={{ color: CODE.string }}>
      "<Marked text={shown} q={q} />{long && !whole ? "…" : ""}"
      {long && !has(value, q) && (
        <>
          {" "}
          <MoreButton onClick={() => setAll((v) => !v)}>
            {all ? "show less" : `show ${plural(value.length - STRING_SHOWN, "more character")}`}
          </MoreButton>
        </>
      )}
    </span>
  );
}

function Leaf({ value, q }: { value: unknown; q: string }) {
  if (value === null || value === undefined) return <span style={{ color: CODE.keyword }}>null</span>;
  if (typeof value === "string") return <JsonString value={value} q={q} />;
  if (typeof value === "number" || typeof value === "bigint") return <span style={{ color: CODE.number }}><Marked text={String(value)} q={q} /></span>;
  if (typeof value === "boolean") return <span style={{ color: CODE.keyword }}><Marked text={String(value)} q={q} /></span>;
  return <span style={{ color: CODE.plain }}>{String(value)}</span>;
}

/** An object's key is a property; an array's index is only a position, and stays quiet. */
function Key({ name, q }: { name: string | number | undefined; q: string }) {
  if (name === undefined) return null;
  if (typeof name === "number") return <span className="text-faint">{name}: </span>;
  return (
    <span>
      <span style={{ color: CODE.variable }}><Marked text={name} q={q} /></span>
      <span style={{ color: CODE.plain }}>: </span>
    </span>
  );
}

function Branch({ name, value, walk }: { name?: string | number; value: object; walk: Walk }) {
  const { depth, openDepth, line, gutter, q } = walk;
  const isArray = Array.isArray(value);
  const all: [string | number, unknown][] = isArray
    ? (value as unknown[]).map((v, i) => [i, v])
    : Object.entries(value as Record<string, unknown>);
  // Each child's line: the line after this one, plus every line its elder siblings take.
  const starts: number[] = [];
  let next = line + 1;
  for (const [, v] of all) {
    starts.push(next);
    next += jsonLines(v);
  }
  // SEARCHING, a branch shows only what holds the search — and all of a child whose key does.
  const entries = q
    ? all.map((e, i) => [e, i] as const).filter(([[k, v]]) => (typeof k === "string" && has(k, q)) || holds(v, q))
    : all.map((e, i) => [e, i] as const);
  const [userOpen, setOpen] = useState(depth < openDepth);
  const open = q ? entries.length > 0 || userOpen : userOpen;
  const [shown, setShown] = useState(PAGE);

  if (all.length === 0) {
    return (
      <div>
        <LineNo n={line} gutter={gutter} />
        <Key name={name} q={q} />
        <span style={{ color: CODE.plain }}>{isArray ? "[ ]" : "{ }"}</span>
        <TypeBadge value={value} />
      </div>
    );
  }

  return (
    <div>
      <LineNo n={line} gutter={gutter} />
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="-ml-4 flex max-w-full items-baseline gap-0 rounded-xs text-left focus-visible:outline-none focus-visible:shadow-focusring"
      >
        <span className={`inline-flex w-4 shrink-0 justify-center self-center text-faint transition-transform duration-fast ${open ? "" : "-rotate-90"}`} aria-hidden>
          <Icon.trace.fold size={ICON.badge} />
        </span>
        <span className="min-w-0">
          <Key name={name} q={q} />
          <span style={{ color: CODE.plain }}>{isArray ? "[" : "{"}</span>
          {!open && <span style={{ color: CODE.plain }}> … {isArray ? "]" : "}"}</span>}
          <TypeBadge value={value} />
        </span>
      </button>
      {open && (
        <>
          <div className="ml-[3px] border-l border-hair pl-4">
            {depth >= MAX_DEPTH ? (
              <span className="text-faint">…</span>
            ) : (
              entries.slice(0, shown).map(([[k, v], i]) => (
                <Value
                  key={k}
                  name={k}
                  value={v}
                  walk={{ ...walk, depth: depth + 1, line: starts[i]!, q: typeof k === "string" && has(k, q) ? "" : q }}
                />
              ))
            )}
            {entries.length > shown && (
              <MoreButton onClick={() => setShown((n) => n + PAGE)}>
                show {Math.min(PAGE, entries.length - shown)} more of {entries.length.toLocaleString()}
              </MoreButton>
            )}
          </div>
          <div>
            <LineNo n={line + jsonLines(value) - 1} gutter={gutter} />
            <span style={{ color: CODE.plain }}>{isArray ? "]" : "}"}</span>
          </div>
        </>
      )}
    </div>
  );
}

function Value({ name, value, walk }: { name?: string | number; value: unknown; walk: Walk }) {
  if (value !== null && typeof value === "object") return <Branch name={name} value={value} walk={walk} />;
  return (
    <div className="group">
      <LineNo n={walk.line} gutter={walk.gutter} />
      <Key name={name} q={walk.q} />
      <Leaf value={value} q={walk.q} />
      <TypeBadge value={value} hover />
    </div>
  );
}

/** Raw: the value pretty-printed, line by line, each token in the code palette. */
const RAW_TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;
function RawLine({ text, q }: { text: string; q: string }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(RAW_TOKEN)) {
    const i = m.index ?? 0;
    if (i > at) parts.push(<span key={`p${at}`} style={{ color: CODE.plain }}>{text.slice(at, i)}</span>);
    const colour = m[1] ? (m[2] ? CODE.variable : CODE.string) : m[3] ? CODE.number : CODE.keyword;
    const token = m[1] ?? m[3] ?? m[4] ?? "";
    parts.push(<span key={`t${i}`} style={{ color: colour }}><Marked text={token} q={q} /></span>);
    if (m[2]) parts.push(<span key={`c${i}`} style={{ color: CODE.plain }}>{m[2]}</span>);
    at = i + m[0].length;
  }
  if (at < text.length) parts.push(<span key={`p${at}`} style={{ color: CODE.plain }}>{text.slice(at)}</span>);
  return <>{parts}</>;
}

/** Lines of Raw drawn before "show all": a pretty-printed state can run to thousands. */
const RAW_SHOWN = 400;

function RawJson({ value, gutter, q }: { value: unknown; gutter: number; q: string }) {
  const [all, setAll] = useState(false);
  const lines = useMemo(() => (JSON.stringify(value, null, 2) ?? "null").split("\n"), [value]);
  const shown = all ? lines : lines.slice(0, RAW_SHOWN);
  return (
    <>
      {shown.map((l, i) => (
        <div key={i} className="whitespace-pre-wrap">
          <LineNo n={i + 1} gutter={gutter} />
          <RawLine text={l} q={q} />
        </div>
      ))}
      {lines.length > shown.length && (
        <MoreButton onClick={() => setAll(true)}>show all {lines.length.toLocaleString()} lines</MoreButton>
      )}
    </>
  );
}

/**
 * Any JSON value as a tree, folded below `openDepth` — and, from TOOLS_FROM lines, with a gutter of
 * line numbers, a search over its keys and values, and the same value as Raw text.
 */
export function JsonTree({ value, openDepth = 2 }: { value: unknown; openDepth?: number }) {
  const total = jsonLines(value);
  const tools = total >= TOOLS_FROM;
  const [query, setQuery] = useState("");
  const [raw, setRaw] = useState(false);
  const q = tools ? query.trim().toLowerCase() : "";
  const matches = useMemo(() => (q ? jsonMatches(value, q) : 0), [value, q]);
  // Wide enough for the last line's number, in the gutter's own digits.
  const gutter = tools ? 12 + String(total).length * 7 : 0;
  return (
    <div className="overflow-hidden rounded-control border border-hair bg-panel">
      {tools && (
        <div className="flex items-center gap-2 border-b border-hair px-2 py-1">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search keys and values"
            aria-label="Search this JSON"
            spellCheck={false}
            className="h-6 min-w-0 flex-1 rounded-input border border-hair bg-elevated px-2 text-tiny text-ink outline-none placeholder:text-faint focus-visible:shadow-focusring"
          />
          {q && <span className="shrink-0 text-tiny tabular-nums text-faint">{matches === 0 ? "No matches" : matches === 1 ? "1 match" : `${matches} matches`}</span>}
          <div role="group" aria-label="Show as" className="flex shrink-0 items-center gap-0.5">
            <button type="button" aria-pressed={!raw} onClick={() => setRaw(false)} className={tabBtn(!raw, "sm")}>Pretty</button>
            <button type="button" aria-pressed={raw} onClick={() => setRaw(true)} className={tabBtn(raw, "sm")}>Raw</button>
          </div>
        </div>
      )}
      <div
        className="relative py-2 pr-2 font-mono text-tiny leading-relaxed [overflow-wrap:anywhere]"
        style={{ paddingLeft: gutter + (raw ? 8 : 24) }}
      >
        {raw ? (
          <RawJson value={value} gutter={gutter} q={q} />
        ) : (
          <Value value={value} walk={{ depth: 0, openDepth, line: 1, gutter, q }} />
        )}
      </div>
    </div>
  );
}

/** A text payload — a tool's return, an HTTP response — as text, clamped until asked for. */
export function PayloadText({ text, prose = false, limit = TEXT_SHOWN }: { text: string; prose?: boolean; limit?: number }) {
  const [all, setAll] = useState(false);
  const long = text.length > limit;
  return (
    <div className="rounded-control border border-hair bg-panel px-2.5 py-2">
      <div className={`whitespace-pre-wrap break-words text-ink [overflow-wrap:anywhere] ${prose ? "text-caption leading-relaxed" : "font-mono text-tiny leading-relaxed"}`}>
        {long && !all ? `${text.slice(0, limit)}…` : text}
      </div>
      {long && (
        <div className="mt-1.5">
          <MoreButton onClick={() => setAll((v) => !v)}>
            {all ? "Show less" : `Show all ${plural(text.length, "character")}`}
          </MoreButton>
        </div>
      )}
    </div>
  );
}

/** Characters of one message shown before "show all" — a system prompt must not bury the turn after it. */
const MESSAGE_SHOWN = 600;

/** A message the way LangChain serialises one: a `type` (or `role`) and a `content`. */
export interface Message {
  type?: unknown;
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
}

const isMessage = (m: unknown): m is Message =>
  typeof m === "object" && m !== null && !Array.isArray(m) && "content" in m && ("type" in m || "role" in m);

/**
 * The messages a model was sent, when `input` is that shape: a list of them, or a batch of lists
 * (`[[…]]`, which is how the interceptor captures a chat model's input). Null for anything else, so
 * the caller falls back to the tree.
 */
export function asMessages(input: unknown): Message[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const flat = input.length === 1 && Array.isArray(input[0]) ? (input[0] as unknown[]) : input;
  return flat.length > 0 && flat.every(isMessage) ? (flat as Message[]) : null;
}

/** What a message's content says, as text: a string, or the text blocks of a content list. */
export function contentText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((b) => (typeof b === "string" ? b : typeof b === "object" && b !== null && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : null))
    .filter((t): t is string => t !== null);
  return parts.length > 0 ? parts.join("\n") : null;
}

/** A model's conversation, one message per block: who said it, then what. */
export function MessageList({ messages }: { messages: Message[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      {messages.map((m, i) => {
        const role = String(m.type ?? m.role ?? "message");
        const text = contentText(m.content);
        return (
          <div key={i} className="min-w-0">
            <div className="mb-0.5 text-tiny uppercase tracking-wider text-faint">{role}</div>
            {text !== null && text.trim() !== "" ? <PayloadText text={text} prose limit={MESSAGE_SHOWN} /> : null}
            {(text === null || text.trim() === "") && m.content !== undefined && typeof m.content !== "string" && (
              <JsonTree value={m.content} openDepth={1} />
            )}
            {Array.isArray(m.tool_calls) && m.tool_calls.length > 0 && <JsonTree value={{ tool_calls: m.tool_calls }} openDepth={2} />}
          </div>
        );
      })}
    </div>
  );
}
