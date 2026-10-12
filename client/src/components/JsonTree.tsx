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
// objects is read by its indentation.

import { useState } from "react";

import { ICON } from "../lib/tokens.ts";
import { Icon } from "../lib/icons/registry.ts";

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

function JsonString({ value }: { value: string }) {
  const [all, setAll] = useState(false);
  const long = value.length > STRING_SHOWN;
  const shown = long && !all ? value.slice(0, STRING_SHOWN) : value;
  return (
    <span className="whitespace-pre-wrap text-ink">
      "{shown}{long && !all ? "…" : ""}"
      {long && (
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

function Leaf({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-faint">null</span>;
  if (typeof value === "string") return <JsonString value={value} />;
  return <span className="text-muted">{String(value)}</span>;
}

function Key({ name }: { name: string | number | undefined }) {
  if (name === undefined) return null;
  return <span className="text-muted">{typeof name === "number" ? `${name}` : name}: </span>;
}

function Branch({ name, value, depth, openDepth }: { name?: string | number; value: object; depth: number; openDepth: number }) {
  const isArray = Array.isArray(value);
  const entries: [string | number, unknown][] = isArray
    ? (value as unknown[]).map((v, i) => [i, v])
    : Object.entries(value as Record<string, unknown>);
  const [open, setOpen] = useState(depth < openDepth);
  const [shown, setShown] = useState(PAGE);
  const size = isArray ? plural(entries.length, "item") : plural(entries.length, "key");

  if (entries.length === 0) {
    return (
      <div>
        <Key name={name} />
        <span className="text-faint">{isArray ? "[ ]" : "{ }"}</span>
      </div>
    );
  }

  return (
    <div>
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
          <Key name={name} />
          <span className="text-faint">{isArray ? "[" : "{"}</span>
          {!open && <span className="font-sans text-tiny text-faint"> {size} </span>}
          {!open && <span className="text-faint">{isArray ? "]" : "}"}</span>}
        </span>
      </button>
      {open && (
        <>
          <div className="ml-[3px] border-l border-hair pl-4">
            {depth >= MAX_DEPTH ? (
              <span className="text-faint">…</span>
            ) : (
              entries.slice(0, shown).map(([k, v]) => <Value key={k} name={k} value={v} depth={depth + 1} openDepth={openDepth} />)
            )}
            {entries.length > shown && (
              <MoreButton onClick={() => setShown((n) => n + PAGE)}>
                show {Math.min(PAGE, entries.length - shown)} more of {entries.length.toLocaleString()}
              </MoreButton>
            )}
          </div>
          <span className="text-faint">{isArray ? "]" : "}"}</span>
        </>
      )}
    </div>
  );
}

function Value({ name, value, depth, openDepth }: { name?: string | number; value: unknown; depth: number; openDepth: number }) {
  if (value !== null && typeof value === "object") return <Branch name={name} value={value} depth={depth} openDepth={openDepth} />;
  return (
    <div>
      <Key name={name} />
      <Leaf value={value} />
    </div>
  );
}

/** Any JSON value as a tree, folded below `openDepth`. */
export function JsonTree({ value, openDepth = 2 }: { value: unknown; openDepth?: number }) {
  return (
    <div className="overflow-hidden rounded-control border border-hair bg-panel py-2 pl-6 pr-2 font-mono text-tiny leading-relaxed [overflow-wrap:anywhere]">
      <Value value={value} depth={0} openDepth={openDepth} />
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
interface Message {
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
function contentText(content: unknown): string | null {
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
