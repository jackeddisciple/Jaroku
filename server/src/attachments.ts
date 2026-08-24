// Context attachments — §4's explicit channel, and the budget that keeps it honest.
//
// WHY THIS IS A SERVER MODULE AT ALL. §4.4 is unambiguous: "Fetch attachment bodies server-side at
// dispatch, resolving GitHub content through SecretStore. The client sends refs, never blobs, and
// never sees a token." So a client says "the file at tools/weather.py" and this decides what that
// means, what it costs, and whether it fits. Nothing about that can be delegated to the browser —
// a client that estimated its own token cost could send a request that overflows the window and
// have the overflow silently truncated, which is the outcome §4.4 calls "the worst possible
// behavior here, because it produces a confident answer grounded in half a file."
//
// THREE THINGS ARE DECIDED HERE AND THE ORDER MATTERS:
//
//   RESOLVE — turn a ref into a pinned one. A file becomes {path, version_id}, so the turn is
//   reproducible after the file changes. §4.4's "snapshot at send, not at attach".
//
//   ESTIMATE — how much of the context window this costs. Approximate on purpose; see `estimate`.
//
//   BUDGET — warn at 70%, BLOCK at 100%, and name the attachments responsible. Blocking is the
//   part that matters: the alternative is a request that fits by having been quietly cut.
//
// THE CAP IS TEN (§4.4). Not a performance limit — ten attachments is already more context than
// anybody assembles deliberately, and the eleventh is far more likely to be somebody who has lost
// track of the rail than somebody who genuinely needs eleven.
//
//   npm run test:attachments

import { contextWindowFor } from "./pricing.ts";

/** §4.2's five sources. */
export const ATTACHMENT_KINDS = ["file", "run", "dataset_case", "tool_schema", "github"] as const;

export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export function isAttachmentKind(v: unknown): v is AttachmentKind {
  return typeof v === "string" && (ATTACHMENT_KINDS as readonly string[]).includes(v);
}

/** §4.4: "Cap at 10 attachments per turn, with a clear message on the 11th." */
export const MAX_ATTACHMENTS = 10;

/** §4.4 / §9: an inline warning at 70% of the window, a hard block at 100%. */
export const WARN_AT = 0.7;

/**
 * Characters per token, for the estimate.
 *
 * FOUR, AND IT IS AN APPROXIMATION THAT IS SAID TO BE ONE. Real tokenisation is per-provider and
 * per-model, and running three tokenisers server-side to decide whether to show a warning would be
 * a dependency, a cache and a per-keystroke cost for a number that only has to be right enough to
 * catch "this file will not fit".
 *
 * It errs HIGH for code, which is the direction that matters here: code tokenises closer to 3
 * characters per token than 4, so a four-character divisor UNDER-estimates... which is the wrong
 * direction. Hence `SAFETY`, below, rather than a prettier constant.
 */
const CHARS_PER_TOKEN = 4;

/**
 * The margin the estimate is inflated by before it is compared against a window.
 *
 * A FIFTH, AND IT IS THE WHOLE REASON THE ESTIMATE IS SAFE TO BLOCK ON. Four characters per token
 * is roughly right for prose and optimistic for source code, which is most of what gets attached
 * here — a Python file with its punctuation and its indentation runs nearer three. An estimate
 * that came in low would let a send through that then overflowed and got truncated by the
 * provider, which is precisely the silent failure this whole budget exists to prevent.
 *
 * So the arithmetic leans toward refusing a send that might have fitted, rather than accepting one
 * that might not. That trade is the right way round: a refusal is visible and has a remedy on
 * screen; a truncation is invisible and produces a confident wrong answer.
 */
const SAFETY = 1.2;

/** Tokens a piece of text will cost, leaning high. Never negative, never NaN. */
export function estimateTokens(text: string | null | undefined): number {
  if (typeof text !== "string" || text.length === 0) return 0;
  return Math.ceil((text.length / CHARS_PER_TOKEN) * SAFETY);
}

/** One attachment, as the server knows it — a resolved ref plus what it costs. */
export interface ResolvedAttachment {
  kind: AttachmentKind;
  /** The pinned reference. Shapes per kind are documented in migration 055. */
  ref: Record<string, unknown>;
  tokenEstimate: number;
  /** What the chip says. Middle-truncated by the client, never here. */
  label: string;
  /** §4.2: a protected file is attachable and renders with a lock. Never a reason to refuse. */
  protected?: boolean;
}

export type BudgetLevel = "ok" | "warn" | "over";

export interface BudgetVerdict {
  level: BudgetLevel;
  /** Tokens the attachments alone would cost. */
  tokens: number;
  /** The model's window, or null when nothing has recorded one. */
  window: number | null;
  /** 0–1, or null when the window is unknown. */
  fraction: number | null;
  /**
   * The attachments to name in the message, largest first.
   *
   * §4.4: "at >100% block send and name the offending attachments." Naming them is the difference
   * between a refusal somebody can act on and one they can only be annoyed by — the remedy is
   * always "remove that one", and the user needs to know which one that is.
   */
  offending: string[];
  /** The sentence to show. Null when there is nothing to say. */
  message: string | null;
}

/**
 * Whether this set of attachments fits, and what to say about it.
 *
 * AN UNKNOWN WINDOW WARNS RATHER THAN BLOCKS. A model with no recorded context window is one
 * nobody has checked, and refusing every send on it would break the product for a model that
 * probably works — while blocking on a number we do not have would be asserting a limit we cannot
 * name. This is the one place in this feature that fails toward permissive, and it does so because
 * the failure it is guarding against (a truncated context) is not certain, whereas the failure it
 * would cause (an unusable model) is.
 */
export function checkBudget(
  attachments: readonly ResolvedAttachment[],
  modelId: string,
  /** Tokens the message itself and the conversation already cost. */
  baseTokens = 0,
): BudgetVerdict {
  const tokens = attachments.reduce((n, a) => n + a.tokenEstimate, 0);
  const total = tokens + baseTokens;
  const window = contextWindowFor(modelId);

  // Largest first, because the remedy is "remove one" and the largest is the one worth removing.
  const byCost = [...attachments].sort((a, b) => b.tokenEstimate - a.tokenEstimate);

  if (window === null) {
    return {
      level: "ok", tokens, window: null, fraction: null, offending: [],
      message: attachments.length > 0
        ? "Jaroku has no context-window record for this model, so it cannot check whether this fits."
        : null,
    };
  }

  const fraction = total / window;

  if (fraction >= 1) {
    // Name enough of them to get back under the line, largest first — rather than every
    // attachment, which for ten of them is a paragraph nobody reads.
    const offending: string[] = [];
    let remaining = total - window;
    for (const a of byCost) {
      if (remaining <= 0) break;
      offending.push(a.label);
      remaining -= a.tokenEstimate;
    }
    return {
      level: "over", tokens, window, fraction, offending,
      message:
        `This turn's context is about ${Math.round(fraction * 100)}% of what this model can hold. ` +
        `Remove ${offending.join(" or ")} to send it.`,
    };
  }

  if (fraction >= WARN_AT) {
    return {
      level: "warn", tokens, window, fraction, offending: [],
      message: `This turn is using about ${Math.round(fraction * 100)}% of the model's context.`,
    };
  }

  return { level: "ok", tokens, window, fraction, offending: [], message: null };
}

/**
 * Whether one more attachment may be added.
 *
 * Separate from `checkBudget` because it answers a different question at a different moment: the
 * cap is about the rail being legible, the budget is about the request being complete. An
 * attachment can be refused by either and the messages are not interchangeable.
 */
export function checkCount(count: number): { allowed: boolean; message: string | null } {
  if (count < MAX_ATTACHMENTS) return { allowed: true, message: null };
  return {
    allowed: false,
    message: `A turn can carry ${MAX_ATTACHMENTS} attachments. Remove one to attach something else.`,
  };
}

/**
 * The label a chip shows, per kind.
 *
 * HERE RATHER THAN IN THE CLIENT, because the same label goes into the budget message ("Remove
 * tools/weather.py or run #128") and into the stored row. Two spellings of the same attachment —
 * one in a chip, one in the sentence explaining why the send was refused — would read as two
 * different things.
 */
export function labelFor(kind: AttachmentKind, ref: Record<string, unknown>): string {
  switch (kind) {
    case "file":
      return String(ref.path ?? "a file");
    case "run":
      return `run ${String(ref.run_id ?? "").slice(0, 8)}`;
    case "dataset_case":
      return `case: ${String(ref.name ?? ref.case_id ?? "")}`;
    case "tool_schema":
      return String(ref.name ?? ref.tool_id ?? "a tool");
    case "github": {
      if (typeof ref.pr === "number") return `PR #${ref.pr}`;
      if (typeof ref.commit_sha === "string") return `commit ${ref.commit_sha.slice(0, 7)}`;
      if (typeof ref.path === "string") return `${ref.path} @ ${String(ref.ref ?? "HEAD")}`;
      return "a GitHub reference";
    }
  }
}

/**
 * Refuse a ref that does not carry what its kind requires.
 *
 * VALIDATED HERE RATHER THAN AT THE CHECK CONSTRAINT, because a constraint violation reaches a
 * client as a 500 with a driver's message in it — which is both useless to the caller and a
 * description of the inside of the server. The schema's CHECK still guards the `kind`; this guards
 * the shape, where the schema deliberately does not.
 */
export function validateRef(kind: AttachmentKind, ref: unknown): string | null {
  if (typeof ref !== "object" || ref === null || Array.isArray(ref)) return "ref must be an object";
  const r = ref as Record<string, unknown>;
  const str = (k: string): boolean => typeof r[k] === "string" && (r[k] as string).length > 0;
  switch (kind) {
    case "file":
      // `version_id` is what makes it a snapshot rather than a bookmark, so its absence is a
      // refusal rather than a default — §4.4's whole reproducibility claim rests on it.
      return str("path") && str("version_id") ? null : "a file ref needs a path and a version_id";
    case "run":
      return str("run_id") ? null : "a run ref needs a run_id";
    case "dataset_case":
      return str("case_id") ? null : "a dataset case ref needs a case_id";
    case "tool_schema":
      return str("tool_id") ? null : "a tool schema ref needs a tool_id";
    case "github":
      return str("commit_sha") || typeof r.pr === "number" || str("path")
        ? null
        : "a GitHub ref needs a commit_sha, a pr number, or a path";
  }
}
