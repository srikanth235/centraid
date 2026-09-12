# syntax=docker/dockerfile:1.7-labs
# THE v1 GATEWAY IMAGE (#1020, D-1020-G1). Build context: monorepo root.
#
# Vault/data: bind-mount a host path or a named volume at /data — a bare run
# LOSES STATE when the container is removed. There is deliberately no anonymous
# `VOLUME` here: an anonymous volume is not durable, it just makes the loss
# quieter (the same reason gateway-v0.Dockerfile says so at its top).
#
# WHAT CHANGED FROM v0. The runtime is the `centraid` binary, so the image no
# longer carries bun, node, rustup, a napi artifact or a package tree: the build
# stage is Rust on the pinned toolchain and the runtime stage is
# debian-trixie-slim plus one statically-known executable. The layering rule v0
# established is kept because it is what makes a source-only commit cheap:
# manifests are copied first, dependencies are built against them, and sources
# arrive afterwards.
#
# NOT distroless, and that is a decision rather than an omission: `centraid
# doctor` and `centraid recover` are operator verbs run with `docker exec`, and
# an image with no shell turns every incident into "rebuild the image with a
# shell in it". debian-slim is ~30 MB over distroless for a shell, ca-
# certificates and coreutils.
#
# NO REVERSE PROXY, NO TLS, NO BACKUP CRON — see deploy/README.md. iroh is QUIC
# over UDP with its own transport encryption and needs none of the three, and
# backup is the gateway's own scheduler.
#
# Base images are digest-pinned (multi-arch index), matching the Action SHA pin
# posture of .github/workflows/**.

FROM rust:1.94.1-slim-trixie@sha256:cf09adf8c3ebaba10779e5c23ff7fe4df4cccdab8a91f199b0c142c53fef3e1a AS build
WORKDIR /src

# `rusqlite` is built with `bundled`, so the SQLite amalgamation is compiled
# here and needs a C toolchain; `pkg-config` and `perl` are what the AEAD and
# compression crates' build scripts look for. No rustup install: the base image
# IS the pinned toolchain, and rust-toolchain.toml is copied in below so a
# mismatch between the two fails loudly instead of silently building on the
# base image's channel.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    perl \
    pkg-config \
  && rm -rf /var/lib/apt/lists/*

# THE IDENTITY STAMP (#1020 Artifacts, D-1020-G2). Passed in by the release
# workflow; absent here, `crates/centraid/build.rs` marks the build `dev` and
# `centraid --version --json` says so. An image that silently claimed a git sha
# it did not have would break every shell-side digest check in a way that looks
# like a pairing bug.
ARG CENTRAID_BUILD_GIT_SHA=""
ARG CENTRAID_BUILD_DIGEST=""
ENV CENTRAID_BUILD_GIT_SHA=${CENTRAID_BUILD_GIT_SHA} \
  CENTRAID_BUILD_DIGEST=${CENTRAID_BUILD_DIGEST}

# Manifests and the toolchain pin only, so a source-only commit keeps the
# dependency layer warm (v0's #637 Phase 2 rule, kept). `--parents` needs the
# labs frontend declared at the top of this file.
COPY rust-toolchain.toml Cargo.toml Cargo.lock ./
COPY --parents crates/*/Cargo.toml crates/apps/*/Cargo.toml ./

# A dependency-only build. Every member gets a placeholder root so cargo can
# resolve and compile the graph; the real sources replace them below and only
# our own crates recompile. `--bin centraid` is not available yet at this stage
# (the placeholders have no bin target), so the whole graph is built as libs.
RUN set -eu; \
  for manifest in crates/*/Cargo.toml crates/apps/*/Cargo.toml; do \
    dir="$(dirname "$manifest")"; \
    mkdir -p "$dir/src"; \
    : > "$dir/src/lib.rs"; \
    printf 'fn main() {}\n' > "$dir/src/main.rs"; \
  done; \
  cargo build --profile dist --workspace || true

# The real sources. `contracts/` is copied because several crates read its
# fixtures through `include_str!`-shaped paths at build time.
COPY crates ./crates
COPY contracts ./contracts
COPY buf.yaml buf.gen.yaml ./

# `touch` defeats the placeholder mtimes cargo cached above.
RUN set -eu; \
  find crates -name '*.rs' -exec touch {} +; \
  cargo build --profile dist --bin centraid

# SYMBOLS ARE SPLIT, NOT DISCARDED (#1020, D-1020-G2/G7). `[profile.dist]`
# carries `split-debuginfo = "packed"`, so cargo has already written the DWARF
# to `centraid.dwp` beside the binary — one file, which is what a published
# symbol artifact has to be. The image ships the STRIPPED binary and the `.dwp`
# is copied out for the release to publish; a stripped binary with no symbol
# file anywhere is a crash report nobody can read.
RUN set -eu; \
  install -D target/dist/centraid /out/centraid; \
  cp target/dist/centraid.dwp /out/centraid.dwp; \
  objcopy --strip-debug /out/centraid; \
  ls -l /out

FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132 AS runtime

ARG VERSION=1.0.0-alpha.0
ARG REVISION=unknown
LABEL org.opencontainers.image.title="centraid-gateway" \
  org.opencontainers.image.description="Centraid gateway: the iroh endpoint, the device allowlist and the vault's authority (#1020)" \
  org.opencontainers.image.source="https://github.com/srikanth235/centraid" \
  org.opencontainers.image.url="https://github.com/srikanth235/centraid" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.revision="${REVISION}" \
  org.opencontainers.image.licenses="SEE LICENSE IN REPOSITORY"

# Non-root operator user, UID/GID 10001 as v0's image used, so an existing
# bind mount keeps working across the two.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 centraid \
  && useradd --system --uid 10001 --gid centraid --home-dir /data --shell /usr/sbin/nologin centraid \
  && mkdir -p /data \
  && chown centraid:centraid /data

COPY --from=build /out/centraid /usr/local/bin/centraid

USER centraid
WORKDIR /data

# NO `EXPOSE`. The gateway binds no TCP listener at all — it is a QUIC/UDP iroh
# endpoint dialled by node id, enforced by `crates/xtask`'s `no-listening-socket`
# rule and by `crates/centraid/tests/no_listener.rs`. An `EXPOSE 8787` here
# would document a port that does not exist.

# `doctor` is the health check because it is the check an operator runs by hand:
# one command, one meaning, and no second definition of "up" to drift.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD ["/usr/local/bin/centraid", "doctor", "--data-dir", "/data"]

ENTRYPOINT ["/usr/local/bin/centraid"]
CMD ["gateway", "--data-dir", "/data"]
