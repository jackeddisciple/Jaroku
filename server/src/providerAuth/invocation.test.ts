// The command line, asserted as a value.
//
// The argv this module produces is the last thing between a user's intention and a process that
// spends their provider account, so the assertions here are about what CANNOT appear in it: a
// command for a gated provider, a flag that switches billing, an effort level the CLI would reject.
//
// The Codex expectations were checked against a real run on 2026-09-13:
//
//   $ codex exec --json --skip-git-repo-check -c model_reasoning_effort="low" "…"
//   {"type":"thread.started",…}  {"type":"turn.started"}
//   {"type":"item.completed","item":{"type":"agent_message","text":"BRIDGE OK"}}
//   {"type":"turn.completed","usage":{…}}
//
//   npm run test:provider-auth-invocation

import { EFFORT_LEVELS, type Effort } from "../effort.ts";
import { PROVIDER_IDS, type ProviderId } from "../providers.ts";
import { capabilityOf } from "./capability.ts";
import { FORBIDDEN_CLAUDE_FLAGS, isRefusal, planInvocation, type Invocation } from "./invocation.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const req = (over: Partial<Parameters<typeof planInvocation>[1]> = {}) => ({
  prompt: "what does this agent do?",
  model: null,
  effort: "medium" as Effort,
  cwd: "/tmp/jaroku",
  ...over,
});

console.log("\na gated provider produces no command at all");
{
  for (const id of PROVIDER_IDS) {
    const plan = planInvocation(id, req());
    if (capabilityOf(id).subscriptionChatAvailable) {
      check(`${id} plans a command`, !isRefusal(plan));
    } else {
      check(`${id} refuses rather than improvising`, isRefusal(plan));
      check(`...and says why`, isRefusal(plan) && plan.reason.length > 20, isRefusal(plan) ? plan.reason : "");
    }
  }
  // Muse Spark specifically: it has no subscription mechanism at all, so the refusal says that
  // rather than implying something is merely switched off.
  const meta = planInvocation("meta", req());
  check("Muse Spark's refusal says no mechanism exists", isRefusal(meta) && /no supported subscription/i.test(meta.reason),
    isRefusal(meta) ? meta.reason : "");
  // And Claude, now permitted, plans a real command rather than a refusal.
  const claude = planInvocation("anthropic", req());
  check("Claude plans a command", !isRefusal(claude));
}

console.log("\nthe flag that would switch billing can never be emitted");
{
  // THE LOAD-BEARING ASSERTION. `--bare` never reads OAuth credentials or the keychain and wants an
  // API key instead — a subscription turn carrying it spends the wrong pool silently. Asserted for
  // every provider at every level, not for the one case somebody remembered.
  let emitted = false;
  for (const id of PROVIDER_IDS) {
    for (const effort of EFFORT_LEVELS) {
      for (const model of [null, "claude-opus-5", "gpt-6-astra"]) {
        const plan = planInvocation(id, req({ effort, model }));
        if (isRefusal(plan)) continue;
        if (plan.argv.some((a) => FORBIDDEN_CLAUDE_FLAGS.includes(a))) emitted = true;
      }
    }
  }
  check("no plan at any level on any provider emits --bare", !emitted);
  check("...and the forbidden list is not empty, so the loop above means something", FORBIDDEN_CLAUDE_FLAGS.length > 0);
}

console.log("\nCodex is invoked exactly as it was verified to work");
{
  const plan = planInvocation("openai", req({ effort: "high" })) as Invocation;
  const argv = plan.argv.join(" ");
  check("it runs the documented non-interactive mode", argv.startsWith("codex exec --json"), argv);
  // Without this, `codex exec` refuses outside a trusted git repo — the real failure seen on
  // 2026-09-13: "Not inside a trusted directory and --skip-git-repo-check was not specified."
  check("...skipping the git-repo check Jaroku's own directory would fail", plan.argv.includes("--skip-git-repo-check"));
  check("...carrying the provider's own effort parameter", argv.includes('-c model_reasoning_effort="high"'), argv);
  check("...and the prompt in argv, not stdin", plan.stdin === null && plan.argv.at(-1) === "what does this agent do?");
  check("...reporting the level actually applied", plan.appliedEffort === "high" && plan.effortValue === "high");
}

console.log("\nClaude takes its level as a flag, and the prompt is exactly the message");
{
  // THE FAILURE THIS REPLACES: `/effort high\n<message>` made Claude Code parse the entire message as
  // the slash command's argument, never call the model, and report "Invalid argument" as a success.
  for (const effort of EFFORT_LEVELS) {
    const plan = planInvocation("anthropic", req({ effort })) as Invocation;
    const at = plan.argv.indexOf("--effort");
    check(`${effort}: --effort ${plan.effortValue}`, at > 0 && plan.argv[at + 1] === plan.effortValue, plan.argv.join(" "));
    check(`${effort}: ...and the prompt is the message, untouched`,
      plan.argv.at(-1) === "what does this agent do?", String(plan.argv.at(-1)));
    check(`${effort}: ...with no slash command anywhere`, !plan.argv.some((a) => a.includes("/effort")), plan.argv.join(" "));
  }
}

console.log("\neffort is clamped to what each CLI accepts, and the clamp is reported");
{
  // Codex stops at xhigh. Sending "max" would be a value the CLI rejects, failing the whole turn.
  const maxed = planInvocation("openai", req({ effort: "max" })) as Invocation;
  check("Max becomes xhigh on Codex", maxed.effortValue === "xhigh", String(maxed.effortValue));
  check("...and the turn records xhigh rather than the max that was asked for", maxed.appliedEffort === "xhigh");

  // Every level a provider accepts must produce a value that provider accepts.
  for (const id of PROVIDER_IDS) {
    const accepted = capabilityOf(id).reasoning?.levels ?? [];
    if (accepted.length === 0) continue;
    let bad = "";
    for (const effort of EFFORT_LEVELS) {
      const plan = planInvocation(id, req({ effort }));
      if (isRefusal(plan) || plan.effortValue === null) continue;
      if (!accepted.includes(plan.effortValue as Effort)) bad = `${effort}->${plan.effortValue}`;
    }
    check(`${id} never sends a level it does not accept`, bad === "", bad);
  }
}

console.log("\nClaude's recorded serve mode is the documented programmatic one");
{
  // Claude is permitted, so `planInvocation` builds its command in the blocks above. This reads the
  // mechanism the capability table records for it — what the row names, and what must never carry
  // the flag that switches billing.
  const argv = capabilityOf("anthropic").mechanism!.serve.argv;
  check("it uses -p, the documented programmatic mode", argv.includes("-p"));
  check("...streaming, so a long answer is not a wait", argv.includes("stream-json"));
  check("...and never --bare", !argv.some((a) => FORBIDDEN_CLAUDE_FLAGS.includes(a)), argv.join(" "));
}

console.log("\nnothing is interpolated into a shell");
{
  // A prompt is user text. It reaches the child as one argv element, so quoting, backticks and
  // semicolons are characters rather than syntax — there is no shell in this path at all.
  const nasty = '"; rm -rf / #';
  const plan = planInvocation("openai", req({ prompt: nasty })) as Invocation;
  check("the prompt survives as a single argument", plan.argv.at(-1) === nasty);
  check("...and appears exactly once", plan.argv.filter((a) => a === nasty).length === 1);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;
