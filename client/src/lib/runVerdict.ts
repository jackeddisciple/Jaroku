// What a run decided, read out of what it produced — for the trace's verdict card (the product owner's
// list, 2026-10-14: "Turn the Final Answer into a verdict card … a big Advance · 92 chip and a row of
// requirement pills").
//
// DETECTED, NOT DECLARED. An agent has no field for its verdict; a screening agent puts
// `{decision: "advance", score: 92, requirements: [...]}` in its state, or writes "Decision: Advance"
// in its answer. So this reads the run's final state and its answer for the shapes those take, and
// says nothing when it finds none — the card is then the plain answer it always was.
//
//   npm run test:trace-view

import { jsonReply } from "./traceView.ts";

export type VerdictTone = "advance" | "reject" | "other";

export interface Requirement {
  label: string;
  met: boolean;
}

export interface RunVerdict {
  /** The decision as the run worded it — "Advance", "reject" — or null when it gave only a score. */
  decision: string | null;
  tone: VerdictTone;
  /** The score as the chip prints it: "92", "4.5", "92/100". Null when the run gave none. */
  score: string | null;
  requirements: Requirement[];
  /** What the requirements are called, from the run's own field: "must-haves", "criteria". */
  noun: string;
  /** Why, when the run said so in a field of its own; else null and the answer is the reasoning. */
  reasoning: string | null;
}

const REJECT = /\b(reject(ed)?|decline(d)?|den(y|ied)|fail(ed)?|no[- ]hire|do not|don't|not (advance|recommend\w*|proceed|a fit|qualified)|disqualif\w*|pass on|unsuitable|no)\b/i;
const ADVANCE = /\b(advance[ds]?|accept(ed)?|approve[ds]?|hire|pass(ed)?|yes|proceed|shortlist(ed)?|move forward|recommend(ed)?|strong (yes|fit)|interview|qualified|go)\b/i;

/** Advance or reject, by the words of the decision; anything else is neither. */
export function verdictTone(decision: string): VerdictTone {
  if (REJECT.test(decision)) return "reject";
  if (ADVANCE.test(decision)) return "advance";
  return "other";
}

const DECISION_KEY = /^(decision|verdict|recommendation|outcome|final_decision|hiring_decision)$/i;
const SCORE_KEY = /^(score|overall_score|fit_score|match_score|total_score|final_score|rating)$/i;
const REASON_KEY = /^(reasoning|rationale|explanation|justification|reason)$/i;
const CHECKS_KEY = /^(requirements?|must_haves?|criteria|checks|qualifications|requirement_checks|requirements_met)$/i;
const MET_KEY = /^(matched|met|matched_requirements|met_requirements|matched_skills|requirements_matched)$/i;
const UNMET_KEY = /^(missing|unmet|gaps|missing_requirements|unmet_requirements|missing_skills|requirements_missing)$/i;

const LABEL_FIELDS = ["requirement", "name", "label", "criterion", "skill", "title", "item", "text"];
const MET_FIELDS = ["met", "matched", "satisfied", "pass", "passed", "ok", "meets", "present"];

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function metOf(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v !== "string") return null;
  if (/^(met|matched|pass(ed)?|yes|true|ok|present|✓|✔|✅)$/i.test(v.trim())) return true;
  if (/^(missing|unmet|not met|fail(ed)?|no|false|absent|partial|✗|✘|❌)$/i.test(v.trim())) return false;
  return null;
}

function requirementsFrom(v: unknown): Requirement[] {
  const out: Requirement[] = [];
  if (Array.isArray(v)) {
    for (const item of v) {
      if (!isMap(item)) continue;
      const label = LABEL_FIELDS.map((f) => item[f]).find((x): x is string => typeof x === "string" && x.trim() !== "");
      let met: boolean | null = null;
      for (const f of [...MET_FIELDS, "status", "result"]) {
        met = metOf(item[f]);
        if (met != null) break;
      }
      if (label && met != null) out.push({ label: label.trim(), met });
    }
  } else if (isMap(v)) {
    for (const [label, value] of Object.entries(v)) {
      const met = metOf(value);
      if (met != null) out.push({ label: label.replace(/_/g, " "), met });
    }
  }
  return out;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : []);

/** "must_haves" → "must-haves": the requirements' own name, as a sentence says it. */
function nounOf(key: string): string {
  const k = key.toLowerCase();
  if (/must_?have/.test(k)) return "must-haves";
  if (/criteri/.test(k)) return "criteria";
  if (/qualification/.test(k)) return "qualifications";
  if (/skill/.test(k)) return "skills";
  if (/check/.test(k)) return "checks";
  return "requirements";
}

function scoreText(v: unknown): string | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  // A 0–1 fraction reads as the percentage it is: 0.92 is "92".
  if (n > 0 && n < 1) return String(Math.round(n * 100));
  return String(Math.round(n * 10) / 10);
}

interface Found {
  decision: string | null;
  score: string | null;
  requirements: Requirement[];
  noun: string | null;
  reasoning: string | null;
}

/** The verdict's parts from an object — the state, or an answer that is JSON — three levels deep. */
function fromObject(root: Record<string, unknown>): Found {
  const found: Found = { decision: null, score: null, requirements: [], noun: null, reasoning: null };
  const visit = (obj: Record<string, unknown>, depth: number): void => {
    for (const [k, v] of Object.entries(obj)) {
      if (k === "messages") continue;
      if (found.decision == null && DECISION_KEY.test(k) && typeof v === "string" && v.trim() && v.length <= 60) found.decision = v.trim();
      else if (found.score == null && SCORE_KEY.test(k)) found.score = scoreText(v);
      else if (found.reasoning == null && REASON_KEY.test(k) && typeof v === "string" && v.trim().length >= 20) found.reasoning = v.trim();
      else if (CHECKS_KEY.test(k) && found.requirements.length === 0) {
        const reqs = requirementsFrom(v);
        if (reqs.length) {
          found.requirements = reqs;
          found.noun = nounOf(k);
        }
      } else if (MET_KEY.test(k) || UNMET_KEY.test(k)) {
        const met = MET_KEY.test(k);
        const items = strings(v).map((label) => ({ label, met }));
        if (items.length) {
          found.requirements = [...found.requirements, ...items];
          found.noun ??= nounOf(k);
        }
      } else if (isMap(v) && depth < 3) visit(v, depth + 1);
    }
  };
  visit(root, 0);
  return found;
}

/** The verdict's parts from prose: "Decision: Advance", "Score: 92/100", and ✓ / ✗ lines. */
function fromText(text: string): Found {
  const found: Found = { decision: null, score: null, requirements: [], noun: null, reasoning: null };
  const plain = (s: string): string => s.replace(/\*\*|__|`/g, "").trim();
  for (const raw of text.split("\n")) {
    const line = plain(raw.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+)/, ""));
    if (!line) continue;
    const decision = /^(decision|verdict|recommendation|outcome)\s*[:：\-–—]\s*([^(,.;|·—–]{1,40})/i.exec(line);
    if (decision && found.decision == null) {
      found.decision = decision[2]!.trim();
      const inline = /\bscore\s*[:：=]?\s*(\d{1,3}(?:\.\d+)?)(?:\s*\/\s*(\d{1,3}))?/i.exec(line);
      if (inline && found.score == null) found.score = inline[2] ? `${inline[1]}/${inline[2]}` : inline[1]!;
      continue;
    }
    const score = /^(?:overall\s+|fit\s+|match\s+|total\s+|final\s+)?score\s*[:：=\-–—]\s*(\d{1,3}(?:\.\d+)?)(?:\s*\/\s*(\d{1,3}))?/i.exec(line);
    if (score && found.score == null) {
      found.score = score[2] ? `${score[1]}/${score[2]}` : score[1]!;
      continue;
    }
    const check = /^(✓|✔|✅|☑|\[x\]|✗|✘|❌|✖|\[ \])\s*(.+)$/i.exec(line);
    if (check) found.requirements.push({ label: check[2]!.trim().slice(0, 80), met: !/^(✗|✘|❌|✖|\[ \])$/.test(check[1]!) });
  }
  return found;
}

/**
 * What the run decided, or null when it decided nothing this can find: a decision or a score is what
 * makes a verdict. The answer first — what the run said — then the final state for what it did not.
 */
export function readVerdict(state: unknown, answer: string): RunVerdict | null {
  const json = answer ? jsonReply(answer) : undefined;
  const sources: Found[] = [];
  if (isMap(json)) sources.push(fromObject(json));
  else if (answer) sources.push(fromText(answer));
  if (isMap(state)) sources.push(fromObject(state));
  const pick = <K extends keyof Found>(k: K): Found[K] | null => {
    for (const s of sources) {
      const v = s[k];
      if (Array.isArray(v) ? v.length > 0 : v != null) return v;
    }
    return null;
  };
  const decision = pick("decision");
  const score = pick("score");
  const requirements = pick("requirements") ?? [];
  const holder = sources.find((s) => s.requirements.length > 0);
  if (decision == null && score == null && requirements.length === 0) return null;
  return {
    decision,
    tone: decision ? verdictTone(decision) : "other",
    score,
    requirements,
    noun: holder?.noun ?? "requirements",
    reasoning: pick("reasoning"),
  };
}

/** Whether a reading is a verdict: it has a decision or a score. Requirements alone are a summary. */
export const isVerdict = (v: RunVerdict | null): v is RunVerdict => v != null && (v.decision != null || v.score != null);
