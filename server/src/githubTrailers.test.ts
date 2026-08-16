// A commit's receipt, with no repository and no database anywhere.
//
// Four properties this suite exists to hold, and each one is a specific way a trailer can lie:
//
//   AN UNKNOWN FIELD IS AN ABSENT LINE, NEVER A ZERO OR AN EMPTY STRING. `Jaroku-Cost: $0.0000` on
//   a version nothing priced is a claim that it was free, which is the exact laundering v0.1.9's
//   null-not-zero rule exists to prevent — and the failure is invisible, because the line looks
//   like every other line.
//
//   A REAL ZERO STILL RENDERS. The mirror of the above, and the reason the check is `typeof
//   === "number"` rather than a truthiness test: a version whose calls were all cache reads
//   genuinely cost nothing, and omitting its line would say "unknown" about something known.
//
//   A SQUASH UNDER-CLAIMS RATHER THAN OVER-CLAIMS. Gates are intersected and a single unpriced
//   version nulls the whole total, because a receipt for one commit must be true of the whole
//   commit and not of its most flattering part.
//
//   THE VERSION LINE SURVIVES EVERYTHING. `githubService.remoteOnlyCommits` identifies Jaroku's own
//   commits by `/^Jaroku-Versions?:/m` and §3.8's hollow dots are computed from that answer — so a
//   message that lost it comes back on the next fetch as somebody else's work and gets counted
//   among what a force push is about to destroy.
//
//   npm run test:github-trailers

import type { AgentVersion } from "./db/repositories/agents.ts";
import {
  gatesFor, squashTrailerLines, trailerLines, withTrailerBlock,
} from "./githubTrailers.ts";
import { messageFor, squashMessageFor, withVersionTrailer } from "./githubPush.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

function version(n: number, patch: Partial<AgentVersion> = {}): AgentVersion {
  return {
    id: `ver-${n}`,
    agent_id: "agent-1",
    version: n,
    manifest: {},
    source: "edit",
    instruction: null,
    summary: null,
    file_stats: [],
    total_bytes: 0,
    undone_at: null,
    created_at: new Date(n * 1000).toISOString(),
    ...patch,
  };
}

/** The value of one trailer key in a block, or undefined when the key is absent. */
function trailer(text: string, key: string): string | undefined {
  const line = text.split("\n").find((l) => l.trim().startsWith(`${key}:`));
  return line?.slice(line.indexOf(":") + 1).trim();
}

console.log("\nwhich gates a version's source implies");
{
  check(gatesFor(version(1, { source: "generation" })).join(",") === "parse,import,contract",
    "a generation cleared all three, because it could not exist otherwise");
  check(gatesFor(version(1, { source: "edit" })).join(",") === "parse,import,contract",
    "an edit did too, for the same reason");
  check(gatesFor(version(1, { source: "import" })).length === 0,
    "a bare import claims nothing — nobody validated bytes somebody put on disk");
  check(gatesFor(version(1, { source: "deploy" })).length === 0,
    "a deploy version is artifact synthesis, which never met the validator");
}

console.log("\na pulled version cleared the same gates, and the event log is what says so");
{
  // §3.6 holds a pull to the identical bar as generated code, but the runner publishes it as
  // `import` — so the source alone cannot tell a validated pull from a disk import, and this
  // under-claimed on every pulled version until the runner started resolving the set.
  const pulled = version(9, { source: "import", id: "ver-pulled" });
  check(gatesFor(pulled, new Set(["ver-pulled"])).join(",") === "parse,import,contract",
    "an import a validated pull produced claims all three");
  check(gatesFor(pulled).length === 0,
    "…and the same version claims nothing without the set — under-claiming, which is the safe direction");
  check(gatesFor(version(9, { source: "import", id: "ver-disk" }), new Set(["ver-pulled"])).length === 0,
    "a DIFFERENT import is unaffected by some other version having been pulled");

  // The distinction `agent_versions.source` could never have drawn, and the reason the event log is
  // a better answer than widening that enum: a `force_override` pull is precisely the one that
  // FAILED the validator and was published anyway. The runner puts only `outcome: "ok"` pulls in
  // the set, so an override arrives here as an id that is simply not in it.
  check(gatesFor(pulled, new Set()).length === 0,
    "an empty set is an import with no validated pull behind it — which is what an override looks like");

  const block = trailerLines(pulled, { agentSlug: "a", validatedByPull: new Set(["ver-pulled"]) }).join("\n");
  check(trailer(block, "Jaroku-Validated") === "parse,import,contract",
    "and the trailer carries it, which is the whole point", trailer(block, "Jaroku-Validated"));
}

console.log("\nan absent field is an absent line");
{
  const bare = trailerLines(version(14, { source: "import" }));
  check(bare.length === 1 && bare[0] === "Jaroku-Version: v14",
    "nothing known but the version leaves exactly one line", bare.join(" | "));

  const full = trailerLines(version(14, { source: "edit" }), {
    agentSlug: "weather-agent",
    model: "claude-haiku-4-5",
    costUsd: 0.0031,
  }).join("\n");
  check(trailer(full, "Jaroku-Agent") === "weather-agent", "the agent is named when it is known");
  check(trailer(full, "Jaroku-Model") === "claude-haiku-4-5", "so is the model");
  check(trailer(full, "Jaroku-Validated") === "parse,import,contract", "and the gates its source implies");
  check(trailer(full, "Jaroku-Cost") === "$0.0031", "money renders at four places, as the panel does");

  // The one the spec calls out by name: omitted, not zeroed, for a version generated before cost
  // accounting existed or run on the free dry-run provider.
  const unpriced = trailerLines(version(14), { agentSlug: "a", costUsd: null }).join("\n");
  check(trailer(unpriced, "Jaroku-Cost") === undefined, "an unpriced version has NO cost line");
  const missing = trailerLines(version(14), { agentSlug: "a" }).join("\n");
  check(trailer(missing, "Jaroku-Cost") === undefined, "and neither does one nobody asked about");

  // The mirror. A truthiness test here would omit exactly the case where zero is the true answer.
  const free = trailerLines(version(14), { costUsd: 0 }).join("\n");
  check(trailer(free, "Jaroku-Cost") === "$0.0000", "a genuine zero still renders — it is a known answer");

  const blank = trailerLines(version(14), { agentSlug: "   ", model: "" }).join("\n");
  check(trailer(blank, "Jaroku-Agent") === undefined && trailer(blank, "Jaroku-Model") === undefined,
    "whitespace is not a value");
}

console.log("\ngates are ordered by the validator's own order, not by arrival");
{
  const out = trailerLines(version(1), { gates: ["secret-scan", "contract", "parse"] }).join("\n");
  check(trailer(out, "Jaroku-Validated") === "parse,contract,secret-scan",
    "so two commits that cleared the same gates read identically", trailer(out, "Jaroku-Validated"));
  const none = trailerLines(version(1), { gates: [] }).join("\n");
  check(trailer(none, "Jaroku-Validated") === undefined, "an empty list omits the line rather than printing nothing after a colon");
}

console.log("\na squash is true of the whole commit or it does not say it");
{
  const run = [version(11, { source: "generation" }), version(12), version(13)];
  const lines = squashTrailerLines(run, { agentSlug: "weather-agent" }).join("\n");
  check(lines.split("\n")[0] === "Jaroku-Versions: 11-13", "the range form leads, as §2.3 has written it since the base spec");
  check(trailer(lines, "Jaroku-Validated") === "parse,import,contract", "three versions that all cleared the same gates keep them");

  const mixed = squashTrailerLines([version(11, { source: "import" }), version(12)]).join("\n");
  check(trailer(mixed, "Jaroku-Validated") === undefined,
    "one unvalidated version in the run and the commit claims nothing — intersection, not union");

  const priced = squashTrailerLines(run, { costs: [0.001, 0.002, 0.0005] }).join("\n");
  check(trailer(priced, "Jaroku-Cost") === "$0.0035", "fully priced versions sum");
  const partial = squashTrailerLines(run, { costs: [0.001, null, 0.0005] }).join("\n");
  check(trailer(partial, "Jaroku-Cost") === undefined,
    "one unpriced version nulls the total rather than understating it exactly");
  const short = squashTrailerLines(run, { costs: [0.001] }).join("\n");
  check(trailer(short, "Jaroku-Cost") === undefined, "a cost list that does not cover the run is not a total");

  const single = squashTrailerLines([version(7)]).join("\n");
  check(single.split("\n")[0] === "Jaroku-Version: v7", "one version squashed is still singular");
  check(squashTrailerLines([]).length === 0, "an empty run has no trailer to write");
}

console.log("\nattaching a block to a message that may already carry one");
{
  const out = withTrailerBlock("Add retry on tool failure\n\nWraps the call.", ["Jaroku-Version: v14"]);
  check(out === "Add retry on tool failure\n\nWraps the call.\n\nJaroku-Version: v14",
    "one blank line separates the body from the block", JSON.stringify(out));

  // The change from what this did before §B.8.1. Skipping was right when the trailer was one line
  // naming a version; it is wrong now that the block carries a model, a gate list and a cost that
  // belong to a DIFFERENT commit.
  const pasted = withTrailerBlock(
    "Pasted out of git log\n\nJaroku-Version: v9\nJaroku-Cost: $9.9999",
    ["Jaroku-Version: v14", "Jaroku-Cost: $0.0031"],
  );
  check(!pasted.includes("v9") && !pasted.includes("$9.9999"),
    "another commit's receipt is stripped rather than kept beside the new one", pasted);
  check((pasted.match(/Jaroku-Version:/g) ?? []).length === 1, "and there is exactly one of each key");

  // Prose is the user's. Only a line that IS a trailer is stripped.
  const prose = withTrailerBlock("See Jaroku-Version: v9 in the old commit", ["Jaroku-Version: v14"]);
  check(prose.startsWith("See Jaroku-Version: v9 in the old commit"),
    "a sentence that mentions a trailer mid-line is not a trailer");

  check(withTrailerBlock("   ", ["Jaroku-Version: v3"]) === "Jaroku-Version: v3",
    "an empty message is the block alone, with no leading blank lines");
  check(withTrailerBlock("Body\n\n\n", ["Jaroku-Version: v3"]) === "Body\n\nJaroku-Version: v3",
    "trailing blank lines are not a second separator");
}

console.log("\nthe messages a push actually writes");
{
  const v = version(14, {
    source: "edit",
    instruction: "Add retry on tool failure",
    summary: "Wraps the weather tool call in a bounded retry with backoff.",
  });
  const msg = messageFor(v, { agentSlug: "weather-agent", model: "claude-haiku-4-5", costUsd: 0.0031 });
  check(msg.split("\n")[0] === "Add retry on tool failure", "the subject is untouched by any of this");
  check(msg.includes("\nWraps the weather tool call"), "and so is the body");
  check(/^Jaroku-Versions?:/m.test(msg), "the version line is there, so remoteOnlyCommits still finds it");
  check(trailer(msg, "Jaroku-Agent") === "weather-agent" && trailer(msg, "Jaroku-Cost") === "$0.0031",
    "with the rest of the block under it");

  const squashed = squashMessageFor([version(11), version(12)], { agentSlug: "weather-agent" });
  check(/^Jaroku-Versions:/m.test(squashed), "a squash keeps the plural form");
  check(squashed.includes("- v11 ") && squashed.includes("- v12 "), "and still lists what went in");

  const typed = withVersionTrailer("One meaningful sentence", [version(11), version(13)], {
    agentSlug: "weather-agent",
  });
  check(typed.startsWith("One meaningful sentence"), "a typed message keeps its own words");
  check(trailer(typed, "Jaroku-Agent") === "weather-agent", "and gains the receipt it cannot be allowed to drop");
  check(withVersionTrailer("Anything", []) === "Anything", "with no versions there is nothing to attest to");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
