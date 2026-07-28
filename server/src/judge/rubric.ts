// LLM-as-judge: the rubric, the prompt, and the verdict parser.
//
// Deliberately pure — no network, no store. Everything here is a function of its inputs, so
// the part of judging that is product quality (what we ask, on what scale, and what counts
// as a valid answer) can be reasoned about and tested without spending a cent. The call
// itself lives in the scoring pipeline.
//
// Four choices that decide whether scores mean anything:
//
// 1. THE RUBRIC IS DATA, NOT CODE. Criteria live in the `rubrics` table and are editable
//    per dataset (doc §6.4: "LLM-as-judge scoring with editable rubric"). "Correct" for a
//    refund bot is not "correct" for a SQL agent, and a hardcoded rubric would quietly
//    impose one domain's standard on every other.
//
// 2. A COARSE, ANCHORED SCALE. Each criterion is scored 0-4 against written anchors, not on
//    a continuous 0-1. Judges are far more consistent choosing between a handful of
//    described levels than emitting a float, and "0.73" implies a precision that isn't
//    there. The 0-1 overall is derived, never asked for.
//
// 3. EVERY CRITERION IS PHRASED POSITIVELY. The doc lists "correctness, hallucination,
//    tone"; hallucination as written is a negative — a high score would mean a bad answer,
//    and mixing polarities in one weighted sum is a reliable way to produce a number nobody
//    can interpret. It ships as "grounding" instead, measuring the same thing upward.
//
// 4. AN INCOMPLETE VERDICT IS AN ERROR, NOT A ZERO. If the judge omits a criterion, the
//    verdict is rejected and the example is UNSCORED. Defaulting a missing score to 0 would
//    silently punish a provider for the judge's formatting slip.

import type { RubricCriterion } from "../evalStore.ts";

/** Scored levels. Coarse on purpose — see note 2 above. */
export const SCALE_MAX = 4;

/** Anchors shared by every criterion, so a "3" means the same thing across the rubric. */
const SCALE_ANCHORS = [
  "0 — fails this criterion outright",
  "1 — mostly fails; a serious problem",
  "2 — partially meets it; a real but non-fatal problem",
  "3 — meets it, with a minor blemish",
  "4 — fully meets it",
].join("\n");

/**
 * The built-in rubric. Covers the doc's three dimensions, phrased so that higher is always
 * better. Weights sum to 1 but are normalized anyway, so an edited rubric can't skew the
 * scale just by not adding up.
 */
export const DEFAULT_CRITERIA: RubricCriterion[] = [
  {
    id: "correctness",
    label: "Correctness",
    description:
      "Does the response actually accomplish what the input asked for? Judge the outcome, " +
      "not the effort: a confident answer to the wrong question scores low.",
    weight: 0.5,
  },
  {
    id: "grounding",
    label: "Grounding",
    description:
      "Is every factual claim supported by the input, the tool results, or the reference " +
      "output? Invented specifics — order numbers, dates, prices, policies that appear " +
      "nowhere in the available information — score low even when they sound plausible.",
    weight: 0.3,
  },
  {
    id: "tone",
    label: "Tone",
    description:
      "Is the response appropriate for the person who asked: clear, direct, and neither " +
      "curt nor padded? Judge the writing, not whether the answer was right.",
    weight: 0.2,
  },
];

export interface JudgeSubject {
  /** The dataset example's input — what the agent was asked. */
  input: string;
  /** Optional ground truth. Absent for most datasets; the rubric still applies. */
  expected?: string | null;
  /** The agent's final user-facing output. */
  output: string;
  /** Non-fatal problems from the run, so the judge isn't scoring a truncated answer blind. */
  runError?: string | null;
}

export interface JudgePrompt {
  system: string;
  user: string;
  /** JSON Schema for structured output, so the response shape is enforced, not requested. */
  schema: Record<string, unknown>;
}

const SYSTEM =
  "You are grading one response from an AI agent against a rubric. You are a strict, " +
  "consistent grader: the same response and rubric must always get the same scores.\n\n" +
  "Grade ONLY what the rubric asks about. Do not reward length, confidence, or formatting " +
  "beyond what a criterion names. If information needed to judge a criterion is absent, " +
  "score what is actually there rather than assuming the best case.\n\n" +
  "A reference output, when provided, is one acceptable answer — not the only one. A " +
  "response that reaches the same outcome by different wording is correct.";

/** Render the rubric into the prompt. Criterion ids are the keys the judge must return. */
function renderCriteria(criteria: RubricCriterion[]): string {
  return criteria
    .map((c, i) => `${i + 1}. "${c.id}" — ${c.label}\n   ${c.description}`)
    .join("\n\n");
}

/** JSON Schema for the verdict: one integer per criterion, plus a short rationale. */
export function verdictSchema(criteria: RubricCriterion[]): Record<string, unknown> {
  const scores: Record<string, unknown> = {};
  for (const c of criteria) {
    scores[c.id] = {
      type: "integer",
      minimum: 0,
      maximum: SCALE_MAX,
      description: `${c.label}: ${c.description}`,
    };
  }
  return {
    type: "object",
    properties: {
      scores: {
        type: "object",
        properties: scores,
        required: criteria.map((c) => c.id),
        additionalProperties: false,
      },
      rationale: {
        type: "string",
        description: "One or two sentences citing the specific thing that decided the scores.",
      },
    },
    required: ["scores", "rationale"],
    additionalProperties: false,
  };
}

export function buildJudgePrompt(subject: JudgeSubject, criteria: RubricCriterion[]): JudgePrompt {
  const parts = [
    `## The input the agent was given\n${subject.input}`,
    subject.expected
      ? `## Reference output (one acceptable answer, not the only one)\n${subject.expected}`
      : null,
    `## The agent's response\n${subject.output || "(the agent produced no output)"}`,
    subject.runError
      ? `## Note\nThe run reported an error: ${subject.runError}\nGrade the response as it stands.`
      : null,
    `## Rubric\nScore each criterion from 0 to ${SCALE_MAX}:\n\n${SCALE_ANCHORS}\n\n${renderCriteria(criteria)}`,
  ].filter(Boolean);

  return {
    system: SYSTEM,
    user: parts.join("\n\n"),
    schema: verdictSchema(criteria),
  };
}

export interface JudgeVerdict {
  /** Weighted overall, 0..1. Derived from the per-criterion scores — never asked for. */
  score: number;
  /** Raw 0..SCALE_MAX per criterion id. */
  perCriterion: Record<string, number>;
  rationale: string;
}

/**
 * Parse and validate a judge response.
 *
 * Strict by design: an unparseable or incomplete verdict returns an error so the example is
 * recorded UNSCORED. A lenient parser that filled in gaps would turn the judge's formatting
 * slips into a provider's low score, which is worse than a blank.
 */
export function parseJudgeVerdict(
  raw: string,
  criteria: RubricCriterion[],
): { verdict: JudgeVerdict } | { error: string } {
  const text = stripCodeFence(raw).trim();
  if (!text) return { error: "the judge returned nothing" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "the judge's response was not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { error: "the judge's response was not a JSON object" };
  }

  const scoresRaw = (parsed as { scores?: unknown }).scores;
  if (typeof scoresRaw !== "object" || scoresRaw === null) {
    return { error: "the judge's response had no scores object" };
  }
  const scores = scoresRaw as Record<string, unknown>;

  const perCriterion: Record<string, number> = {};
  for (const c of criteria) {
    const v = scores[c.id];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      // Missing or non-numeric — reject rather than default. See note 4.
      return { error: `the judge did not score "${c.id}"` };
    }
    // Clamp rather than reject: a judge that says 5 on a 0-4 scale meant "full marks", and
    // discarding an otherwise-complete verdict over that would lose a real signal.
    perCriterion[c.id] = Math.min(Math.max(Math.round(v), 0), SCALE_MAX);
  }

  const totalWeight = criteria.reduce((s, c) => s + (c.weight > 0 ? c.weight : 0), 0);
  // Weights are normalized here so an edited rubric whose weights don't sum to 1 still
  // produces a 0..1 score. An all-zero-weight rubric falls back to an equal split rather
  // than dividing by zero.
  const score = totalWeight
    ? criteria.reduce(
        (s, c) => s + ((c.weight > 0 ? c.weight : 0) / totalWeight) * (perCriterion[c.id]! / SCALE_MAX),
        0,
      )
    : criteria.reduce((s, c) => s + perCriterion[c.id]! / SCALE_MAX, 0) / (criteria.length || 1);

  const rationale = typeof (parsed as { rationale?: unknown }).rationale === "string"
    ? ((parsed as { rationale: string }).rationale)
    : "";

  return { verdict: { score: Number(score.toFixed(4)), perCriterion, rationale } };
}

/** Tolerate a ```json fence around the object — cheap, and models still add them. */
function stripCodeFence(s: string): string {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced?.[1] ?? s;
}
