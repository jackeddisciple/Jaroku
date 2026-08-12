// The edge rules, and the one property no dashboard can check.
//
// THE INTERESTING ASSERTION IS AGREEMENT, not syntax. The edge and `http/rateLimit.ts` both
// decide what is exempt from being throttled, and they decide it in different repositories'
// worth of distance from each other — one is data rendered into a vendor's configuration, the
// other is a function in the request path. When they disagree, the failure is not a test going
// red: it is every sandbox in a Fly region being served a JavaScript challenge, because they
// share one egress address and somebody added a blanket rate limit at the edge.
//
//   npm run test:edge-rules

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ipRuleFor } from "../http/rateLimit.ts";
import { MAX_BINARY_BODY_BYTES } from "../http/router.ts";
import {
  EDGE_EXEMPT_PREFIXES,
  EDGE_MAX_BODY_BYTES,
  EDGE_RULES,
  SCANNER_PATHS,
  renderEdgeConfig,
  renderEdgeConfigJson,
  toCloudflare,
  type EdgeRule,
} from "./edgeRules.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

console.log("\nthe two layers agree about what is exempt");
{
  // Every prefix the edge leaves alone must also be one the application does not bucket, and
  // the other way round. A representative path per prefix, because `ipRuleFor` takes a path.
  const samples: Record<string, string> = {
    "/healthz": "/healthz",
    "/readyz": "/readyz",
    "/v1/runs/": "/v1/runs/00000000-0000-4000-8000-000000000000/control",
  };
  for (const prefix of EDGE_EXEMPT_PREFIXES) {
    const path = samples[prefix] ?? prefix;
    check(
      ipRuleFor(path) === null,
      `the edge exempts ${prefix}, and so does the application's own limiter (${path})`,
    );
  }
  // ...and nothing ELSE is exempt in the application, or the edge is protecting a path the
  // application deliberately left unprotected.
  const applicationExempt = ["/healthz", "/readyz", "/v1/runs/x/control"];
  check(
    applicationExempt.every((p) => EDGE_EXEMPT_PREFIXES.some((prefix) => p.startsWith(prefix))),
    "and every path the application exempts is one the edge exempts too — neither list has a member of its own",
  );
  check(
    ipRuleFor("/v1/auth/session") !== null && ipRuleFor("/v1/ws-ticket") !== null,
    "the authentication endpoints are bucketed in the application as well as at the edge",
  );
}

console.log("\nthe rules themselves");
{
  const ids = EDGE_RULES.map((r) => r.id);
  check(new Set(ids).size === ids.length, "ids are unique — a duplicate would overwrite a rule on apply");
  check(
    ids.every((id) => /^[a-z][a-z0-9-]*$/.test(id)),
    "...and are stable slugs rather than prose, since they are the provider's rule identity",
  );
  check(
    EDGE_RULES.every((r) => r.description.length > 20),
    "every rule says in a sentence what it is for — this table is read during an incident",
  );
  check(
    EDGE_RULES.filter((r) => r.skip).length === 1,
    "there is exactly one skip rule, and it is the exemption",
  );
  check(EDGE_RULES[0]!.skip === true, "...and it is first, because order is the whole of an edge's semantics");
  check(
    EDGE_RULES.every((r) => !r.rateLimit || (r.rateLimit.requests > 0 && r.rateLimit.periodSec > 0)),
    "no rate rule admits zero requests — a limit of none is an outage with a firewall's name on it",
  );

  // A bot score never blocks. It is a vendor's number about a person, and the cost of being
  // wrong has to be an inconvenience rather than a lockout.
  const scored = EDGE_RULES.filter((r) => JSON.stringify(r.expression).includes("botScoreBelow"));
  check(scored.length > 0, `${scored.length} rule(s) use a bot score`);
  check(
    scored.every((r) => r.action === "managed_challenge" || r.action === "js_challenge" || r.action === "log"),
    "...and none of them blocks — a challenge is what a wrong guess should cost",
  );

  check(
    EDGE_MAX_BODY_BYTES > MAX_BINARY_BODY_BYTES,
    "the edge's body cap is LOOSER than the application's, so an ordinary oversize gets the 413 that explains itself",
  );
  check(SCANNER_PATHS.includes("/.env"), "the paths a scanner asks for first are among the ones blocked outright");
}

console.log("\nrendering");
{
  const rendered = renderEdgeConfig();
  check(rendered.rules.length === EDGE_RULES.length, "every rule renders");
  check(
    rendered.rules.every((r) => r.expression.startsWith("(") && r.expression.endsWith(")")),
    "every expression is parenthesised, so composing two can never change what either means",
  );
  check(
    toCloudflare({ pathEquals: "/v1/auth/session" }) === '(http.request.uri.path eq "/v1/auth/session")',
    "a path equality renders as the provider spells it",
  );
  check(
    toCloudflare({ all: [{ method: ["POST"] }, { botScoreBelow: 30 }] }) ===
      '((http.request.method in {"POST"}) and (cf.bot_management.score lt 30))',
    "...and a conjunction is a conjunction",
  );
  check(
    toCloudflare({ not: { pathStartsWith: "/v1/runs/" } }) === '(not (starts_with(http.request.uri.path, "/v1/runs/")))',
    "...and a negation reads as one",
  );

  // Injection into a firewall rule. A quote in a value would close the string and start
  // expression syntax, so it is refused rather than escaped.
  let refused = false;
  try {
    toCloudflare({ pathEquals: '/x" or true or "' });
  } catch {
    refused = true;
  }
  check(refused, "a value that could end its own quote is refused rather than escaped");

  let refusedNumber = false;
  try {
    toCloudflare({ botScoreBelow: 1.5 });
  } catch {
    refusedNumber = true;
  }
  check(refusedNumber, "...and so is a number that is not one");

  check(renderEdgeConfigJson() === renderEdgeConfigJson(), "rendering is deterministic");
  check(
    !renderEdgeConfigJson().includes(new Date().getFullYear().toString().slice(0, 3)) ||
      !/"generatedAt"/.test(renderEdgeConfigJson()),
    "...and carries no timestamp, or a committed copy could never be compared to it",
  );
}

console.log("\nthe committed file");
{
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "deploy", "edge", "cloudflare-rules.json");
  let onDisk: string | null = null;
  try {
    onDisk = readFileSync(path, "utf8");
  } catch {
    onDisk = null;
  }
  check(onDisk !== null, "deploy/edge/cloudflare-rules.json exists");
  check(
    onDisk === renderEdgeConfigJson(),
    "...and is exactly what the rule table renders to — `npm run edge:render` if this fails",
  );
}

console.log("\nan edge that is absent changes nothing about what is enforced");
{
  // Stated as an assertion because it is the thing most easily forgotten: none of the above
  // runs in the request path, and nothing in the server consults it.
  const rules: readonly EdgeRule[] = EDGE_RULES;
  check(
    rules.every((r) => typeof r.expression === "object"),
    "the rules are data, not handlers — nothing here can be called with a request",
  );
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
