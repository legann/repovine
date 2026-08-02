# Harness image — fully self-contained: a builder stage compiles the repovine
# CLI from source, so the image no longer depends on a dist/ built on the host
# (no "built on my machine" drift; CI builds it the same way every time).
#
# Build context: repovine/ (see compose.yaml).

# ── Stage 1: compile the repovine CLI from source (dev deps live here only) ────
FROM node:22-bookworm-slim@sha256:7af03b14a13c8cdd38e45058fd957bf00a72bbe17feac43b1c15a689c029c732 AS builder
WORKDIR /app/repovine
# `package*.json` includes the committed root lockfile; keep the fallback so the
# image also remains buildable from a source export that intentionally omits it.
COPY package*.json tsconfig.json ./
# The root build owns every plugin workspace after the plugin-boundary migration.
# Copy the complete workspace tree before npm ci so workspace links resolve, and
# so clean/build/asset verification see the same projects as a clean checkout.
COPY packages ./packages
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY src ./src
# `npm run build` shells out to Node build scripts (clean, copy-build-assets),
# so the scripts/ dir must be in the builder stage — a plain `tsc` is not enough.
COPY scripts ./scripts
RUN npm run build \
  && test -f dist/mcp/index.js

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim@sha256:7af03b14a13c8cdd38e45058fd957bf00a72bbe17feac43b1c15a689c029c732
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/repovine
# Production deps plus the compiled workspace packages. The root lockfile links
# @repovine/plugin-* dependencies to packages/**, so those workspaces must exist
# before npm ci; copying them from the builder also carries their verified dist/.
COPY package*.json ./
COPY --from=builder /app/repovine/packages ./packages
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
COPY --from=builder /app/repovine/dist ./dist

WORKDIR /app/repovine/examples/delivery-protocol-harness-demo
# `package*.json` glob copies package.json and the committed package-lock.json
# (this demo overrides the repo-wide lockfile ignore — see .gitignore), so `npm ci`
# (reproducible) is used; the `npm install` fallback only applies if it is ever absent.
COPY examples/delivery-protocol-harness-demo/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
# Whole demo tree (incl. lib/agents/, lib/rules/, lib/handoff/) — baked-in defaults.
# compose.yaml bind-mounts ./lib/agents over lib/agents/ at runtime so brief edits
# on the host apply without rebuild; HARNESS_AGENTS_DIR points loaders at that path.
COPY examples/delivery-protocol-harness-demo/ ./
# Mountpoint for the ./.workspace bind mount (compose.yaml). Create it in the image so
# the path exists; Docker overlays the host dir at runtime. The bind sets
# create_host_path:false, so the host dir must exist first — scripts/compose.mjs
# pre-creates it as the invoking user, then workspace-init normalizes ownership.
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
