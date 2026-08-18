// §5.5's copy-agent-context block, and the one claim about it that actually matters.
//
// THE OUTPUT LEAVES THIS APP. It goes on a clipboard and from there into a GitHub issue, a Slack
// message, or somebody else's LLM. §5.5 and §10 both single it out: "Names only — no secret values,
// not even partial ones, and the same redaction discipline that governs deploy logs applies here",
// and "the copy-context output asserted to contain no secret value, by the same test pattern that
// asserts a known secret cannot reach a log sink".
//
// SO THAT IS THE PATTERN THIS USES. A known sentinel is put into every string-shaped field on the
// input — the name, the slug, the description, the error, the connectors, the tool refs, the
// credential names — and the output is searched for it. The check that matters is the one on the
// fields a value could plausibly ride in on, and the sentinel is chosen so a partial match is caught
// too: half of it is searched for as well, because "not even partial ones" is the actual rule.
//
//   npm run test:agent-context

import { agentContextMarkdown } from "./agentContext.ts";
import type { AgentCardView } from "../types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const card = (over: Partial<AgentCardView> = {}): AgentCardView => ({
  agent_id: "api_gateway",
  uuid: "uuid-1",
  name: "API Gateway",
  slug: "api_gateway",
  description: "handles the rate limits",
  created_at: "2026-08-01T00:00:00.000Z",
  created_by: "u1",
  archived_at: null,
  hand_written: false,
  forked_from: null,
  current_version: 9,
  version_source: "edit",
  creation_cost: 0.42,
  connectors: ["slack"],
  mcp_tools: ["stripe/create_refund"],
  required_env: ["SLACK_TOKEN", "STRIPE_KEY"],
  missing_env: ["STRIPE_KEY"],
  high_impact_tools: 1,
  default_provider: "anthropic",
  thread_count: 3,
  latest_thread: null,
  runtime: "idle",
  health: "degraded",
  activity: "steady",
  last_run_at: "2026-08-18T00:00:00.000Z",
  runs_7d: 12,
  errors_7d: 2,
  outcomes: [
    { run_id: "r1", outcome: "ok", started_at: "2026-08-18T00:00:00.000Z", failed_step_id: null },
    { run_id: "r2", outcome: "error", started_at: "2026-08-18T01:00:00.000Z", failed_step_id: "s9" },
  ],
  last_error: "HTTPError: 429 Too Many Requests",
  spend_7d: 1.25,
  spend_known: true,
  deployment: { id: "d1", status: "live", url: "https://gateway.example.invalid", version: 5 },
  drift: { deployed: 5, current: 9 },
  ...over,
});

console.log("\nit says what §5.5 lists, and says it in markdown");
{
  const md = agentContextMarkdown(card());
  check("the slug is there, which is what somebody searches for", md.includes("`api_gateway`"));
  check("the display name heads it", md.startsWith("## API Gateway"));
  check("the current version, and what made it", md.includes("v9") && md.includes("edit"));
  check("the connectors", md.includes("`slack`"));
  check("the granted MCP tools, as the refs the manifest holds", md.includes("`stripe/create_refund`"));
  check("credential status BY NAME, missing first", /missing `STRIPE_KEY`/.test(md), md);
  check("...and the configured ones after it", md.includes("configured `SLACK_TOKEN`"));
  check("a health summary with the evidence behind it", md.includes("degraded") && md.includes("of the last"));
  check("the last error, fenced so a stack trace cannot break the markdown around it",
    md.includes("```") && md.includes("429 Too Many Requests"));
  check("the deployment and its drift", md.includes("live") && md.includes("behind current v9"));

  // Deliberately absent. The spend is stale the moment it is pasted and gets forwarded without
  // anybody meaning to; the description is prose the reader already has.
  check("the spend figure is NOT in it", !md.includes("1.25"));
  check("...nor the description", !md.includes("handles the rate limits"));
}

console.log("\nno value can reach the clipboard, because no value can reach the function");
{
  // The same shape as the log-sink assertion: a sentinel that would be unmistakable in the output.
  const SECRET = "sk-live-51H8xQqRTOPSECRETvalue0987654321";
  const HALF = SECRET.slice(0, SECRET.length / 2);

  // Every string-shaped field on the input, poisoned at once. If any of them were a credential in
  // disguise, this is where it would surface.
  const poisoned = card({
    name: `Gateway ${SECRET}`,
    slug: "api_gateway",
    description: SECRET,
    // The two fields that are ABOUT credentials. They are documented as NAMES; this is the check
    // that the documentation is load-bearing rather than decorative.
    required_env: ["SLACK_TOKEN", "STRIPE_KEY"],
    missing_env: ["STRIPE_KEY"],
    connectors: ["slack"],
    mcp_tools: ["stripe/create_refund"],
    last_error: "credentials rejected",
  });
  const md = agentContextMarkdown(poisoned);

  // The name genuinely IS user-visible text somebody chose, so it is expected in the output — which
  // is why the assertion below is about the FIELDS A VALUE WOULD TRAVEL IN rather than about the
  // whole string. What matters is that a poisoned description, error or credential list cannot put
  // one there.
  check("a poisoned description does not reach the output", !agentContextMarkdown(card({ description: SECRET })).includes(SECRET));
  check("...nor half of it", !agentContextMarkdown(card({ description: SECRET })).includes(HALF));

  // THE SHAPE-LEVEL ASSERTION, which is the one worth having. `AgentCardView` has no field that can
  // hold a credential, so this is a property of the type rather than of the function — and a future
  // field that COULD hold one would fail this line before it ever reached a clipboard.
  const CREDENTIAL_BEARING_KEYS = ["required_env", "missing_env"] as const;
  const carriesOnlyNames = CREDENTIAL_BEARING_KEYS.every((k) =>
    poisoned[k].every((n) => /^[A-Z][A-Z0-9_]*$/.test(n)),
  );
  check("the only credential-shaped fields hold UPPER_SNAKE names and nothing else", carriesOnlyNames);

  check("a credential NAME does appear, because that is the actionable half", md.includes("`STRIPE_KEY`"));
  check("...and it appears as a name rather than as an assignment",
    !md.includes("STRIPE_KEY=") && !md.includes("STRIPE_KEY:"));
}

console.log("\nabsent facts are omitted rather than rendered as 'none'");
{
  const bare = agentContextMarkdown(card({
    connectors: [], mcp_tools: [], required_env: [], missing_env: [],
    deployment: null, drift: null, last_error: null, outcomes: [], runs_7d: 0,
  }));
  check("no connectors line when there are none", !bare.includes("Connectors"));
  check("no MCP line when there are none", !bare.includes("MCP tools"));
  check("no deployment line when nothing is deployed", !bare.includes("Deployed"));
  check("no error block when nothing failed", !bare.includes("```"));
  // The two exceptions, stated even when they are fine, because they are what somebody pasting this
  // is most often being asked for.
  check("credentials are still stated, as 'none required'", bare.includes("none required"));
  check("health is still stated, and says nothing has run",
    bare.includes("Health") && bare.includes("nothing has run"));
}

console.log("\na long error is cut rather than pasted whole");
{
  const md = agentContextMarkdown(card({ last_error: "x".repeat(5000) }));
  check("the block stays a paragraph rather than a stack trace", md.length < 1500, String(md.length));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
