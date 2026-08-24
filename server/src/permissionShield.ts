// The permission shield — §3.2's policy control, and the server-side invariants underneath it.
//
// WHAT THE CONTROL IS. v0.2.0's MCP confirmation gate already stops a run before a high-impact
// tool's first call. The shield exposes that policy as something a user can set, which is the
// whole of its UI job. What makes it more than a dropdown is everything below, because a policy
// control whose enforcement lives in the client is a policy control that a modified client turns
// off. §12.7 says so in the assertion itself: "Verify server-side with the client bypassed."
//
// THREE HARD INVARIANTS, and the first two are enforced here rather than in the composer:
//
//   1. WRITE AND DESTRUCTIVE TOOLS ALWAYS CONFIRM, IN EVERY MODE, INCLUDING FAST. This is the
//      invariant that makes the whole control safe to ship. It also makes Smart and Fast narrower
//      than they look, and that is worth saying out loud rather than discovering: once writes
//      always confirm, the only thing Fast actually buys is that a read-only tool stops asking on
//      its first call. That is a small difference on purpose. A mode that bought more would have
//      to buy it by weakening invariant 1, and the spec forbids exactly that — "There is no
//      'approve everything' mode, and adding one later is a product decision, not an
//      implementation shortcut."
//
//   2. PROTECTED PATHS ARE NEVER WRITABLE, IN ANY MODE. The block list is projectFs's, not a
//      second copy — see `assertWritable`. What is new here is the NORMALISATION, and it exists
//      because of a bug that already shipped once: `join` uses the platform separator, so on
//      Windows a block-list entry read `tools\mcp_bridge.py` and matched nothing in an object
//      store whose keys are always `/`-separated. The list went quietly empty for the one file
//      that carries an agent's entire MCP grant. §12.8 asks for both spellings to be verified,
//      and this module is where a request's path is flattened before it is compared.
//
//   3. Mode changes are audit-logged. That one lives at the route (http/conversations.ts), because
//      it is about a settings write rather than about a tool call.
//
// THE RATCHET IS UNCHANGED AND IS NOT RELITIGATED HERE. mcpImpact.ts decides what a tool IS, with
// an untrusted server allowed to raise impact and never lower it, and an unreadable tool landing
// on HIGH. This module decides what to DO about that, per mode. Keeping the two apart is what
// stops a permission mode from quietly becoming a second impact classifier.
//
//   npm run test:permission-shield

import type { McpImpact } from "./mcpStore.ts";
import type { PermissionMode } from "./conversationSettings.ts";

/**
 * What a tool call is, for the purpose of deciding whether to ask.
 *
 * Deliberately three values and not two. "Unknown" is not folded into "write": they are treated
 * identically by every mode today, and collapsing them would throw away the reason — a future
 * mode that wanted to distinguish "we know this writes" from "we could not tell" would have to
 * re-derive it from the impact verdict, which is where this started.
 */
export type ToolClass = "read" | "write" | "unknown";

/**
 * Read the impact verdict as a class.
 *
 * `low` is the ONLY thing that becomes `read`, and that asymmetry is mcpImpact's ratchet reaching
 * this module intact: a server's own `readOnlyHint` is ignored there, so a `low` verdict means the
 * tool's own NAME read as a retrieval verb — the one signal allowed to vote in both directions.
 * Everything else, including a tool nothing could classify, is something that might change the
 * world, and gets treated as one.
 */
export function classOf(impact: McpImpact | null | undefined): ToolClass {
  if (impact === "low") return "read";
  if (impact === "high") return "write";
  return "unknown";
}

export interface GateDecision {
  /** Whether a human has to answer before this call proceeds. */
  confirm: boolean;
  /** Why, in words. Shown in the confirmation modal and written to the trace. */
  reason: string;
}

/**
 * Whether this call must stop and ask.
 *
 * `firstCallInRun` is what Smart and Fast spend: a write tool asks once per run rather than once
 * per call, because a loop that writes forty rows would otherwise be forty modals and the honest
 * consequence of that is people clicking through without reading — which is worse than not having
 * a gate, and is the failure mcpImpact's own header names.
 *
 * STRICT DOES NOT SPEND IT. "Confirm every tool call" is the spec's own wording, and somebody who
 * chose Strict has decided the forty modals are the point.
 */
export function mustConfirm(
  mode: PermissionMode,
  cls: ToolClass,
  firstCallInRun: boolean,
): GateDecision {
  // INVARIANT 1, AND IT IS CHECKED BEFORE THE MODE IS EVEN READ. Written this way round on
  // purpose: a later mode added to the union cannot opt out of it by forgetting a branch, because
  // there is no branch to forget. The only way to weaken this is to delete these four lines, which
  // is a change somebody has to make deliberately and a reviewer can see.
  if (cls !== "read") {
    return {
      confirm: true,
      reason: cls === "write"
        ? "it can change or delete something, and every mode confirms that"
        : "nobody has been able to classify what it does, so it is treated as if it writes",
    };
  }

  if (mode === "strict") {
    return { confirm: true, reason: "Strict mode confirms every tool call" };
  }

  // Smart and Fast agree here, and the header says why that is not an oversight: once writes always
  // confirm, a read-only tool's first call is the only thing left for a mode to decide.
  if (mode === "smart" && firstCallInRun) {
    return { confirm: true, reason: "Smart mode confirms a tool's first call in a run" };
  }

  return { confirm: false, reason: "read-only" };
}

// ── Protected paths ─────────────────────────────────────────────────────────

/**
 * Flatten a path to the shape the block list is written in: POSIX separators, no `.` segments, no
 * `..`, no leading slash, no duplicate slashes.
 *
 * EVERY ONE OF THOSE IS A REAL BYPASS AND NOT A TIDINESS RULE:
 *
 *   `tools\mcp_bridge.py` is the Windows-separator bug that already shipped. It matched the local
 *   paths one code path produced and matched nothing in the object store, so the block list was
 *   empty for the file that carries an agent's entire MCP grant.
 *
 *   `tools/../tools/mcp_bridge.py` and `./tools/mcp_bridge.py` and `tools//mcp_bridge.py` all name
 *   the same object and none of them is string-equal to the entry. A block list compared by string
 *   equality is defeated by punctuation.
 *
 *   A leading `/` likewise: `/tools/mcp_bridge.py` reads as the same file to a person and to most
 *   filesystems, and as a different key to a Set.
 *
 * `..` THAT CLIMBS PAST THE ROOT IS REFUSED RATHER THAN CLAMPED. Returning `""` for
 * `../../etc/passwd` would make it compare unequal to every entry and therefore writable — which
 * is the failure this function exists to prevent, arrived at by being helpful. The caller gets
 * null and must treat it as a refusal.
 */
export function normalizePath(raw: string): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  // Backslashes first, so a Windows-style path is a POSIX one before anything else looks at it.
  const flattened = raw.replace(/\\/g, "/");
  const out: string[] = [];
  for (const segment of flattened.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // Nothing to pop means this escapes the project root. Refuse rather than clamp.
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.length === 0 ? null : out.join("/");
}

export interface WriteDecision {
  allowed: boolean;
  /** Why not, in words, or null when it is allowed. */
  reason: string | null;
}

/**
 * Whether a write to this path may proceed, in the mode given.
 *
 * THE MODE IS A PARAMETER AND IS NEVER READ, and that is the assertion rather than an oversight.
 * §3.2: "Protected paths are never writable, in any mode." Taking the mode and ignoring it is what
 * lets a suite pass all three and see the same refusal — a signature without it would make the
 * claim untestable, and a signature that branched on it would make the claim false.
 *
 * `protectedPaths` comes from `projectFs.readOnlyPaths()`, unchanged. A second list here would be
 * a second answer to "may this file be edited", and the two would disagree the first time a
 * connector template was added.
 */
export function permitWrite(
  path: string,
  protectedPaths: Iterable<string>,
  _mode: PermissionMode,
): WriteDecision {
  const key = normalizePath(path);
  if (key === null) {
    return { allowed: false, reason: "that path does not name a file inside the project" };
  }
  // The block list is normalised too. Its entries are already written POSIX-style, so this changes
  // nothing today — and it is what stops a future entry added with a `./` or a backslash from
  // silently removing itself from the list.
  for (const entry of protectedPaths) {
    if (normalizePath(entry) === key) {
      return {
        allowed: false,
        reason: `${key} is host-owned or a reviewed template, and is read-only in every permission mode`,
      };
    }
  }
  return { allowed: true, reason: null };
}

/**
 * Whether a path may be ATTACHED as context, which is a different question with a different answer.
 *
 * §4.2: "Protected files are attachable (reading them as context is fine and useful) but render
 * with a lock and a tooltip stating they can't be edited. Attaching must never imply write
 * capability." So this is deliberately permissive where `permitWrite` is not, and the pair exists
 * so that the two questions cannot be answered by one function that somebody later "simplifies"
 * into agreeing with itself.
 */
export function permitAttach(path: string): WriteDecision {
  const key = normalizePath(path);
  if (key === null) {
    return { allowed: false, reason: "that path does not name a file inside the project" };
  }
  return { allowed: true, reason: null };
}
