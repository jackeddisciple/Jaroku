// Which mark a tool file gets, which is a table of regexes and is therefore an ordering.
//
// THIS MAPPER RUNS ON EVERY TOOL PATH, not only on the six connectors — the graph draws a resource
// circle for each of an agent's tools, and most of an agent's tools are bespoke files a model
// named. So the inputs are not a fixed list somebody reviewed: they are `mail_to_calendar.py`,
// `stripe_refund_check.py`, `api_client.py`, written by a model that was thinking about the task
// rather than about this table.
//
// WHICH MAKES THE ORDER LOAD-BEARING AND INVISIBLE. Every rule here looks obviously right on its
// own and the file passes a typecheck in any order. What a wrong order produces is a Gmail
// envelope on the calendar-sync tool of a workspace that connected both — not a crash, not a blank
// square, just the wrong logo on a canvas nobody reads closely enough to doubt. §4's own rule for
// the action registry applies here for the same reason: one table, extended, rather than a second
// one beside it.
//
// AND THE THREE v0.3.6 CONNECTORS ARE THE FIRST ADDITIONS THAT COLLIDE. `stripe` and `http` are
// distinct enough; `google_calendar` sits directly under a rule matching `mail`, and the pair of
// them is exactly the pair a scheduling agent has.
//
//   npm run test:graph-icons

import { modelResource, toolResource } from "./graphIcons.tsx";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("\nevery reviewed connector's own template draws its own mark");
for (const [path, label] of [
  ["tools/gmail.py", "Gmail"],
  ["tools/google_calendar.py", "Google Calendar"],
  ["tools/slack.py", "Slack"],
  ["tools/stripe_connector.py", "Stripe"],
  ["tools/postgres.py", "Postgres"],
  ["tools/http_connector.py", "HTTP"],
  ["tools/mcp_bridge.py", "MCP"],
] as const) {
  const resource = toolResource(path);
  check(`${path} -> ${label}`, resource.label === label, resource.label);
  check(`...and has a mark to draw`, typeof resource.Icon === "function");
}

console.log("\nand the ordering holds for the names a model actually writes");
{
  // THE CASE THE ORDER EXISTS FOR. Both of these contain `mail` and both belong to Calendar; under
  // the mail rule they would draw the Gmail envelope, on a canvas describing an agent that has
  // both connectors and where telling them apart is the entire point of the icon.
  check("gmail_calendar_sync is Calendar, not Gmail", toolResource("tools/gmail_calendar_sync.py").label === "Google Calendar");
  check("mail_to_calendar is Calendar, not Gmail", toolResource("tools/mail_to_calendar.py").label === "Google Calendar");
  check("...while a tool that is only about mail is still Gmail", toolResource("tools/mail_digest.py").label === "Gmail");

  // Provenance outranks resemblance, which is the rule the MCP entry is first for.
  check("mcp_bridge is MCP even though a server could be named for mail", toolResource("tools/mcp_bridge.py").label === "MCP");

  // `api` is in the HTTP rule, so anything whose name merely mentions an API must not outrank a
  // connector that names itself.
  check("stripe_api_client is Stripe, not HTTP", toolResource("tools/stripe_api_client.py").label === "Stripe");
  check("calendar_api is Calendar, not HTTP", toolResource("tools/calendar_api.py").label === "Google Calendar");
  check("...and a bare api_client is HTTP, which is the honest answer", toolResource("tools/api_client.py").label === "HTTP");
}

console.log("\na tool nothing recognises gets a readable label rather than a path");
{
  check("underscores become spaces and words are capitalised", toolResource("tools/order_lookup.py").label === "Order Lookup");
  check("...and it still has a mark", typeof toolResource("tools/order_lookup.py").Icon === "function");
  check("a bare filename works as well as a path", toolResource("statistics.py").label === "Statistics");
}

console.log("\nand the model circle is unchanged by any of this");
{
  check("anthropic", modelResource("anthropic", "claude-sonnet-4").label === "claude-sonnet-4");
  check("openai", modelResource("openai", "gpt-4o").label === "gpt-4o");
  check("the dry-run provider names itself rather than guessing", modelResource("fake").label === "Dry-run");
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
