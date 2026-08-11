// The sandbox image's pinning rule, and boot.py's archive-extraction guard — exercised for
// real rather than assumed, the same way validator.ts's Python checks are.
//
//   npm run test:sandbox-image

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDigestPinned, requireDigestPinnedImage, sandboxImageRef } from "./image.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RUNTIME_DIR = join(ROOT, "runtime");

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// --- digest pinning -----------------------------------------------------------------------

const REAL_DIGEST = "sha256:229a2c5bfa27522db7815ea81f9bed70af17ccb9de9fc7ad142b1877b5830d36";

check("a digest-pinned ref is accepted", isDigestPinned(`python:3.12-slim@${REAL_DIGEST}`));
check("a bare tag is refused", !isDigestPinned("python:3.12-slim"));
check("`:latest` is refused", !isDigestPinned("myregistry.example/jaroku-sandbox:latest"));
check("a short/malformed digest is refused", !isDigestPinned("python:3.12-slim@sha256:deadbeef"));

check(
  "requireDigestPinnedImage throws on a tag",
  (() => {
    try {
      requireDigestPinnedImage("jaroku-sandbox:latest");
      return false;
    } catch (e) {
      return (e as Error).message.includes("not pinned by digest");
    }
  })(),
);

check(
  "sandboxImageRef refuses an unset variable rather than defaulting",
  (() => {
    try {
      sandboxImageRef({});
      return false;
    } catch (e) {
      return (e as Error).message.includes("JAROKU_SANDBOX_IMAGE is not set");
    }
  })(),
);

check(
  "sandboxImageRef passes through a properly pinned value",
  sandboxImageRef({ JAROKU_SANDBOX_IMAGE: `ghcr.io/jackeddisciple/jaroku-sandbox@${REAL_DIGEST}` }) ===
    `ghcr.io/jackeddisciple/jaroku-sandbox@${REAL_DIGEST}`,
);

// --- boot.py: extraction must refuse anything that resolves outside the target -------------
//
// Built and checked from THIS process (tarfile, not shell), so the archive is exactly the
// hostile shape being tested rather than whatever a shell quoting mistake produced. Run through
// boot.py's own safe_extract via a tiny driver script, the same "drive the real Python" pattern
// validator.ts's analyzePython uses.

const driver = `
import sys, tarfile, io, tempfile
sys.path.insert(0, ${JSON.stringify(RUNTIME_DIR)})
from sandbox.boot import safe_extract

kind = sys.argv[1]
target = sys.argv[2]

buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w") as tar:
    if kind == "traversal":
        data = b"pwned"
        info = tarfile.TarInfo(name="../../etc/passwd")
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
    elif kind == "absolute":
        data = b"pwned"
        info = tarfile.TarInfo(name="/etc/passwd")
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
    elif kind == "symlink":
        info = tarfile.TarInfo(name="escape")
        info.type = tarfile.SYMTYPE
        info.linkname = "/etc"
        tar.addfile(info)
    elif kind == "clean":
        data = b"print('hi')"
        info = tarfile.TarInfo(name="agent.py")
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))

with tempfile.NamedTemporaryFile(suffix=".tar", delete=False) as fh:
    fh.write(buf.getvalue())
    archive = fh.name

try:
    safe_extract(__import__("pathlib").Path(archive), __import__("pathlib").Path(target))
    print("EXTRACTED")
except Exception as e:
    print(f"REFUSED: {e}")
`.trim();

function runDriver(kind: string): string {
  const tmp = join(RUNTIME_DIR, ".sandbox-image-test-scratch");
  try {
    return execFileSync("uv", ["run", "python", "-c", driver, kind, tmp], {
      cwd: RUNTIME_DIR,
      encoding: "utf8",
      env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}` },
    }).trim();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  check("a path-traversal member is refused", runDriver("traversal").startsWith("REFUSED:"));
  check("an absolute-path member is refused", runDriver("absolute").startsWith("REFUSED:"));
  check("a symlink member is refused", runDriver("symlink").startsWith("REFUSED:"));
  check("an ordinary project archive extracts cleanly", runDriver("clean") === "EXTRACTED");
} catch (e) {
  check("boot.py's safe_extract is exercisable via uv", false, (e as Error).message);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
