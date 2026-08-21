// §5.1 step 4 — the first agent, which is the "wow" moment or is skipped entirely.
//
// THE SAMPLE IS THE DEFAULT AND THAT IS DELIBERATE. "Weather+calculator is the existing test agent,
// which runs offline (dry-run) with no API key. This is deliberately the default recommendation
// because it works for every user regardless of whether they set up a provider key." Which is the
// same promise step 3's skip makes, kept one screen later — a flow where skipping the key screen
// led to a screen you could not complete would have made that skip a lie.
//
// "DESCRIBE YOUR OWN" IS THE OTHER HALF, and §5.1 is explicit about what it is for: it "kicks off
// the normal agent generation flow — with the plan gate shown as a normal turn. The user sees their
// first plan card as part of onboarding, which is the 'wow' moment." So it is not a special
// onboarding generator; it is the product, on its first turn.
//
// AND SKIP LANDS SOMEBODY IN AN EMPTY APP RATHER THAN A FAKE ONE. "Skip lands the user in the main
// app with an empty state ('Your first agent will appear here — generate one from the composer').
// No fake sample data." A seeded example somebody then has to work out is not theirs is worse than
// an empty panel that says what to do.

import { useState } from "react";
import { startFirstAgent } from "../../../lib/firstAgent.ts";
import { useAccountOnboardingStore } from "../../../store/accountOnboardingStore.ts";
import { FormError, PrimaryButton } from "../../auth/controls.tsx";
import { StepShell } from "./StepShell.tsx";

type Choice = "sample" | "describe";

export function AgentStep() {
  const advance = useAccountOnboardingStore((s) => s.advance);
  const [choice, setChoice] = useState<Choice>("sample");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async (): Promise<void> => {
    if (busy) return;
    if (choice === "describe" && description.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await startFirstAgent(
        choice === "sample" ? { kind: "sample" } : { kind: "describe", prompt: description.trim() },
      );
      advance();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <StepShell
      step={4}
      title="Generate your first agent"
      subtitle="Pick a starting point."
      skip={{ label: "Skip for now", onSkip: advance }}
      width="wide"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void generate();
        }}
        className="flex flex-col gap-5"
      >
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Starting point</legend>
          <Option
            id="sample"
            checked={choice === "sample"}
            onChoose={() => setChoice("sample")}
            title="Weather + calculator"
            detail="A simple two-tool agent. Runs offline, with no API key."
          />
          <Option
            id="describe"
            checked={choice === "describe"}
            onChoose={() => setChoice("describe")}
            title="Describe your own"
            detail="Type what you want and Jaroku will generate it."
          />
        </fieldset>

        {/* INLINE RATHER THAN A SECOND SCREEN, per §5.1's own drawing. The textarea appears under
            the option it belongs to, so choosing it and filling it in is one movement. */}
        {choice === "describe" && (
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="An agent that reads my calendar and drafts a summary of tomorrow…"
            aria-label="Describe your agent"
            rows={4}
            disabled={busy}
            autoFocus
            // The one deliberate exception to the type ladder, the same one the composer takes:
            // this is the thing you type into, and it is allowed to be the largest text here.
            className="w-full resize-none rounded-control border border-edge bg-void px-3.5 py-3 text-[14px]
              leading-[1.6] text-ink outline-none transition-colors duration-fast placeholder:text-faint
              focus-visible:shadow-focusring focus:border-chrome disabled:opacity-50"
          />
        )}

        {error && <FormError>{error}</FormError>}

        <PrimaryButton type="submit" disabled={busy || (choice === "describe" && description.trim().length === 0)}>
          {busy ? "Generating…" : "Generate"}
        </PrimaryButton>
      </form>
    </StepShell>
  );
}

function Option({
  id,
  checked,
  onChoose,
  title,
  detail,
}: {
  id: string;
  checked: boolean;
  onChoose: () => void;
  title: string;
  detail: string;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-control border px-3.5 py-3 transition-colors
        duration-fast ${checked ? "border-chrome bg-active" : "border-edge bg-void hover:border-chrome"}`}
    >
      <input type="radio" name="starting-point" value={id} checked={checked} onChange={onChoose} className="peer sr-only" />
      <span
        aria-hidden
        className={`mt-[3px] flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-full border
          transition-colors duration-fast peer-focus-visible:shadow-focusring ${checked ? "border-ink" : "border-edge"}`}
      >
        {checked && <span className="h-[7px] w-[7px] rounded-full bg-ink" />}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] leading-[1.4] text-ink">{title}</span>
        <span className="mt-1 block text-[12px] leading-[1.5] text-muted">{detail}</span>
      </span>
    </label>
  );
}
