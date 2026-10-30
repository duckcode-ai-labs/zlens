# ZLens — single-image build that bundles the workspace + CLI.
#
# Two-stage:
#   1. builder — pnpm install + pnpm -r build over the whole workspace.
#   2. runtime — slim node image with only the built dist/ trees and a
#      preinstalled `zlens` shim (and the `dql` alias) that delegates to the bundled CLI.
#
# Default entrypoint launches the notebook bound to 0.0.0.0:3474 inside the
# container, which the host maps to 127.0.0.1:3474 via docker-compose so the
# loopback security posture is preserved on the host.
#
# Usage:
#   docker build -t zlens:latest .
#   docker run --rm -it -p 127.0.0.1:3474:3474 -v "$PWD":/workspace zlens:latest

# ── Stage 1: builder ────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder

WORKDIR /build

# pnpm via corepack — pinned by the repo's `packageManager` field.
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Build deps for native modules (better-sqlite3; the DuckDB driver needs none).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 build-essential \
 && rm -rf /var/lib/apt/lists/*

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile
RUN pnpm -r build

# Trim devDependencies for the runtime image.
RUN pnpm -r --prod deploy /tmp/deploy-cli --filter @zlens/cli

# ── Stage 2: runtime ────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    ZLENS_HOST=0.0.0.0

WORKDIR /opt/dql

# Native modules need libstdc++ at runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Pull in the deployed CLI bundle (dist + node_modules).
COPY --from=builder /tmp/deploy-cli /opt/dql
COPY --from=builder /build/packages/create-dql-app/templates/starter /opt/dql/templates/starter
COPY scripts/docker-entrypoint.sh /usr/local/bin/dql-docker-entrypoint

# Make `zlens` (and the old `dql` alias) available on PATH via tiny shims —
# `pnpm deploy` doesn't link bins.
RUN printf '#!/bin/sh\nexec node /opt/dql/dist/index.js "$@"\n' > /usr/local/bin/zlens \
 && printf '#!/bin/sh\nexec node /opt/dql/dist/dql-alias.js "$@"\n' > /usr/local/bin/dql \
 && chmod +x /usr/local/bin/zlens /usr/local/bin/dql \
 && chmod +x /usr/local/bin/dql-docker-entrypoint

# Project files live here at runtime — bind-mount your repo to /workspace.
WORKDIR /workspace

EXPOSE 3474 3479

# Bind 0.0.0.0 inside the container; map a single port from 127.0.0.1 on
# the host with `-p 127.0.0.1:3474:3474` to keep loopback-only on the host.
# A non-loopback binding needs ZLENS_SERVER_TOKEN and ZLENS_ALLOWED_ORIGINS or the
# server refuses to start, e.g.:
#   docker run -p 127.0.0.1:3474:3474 -e ZLENS_SERVER_TOKEN=... \
#     -e ZLENS_ALLOWED_ORIGINS=http://127.0.0.1:3474 -v "$PWD":/workspace <image>
ENTRYPOINT ["dql-docker-entrypoint"]
CMD ["zlens", "notebook", "--host", "0.0.0.0", "--no-open"]
