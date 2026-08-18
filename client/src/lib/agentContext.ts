// §5.5's Copy agent context: one markdown block, for pasting into an issue or another tool.
//
// THE WHOLE POINT IS THAT IT LEAVES THIS APP. It goes on a clipboard, into a GitHub issue, into a
// Slack message, into somebody else's LLM. That makes it the single highest-risk piece of text this
// feature produces, and it is why the redaction rule is stated as a property of the FUNCTION rather
// than as a discipline whoever calls it has to remember:
//
//   THIS FILE IS HANDED NAMES AND NEVER VALUES. `AgentCardView` carries `required_env` and
//   `missing_env`, both of which are lists of environment-variable NAMES, and there is no field on it
//   — none — that holds a credential, a fragment of one, or its length. So the redaction is not
//   something this function does; it is something it cannot fail to do, which is the only kind of
//   redaction worth relying on. `test:agent-context` asserts it by putting a known secret through
//   every string on the input and checking the output does not contain it, by the same pattern that
//   asserts a known secret cannot reach a log sink.
//
// MARKDOWN, BECAUSE OF WHERE IT IS GOING. An issue tracker, a pull request and a chat window all
// render it; a terminal and a plain text field show it unchanged and still readable, which a table of
// box-drawing characters would not be.
//
// WHAT IT CONTAINS is §5.5's list and nothing beyond it: slug, current version, connectors, granted
// MCP tools, credential status by name, health summary, last error. Deliberately NOT the description
// (prose somebody already has), the thread list (a link, not a fact) or the spend (a figure that is
// stale the moment it is pasted, and one people forward without meaning to).

import type { AgentCardView } from "../types.ts";

/**
 * How much of a failure message is worth carrying.
 *
 * A stack trace is not context, it is the thing the person is about to go and look at — and a
 * clipboard block that is mostly Python frames is one nobody reads. Long enough for the sentence at
 * the top of a traceback, which is the part that says what went wrong.
 */
const ERROR_CAP = 300;

/** One line, with a bullet, or nothing at all when there is nothing to say. */
const line = (label: string, value: string | null): string | null =>
  value === null ? null : `- **${label}:** ${value}`;

/**
 * The block, as text.
 *
 * ABSENT FACTS ARE OMITTED RATHER THAN RENDERED AS "none". A block with six lines reading "none" says
 * less than a block with two lines that are true, and the reader is a person triaging something
 * rather than a parser expecting a schema. The two exceptions are credentials and health, which are
 * stated even when they are fine — "all configured" and "healthy" are the answers somebody pasting
 * this is most often being asked for.
 */
export function agentContextMarkdown(a: AgentCardView): string {
  const configured = a.required_env.filter((n) => !a.missing_env.includes(n));

  const facts: (string | null)[] = [
    line("Agent", `\`${a.slug}\`${a.name !== a.slug ? ` (${a.name})` : ""}`),
    line("Version", `v${a.current_version}${a.version_source ? ` (${a.version_source})` : ""}`),
    line("Connectors", a.connectors.length ? a.connectors.map((c) => `\`${c}\``).join(", ") : null),
    // NAMES, as `server/tool` refs. That is what the manifest holds and what somebody would search
    // for; the impact classification lives in the Capabilities tab, where the stored reason is beside
    // it and can be read rather than summarised into one word.
    line("MCP tools", a.mcp_tools.length ? a.mcp_tools.map((t) => `\`${t}\``).join(", ") : null),
    line(
      "Credentials",
      a.required_env.length === 0
        ? "none required"
        : a.missing_env.length === 0
          ? `all configured (${configured.map((n) => `\`${n}\``).join(", ")})`
          // MISSING FIRST, because that is the actionable half and the reason somebody is copying
          // this at all. Names only, here as everywhere.
          : `missing ${a.missing_env.map((n) => `\`${n}\``).join(", ")}` +
            (configured.length ? `; configured ${configured.map((n) => `\`${n}\``).join(", ")}` : ""),
    ),
    line("Health", healthLine(a)),
    line(
      "Deployed",
      a.deployment
        ? `${a.deployment.status}${a.deployment.version ? ` from v${a.deployment.version}` : ""}` +
          (a.drift ? ` — behind current v${a.drift.current}` : "")
        : null,
    ),
    // Fenced rather than inlined: a failure message can contain backticks, pipes and newlines, and a
    // block that broke the markdown around it would be one somebody has to clean up by hand.
    a.last_error ? `- **Last error:**\n\n\`\`\`\n${a.last_error.slice(0, ERROR_CAP)}\n\`\`\`` : null,
  ];

  return [`## ${a.name}`, "", ...facts.filter((f): f is string => f !== null)].join("\n");
}

/** The health summary: the word, and the evidence behind it. */
function healthLine(a: AgentCardView): string {
  const settled = a.outcomes.filter((o) => o.outcome === "ok" || o.outcome === "error").length;
  if (settled === 0) return `${a.health} (nothing has run)`;
  const failed = a.outcomes.filter((o) => o.outcome === "error").length;
  return `${a.health} — ${failed} of the last ${settled} runs failed; ${a.runs_7d} run${a.runs_7d === 1 ? "" : "s"} in 7 days`;
}
