# The gateway and worker image: one image, two commands.
#
# WHY THIS FILE DID NOT EXIST UNTIL NOW. `deploy/fly/*.toml` both name an image by digest —
# `registry.fly.io/jaroku-gateway@sha256:REPLACE_WITH_DIGEST` — which is the right shape for a
# rolling deploy (a tag is a mutable pointer and two replicas resolving it can run different code)
# and is not a thing anybody can build without a Dockerfile. The placeholder was the honest
# admission that this half was never built.
#
# ONE IMAGE FOR BOTH TIERS, because they are the same program. `server/src/index.ts` answers HTTP
# and holds sockets; `server/src/worker.ts` drains the queue. They share every repository, every
# migration and every model of a tenant, so shipping two images would mean two things to keep in
# step for no gain. The fly.toml picks the command.
#
# NODE 24 BECAUSE OF `node:sqlite`. The server imports it directly — that is the reason this
# project has no `better-sqlite3` and no native build step — and it is not present before 22.
# Postgres is what a hosted deployment actually runs on, but the import is unconditional.
FROM node:24-slim

# `tini` so PID 1 reaps children and forwards signals. The server's graceful shutdown is a SIGTERM
# handler that stops admission and drains in-flight work; under a PID 1 that does not forward
# signals, that handler never runs and Fly's rolling deploy becomes a hard kill on every replica.
# `ca-certificates` because everything this process talks to is TLS: Neon, Google's JWKS, Resend.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# THE DEPENDENCY LAYER, BEFORE THE SOURCE. Only these two files invalidate it, so editing a route
# does not reinstall `pg` and `ws`. `npm ci` rather than `install`: the lock file is the input, and
# a deploy that silently resolved a different tree than CI tested is the failure this prevents.
COPY server/package.json server/package-lock.json ./server/
RUN npm --prefix server ci --omit=dev

# `tsx` IS A RUNTIME DEPENDENCY HERE, not a build tool. The packaged desktop app runs
# `tsx src/index.ts` and so does this — the same command `npm run dev` runs, which is what keeps
# the deployed path and the developed path the same one. There is no compile step to skip.
RUN npm --prefix server ci --include=dev --ignore-scripts

COPY server/src ./server/src
COPY server/migrations ./server/migrations
COPY server/tsconfig.json ./server/
# The dependency-free fallback client the relay serves at `/`. Without it that route throws while
# trying to read a file that is not there, so the friendliest URL in the deployment — the one
# somebody pastes into a browser first — answers 500 on a server that is working perfectly.
COPY server/debug-client.html ./server/

# RUNTIME_DIR IS DERIVED FROM index.ts's OWN LOCATION — `join(REPO_DIR, "runtime")` — so the
# directory has to exist beside `server/` even where this tier never executes an agent. Under
# JAROKU_RUN_SANDBOX=fly the sandbox runs the Python; what the gateway still reads from here is
# `pricing.json`, which is where every cost figure in the product comes from, and it writes
# `.env` when a workspace saves a credential under the dotenv store.
COPY runtime/pricing.json ./runtime/
COPY runtime/pyproject.toml ./runtime/
COPY runtime/jaroku_runner ./runtime/jaroku_runner
COPY runtime/jaroku_interceptor ./runtime/jaroku_interceptor
COPY runtime/tool_templates ./runtime/tool_templates
RUN mkdir -p runtime/agents runtime/.objects runtime/.checkpoints

# Not root. Nothing here needs to write outside /app, and the one thing that does write —
# runtime/ — is chowned rather than left to a privileged process.
RUN chown -R node:node /app
USER node

# The port `http_service.internal_port` publishes. Overridable, because ports.rs walks upward
# locally and there is no reason for this to be the one place that cannot.
ENV JAROKU_PORT=4317
EXPOSE 4317

# Bound to every interface DELIBERATELY, and only here. `auth/bindHost.ts` defaults to loopback
# because a desktop install mounts a passwordless sign-in route; inside a container the opposite is
# true — the platform publishes the port and a process on loopback is one nothing can route to.
# NODE_ENV=production already resolves to 0.0.0.0, and this states it rather than relying on it.
ENV JAROKU_BIND_HOST=0.0.0.0

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "--prefix", "server", "run", "start"]
