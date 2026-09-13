// The exact command line one Chat turn becomes, for one provider, at one effort.
//
// A PURE FUNCTION RATHER THAN A SPAWN, because the thing worth getting right here is not the
// process handling — it is the ARGUMENT VECTOR, and an argument vector is a value that can be
// asserted. The shell runs what this returns; it decides nothing itself. So every rule about how a
// provider may be invoked is enforced in one testable place instead of at a call site nobody reads
// twice.
//
// TWO RULES LIVE HERE AND NOWHERE ELSE:
//
//   1. A GATED PROVIDER PRODUCES NO COMMAND. `plan` returns a refusal, not a best effort. This is
//      the last gate before a process would actually start, and it repeats the check `status.ts`
//      already made — deliberately. Defence in depth is cheap when the failure mode is "a user's
//      provider account gets enforced against".
//
//   2. THE FLAG THAT WOULD SILENTLY SWITCH BILLING IS NEVER EMITTED. `claude --bare` "never reads
//      OAuth credentials or the system keychain" and wants ANTHROPIC_API_KEY instead. A subscription
//      turn carrying it would quietly spend the user's API balance while the interface said it was
//      using their plan. Nothing here can emit it, and a test asserts that for every provider and
//      every level rather than for the one case somebody remembered.
//
// EFFORT IS TRANSLATED, NEVER PASSED THROUGH. Claude takes `/effort <level>` inside the prompt;
// Codex takes `-c model_reasoning_effort=<level>`; Muse Spark takes nothing and has no path here at
// all. `mapEffort` owns the vocabulary and the clamp, and this module owns where the result is
// placed on the command line — which is a different question for each of them.
//
//   npm run test:provider-auth-invocation

import type { Effort } from "../effort.ts";
import { providerLabel, type ProviderId } from "../providers.ts";
import { capabilityOf, mapEffort } from "./capability.ts";

/** What a turn needs to become a command. */
export interface TurnRequest {
  /** The user's message. Passed as an argument or on stdin, never interpolated into a shell. */
  readonly prompt: string;
  /** The model to run on, or null to let the provider's own default stand. */
  readonly model: string | null;
  /** The level the composer asked for. Clamped per provider before it reaches the wire. */
  readonly effort: Effort;
  /** Where the process should run. Its own directory, never the user's project by accident. */
  readonly cwd: string;
}

/** A command ready to spawn. */
export interface Invocation {
  readonly provider: ProviderId;
  /** argv[0] is the binary; the shell resolves it on PATH. Never passed to a shell interpreter. */
  readonly argv: readonly string[];
  /** Written to the child's stdin, or null when the prompt rides in argv. */
  readonly stdin: string | null;
  /** How to read what comes back. */
  readonly protocol: string;
  /** The level actually asked for, after this provider's clamp. Reported, never re-derived. */
  readonly appliedEffort: Effort | null;
  /** The provider's own word for that level, for the trace record. */
  readonly effortValue: string | null;
}

/** Why no command was produced. */
export interface Refusal {
  readonly refused: true;
  readonly reason: string;
}

export type InvocationPlan = Invocation | Refusal;

export function isRefusal(plan: InvocationPlan): plan is Refusal {
  return (plan as Refusal).refused === true;
}

/**
 * The flag that must never appear in a subscription invocation, and the reason it must not.
 *
 * Exported so the test can assert against the same constant the planner avoids, rather than against
 * a second copy of the string that could drift away from it.
 */
export const FORBIDDEN_CLAUDE_FLAGS: readonly string[] = ["--bare"];

/**
 * Build the command for one turn, or refuse.
 *
 * `cwd` matters more than it looks: `codex exec` declines to run outside a trusted git repository
 * unless told not to check, and Jaroku's chat turns are not about the user's repository at all —
 * they are about an agent Jaroku is building. So the caller passes a directory Jaroku owns and the
 * check is skipped explicitly, which is a narrower thing than trusting wherever the app happened to
 * be launched from.
 */
export function planInvocation(provider: ProviderId, req: TurnRequest): InvocationPlan {
  const cap = capabilityOf(provider);

  // RULE 1. Checked here even though `status.ts` checked it, because this is the last thing that
  // happens before a process would exist.
  if (!cap.subscriptionChatAvailable) {
    return {
      refused: true,
      reason: cap.requiresProviderApproval
        ? `${providerLabel(provider)} is awaiting provider approval and cannot answer a turn yet.`
        : `${providerLabel(provider)} has no supported subscription mechanism.`,
    };
  }
  const mechanism = cap.mechanism;
  if (!mechanism) {
    return { refused: true, reason: `${providerLabel(provider)} has no invocation mechanism.` };
  }

  const { applied, value } = mapEffort(provider, req.effort);

  if (provider === "openai") {
    // `codex exec --json` is the documented non-interactive mode and emits one JSON object per
    // line: thread.started, turn.started, item.completed, turn.completed with a usage block.
    // app-server is the richer surface — approvals, history — and is what a later revision moves
    // to; a single question with a streamed answer needs none of it.
    const argv = ["codex", "exec", "--json", "--skip-git-repo-check"];
    if (value) argv.push("-c", `model_reasoning_effort="${value}"`);
    if (req.model) argv.push("--model", req.model);
    // The prompt goes in argv rather than stdin: `codex exec` reads stdin as ADDITIONAL input and
    // waits on it, so a turn whose prompt was piped would hang until the stream closed.
    argv.push(req.prompt);
    return {
      provider, argv, stdin: null, protocol: "jsonl/stdout",
      appliedEffort: applied, effortValue: value,
    };
  }

  if (provider === "anthropic") {
    // Unreachable while Claude is gated — rule 1 returned above. Written and tested anyway, because
    // "production-ready underneath the gate" means the day approval lands nothing here is new.
    const argv = ["claude", "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
    if (req.model) argv.push("--model", req.model);
    // Claude takes its level as a slash command inside the prompt, not as a flag. Prepended rather
    // than appended so the user's own text cannot end up parsed as the level's argument.
    const prompt = value ? `/effort ${value}\n${req.prompt}` : req.prompt;
    argv.push(prompt);
    return {
      provider, argv, stdin: null, protocol: "stream-json/stdout",
      appliedEffort: applied, effortValue: value,
    };
  }

  return { refused: true, reason: `${providerLabel(provider)} has no subscription chat path.` };
}
