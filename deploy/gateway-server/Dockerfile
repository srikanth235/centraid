# THE STANDALONE GATEWAY, AS ONE IMAGE (#1029 §3). Build context: monorepo root.
#
# This is **not** `deploy/docker/Dockerfile`, and the difference is the whole of
# #1029 §6: that image runs `centraid`, which served an iroh QUIC endpoint to
# paired seats and bound no TCP listener at all. This one runs
# `centraid-gateway`, the standalone half of "one protocol, two deployments" —
# an HTTP server a phone dials over a name, which is why this file has an
# `EXPOSE` and that one deliberately does not.
#
# State: bind-mount a host path or a named volume at `/var/lib/centraid`. A bare
# run LOSES THE HOUSEHOLD'S BACKUP INDEX when the container is removed, which is
# the one failure worth being loud about; there is no anonymous `VOLUME` here
# because an anonymous volume is not durable, it only makes the loss quieter.
#
# NOT distroless, for the same reason `deploy/docker/Dockerfile` is not: a
# self-hoster debugging a tunnel at 11pm needs `docker exec` and a shell, and an
# image with none turns every incident into "rebuild the image with a shell in
# it". debian-slim is ~30 MB over distroless for that.
#
# Base images are digest-pinned, matching the Action SHA pin posture of
# `.github/workflows/**` and the sibling Dockerfile.

FROM rust:1.94.1-slim-trixie@sha256:cf09adf8c3ebaba10779e5c23ff7fe4df4cccdab8a91f199b0c142c53fef3e1a AS build
WORKDIR /src

# `rusqlite` is built with `bundled`, so the SQLite amalgamation is compiled
# here and needs a C toolchain; `pkg-config` and `perl` are what the AEAD and
# TLS crates' build scripts look for.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    perl \
    pkg-config \
  && rm -rf /var/lib/apt/lists/*

# THE TOOLCHAIN PIN IS ASSERTED, NOT INSTALLED — the sibling Dockerfile's
# reasoning, unchanged: copying `rust-toolchain.toml` in makes rustup sync the
# channel on every build, which on a proxied host is a build failure with a TLS
# error that says nothing about Centraid. A mismatch fails LOUDLY with both
# numbers instead.
COPY rust-toolchain.toml /tmp/rust-toolchain.toml
RUN set -eu; \
  want="$(sed -n 's/^channel[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' /tmp/rust-toolchain.toml | head -1)"; \
  got="$(rustc --version | cut -d' ' -f2)"; \
  if [ "$want" != "$got" ]; then \
    echo "deploy/gateway-server/Dockerfile: the base image is rustc $got and rust-toolchain.toml pins $want. Bump the FROM line (and its digest) to match; this image must not build on a channel the repository does not pin." >&2; \
    exit 1; \
  fi; \
  echo "toolchain $got matches rust-toolchain.toml"; \
  rm /tmp/rust-toolchain.toml

# `contracts/` is not optional here: `crates/gateway-core` reaches
# `contracts/gateway/schema.sql` through `include_str!`, and
# `crates/gateway-server` reaches every statement in
# `contracts/gateway/queries/` the same way. An image built without it does not
# compile, which is the right failure — the SQL is a contract between two
# adapters and is not a copy this crate carries.
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
COPY contracts ./contracts
COPY buf.yaml buf.gen.yaml ./

# `--locked`: the image is built from the lockfile the conformance suite passed
# against, never from whatever resolved that morning. An image whose dependency
# graph differs from the tested one is an image nothing has tested.
RUN cargo build --locked --profile dist -p centraid-gateway-server --bin centraid-gateway

# SYMBOLS ARE SPLIT, NOT DISCARDED (#1020, D-1020-G2/G7). `[profile.dist]`
# packs the DWARF beside the binary; the image ships the stripped executable and
# the `.dwp` is copied out for a release to publish. A stripped binary with no
# symbol file anywhere is a crash report nobody can read.
RUN set -eu; \
  install -D target/dist/centraid-gateway /out/centraid-gateway; \
  cp target/dist/centraid-gateway.dwp /out/centraid-gateway.dwp; \
  objcopy --strip-debug /out/centraid-gateway; \
  ls -l /out

FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132 AS runtime

ARG VERSION=1.0.0-alpha.0
ARG REVISION=unknown
LABEL org.opencontainers.image.title="centraid-gateway-server" \
  org.opencontainers.image.description="The standalone Centraid gateway: one binary anyone can self-host (#1029 §3)" \
  org.opencontainers.image.source="https://github.com/srikanth235/centraid" \
  org.opencontainers.image.url="https://github.com/srikanth235/centraid" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.revision="${REVISION}" \
  org.opencontainers.image.licenses="SEE LICENSE IN REPOSITORY"

# The CA bundle is for ACME and for an S3 endpoint over TLS. UID/GID 10001
# matches the sibling image, so an existing bind mount keeps working across the
# two.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 centraid \
  && useradd --system --uid 10001 --gid centraid --home-dir /var/lib/centraid --shell /usr/sbin/nologin centraid \
  && mkdir -p /var/lib/centraid \
  && chown centraid:centraid /var/lib/centraid

COPY --from=build /out/centraid-gateway /usr/local/bin/centraid-gateway

# AN UNPRIVILEGED USER, and the state directory is theirs. A container running
# as root would undo what `ProtectSystem=strict` buys on a bare-metal install,
# and the two shapes should not differ on this.
USER centraid
WORKDIR /var/lib/centraid

EXPOSE 8443

# THE ONE SETTING THAT HAS TO BE RIGHT. Proxied upload targets are built from
# it, so a wrong value authenticates fine, declares fine, and then hangs on a
# PUT to a name that does not resolve. It is an environment variable because a
# `CMD` cannot know a household's hostname.
ENV CENTRAID_GATEWAY_ORIGIN=""

# `/v1/health` is the health check because it is what a phone asks first: one
# endpoint, one meaning, and no second definition of "up" to drift from it. It
# answers on an empty server, before anybody has redeemed an invite.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD ["/usr/local/bin/centraid-gateway", "health", "--url", "http://127.0.0.1:8443"]

ENTRYPOINT ["/usr/local/bin/centraid-gateway"]
CMD ["serve", "--data-dir", "/var/lib/centraid", "--bind", "0.0.0.0:8443"]
