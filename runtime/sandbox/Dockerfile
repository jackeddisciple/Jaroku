# The image every hosted RunSandbox boots from — one image, shared by every run, every
# workspace. It is built ONCE, reviewed, pushed, and referenced by digest (see
# server/src/sandbox/image.ts:requireDigestPinnedImage). Nothing about a particular run is
# baked in here: the agent's OWN code — the part a language model wrote — never lands in this
# image at all. It is fetched at boot from the presigned URL in SandboxSpec.files, extracted
# onto a tmpfs scratch mount, and is gone the moment the micro-VM is.
#
# What DOES live in this image is code Jaroku wrote and reviewed: jaroku_runner, the
# interceptor, and the tool templates. That is the same trust boundary the rest of the product
# already draws — a connector template is reviewed and copied verbatim; this is the same
# guarantee at the image layer.
#
# Base images pinned by digest, not tag. A tag can be repointed by anyone with push access to
# the upstream registry; a digest cannot. Re-resolve and re-pin deliberately (there is no
# `:latest` anywhere in this file), not by a background update nobody reviewed.
FROM python:3.12-slim@sha256:229a2c5bfa27522db7815ea81f9bed70af17ccb9de9fc7ad142b1877b5830d36

COPY --from=ghcr.io/astral-sh/uv:0.5.11@sha256:0ac957607303916420297a4c9c213bb33fbd3c888f9cd7f4f7273596ebf42b85 \
     /uv /usr/local/bin/uv

WORKDIR /app

# Dependencies as their OWN layer, synced from the exact lock the rest of Jaroku develops
# against — so a sandboxed run resolves the same versions `npm run dev` does, and a cold start
# never reaches out to PyPI. `--extra connectors` and `--extra hosted` because a run may need
# either: which connectors and which checkpointer are per-workspace choices, not per-image ones.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --extra connectors --extra hosted --no-install-project

# Jaroku's OWN code — reviewed, not model-written. The agent project itself is never copied
# into the image; see the boot script below.
COPY jaroku_interceptor/ ./jaroku_interceptor/
COPY jaroku_runner/ ./jaroku_runner/
COPY tool_templates/ ./tool_templates/
COPY sandbox/__init__.py sandbox/boot.py ./sandbox/

# tmpfs at runtime (set on the Fly Machine's mount config, not here — a Dockerfile cannot
# declare a mount). This is merely where that mount lands: an empty, writable directory the
# rootfs itself stays read-only around. boot.py extracts the fetched agent project here and
# points JAROKU_AGENT_DIR at it.
RUN mkdir -p /scratch

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/app/.venv/bin:${PATH}"

# Nothing here needs root, and code a language model wrote should never have it. This is the
# LAST line of a defence that starts with the egress policy and the read-only rootfs — not a
# substitute for either, since a process running as an unprivileged user inside a compromised
# container can still reach anything the network policy allows.
RUN useradd --uid 10001 --create-home --no-log-init sandbox \
    && chown -R sandbox:sandbox /app /scratch
USER sandbox

# boot.py is the only thing this image ever runs: fetch the run's project, verify it landed
# inside /scratch (never outside it — see safeExtract in sandbox/boot.py), then exec the runner
# with JAROKU_AGENT_DIR pointed at the extraction. It never runs as PID 1 with a shell in
# between, so there is nothing here for a fork bomb to inherit a job-control terminal from.
ENTRYPOINT ["python", "-m", "sandbox.boot"]
