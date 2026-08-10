// One thread name, computed in two languages.
//
// The Node side names a thread when it dispatches a branch; the Python side names one when it
// opens a checkpointer. They must agree, and they are separate implementations of one rule — so
// this suite computes the name on both sides and compares, rather than testing the TypeScript
// against itself. A disagreement would surface exactly once, on a branch, as a fork that finds
// no checkpoint at a checkpoint id the server just read out of its own database.
//
//   npm run test:checkpoint-threads

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  CHECKPOINTER_ENV, checkpointThreadId, checkpointerKindFromEnv, runIdFromThread,
  workspaceThreadPrefix,
} from "./threads.ts";

const RUNTIME_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "runtime");

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const WS = randomUUID();
const RUN = randomUUID();

// --- 1. the rule ---------------------------------------------------------------------------
console.log("\nnaming a checkpoint thread");
{
  check(
    checkpointThreadId(WS, RUN, "postgres") === `ws:${WS}:run:${RUN}`,
    "on Postgres the workspace is part of the key, because the table is shared",
  );
  check(
    checkpointThreadId(WS, RUN, "sqlite") === RUN,
    "on SQLite it is the bare run id, because one file per run is already a namespace",
  );
  check(
    checkpointThreadId("", RUN, "postgres") === RUN,
    "a run with no workspace — an exported project — gets the bare form either way",
  );

  check(
    workspaceThreadPrefix(WS) === `ws:${WS}:run:`,
    "a workspace's threads are a prefix, which is what makes the sweep a prefix delete",
  );
  check(
    checkpointThreadId(WS, RUN, "postgres").startsWith(workspaceThreadPrefix(WS)),
    "...and a thread of that workspace matches it",
  );
  check(
    !checkpointThreadId(randomUUID(), RUN, "postgres").startsWith(workspaceThreadPrefix(WS)),
    "...while another workspace's does not",
  );

  check(runIdFromThread(`ws:${WS}:run:${RUN}`) === RUN, "a run id can be recovered from a prefixed thread");
  check(runIdFromThread(RUN) === RUN, "...and from a bare one");
}

// --- 2. the configuration ---------------------------------------------------------------
console.log("\nchoosing a checkpointer");
{
  check(checkpointerKindFromEnv(undefined, {}) === "sqlite", "the default is sqlite, so npm run dev needs no database");
  check(checkpointerKindFromEnv(undefined, { [CHECKPOINTER_ENV]: "postgres" }) === "postgres", "and it can be set");
  let refused = false;
  try {
    checkpointerKindFromEnv(undefined, { [CHECKPOINTER_ENV]: "redis" });
  } catch {
    refused = true;
  }
  check(refused, "an unknown value is refused rather than falling back to checkpoints nobody looks for");
}

// --- 3. the two languages agree -------------------------------------------------------------
console.log("\nthe Python runner computes the same name");
{
  const ask = (kind: string, ws: string): string =>
    execFileSync(
      "python3",
      [
        "-c",
        [
          // Loaded BY PATH rather than as `jaroku_runner.debug`, so importing it does not pull
          // in the package's __init__, which reaches for langchain_core. `debug.py` itself
          // imports nothing outside the standard library at module level — deliberately, so the
          // stdout guard and the control plane load before any generated code does — and that
          // is what makes this check runnable against a bare interpreter.
          "import importlib.util, os, sys",
          "spec = importlib.util.spec_from_file_location('jdebug', os.path.join(os.environ['RT'], 'jaroku_runner', 'debug.py'))",
          "mod = importlib.util.module_from_spec(spec)",
          "spec.loader.exec_module(mod)",
          "print(mod.thread_id_for(sys.argv[1]))",
        ].join("\n"),
        RUN,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, RT: RUNTIME_DIR, [CHECKPOINTER_ENV]: kind, JAROKU_WORKSPACE_ID: ws },
      },
    ).trim();

  // No uv, no virtualenv, no optional extras. A test that needed the hosted extra installed in
  // order to check a string would not run in CI, which is the same as not existing.
  const pgSide = ask("postgres", WS);
  check(
    pgSide === checkpointThreadId(WS, RUN, "postgres"),
    "postgres: both sides produce the same thread id",
    `${pgSide} vs ${checkpointThreadId(WS, RUN, "postgres")}`,
  );

  const sqliteSide = ask("sqlite", WS);
  check(
    sqliteSide === checkpointThreadId(WS, RUN, "sqlite"),
    "sqlite: both sides produce the same thread id",
    `${sqliteSide} vs ${checkpointThreadId(WS, RUN, "sqlite")}`,
  );

  const exported = ask("postgres", "");
  check(exported === RUN, "and an exported project with no workspace gets the bare run id", exported);
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
