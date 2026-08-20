// Stage what the desktop bundle carries: the Node runtime as a Tauri sidecar, and `server/` and
// `runtime/` as a resource directory.
//
// WHAT GOES IN, AND WHY IT IS "EVERYTHING THE REPOSITORY TRACKS" RATHER THAN A CURATED LIST.
// The tempting version of this script names the files the server needs — `src/`, `migrations/`,
// `package.json` — and ships a third of the size. It is also the version that breaks the first
// time somebody adds a file the server reads at runtime and nobody notices until an installed
// app cannot find it, because the missing file is invisible in every environment that has a
// checkout. `git ls-files` is the list of what this project considers its own, it is maintained
// by the act of committing, and it cannot go stale. The suites come along with it: they are a
// few megabytes beside `node_modules`, and being able to run `npm run test:relay` inside an
// installed app is worth more than that.
//
// WHAT IS DELIBERATELY OUT. Everything gitignored, which is exactly the right cut: the local
// object store, the checkpoint databases, generated agent projects, `runtime/.venv`, the three
// signing keys and `runtime/.env`. Every one of those is either somebody's data or a credential,
// and the interesting thing about the list is that it needed no rule of its own — a file this
// repository refuses to commit is a file a bundle must not ship.
//
// Run it with `npm run tauri:payload` from the repository root. `tauri:build` runs it first.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STAGE = join(ROOT, "src-tauri", "resources", "app");
const BINARIES = join(ROOT, "src-tauri", "binaries");

/**
 * The Rust target triple, which is what Tauri appends to a sidecar's name on disk.
 *
 * `rustc -vV` when there is a rustc, because it is the authority and it is the only thing that
 * knows a musl host from a gnu one. The table below is the fallback for the machine that has a
 * Node toolchain and no Rust one — which is a real case: staging the payload is a `cp`, and
 * asking somebody to install a compiler to run it would be absurd. A wrong guess here is loud
 * rather than subtle: Tauri fails the bundle with "binary not found for target".
 */
function targetTriple() {
  try {
    const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
    const host = /^host:\s*(\S+)$/m.exec(out);
    if (host) return host[1];
  } catch {
    /* no rustc on this machine; the table below is why that is survivable */
  }
  const table = {
    "win32:x64": "x86_64-pc-windows-msvc",
    "win32:arm64": "aarch64-pc-windows-msvc",
    "darwin:x64": "x86_64-apple-darwin",
    "darwin:arm64": "aarch64-apple-darwin",
    "linux:x64": "x86_64-unknown-linux-gnu",
    "linux:arm64": "aarch64-unknown-linux-gnu",
  };
  const key = `${process.platform}:${process.arch}`;
  const triple = table[key];
  if (!triple) throw new Error(`no target triple is known for ${key} — set it with JAROKU_TARGET_TRIPLE`);
  return triple;
}

/**
 * The Node binary the bundle ships.
 *
 * BY DEFAULT IT IS THE ONE RUNNING THIS SCRIPT, which is the right thing for a developer build
 * and the wrong thing for a release. A release should pin the runtime rather than inherit
 * whatever the build machine happened to have — so `JAROKU_NODE_BINARY` points at a downloaded
 * one, and the version that was actually used is written into the stamp below so an installed
 * app can answer the question rather than being asked to guess.
 *
 * TWO CONSEQUENCES OF COPYING A BINARY, both of which belong to the person cutting a release
 * rather than to this script, and both of which are in docs/tauri.md. On macOS the copy has to
 * be signed along with the rest of the bundle, because a `.app` with one unsigned executable in
 * it is a `.app` Gatekeeper refuses. On Linux the copy is linked against the BUILD machine's
 * glibc, so that machine's glibc becomes the app's floor.
 */
function nodeBinary() {
  const pinned = process.env.JAROKU_NODE_BINARY;
  if (pinned) {
    if (!existsSync(pinned)) throw new Error(`JAROKU_NODE_BINARY points at ${pinned}, which does not exist`);
    return pinned;
  }
  return process.execPath;
}

function tracked(prefix) {
  // `-z` and a NUL split, because a path with a newline in it is legal on every platform this
  // ships to and `git ls-files` would otherwise quote it into something this script mis-parses.
  const out = execFileSync("git", ["ls-files", "-z", "--", prefix], { cwd: ROOT, encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

// ---------------------------------------------------------------------------------------------

if (!existsSync(join(ROOT, "server", "node_modules", "tsx", "dist", "cli.mjs"))) {
  console.error(
    "server/node_modules is not installed, so there is nothing to stage. Run `npm ci` in server/ " +
      "first — the bundle ships the dependency tree rather than resolving one at install time, " +
      "and tsx is in it because `npm run dev` runs the server through tsx and the packaged app " +
      "runs the same command.",
  );
  process.exit(1);
}

const triple = process.env.JAROKU_TARGET_TRIPLE ?? targetTriple();
const exe = process.platform === "win32" ? ".exe" : "";

// A clean stage every time. This directory is gitignored build output, so there is nothing here
// to preserve, and an incremental copy is how a file deleted from the repository lives on in
// every bundle built afterwards.
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
mkdirSync(BINARIES, { recursive: true });

const source = nodeBinary();
const sidecar = join(BINARIES, `jaroku-node-${triple}${exe}`);
copyFileSync(source, sidecar);
console.log(`sidecar   ${relative(ROOT, sidecar)}  <- ${source}`);

const files = [...tracked("server"), ...tracked("runtime")].sort();
for (const file of files) {
  const to = join(STAGE, file);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(ROOT, file), to);
}
console.log(`tracked   ${files.length} files from server/ and runtime/`);

cpSync(join(ROOT, "server", "node_modules"), join(STAGE, "server", "node_modules"), {
  recursive: true,
  // `node_modules` is full of symlinks on any machine that has used a workspace or `npm link`,
  // and a symlink copied into a bundle is a link out of it. Dereferencing turns each into the
  // file it points at, which is what a self-contained payload means.
  dereference: true,
});
console.log("modules   server/node_modules");

/**
 * The stamp, which is what the extractor compares against to decide whether it has work to do.
 *
 * DERIVED FROM CONTENT, NEVER FROM A CLOCK. A timestamp would make every build look like a new
 * payload and re-extract a hundred megabytes onto a user's disk on the launch after a rebuild
 * that changed nothing. Path and size rather than a full digest of every byte: hashing
 * `node_modules` is seconds of work on every build to distinguish cases that do not occur, since
 * a dependency that changes its contents and not its length is a dependency that changed its
 * version and therefore its paths.
 */
function stamp(dir) {
  const digest = createHash("sha256");
  const walk = (at) => {
    // Sorted at every level, so the digest is a property of the tree rather than of the order
    // this platform's filesystem happens to hand its entries back in. Directory iteration order
    // is not stable across platforms, and this project has been bitten by that once already.
    for (const entry of readdirSync(at).sort()) {
      const full = join(at, entry);
      const info = statSync(full);
      if (info.isDirectory()) walk(full);
      else digest.update(`${relative(dir, full).split(sep).join("/")}:${info.size}\n`);
    }
  };
  walk(dir);
  return digest.digest("hex").slice(0, 32);
}

const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const nodeVersion = execFileSync(source, ["--version"], { encoding: "utf8" }).trim();
const payload = { version, node: nodeVersion, triple, files: files.length, digest: stamp(STAGE) };
writeFileSync(join(STAGE, "payload.json"), `${JSON.stringify(payload, null, 2)}\n`);
console.log(`stamp     ${JSON.stringify(payload)}`);
