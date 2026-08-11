"""The sandbox image's ENTRYPOINT — the first thing that runs inside a hosted RunSandbox.

Its whole job: fetch the ONE thing this image does not already contain — the run's agent
project, model-written and untrusted — extract it onto the tmpfs scratch mount, point
JAROKU_AGENT_DIR at it, and exec the real command in its place. Everything else the run needs
(jaroku_runner, the interceptor, the tool templates) is already baked into the image; see
sandbox/Dockerfile for why.

    python -m sandbox.boot -- uv run python -m jaroku_runner <agent_id> ["input"]

Two things this module is deliberately careful about, because it is the first code a fetched,
untrusted archive touches:

  SAFE EXTRACTION. A tar entry can name any path, including one that walks out of the
  extraction root ("../../etc/passwd") or resolves through a symlink to somewhere it should
  not — the same class of attack ADR-031 already refuses at the object-store key layer and
  projectFs already refuses on local disk. A hosted run has no "outside" that matters as much
  as a shared host would, but the scratch mount is still shared with this process's own
  memory-mapped files, and there is no reason to trust an entry name a language model's output
  could shape. Every member is resolved and checked before it is written.

  EXEC, NOT FORK. os.execvpe REPLACES this process rather than spawning a child — so there is
  no boot.py left running above the real workload for a signal to get lost in, and no shell
  interposed for an argument to be reinterpreted by. The runner becomes PID 1.
"""

from __future__ import annotations

import os
import sys
import tarfile
import urllib.request
from pathlib import Path

# Where the Dockerfile made a tmpfs-backed, writable directory the read-only rootfs stays
# closed around. One run per boot, so one subdirectory per run rather than per-request cleanup.
SCRATCH_ROOT = Path("/scratch")

# 200 MB is generous for a generated LangGraph project (source only, no venv — the runtime and
# every dependency already live in the image) and small enough that a compromised or careless
# presigned URL cannot fill the tmpfs mount and take the machine down with it.
MAX_ARCHIVE_BYTES = 200 * 1024 * 1024


def log(*args: object) -> None:
    print("[boot]", *args, file=sys.stderr, flush=True)


def fetch(url: str, dest: Path) -> None:
    """Download the presigned archive, refusing anything larger than the cap as it streams."""
    request = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310 - fixed https scheme, presigned
        written = 0
        with open(dest, "wb") as fh:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > MAX_ARCHIVE_BYTES:
                    raise RuntimeError(
                        f"the agent project archive exceeds {MAX_ARCHIVE_BYTES} bytes — refusing "
                        "to keep downloading rather than filling the sandbox's scratch mount"
                    )
                fh.write(chunk)


def safe_extract(archive: Path, target: Path) -> None:
    """Extract `archive` into `target`, refusing any member that would land outside it.

    Mirrors projectFs's path-confinement rule for the same reason: an archive built from a
    generated project's files is, transitively, model-influenced input, and a member name is
    not a path until it has been proven to resolve inside the directory it is meant for.
    """
    target.mkdir(parents=True, exist_ok=True)
    resolved_target = target.resolve()
    with tarfile.open(archive, mode="r:*") as tar:
        for member in tar.getmembers():
            # Absolute paths and symlink/hardlink members are refused outright — a legitimate
            # generated project has neither, and both are exactly the shapes a traversal or a
            # link-out-of-scratch attempt would use.
            if member.issym() or member.islnk():
                raise RuntimeError(f"refusing archive member with a link: {member.name!r}")
            if os.path.isabs(member.name):
                raise RuntimeError(f"refusing absolute archive member path: {member.name!r}")
            member_path = (target / member.name).resolve()
            if member_path != resolved_target and resolved_target not in member_path.parents:
                raise RuntimeError(
                    f"refusing archive member outside the extraction root: {member.name!r}"
                )
        tar.extractall(path=target)  # noqa: S202 - every member re-checked above


def main(argv: list[str]) -> int:
    if "--" not in argv:
        log("usage: python -m sandbox.boot -- <command...>")
        return 2
    split = argv.index("--")
    command = argv[split + 1 :]
    if not command:
        log("no command given after --")
        return 2

    run_id = os.environ.get("JAROKU_RUN_ID", "run")
    tar_url = os.environ.get("JAROKU_PROJECT_TAR_URL")
    if not tar_url:
        log("JAROKU_PROJECT_TAR_URL is not set — nothing to run in this sandbox")
        return 2

    run_scratch = SCRATCH_ROOT / run_id
    archive_path = run_scratch / "project.tar"
    project_dir = run_scratch / "project"

    log(f"fetching agent project for run {run_id}")
    run_scratch.mkdir(parents=True, exist_ok=True)
    fetch(tar_url, archive_path)
    safe_extract(archive_path, project_dir)
    archive_path.unlink(missing_ok=True)  # the tar itself has no further use once extracted

    os.environ["JAROKU_AGENT_DIR"] = str(project_dir)
    log(f"extracted to {project_dir}, executing: {' '.join(command)}")

    # REPLACES this process. Nothing below this line ever runs.
    os.execvpe(command[0], command, os.environ)  # noqa: S606 - the whole point of this module
    return 1  # unreachable; satisfies callers that check a return value


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
