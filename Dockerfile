# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# @hasna/attachments — ARM64 (Fargate) container for attachments-serve.
# PURE REMOTE (Amendment A1): the service talks to RDS Postgres + S3 directly.
# ---------------------------------------------------------------------------
FROM oven/bun:1 AS build
WORKDIR /app

# Install dependencies against the committed lockfile. --ignore-scripts because
# this package's own `prepare` script builds dist, which needs src (copied next).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

# Build the dist bundles (cli, mcp, serve).
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN bun run build

# Prune to production dependencies for the runtime image.
RUN rm -rf node_modules && bun install --frozen-lockfile --production --ignore-scripts

# ---------------------------------------------------------------------------
FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HASNA_ATTACHMENTS_STORAGE_MODE=postgres

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# `attachments-serve` on PATH so ECS command overrides (serve / migrate) work.
RUN printf '#!/bin/sh\nexec bun /app/dist/serve/index.js "$@"\n' > /usr/local/bin/attachments-serve \
    && chmod +x /usr/local/bin/attachments-serve

EXPOSE 8080
CMD ["attachments-serve"]
