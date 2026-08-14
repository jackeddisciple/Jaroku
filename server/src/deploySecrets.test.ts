// The secrets discipline, asserted rather than intended.
//
// Everything else in the deploy layer can be wrong and be fixed. A credential that reaches a
// build log, a database row, or a browser cannot be un-sent — it has to be rotated, and the
// user has to be told. So the tests here are almost all negative: not "does the right value
// arrive" but "can a value get anywhere it must not".
//
//   npm run test:deploy-secrets

import {
  hostEnv, makeScrubber, missingSecrets, REDACTION, requiredSecrets, resolveSecretValues,
  scrubSecrets,
} from "./deploySecrets.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// Values that look like the real thing, so a leak is unmistakable in a diff.
const ANTHROPIC = "sk-ant-api03-NOTAREALKEY-000000000000";
const DB_URL = "postgres://appuser:hunter2hunter2@db.internal:5432/orders";
const MCP_TOKEN = "mcp_tok_9f3ac1d0e5b74821";
const ALL_SECRETS = [ANTHROPIC, DB_URL, MCP_TOKEN];

const withEnv = <T>(vars: Record<string, string | undefined>, fn: () => T): T => {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

// --- 1. what the browser is told is names, and only names -------------------------------
{
  withEnv(
    {
      ANTHROPIC_API_KEY: ANTHROPIC,
      DATABASE_URL: DB_URL,
      SLACK_BOT_TOKEN: undefined,
      JAROKU_MCP_MOCK_TOKEN: MCP_TOKEN,
    },
    () => {
      const status = requiredSecrets({
        requiredEnv: ["DATABASE_URL", "SLACK_BOT_TOKEN"],
        mcpServers: ["mock"],
        provider: "anthropic",
      });
      const serialised = JSON.stringify(status);

      // THE test in this file. Everything else is a way of making this one hard to break.
      const leaked = ALL_SECRETS.filter((s) => serialised.includes(s));
      check("no secret value appears in what the client receives",
        leaked.length === 0, leaked.join(","));

      check("every entry carries a name and a configured flag",
        status.every((s) => typeof s.name === "string" && typeof s.configured === "boolean"));
      check("configured reflects the environment, both ways",
        status.find((s) => s.name === "DATABASE_URL")?.configured === true
          && status.find((s) => s.name === "SLACK_BOT_TOKEN")?.configured === false);
      check("an entry has no field beyond name/configured/reason/required",
        status.every((s) => Object.keys(s).sort().join(",") === "configured,name,reason,required"));

      check("the provider key is required first — without it every request 500s",
        status[0]?.name === "ANTHROPIC_API_KEY" && status[0]?.required === true);
      check("a connector credential is required",
        status.find((s) => s.name === "DATABASE_URL")?.required === true);
      check("an MCP token is optional — plenty of servers need none",
        status.find((s) => s.name === "JAROKU_MCP_MOCK_TOKEN")?.required === false);
      check("every entry explains itself, so a list of names reads as something",
        status.every((s) => s.reason.length > 0));
    },
  );
}

// --- 1b. a workspace's credentials, not this process's --------------------------------
//
// THE DIVERGENCE THE SECRETS TAB MADE VISIBLE. `configured` was `Boolean(process.env[name])`,
// which on the local path is exactly right — the local store IS the process environment — and
// hosted asks a different question from the one that decides a deploy: whether the SERVER holds a
// variable, rather than whether this WORKSPACE holds the credential. It is wrong in both
// directions, and the second is the worse one.
{
  withEnv({ ANTHROPIC_API_KEY: ANTHROPIC, DATABASE_URL: undefined }, () => {
    const vaultNames = new Set(["DATABASE_URL"]);
    const status = requiredSecrets({
      requiredEnv: ["DATABASE_URL"],
      provider: "anthropic",
      configuredNames: vaultNames,
    });

    check("a credential in the workspace's vault reads as configured, though this process has no such variable",
      status.find((s) => s.name === "DATABASE_URL")?.configured === true);

    // The direction that actually leaks a decision across a tenant boundary: the PLATFORM's own
    // Anthropic key is in this process's environment, and reading it would tell every workspace on
    // the box that it has a provider key configured when it has not.
    check("and the platform's own key in the environment does NOT read as this workspace's",
      status.find((s) => s.name === "ANTHROPIC_API_KEY")?.configured === false);

    check("while with no names supplied it still falls back to the environment, for the local path",
      requiredSecrets({ requiredEnv: [], provider: "anthropic" })
        .find((s) => s.name === "ANTHROPIC_API_KEY")?.configured === true);
  });
}

// --- 2. the name list is right --------------------------------------------------------
{
  withEnv({ OPENAI_API_KEY: "sk-openai", ANTHROPIC_API_KEY: undefined }, () => {
    const names = (input: Parameters<typeof requiredSecrets>[0]): string[] =>
      requiredSecrets(input).map((s) => s.name);

    check("the provider key follows the provider the agent will run on",
      names({ requiredEnv: [], provider: "openai" }).includes("OPENAI_API_KEY")
        && !names({ requiredEnv: [], provider: "openai" }).includes("ANTHROPIC_API_KEY"));

    // serve.py refuses to start on the dry-run provider; this just declines to invent a
    // variable name on the way to that refusal.
    check("an unknown provider contributes no key name",
      names({ requiredEnv: ["DATABASE_URL"], provider: "fake" }).join(",") === "DATABASE_URL");

    check("duplicates collapse",
      names({ requiredEnv: ["DATABASE_URL", "DATABASE_URL"], provider: "openai" })
        .filter((n) => n === "DATABASE_URL").length === 1);

    check("MCP token names are derived, not guessed",
      names({ requiredEnv: [], mcpServers: ["github"], provider: "openai" })
        .includes("JAROKU_MCP_GITHUB_TOKEN"));

    // A JAROKU_* variable in required_env is a host knob, not a user credential. Offering to
    // copy this machine's value for one would hand a container a local path or a local port.
    check("JAROKU_* variables are never offered as credentials to copy",
      !names({ requiredEnv: ["JAROKU_CONTROL_DIR", "JAROKU_MCP_CONFIRM"], provider: "openai" })
        .some((n) => n.startsWith("JAROKU_")));
  });
}

// --- 3. values are read at the moment of use, and nowhere else ---------------------------
{
  withEnv({ ANTHROPIC_API_KEY: ANTHROPIC, DATABASE_URL: DB_URL, EMPTY_ONE: "" }, () => {
    const values = resolveSecretValues(["ANTHROPIC_API_KEY", "DATABASE_URL", "ABSENT", "EMPTY_ONE"]);
    check("the values that exist are resolved", values.get("ANTHROPIC_API_KEY") === ANTHROPIC);
    check("an absent name is skipped, not sent as undefined", !values.has("ABSENT"));

    // An empty variable on a host shadows nothing but still renders as "configured" in its
    // dashboard — which is a lie the user then has to debug.
    check("an empty value is skipped rather than sent as an empty string", !values.has("EMPTY_ONE"));

    check("missingSecrets names exactly what this machine cannot supply",
      missingSecrets(["ANTHROPIC_API_KEY", "ABSENT"]).join(",") === "ABSENT");
  });
}

// --- 4. what the deploy sets itself is not a credential ----------------------------------
{
  const { env, secret } = hostEnv({
    provider: "anthropic", model: "claude-haiku-4-5", serveToken: "tok-abcdefgh",
  });
  check("the deploy sets the provider and model it was told",
    env["JAROKU_PROVIDER"] === "anthropic" && env["JAROKU_MODEL"] === "claude-haiku-4-5");

  // Without this the MCP bridge proceeds unconfirmed in an unattended container, and its
  // module-level run grant leaks across every later request for the life of the process.
  check("high-impact MCP calls fail closed on the host",
    env["JAROKU_MCP_CONFIRM"] === "require");

  check("the serve token is passed when there is one", env["JAROKU_SERVE_TOKEN"] === "tok-abcdefgh");
  const publicEnv = hostEnv({ provider: "openai", model: "m", serveToken: null });
  check("...and omitted entirely when the endpoint is deliberately public",
    !("JAROKU_SERVE_TOKEN" in publicEnv.env));

  // Which host values are credentials is declared here, not inferred by the caller. The
  // caller inferred "all of them" and redacted the provider name out of every build log.
  check("only the serve token is marked secret",
    secret.length === 1 && secret[0] === "tok-abcdefgh", secret.join(","));
  check("the provider and model are NOT secret",
    !secret.includes("anthropic") && !secret.includes("claude-haiku-4-5"));
  check("a public endpoint has no host secret at all", publicEnv.secret.length === 0);

  // The regression itself, end to end: a build log line naming the provider must survive.
  const scrubbed = makeScrubber([...secret, "sk-ant-REAL-SECRET-000"])(
    "RUN uv pip install langchain-anthropic>=0.3.0 with sk-ant-REAL-SECRET-000",
  );
  check("a build line naming the provider is left readable",
    scrubbed.includes("langchain-anthropic>=0.3.0"), scrubbed);
  check("...while the credential beside it still goes",
    !scrubbed.includes("sk-ant-REAL-SECRET-000"), scrubbed);
}

// --- 5. the scrubber catches what a build log could echo ----------------------------------
{
  const scrub = makeScrubber(ALL_SECRETS);

  check("a secret in a log line is replaced",
    scrub(`connecting to ${DB_URL}`) === `connecting to ${REDACTION}`);
  check("...wherever it appears in the line",
    !scrub(`${ANTHROPIC} at the front`).includes(ANTHROPIC));
  check("...and every occurrence, not just the first",
    scrub(`${MCP_TOKEN} and again ${MCP_TOKEN}`).split(REDACTION).length === 3);
  check("several different secrets in one line all go",
    ALL_SECRETS.every((s) => !scrub(`${ANTHROPIC} ${DB_URL} ${MCP_TOKEN}`).includes(s)));
  check("a line with no secret is returned unchanged",
    scrub("Step 4/9 : RUN uv pip install") === "Step 4/9 : RUN uv pip install");

  // A credential is arbitrary text. Building a RegExp out of one is how a scrubber silently
  // stops matching the exact value it exists to catch.
  const metachars = "pw+[a-z].*$^(){}|?";
  const meta = makeScrubber([metachars]);
  check("a value full of regex metacharacters is matched literally",
    meta(`token=${metachars} end`) === `token=${REDACTION} end`);
  check("...and does not match what the pattern would have",
    meta("pwXXXXXXXXX end") === "pwXXXXXXXXX end");

  // A log full of holes tells an observer more about a short value than its absence hides.
  const short = makeScrubber(["abc", "PORT"]);
  check("values under the length floor are left alone",
    short("abc PORT /usr/lib/abc") === "abc PORT /usr/lib/abc");

  // If one secret contains another, replacing the shorter first would leave the longer one's
  // tail in the log — a partial credential is still a credential.
  const nested = makeScrubber(["hunter2hunter2", DB_URL]);
  const nestedOut = nested(`url=${DB_URL}`);
  check("a secret containing another is replaced whole",
    !nestedOut.includes("hunter2hunter2") && !nestedOut.includes("db.internal"), nestedOut);

  check("an empty secret set is a no-op rather than a mangled line",
    makeScrubber([])("nothing to hide") === "nothing to hide");
  check("scrubSecrets is the same rule in one shot",
    scrubSecrets(`k=${ANTHROPIC}`, ALL_SECRETS) === `k=${REDACTION}`);
}

// --- 6. the shapes that cross a wire cannot carry a value ---------------------------------
{
  // A structural check rather than a behavioural one: if someone later adds a value-bearing
  // field to DeploySecretStatus, this is what notices. Every string field is inspected, so
  // the assertion does not depend on knowing the field names.
  withEnv({ ANTHROPIC_API_KEY: ANTHROPIC, DATABASE_URL: DB_URL }, () => {
    const status = requiredSecrets({
      requiredEnv: ["DATABASE_URL"], mcpServers: ["mock"], provider: "anthropic",
    });
    const strings = status.flatMap((s) => Object.values(s).filter((v) => typeof v === "string"));
    check("no field of any status entry contains a value from the environment",
      !strings.some((v) => ALL_SECRETS.some((secret) => v.includes(secret))));

    // The map is the one structure that legitimately holds values. It exists so that the
    // request body and the scrubber can be built from the same read — nothing else takes it.
    const values = resolveSecretValues(status.map((s) => s.name));
    check("only the resolver's own map carries values",
      values.get("DATABASE_URL") === DB_URL
        && !JSON.stringify([...values.keys()]).includes(DB_URL));
  });
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
