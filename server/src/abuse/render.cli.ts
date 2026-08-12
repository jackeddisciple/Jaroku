// Write the edge configuration out of the rule table.
//
//   npm run edge:render          # rewrite deploy/edge/cloudflare-rules.json
//   npm run edge:render -- --check   # fail if it is out of date, for CI
//
// The `--check` mode is the point of committing a generated file at all: it makes "the edge
// configuration in the repository is the one this code describes" a thing a pipeline can answer,
// rather than a thing somebody remembers to do after editing the table.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderEdgeConfigJson } from "./edgeRules.ts";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(SERVER_DIR, "..", "deploy", "edge", "cloudflare-rules.json");

const rendered = renderEdgeConfigJson();
const check = process.argv.includes("--check");

if (check) {
  let onDisk = "";
  try {
    onDisk = readFileSync(OUT, "utf8");
  } catch {
    console.error(`[edge] ${OUT} does not exist. Run: npm run edge:render`);
    process.exit(1);
  }
  if (onDisk !== rendered) {
    console.error(
      `[edge] deploy/edge/cloudflare-rules.json is not what server/src/abuse/edgeRules.ts describes.\n` +
        `       Run: npm run edge:render`,
    );
    process.exit(1);
  }
  console.log("[edge] the committed configuration matches the rule table");
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, rendered);
  console.log(`[edge] wrote ${OUT}`);
}
