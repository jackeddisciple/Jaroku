// Read at build time from the SAME pricing.json the runtime and the server both read. One
// source of truth, one number that can be wrong, and it is checked in with the code that
// uses it.
import pricing from "../../../runtime/pricing.json";

export type Provider = "anthropic" | "openai" | "google" | "fake";

export interface Model {
  id: string;
  provider: Provider;
  input: number;   // USD per million input tokens
  output: number;  // USD per million output tokens
  cache_read_mult: number;
  cache_write_mult: number;
  reasoning: "thinking" | "effort" | null;
  max_output_tokens: number;
  context_window: number;
  free?: boolean;
}

export const MODELS: Model[] = (pricing.models as Model[])
  .filter((m) => m.provider !== "fake");

export const DRY_RUN = (pricing.models as Model[]).find((m) => m.provider === "fake")!;

export const PROVIDER_META: Record<Provider, { label: string; envKey: string; note: string }> = {
  anthropic: {
    label: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    note: "Used for planning, generation, editing, explain and the eval judge — plus any agent that runs on a Claude model.",
  },
  openai: {
    label: "OpenAI",
    envKey: "OPENAI_API_KEY",
    note: "Only needed to run agents on the OpenAI provider.",
  },
  google: {
    label: "Google",
    envKey: "GOOGLE_API_KEY",
    note: "Only needed to run agents on Gemini. This is not the Gmail connector's OAuth app.",
  },
  fake: {
    label: "Dry run",
    envKey: "—",
    note: "The free provider. Walks TOOLS, synthesises one call per tool, answers plainly. No key required.",
  },
};

export const REASONING_BUDGETS = pricing.reasoning.budgets;
