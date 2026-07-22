# Optional distribution image for centraid-gateway (issue #501).
# Product install remains source + H5 OS service; this is the D5 container channel.
# Multi-stage: Bun monorepo build → Node runtime.

FROM oven/bun:1.3.13 AS build
WORKDIR /src
COPY package.json bun.lock turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY apps/mobile/package.json ./apps/mobile/package.json
# Workspace install (may pull unused apps — acceptable for simple image build)
RUN bun install --frozen-lockfile
RUN bun run build --filter=@centraid/gateway...

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# Minimal runtime copy: gateway package dist + its workspace deps' dist
COPY --from=build /src/packages/gateway /app/packages/gateway
COPY --from=build /src/packages /app/packages
COPY --from=build /src/node_modules /app/node_modules
COPY --from=build /src/package.json /app/package.json
ENV NODE_ENV=production
EXPOSE 8765
# data dir must be mounted by the operator
VOLUME ["/data"]
ENTRYPOINT ["node", "packages/gateway/dist/cli/cli.js"]
CMD ["serve", "--data-dir", "/data", "--host", "0.0.0.0", "--port", "8765"]
