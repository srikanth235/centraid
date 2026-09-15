# syntax=docker/dockerfile:1.7-labs
# Gateway-only image (issue #504 packaging Phase C + hardening).
# Build context: monorepo root (see .dockerignore).
# Vault/data: bind-mount a host path or named volume at /data — bare runs
# lose state when the container is removed (anonymous VOLUME is not durable).
# Non-loopback: set CENTRAID_ALLOWED_HOSTS=hostname1,hostname2 for public Host
# headers (loopback Host always allowed). See SECURITY.md + README.
#
# Tunneling is required: this image builds the native iroh napi relay
# (packages/tunnel/native) so remote devices can dial the gateway over QUIC.
#
# #637 Phase 2 — manifests-first COPY so source-only commits keep the
# rustup + bun install layers warm under registry-backed BuildKit cache.
# Base images are digest-pinned (multi-arch index) to match Action SHA pins.

FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04 AS build
WORKDIR /src

# Native tunnel (napi + data-plane): rustc 1.91 matches packages/tunnel/*/Cargo.toml.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    clang \
    curl \
    git \
    pkg-config \
    python3 \
  && rm -rf /var/lib/apt/lists/* \
  && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain 1.91.0 --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

# Workspace manifests only — invalidates install only when deps change.
COPY package.json bun.lock turbo.json tsconfig.base.json tsconfig.electron.json tsconfig.expo.json ./
COPY --parents packages/*/package.json apps/*/package.json ./
COPY --parents tools/*/package.json ./

RUN bun install --frozen-lockfile

# Full sources after install so code edits do not re-run bun install.
COPY packages ./packages
# apps/* package.json kept via .dockerignore for lockfile workspaces; web needs sources to embed.
COPY apps ./apps
COPY scripts/gateway-package ./scripts/gateway-package

# Full dependency graph for gateway. Native tunnel is mandatory for this image.
ENV CENTRAID_REQUIRE_NATIVE_TUNNEL=1
RUN bunx turbo run build --filter=@centraid/server \
  && node -e "const fs=require('fs');const p=require('path');const dir='packages/tunnel/native';const need=\`centraid-tunnel-native.\${process.platform}-\${process.arch}.node\`;const full=p.join(dir,need);if(!fs.existsSync(full)){console.error('missing required native tunnel artifact',full,'have',fs.readdirSync(dir).filter(n=>n.endsWith('.node')));process.exit(1)};console.log('native tunnel artifact:',full);"
# Packages + assets only — bun's .bun store is re-installed for production below.
RUN node scripts/gateway-package/assemble-runtime.mjs --root=/src --out=/runtime --packages-only

# Fresh production install against the lean workspace (resolves esbuild, ajv, sharp, …).
FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04 AS deps
WORKDIR /app
COPY --from=build /runtime/ /app/
# Gateway-only workspace + stripped devDependencies — monorepo bun.lock is not
# a bit-for-bit match; allow lock refresh for this install-only stage.
# #637 note: a per-stage lock would pin this tree; deferred until assemble-runtime
# emits one. Prefer frozen monorepo lock when the lean workspace can use it.
RUN rm -f bun.lock && bun install --production

FROM node:26-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS runtime

ARG VERSION=0.1.0
ARG REVISION=unknown
LABEL org.opencontainers.image.title="centraid-gateway" \
  org.opencontainers.image.description="Centraid gateway HTTP control plane + native iroh tunnel" \
  org.opencontainers.image.source="https://github.com/srikanth235/centraid" \
  org.opencontainers.image.url="https://github.com/srikanth235/centraid" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.revision="${REVISION}" \
  org.opencontainers.image.licenses="SEE LICENSE IN REPOSITORY"

WORKDIR /app
ENV NODE_ENV=production \
  CENTRAID_KEYSTORE_CREDENTIAL_ROOT=/config/centraid/credentials

# git: apps-store / blueprint publish paths shell out to git.
# Non-root operator user; mount /data with matching UID/GID (10001) or chown.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 centraid \
  && useradd --system --uid 10001 --gid centraid --home-dir /app --shell /usr/sbin/nologin centraid \
  && mkdir -p /data /config \
  && chown centraid:centraid /data /config

COPY --from=deps --chown=centraid:centraid /app/ /app/

USER centraid
VOLUME ["/data", "/config"]
EXPOSE 8787

# Proves listen on loopback Host (always allowlisted). 200 or 401 = up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/centraid/_gateway/info').then((r)=>process.exit(r.status===200||r.status===401?0:1)).catch(()=>process.exit(1))"

# Bind all interfaces for container networks. Host allowlist still applies:
# clients using Host: localhost work; other Host names need CENTRAID_ALLOWED_HOSTS.
ENTRYPOINT ["node", "packages/server/dist/cli/cli.js", "serve", "--data-dir", "/data", "--host", "0.0.0.0", "--port", "8787"]
