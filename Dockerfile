# Gateway-only image (issue #504 packaging Phase C).
# Build context: monorepo root after `bun install` + package builds.
# Ships control-plane HTTP; inherits Host/CORS posture from batch 0
# (loopback-safe defaults — override bind host carefully).

FROM oven/bun:1.3.13-slim AS build
WORKDIR /src
COPY package.json bun.lock turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN bun install --frozen-lockfile
RUN bun run --cwd packages/protocol build \
 && bun run --cwd packages/blob-format build \
 && bun run --cwd packages/design-tokens build \
 && bun run --cwd packages/vault build \
 && bun run --cwd packages/tunnel build \
 && bun run --cwd packages/app-engine build \
 && bun run --cwd packages/agent-runtime build \
 && bun run --cwd packages/automation build \
 && bun run --cwd packages/backup build \
 && bun run --cwd packages/blueprints build \
 && bun run --cwd packages/gateway build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# Non-loopback binds need Host allowlist + operator review (SECURITY.md).
COPY --from=build /src/packages/gateway /app/packages/gateway
COPY --from=build /src/packages/protocol /app/packages/protocol
COPY --from=build /src/packages/app-engine /app/packages/app-engine
COPY --from=build /src/packages/agent-runtime /app/packages/agent-runtime
COPY --from=build /src/packages/automation /app/packages/automation
COPY --from=build /src/packages/backup /app/packages/backup
COPY --from=build /src/packages/blueprints /app/packages/blueprints
COPY --from=build /src/packages/vault /app/packages/vault
COPY --from=build /src/packages/tunnel /app/packages/tunnel
COPY --from=build /src/packages/blob-format /app/packages/blob-format
COPY --from=build /src/packages/design-tokens /app/packages/design-tokens
COPY --from=build /src/node_modules /app/node_modules
COPY --from=build /src/package.json /app/package.json
VOLUME ["/data"]
EXPOSE 8787
ENTRYPOINT ["node", "packages/gateway/dist/cli/cli.js", "serve", "--data-dir", "/data", "--host", "0.0.0.0", "--port", "8787"]
