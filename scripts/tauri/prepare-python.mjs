// Stage the Python side of the bundle: uv itself, a standalone interpreter, and the wheels for
// everything `runtime/uv.lock` pins.
//
// THE GOAL IS THAT A USER INSTALLS NOTHING. Jaroku runs agents by spawning `uv run python -m
// jaroku_runner <agent>` — see server/src/processManager.ts, which is the same line `npm run dev`
// has always run — and today that sentence assumes a machine with uv on its PATH, a Python that
// satisfies `requires-python = ">=3.12"`, and either a warm `runtime/.venv` or a network
// connection. A desktop application may assume none of those.
//
// WHAT IS STAGED, AND WHY IT IS NOT A PRE-BUILT VIRTUALENV. The obvious shape is to build
// `runtime/.venv` here and ship it. A virtualenv is not relocatable: `pyvenv.cfg` names an
// absolute interpreter path and the console scripts carry absolute shebangs, and the path it
// would have to be rewritten to contains the user's own name. Every one of those is fixable and
// each fix is a place to be subtly wrong on one platform. So what ships is the three INPUTS —
// the uv binary, an interpreter uv manages, and a populated wheel cache — and the venv is built
// on the machine it will run on, once, by the tool whose job that is. See src-tauri/src/python.rs
// for the other half.
//
// THE CACHE IS WHAT MAKES IT OFFLINE, and it is a best effort rather than a guarantee: uv reads
// it before reaching for the network, so a first launch with the cache present does no I/O it
// does not have to. A cache entry uv declines to reuse — a different platform tag, a format it
// has moved on from — falls back to a download rather than to a failure. That is the right
// direction for both cases: nobody is asked to install anything, and nobody is stuck if the
// cache turns out not to travel.
//
// Run it with `npm run tauri:python` from the repository root. `tauri:build` runs it first.

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNTIME = join(ROOT, "runtime");
const STAGE = join(ROOT, "src-tauri", "resources", "python");

/** Where each piece lands under the stage. `python.rs` reads the same three names. */
const BIN = join(STAGE, "bin");
const INTERPRETERS = join(STAGE, "interpreters");
const CACHE = join(STAGE, "cache");

/**
 * The uv binary the bundle ships.
 *
 * Same posture as the Node runtime in prepare-payload.mjs, and the same caveat: by default this
 * is whichever uv the build machine has, which is right for a developer build and wrong for a
 * release. `JAROKU_UV_BINARY` pins one, and the version that was actually used goes in the stamp
 * so an installed app can be asked rather than guessed at.
 */
function uvBinary() {
  const pinned = process.env.JAROKU_UV_BINARY;
  if (pinned) {
    if (!existsSync(pinned)) throw new Error(`JAROKU_UV_BINARY points at ${pinned}, which does not exist`);
    return pinned;
  }
  const which = process.platform === "win32" ? ["where", "uv"] : ["which", "uv"];
  try {
    return execFileSync(which[0], [which[1]], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
  } catch {
    throw new Error(
      "no uv on this machine, so there is nothing to stage. Install it (https://docs.astral.sh/uv/) " +
        "or point JAROKU_UV_BINARY at one. The bundle ships uv rather than asking a user for it, " +
        "which means the build machine is the one that has to have it.",
    );
  }
}

/**
 * Which interpreter to bundle, read from `runtime/.python-version` rather than written here.
 *
 * That file is what uv itself consults, so a repository that moves to 3.13 moves the bundle with
 * it and nothing has to be remembered. A constant in this script would be the second copy that
 * disagrees, which is the failure this project keeps writing down.
 */
function pythonVersion() {
  const file = join(RUNTIME, ".python-version");
  if (!existsSync(file)) throw new Error(`${file} is missing, and it is what says which interpreter to bundle`);
  return readFileSync(file, "utf8").trim();
}

function uv(args, extraEnv = {}) {
  execFileSync(binary, args, {
    cwd: RUNTIME,
    stdio: "inherit",
    env: {
      ...process.env,
      UV_CACHE_DIR: CACHE,
      UV_PYTHON_INSTALL_DIR: INTERPRETERS,
      // Require a uv-managed interpreter. Without this uv is entitled to satisfy the request
      // from whatever Python the build machine has on its PATH — which would produce a stage
      // with an empty `interpreters/` and a bundle that works only where somebody already had
      // Python, which is the whole thing this script exists to stop being true.
      UV_MANAGED_PYTHON: "1",
      ...extraEnv,
    },
  });
}

// ---------------------------------------------------------------------------------------------

const binary = uvBinary();
const version = pythonVersion();
const exe = process.platform === "win32" ? ".exe" : "";

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(BIN, { recursive: true });
mkdirSync(INTERPRETERS, { recursive: true });

copyFileSync(binary, join(BIN, `uv${exe}`));
/**
 * ...AND MADE WRITABLE, WHICH IS NOT COSMETIC.
 *
 * `copyFileSync` preserves the source's mode, and a Homebrew-installed `uv` is `r-xr-xr-x` — no
 * write bit for anybody, including its owner. Tauri's build script copies `resources/` into
 * `target/<profile>/` on every build, and the SECOND build then tries to overwrite a destination it
 * cannot write:
 *
 *     error: failed to run custom build command for `jaroku`
 *     Permission denied (os error 13)
 *
 * with no path in the message. The first build succeeds, which is what makes this expensive: it
 * looks like something the developer did between the two, and the obvious suspects — a version
 * bump, a lock file, a running app holding the sidecar — are all wrong. `0o755` is the mode this
 * file would have if it had been downloaded rather than copied from a package manager's cellar.
 */
chmodSync(join(BIN, `uv${exe}`), 0o755);
console.log(`uv          ${join("bin", `uv${exe}`)}  <- ${binary}`);

// `--no-bin` and `--no-registry` because both write OUTSIDE the install directory — a shim into
// the user's own bin directory and, on Windows, a machine-wide registry entry. A build script
// that installed a Python onto the build machine as a side effect of packaging one would be
// doing something nobody asked for.
uv(["python", "install", "--install-dir", INTERPRETERS, "--no-bin", "--no-registry", version]);
console.log(`interpreter ${version}`);

// Populate the cache by resolving the lock into a throwaway environment. `--frozen` so this can
// never silently re-resolve and stage wheels for a lock file that is not the committed one.
//
// AND THE PROJECT ITSELF IS INSTALLED, WHICH IS NOT AN OVERSIGHT. The first version of this line
// carried `--no-install-project` on the reasoning that `jaroku-runtime` is the source tree beside
// this script and there is no wheel of it worth caching. That is true of the wheel and false of
// what BUILDING it needs: `runtime/pyproject.toml` declares hatchling as its build backend, and
// `uv sync` on the user's machine builds the project before it installs anything. Staging without
// it produced a cache that failed on the one command this whole script exists to make work —
// verified, rather than reasoned about: an offline sync against that cache stopped at
// "hatchling was not found in the cache".
uv(["sync", "--frozen"], {
  UV_PROJECT_ENVIRONMENT: join(STAGE, ".build-venv"),
});
rmSync(join(STAGE, ".build-venv"), { recursive: true, force: true });
console.log("wheels      cached from runtime/uv.lock");

const uvVersion = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
const stamp = { uv: uvVersion, python: version, platform: `${process.platform}-${process.arch}` };
writeFileSync(join(STAGE, "python.json"), `${JSON.stringify(stamp, null, 2)}\n`);
console.log(`stamp       ${JSON.stringify(stamp)}`);
