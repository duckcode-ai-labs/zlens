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
#
# For a container with no internet access, bake the database drivers into the image; ZLens finds
# them through ZLENS_CONNECTOR_PATH (--build-arg ZLENS_DRIVERS="snowflake-sdk@^3.4.1").
# ZLENS_USER=node runs the general image as its unprivileged `node` user (uid 1000) instead of root.
# The ZLens app for Snowflake has its own minimal stage, snowflake-app (--target snowflake-app);
# see "ZLens inside Snowflake" in docs/get-started/install.md.

# Node 24 LTS (Node 20's support ended in April 2026). ZLens supports 20, 22, 24 and 26.
# Debian 13 (trixie): unlike bookworm's, its zlib has a fix for every critical CVE Trivy reports.
ARG NODE_VERSION=24

# ── Stage 1: builder ────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-trixie-slim AS builder

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

# Database drivers baked into the image (npm package specs separated by spaces),
# for an install that cannot download them at run time. Empty by default: ZLens
# then installs a project's driver into .dql/connectors when it first needs it.
ARG ZLENS_DRIVERS=""
RUN mkdir -p /tmp/drivers \
 && if [ -n "$ZLENS_DRIVERS" ]; then \
      printf '{"private":true}\n' > /tmp/drivers/package.json \
      && npm --prefix /tmp/drivers install --no-audit --no-fund --omit=dev $ZLENS_DRIVERS; \
    fi

# ── The ZLens app for Snowflake (deploy/snowflake-app) ─────────────────────
# A minimal image, as Snowflake's security review asks: distroless Node (no shell, no package manager,
# no apt), pinned by digest, with only the CLI bundle and the Snowflake driver, running as uid 1000.
# Built on its own with --target (the general image below stays the default):
#   docker build --platform linux/amd64 --target snowflake-app \
#     --build-arg ZLENS_DRIVERS="snowflake-sdk@^3.4.1" -t zlens-snowflake .
# Its start-up is deploy/snowflake-app/snowflake-entrypoint.mjs (plain Node: there is no shell).
FROM builder AS snowflake-files
# The driver must be in the image (the app has no internet), and native modules are built for Node 24,
# the distroless image's Node.
RUN test -d /tmp/drivers/node_modules/snowflake-sdk \
      || { echo 'Build the Snowflake app image with --build-arg ZLENS_DRIVERS="snowflake-sdk@^3.4.1"'; exit 1; } \
 && node -e 'process.exit(process.versions.node.startsWith("24.") ? 0 : 1)' \
      || { echo 'Build the Snowflake app image with NODE_VERSION=24 (the distroless image runs Node 24)'; exit 1; }
# uid 1000 (the user earlier app images ran as, so a volume they wrote stays writable) gets a name and a
# home: Node and the Snowflake driver look the user up.
RUN mkdir -p /out/workspace /out/home \
 && printf 'root:x:0:0:root:/root:/sbin/nologin\nnobody:x:65534:65534:nobody:/nonexistent:/sbin/nologin\nnonroot:x:65532:65532:nonroot:/home/nonroot:/sbin/nologin\nzlens:x:1000:1000:zlens:/home/zlens:/sbin/nologin\n' > /out/passwd \
 && printf 'root:x:0:\nnobody:x:65534:\nnonroot:x:65532:\nzlens:x:1000:\n' > /out/group

# gcr.io/distroless/nodejs24-debian13 (Debian 13, as the builder), pinned; Dependabot proposes new digests.
FROM gcr.io/distroless/nodejs24-debian13@sha256:24bc0fe0225c7518f202a822587dad74fe143b96326b81fe5cc08c1df8bed03e AS snowflake-app
ENV NODE_ENV=production \
    ZLENS_HOST=0.0.0.0 \
    ZLENS_CONNECTOR_PATH=/opt/zlens/drivers \
    HOME=/home/zlens
COPY --from=snowflake-files /out/passwd /etc/passwd
COPY --from=snowflake-files /out/group /etc/group
COPY --from=builder /tmp/deploy-cli /opt/dql
COPY --from=builder /build/packages/create-dql-app/templates/starter /opt/dql/templates/starter
COPY --from=builder /tmp/drivers /opt/zlens/drivers
COPY deploy/snowflake-app/snowflake-entrypoint.mjs /opt/zlens/snowflake-entrypoint.mjs
COPY --from=snowflake-files --chown=1000:1000 /out/home /home/zlens
COPY --from=snowflake-files --chown=1000:1000 /out/workspace /workspace
WORKDIR /workspace
EXPOSE 3474
USER 1000:1000
ENTRYPOINT ["/nodejs/bin/node", "/opt/zlens/snowflake-entrypoint.mjs"]
CMD ["zlens", "notebook", "--host", "0.0.0.0", "--no-open"]

# ── Stage 2: runtime (the general image, and the default target) ───────────
FROM node:${NODE_VERSION}-trixie-slim AS runtime

ENV NODE_ENV=production \
    ZLENS_HOST=0.0.0.0 \
    ZLENS_CONNECTOR_PATH=/opt/zlens/drivers

WORKDIR /opt/dql

# Native modules need libstdc++ at runtime. Debian's security fixes are applied on top of the
# base image, and the npm it bundles is updated: Node 24's npm 11.19 carries brace-expansion and
# undici versions with known high CVEs (Snowflake's app review scans the image; so does CI).
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g --no-audit --no-fund npm@11.21.2 \
 && npm cache clean --force

# Pull in the deployed CLI bundle (dist + node_modules).
COPY --from=builder /tmp/deploy-cli /opt/dql
COPY --from=builder /build/packages/create-dql-app/templates/starter /opt/dql/templates/starter
COPY --from=builder /tmp/drivers /opt/zlens/drivers
COPY scripts/docker-entrypoint.sh /usr/local/bin/dql-docker-entrypoint
COPY deploy/snowflake-app/snowflake-entrypoint.mjs /opt/zlens/snowflake-entrypoint.mjs

# Make `zlens` (and the old `dql` alias) available on PATH via tiny shims —
# `pnpm deploy` doesn't link bins.
RUN printf '#!/bin/sh\nexec node /opt/dql/dist/index.js "$@"\n' > /usr/local/bin/zlens \
 && printf '#!/bin/sh\nexec node /opt/dql/dist/dql-alias.js "$@"\n' > /usr/local/bin/dql \
 && chmod +x /usr/local/bin/zlens /usr/local/bin/dql \
 && chmod +x /usr/local/bin/dql-docker-entrypoint

# Project files live here at runtime — bind-mount your repo to /workspace.
# Owned by `node`, so a fresh volume is writable when ZLENS_USER=node.
RUN mkdir -p /workspace && chown node:node /workspace
WORKDIR /workspace

EXPOSE 3474 3479

# Bind 0.0.0.0 inside the container; map a single port from 127.0.0.1 on
# the host with `-p 127.0.0.1:3474:3474` to keep loopback-only on the host.
# A non-loopback binding needs ZLENS_SERVER_TOKEN and ZLENS_ALLOWED_ORIGINS or the
# server refuses to start, e.g.:
#   docker run -p 127.0.0.1:3474:3474 -e ZLENS_SERVER_TOKEN=... \
#     -e ZLENS_ALLOWED_ORIGINS=http://127.0.0.1:3474 -v "$PWD":/workspace <image>
#
# The user ZLens runs as. root by default, so a bind-mounted folder of any owner keeps working;
# `--build-arg ZLENS_USER=node` (the Snowflake app) runs it unprivileged.
ARG ZLENS_USER=root
USER ${ZLENS_USER}
ENTRYPOINT ["dql-docker-entrypoint"]
CMD ["zlens", "notebook", "--host", "0.0.0.0", "--no-open"]
