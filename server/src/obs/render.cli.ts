// Write the alerting rules and SLOs out of the tables in obs/slo.ts.
//
//   npm run obs:render            # rewrite deploy/observability/alerts.json
//   npm run obs:render -- --check # fail if it is out of date, for the pipeline
//
// The same `--check` discipline the edge rules have, and for the same reason: a generated file
// in the repository is only worth having if something asserts it is the generated one.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderObservabilityJson } from "./slo.ts";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(SERVER_DIR, "..", "deploy", "observability", "alerts.json");

const rendered = renderObservabilityJson();

if (process.argv.includes("--check")) {
  let onDisk = "";
  try {
    onDisk = readFileSync(OUT, "utf8");
  } catch {
    console.error(`[obs] ${OUT} does not exist. Run: npm run obs:render`);
    process.exit(1);
  }
  if (onDisk !== rendered) {
    console.error("[obs] deploy/observability/alerts.json is not what server/src/obs/slo.ts describes. Run: npm run obs:render");
    process.exit(1);
  }
  console.log("[obs] the committed alerting rules match the SLO table");
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, rendered);
  console.log(`[obs] wrote ${OUT}`);
}
