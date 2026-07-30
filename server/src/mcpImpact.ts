// Impact classification for a discovered MCP tool.
//
// The question this answers is narrow: before a generated agent runs THIS tool for the
// first time, must we stop and ask the user? Getting it wrong is costly in both directions
// — false friction on a search tool trains people to click through the gate without
// reading it, which is worse than not having a gate; a missed classification lets something
// irreversible happen while nobody is looking.
//
// So the rule is a RATCHET, and the order below is the whole design:
//
//   1. The server's own ToolAnnotations may only RAISE impact, never lower it.
//      `destructiveHint: true` is believed. `readOnlyHint: true` is IGNORED.
//
//      This asymmetry is the trust model in one line. A server is unreviewed third-party
//      code; letting it certify its own tool as safe would make the gate opt-out, defeated
//      by four characters of JSON. Believing it when it says "this is dangerous" costs
//      nothing, because the answer we already default to is "dangerous".
//
//   2. The tool NAME, which by MCP convention leads with its verb. This is the one signal
//      allowed to decide in both directions, because it is a machine identifier the tool's
//      own author chose — unconjugated, unpunctuated, and about nothing but this tool.
//
//   3. The DESCRIPTION's opening words, for tools whose names say nothing — and, like the
//      annotations, only allowed to RAISE. Prose is a weak signal: it conjugates, it
//      mentions other tools, and "Returns the newly created issue" describes a write in the
//      grammar of a read. A weak signal gets to push in the safe direction only.
//
//   4. Otherwise HIGH.
//
// Steps 1 and 3 are the same rule applied twice, and it is worth naming: an untrusted or
// unreliable signal may raise impact, never lower it. Only the name gets a vote both ways.
//
// Step 4 is load-bearing. It mirrors evalRunner.isTransientFailure treating unrecognised
// failures as deterministic: when the heuristic cannot read something, it must fail toward
// the expensive-but-safe answer, because the cheap-but-unsafe one is silent. A tool called
// `frobnicate` gets a confirmation prompt. That is correct — nobody, including us, knows
// what it does.
//
// The classification is advisory-to-the-user, not final: it is stored with its reason and a
// user can override it per tool (mcpStore.setToolImpactOverride). The heuristic's job is to
// be right often enough that the override is rare, and legible enough that using it is an
// informed decision.
//
//   npm run test:mcp-impact

import type { McpImpact } from "./mcpStore.ts";

export interface ImpactVerdict {
  impact: McpImpact;
  /** Why, in words, shown in the management UI and in the confirmation modal. */
  reason: string;
}

/**
 * Unambiguous mutation verbs. Matched ANYWHERE in the name, because `get_or_create_issue`
 * creates regardless of what it leads with — one high verb anywhere is enough.
 */
const HIGH_VERBS = new Set([
  "add", "apply", "approve", "archive", "assign", "cancel", "clear", "close", "commit",
  "create", "delete", "deploy", "disable", "drop", "edit", "enable", "execute", "grant",
  "insert", "install", "invite", "kill", "merge", "modify", "patch", "publish", "purge",
  "refresh", "reject", "remove", "rename", "replace", "reset", "restart", "revoke", "send",
  "submit", "sync", "terminate", "trigger", "truncate", "uninstall", "update", "upload",
  "upsert", "write",
]);

/**
 * Mutation verbs in the leading position, ordinary nouns anywhere else.
 *
 * Matched ONLY as the first token. `send_message` writes; `get_message` reads, and treating
 * its "message" as a verb would gate every mail-reading tool in existence — the precise
 * false-friction failure this file exists to avoid.
 */
const HIGH_LEADING_ONLY = new Set([
  "book", "charge", "email", "mail", "message", "move", "note", "notify", "order", "pay",
  "post", "push", "put", "refund", "run", "set", "share", "transfer",
]);

/** Information retrieval. Nothing here changes anything the user would want back. */
const LOW_VERBS = new Set([
  "check", "count", "describe", "diff", "download", "exists", "explain", "export", "fetch",
  "find", "get", "has", "inspect", "is", "list", "lookup", "preview", "query", "read",
  "resolve", "retrieve", "search", "show", "status", "summarize", "summarise", "validate",
  "view",
]);

/** How many leading words of a description count as its verb phrase. */
const DESCRIPTION_LEAD_WORDS = 8;

/**
 * Candidate forms of a prose word: "creates" -> ["creates", "create"], "purges" ->
 * ["purges", "purge", "purg"]. Needed only for descriptions, where verbs are conjugated —
 * identifiers are not, which is why the name pass matches exactly and this does not.
 */
function stems(token: string): string[] {
  const out = [token];
  if (token.length > 3 && token.endsWith("es")) out.push(token.slice(0, -2));
  if (token.length > 2 && token.endsWith("s")) out.push(token.slice(0, -1));
  return out;
}

/**
 * `"createIssue"` / `"create_issue"` / `"linear.create-issue"` -> `["create", "issue"]`.
 *
 * Matching is EXACT, never by prefix or stem, and that is a feature: `list_deleted_items`
 * tokenizes to "deleted", which is not "delete", so it stays low. Stemming would gate every
 * tool that mentions a past mutation in its own name.
 */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/** The server's advertised ToolAnnotations, as far as this file cares about them. */
export interface ToolAnnotations {
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
  [key: string]: unknown;
}

export interface ClassifyInput {
  name: string;
  description?: string | null;
  annotations?: ToolAnnotations | null;
}

/**
 * Scan a tokenized NAME — the only signal allowed to vote both ways. Leading-only verbs
 * count at index 0 and nowhere else. Returns the word that decided it, for the reason line.
 */
function scanName(tokens: string[]): { impact: McpImpact; word: string; leading: boolean } | null {
  const first = tokens[0];
  if (first !== undefined) {
    if (HIGH_VERBS.has(first) || HIGH_LEADING_ONLY.has(first)) {
      return { impact: "high", word: first, leading: true };
    }
  }
  // A high verb anywhere outranks a low one, wherever either sits. `get_or_create_issue`
  // is a write with a read's leading verb, and the write is the part that matters.
  for (const t of tokens.slice(1)) {
    if (HIGH_VERBS.has(t)) return { impact: "high", word: t, leading: false };
  }
  if (first !== undefined && LOW_VERBS.has(first)) {
    return { impact: "low", word: first, leading: true };
  }
  for (const t of tokens.slice(1)) {
    if (LOW_VERBS.has(t)) return { impact: "low", word: t, leading: false };
  }
  return null;
}

/**
 * Classify a discovered tool. Never throws — a malformed advertisement from an unreviewed
 * server must not be able to break discovery, and an unreadable tool is high by default
 * anyway.
 */
export function classify(input: ClassifyInput): ImpactVerdict {
  const name = typeof input.name === "string" ? input.name : "";
  const description = typeof input.description === "string" ? input.description : "";
  const annotations = (input.annotations ?? {}) as ToolAnnotations;

  // The server may raise. It may not lower — but if it TRIED to lower and we still landed
  // on high, the user is told, because "the server says this is safe and we disagreed" is
  // exactly the moment the trust boundary earns its keep.
  const claimedReadOnly = annotations.readOnlyHint === true;
  const caveat = claimedReadOnly
    ? " (the server advertises this tool as read-only; a server does not get to certify its own tool as safe)"
    : "";

  if (annotations.destructiveHint === true) {
    return { impact: "high", reason: "the server advertises this tool as destructive" };
  }
  if (annotations.readOnlyHint === false) {
    return { impact: "high", reason: "the server advertises this tool as not read-only" };
  }

  const byName = scanName(tokenize(name));
  if (byName) {
    const where = byName.leading ? "its name begins with" : "its name contains";
    if (byName.impact === "high") {
      return { impact: "high", reason: `${where} "${byName.word}"${caveat}` };
    }
    return { impact: "low", reason: `${where} "${byName.word}"` };
  }

  // Only the opening words, and only looking for evidence of a write. MCP descriptions lead
  // with the verb ("Creates an issue in..."), so a mutation verb here is worth acting on;
  // scanning the whole paragraph would instead gate `search_docs` because its description
  // mentions deletion in passing.
  //
  // There is deliberately no path from a description to "low". "Returns the newly created
  // issue" opens like a read and describes a write, and the cost of believing it is a
  // silent irreversible action — the one outcome this whole file is arranged to prevent.
  const lead = tokenize(description).slice(0, DESCRIPTION_LEAD_WORDS);
  for (const token of lead) {
    for (const form of stems(token)) {
      if (HIGH_VERBS.has(form)) {
        return {
          impact: "high",
          reason: `its description begins "${lead.slice(0, 5).join(" ")}…", and "${form}" writes${caveat}`,
        };
      }
    }
  }

  // Note on what is deliberately NOT consulted: the input schema. An empty parameter list
  // reads like a harmless getter and isn't one — `purge_all()` takes no arguments.
  return {
    impact: "high",
    reason: `nothing in its name or description says what it does, so it is treated as high-impact${caveat}`,
  };
}
