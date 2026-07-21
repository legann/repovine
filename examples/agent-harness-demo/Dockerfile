# Harness image — fully self-contained: a builder stage compiles the repovine
# CLI from source, so the image no longer depends on a dist/ built on the host
# (no "built on my machine" drift; CI builds it the same way every time).
#
# Build context: repovine/ (see compose.yaml).

# ── Stage 1: compile the repovine CLI from source (dev deps live here only) ────
FROM node:22-bookworm-slim@sha256:7af03b14a13c8cdd38e45058fd957bf00a72bbe17feac43b1c15a689c029c732 AS builder
WORKDIR /app/repovine
# `package*.json` glob: use `npm ci` when a lockfile is present, else `npm install`
# (package-lock.json is gitignored repo-wide, so a clean CI checkout has none).
COPY package*.json tsconfig.json ./
COPY packages/plugin-sdk/package.json packages/plugin-sdk/tsconfig.json ./packages/plugin-sdk/
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY packages/plugin-sdk/src ./packages/plugin-sdk/src
COPY src ./src
RUN npm run build \
  && test -f dist/mcp/index.js

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim@sha256:7af03b14a13c8cdd38e45058fd957bf00a72bbe17feac43b1c15a689c029c732
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/repovine
# Production deps only, then the compiled output. dist/stage1/*.js imports
# `typescript` at runtime (it is a devDependency), so copy that one package from
# the builder — this pins it to the lockfile with no second `npm install` and no
# version drift (the old `npm install typescript@<literal>` workaround is gone).
COPY package*.json ./
COPY packages/plugin-sdk/package.json ./packages/plugin-sdk/
COPY --from=builder /app/repovine/packages/plugin-sdk/dist ./packages/plugin-sdk/dist
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
COPY --from=builder /app/repovine/node_modules/typescript ./node_modules/typescript
COPY --from=builder /app/repovine/dist ./dist

WORKDIR /app/repovine/examples/agent-harness-demo
# `package*.json` glob copies package.json and the committed package-lock.json
# (this demo overrides the repo-wide lockfile ignore — see .gitignore), so `npm ci`
# (reproducible) is used; the `npm install` fallback only applies if it is ever absent.
COPY examples/agent-harness-demo/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
# Whole demo tree (incl. lib/agents/, lib/rules/, lib/handoff/) — baked-in defaults.
# compose.yaml bind-mounts ./lib/agents over lib/agents/ at runtime so brief edits
# on the host apply without rebuild; HARNESS_AGENTS_DIR points loaders at that path.
COPY examples/agent-harness-demo/ ./
# Mountpoint for the ./.workspace bind mount (compose.yaml). Create it in the image so
# the path exists; Docker overlays the host dir at runtime and auto-creates a missing
# host dir as root, so workspace-init chowns it to `node` before the harness starts.
RUN mkdir -p .workspace

ENV REPOVINE_CLI=/app/repovine/dist/mcp/index.js

# Smoke check: the CLI must actually answer (catches a broken build / runtime dep).
RUN node /app/repovine/dist/mcp/index.js agents protocol >/dev/null \
  || (echo "repovine CLI smoke check failed — rebuild image" >&2 && exit 1)

# Drop privileges: run as the base image's unprivileged `node` user. The worker
# is write-only and runs no containers, so no docker access is needed at all.
ENV HOME=/home/node
RUN chown -R node:node /app
USER node

CMD ["node", "scripts/langgraph-cli.mjs", "--help"]
