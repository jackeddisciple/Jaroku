// Read at build time from the SAME pricing.json the runtime and the server both read. One
// source of truth, one number that can be wrong, and it is checked in with the code that
// uses it.
import pricing from "../../../runtime/pricing.json";

export type Provider = "anthropic" | "openai" | "meta";

export interface Model {
  id: string;
  /** What a person reads — "GPT-5.6 Luna". `id` is what the API is sent. */
  name: string;
  provider: Provider;
  input: number;   // USD per million input tokens
  output: number;  // USD per million output tokens
  cache_read_mult: number;
  cache_write_mult: number;
  reasoning: "thinking" | "effort" | null;
  /** The levels an `effort` model's API takes. */
  effort_levels?: string[];
  /** Absent where the vendor publishes none — Muse Spark's, today. */
  max_output_tokens?: number;
  context_window: number;
}

// The price sheet also carries `fake-dry-run`, the test suites' stand-in. It is not a model anyone
// is offered, so it is not on this page either.
export const MODELS: Model[] = (pricing.models as { provider: string }[])
  .filter((m) => m.provider !== "fake") as Model[];

export const PROVIDER_META: Record<Provider, { label: string; envKey: string; note: string }> = {
  anthropic: {
    label: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    note: "Used for planning, generation, editing, explain and the eval judge — plus any agent that runs on a Claude model.",
  },
  openai: {
    label: "OpenAI",
    envKey: "OPENAI_API_KEY",
    note: "Only needed to run agents on GPT. Calls go through the Responses API, where these models call tools.",
  },
  meta: {
    label: "Meta",
    envKey: "META_API_KEY",
    note: "Only needed to run agents on Muse Spark. Keys start LLM| and come from Meta's Model API dashboard.",
  },
};

export const REASONING_BUDGETS = pricing.reasoning.budgets;
