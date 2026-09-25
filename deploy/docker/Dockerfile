# syntax=docker/dockerfile:1.7-labs
# THE `centraid` OPERATOR IMAGE (#1020, D-1020-G1). Build context: monorepo
# root.
#
# **THIS IS NOT THE SERVING IMAGE, AND HAS NOT BEEN SINCE W2** (#1029 §3).
# The gateway that serves is `crates/gateway-server` and its image is
# `deploy/gateway-server/Dockerfile`, whose `CMD` is `serve`. What the
# `centraid` binary has left is operator verbs a person runs and reads:
# `doctor`, and `gateway install`, which writes a service unit onto a host and
# is not something a container does at all.
#
# So the default command is `doctor`: ONE-SHOT, and it exits. A `docker run` of
# this image is a health report on the data directory you mounted, not a server
# you left running. Anything else is `docker run … centraid <verb>` through the
# ENTRYPOINT below.
#
# It used to be `CMD ["gateway", "--data-dir", "/data"]`, which W2 broke when it
# reduced the `gateway` verb to `gateway install` — the image built and then
# exited on `docker run`, for four months, because nothing checked. That is what
# `crates/centraid/tests/container.rs` is now for.
#
# Vault/data: bind-mount a host path or a named volume at /data — a bare run
# LOSES STATE when the container is removed. There is deliberately no anonymous
# `VOLUME` here: an anonymous volume is not durable, it just makes the loss
# quieter.
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
# NO REVERSE PROXY, NO TLS, NO BACKUP CRON — see deploy/README.md. Nothing here
# listens, so there is nothing to put a proxy in front of. The serving gateway's
# image is where those questions live (`deploy/gateway-server/README.md`).
#
# Base images are digest-pinned (multi-arch index), matching the Action SHA pin
# posture of .github/workflows/**.

FROM rust:1.94.1-slim-trixie@sha256:cf09adf8c3ebaba10779e5c23ff7fe4df4cccdab8a91f199b0c142c53fef3e1a AS build
WORKDIR /src

# `rusqlite` is built with `bundled`, so the SQLite amalgamation is compiled
# here and needs a C toolchain; `pkg-config` and `perl` are what the AEAD and
# compression crates' build scripts look for. No rustup install: the base image
# IS the pinned toolchain.
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

# THE TOOLCHAIN PIN IS ASSERTED, NOT INSTALLED. `rust-toolchain.toml` is the
# one version file, and copying it in here would make rustup try to SYNC the
# channel on every build: the base image's `rustc` is already 1.94.1, but the
# file also asks for a `minimal` profile and named components, which rustup
# answers by reaching out to static.rust-lang.org. That is a network round-trip
# per build, and on a host whose egress is proxied it is a build failure with a
# TLS error that says nothing about Centraid. So the version is compared
# instead, and a mismatch fails LOUDLY with both numbers rather than quietly
# building on whatever the base image happens to carry.
COPY rust-toolchain.toml /tmp/rust-toolchain.toml
RUN set -eu; \
  want="$(sed -n 's/^channel[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' /tmp/rust-toolchain.toml | head -1)"; \
  got="$(rustc --version | cut -d' ' -f2)"; \
  if [ "$want" != "$got" ]; then \
    echo "deploy/docker/Dockerfile: the base image is rustc $got and rust-toolchain.toml pins $want. Bump the FROM line (and its digest) to match; this image must not build on a channel the repository does not pin." >&2; \
    exit 1; \
  fi; \
  echo "toolchain $got matches rust-toolchain.toml"; \
  rm /tmp/rust-toolchain.toml

# Manifests only, so a source-only commit keeps the dependency layer warm
# (v0's #637 Phase 2 rule, kept). `--parents` needs the labs frontend declared
# at the top of this file.
COPY Cargo.toml Cargo.lock ./
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
LABEL org.opencontainers.image.title="centraid" \
  org.opencontainers.image.description="Centraid operator verbs over a vault directory: doctor, and the service install (#1029 §3). The serving gateway is deploy/gateway-server." \
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

# NO `EXPOSE`. This binary binds no socket of any kind: W2 deleted the iroh
# endpoint it once served, and what is left are operator verbs that read a data
# directory and exit. `crates/xtask`'s `no-listening-socket` rule is what keeps
# that true. An `EXPOSE` here would document a port that does not exist.

# NO `HEALTHCHECK`. A health check answers "is the long-running process in this
# container still serving", and there is no long-running process here — the
# default command is one-shot and exits. Docker would run the check against a
# container that has already stopped and report `unhealthy` forever, which is a
# false alarm rather than a signal. The serving image
# (`deploy/gateway-server/Dockerfile`) is where a health check belongs, and it
# has one.

ENTRYPOINT ["/usr/local/bin/centraid"]
CMD ["doctor", "--data-dir", "/data"]
