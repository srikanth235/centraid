# Gateway-only image (issue #504 packaging Phase C + hardening).
# Build context: monorepo root (see .dockerignore).
# Vault/data: bind-mount a host path or named volume at /data — bare runs
# lose state when the container is removed (anonymous VOLUME is not durable).
# Non-loopback: set CENTRAID_ALLOWED_HOSTS=hostname1,hostname2 for public Host
# headers (loopback Host always allowed). See SECURITY.md + README.

FROM oven/bun:1.3.13-slim AS build
WORKDIR /src

COPY package.json bun.lock turbo.json tsconfig.base.json ./
COPY packages ./packages
# apps/* package.json kept via .dockerignore for lockfile workspaces; web needs sources to embed.
COPY apps ./apps
COPY scripts/gateway-package ./scripts/gateway-package

RUN bun install --frozen-lockfile
# Full dependency graph for gateway (protocol → … → gateway + embed web).
# Skip tunnel native (cargo) — JS iroh relay still starts; native is optional.
ENV CENTRAID_SKIP_NATIVE_TUNNEL=1
RUN bunx turbo run build --filter=@centraid/gateway
# Packages + assets only — bun's .bun store is re-installed for production below.
RUN node scripts/gateway-package/assemble-runtime.mjs --root=/src --out=/runtime --packages-only

# Fresh production install against the lean workspace (resolves esbuild, ajv, sharp, …).
FROM oven/bun:1.3.13-slim AS deps
WORKDIR /app
COPY --from=build /runtime/ /app/
# Gateway-only workspace + stripped devDependencies — monorepo bun.lock is not
# a bit-for-bit match; allow lock refresh for this install-only stage.
RUN rm -f bun.lock && bun install --production

FROM node:22-bookworm-slim AS runtime

ARG VERSION=0.1.0
ARG REVISION=unknown
LABEL org.opencontainers.image.title="centraid-gateway" \
  org.opencontainers.image.description="Centraid gateway HTTP control plane" \
  org.opencontainers.image.source="https://github.com/srikanth235/centraid" \
  org.opencontainers.image.url="https://github.com/srikanth235/centraid" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.revision="${REVISION}" \
  org.opencontainers.image.licenses="SEE LICENSE IN REPOSITORY"

WORKDIR /app
ENV NODE_ENV=production

# git: apps-store / blueprint publish paths shell out to git.
# Non-root operator user; mount /data with matching UID/GID (10001) or chown.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 centraid \
  && useradd --system --uid 10001 --gid centraid --home-dir /app --shell /usr/sbin/nologin centraid \
  && mkdir -p /data \
  && chown centraid:centraid /data

COPY --from=deps --chown=centraid:centraid /app/ /app/

USER centraid
VOLUME ["/data"]
EXPOSE 8787

# Proves listen on loopback Host (always allowlisted). 200 or 401 = up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/centraid/_gateway/info').then((r)=>process.exit(r.status===200||r.status===401?0:1)).catch(()=>process.exit(1))"

# Bind all interfaces for container networks. Host allowlist still applies:
# clients using Host: localhost work; other Host names need CENTRAID_ALLOWED_HOSTS.
ENTRYPOINT ["node", "packages/gateway/dist/cli/cli.js", "serve", "--data-dir", "/data", "--host", "0.0.0.0", "--port", "8787"]
