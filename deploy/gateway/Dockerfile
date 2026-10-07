# THE GATEWAY, AS ONE IMAGE (#1080). Build context: monorepo root.
#
#   docker build -f deploy/gateway/Dockerfile -t centraid-gateway .
#   docker run -d --name centraid-gateway --network host \
#     -v centraid-gateway:/var/lib/centraid centraid-gateway
#   docker logs centraid-gateway          # the first pairing QR, at first start
#   docker exec centraid-gateway centraid-gateway pair --data-dir /var/lib/centraid
#
# It runs `centraid-gateway` from `crates/gateway`. It serves HTTPS ITSELF
# with the self-signed certificate it mints at first start, which a phone pins
# from the pairing QR, so nothing terminates TLS in front of it and there is no
# origin to configure. Its health check is the gateway's own `health` verb,
# which trusts the certificate in the data directory.
#
# `--network host`, AND WHY. The pairing QR lists the addresses the gateway
# can see, and Bonjour advertises on the network it is on. Behind Docker's
# bridge both are the container's own: a QR naming 172.17.0.2 that no phone
# can dial, and an advertisement that never leaves the host. On host
# networking they are the machine's LAN addresses, which is what the phone
# needs. Without host networking (`-p 8443:8443`, and `--no-mdns` on the
# command) the gateway serves, but the QR it prints names addresses no phone
# can reach, so pairing from it fails: host networking is the supported shape.
#
# State: mount a volume or a host path at `/var/lib/centraid`. It holds the
# gateway's identity (`tls.key`, `tls.crt`, `gateway.id`), `state.db` and the
# objects. A run without one LOSES THE IDENTITY every phone pinned when the
# container is removed, and with it every pairing; there is no anonymous
# `VOLUME` because an anonymous volume only makes that loss quieter.
#
# NOT distroless, as the sibling images are not: an operator debugging at 11pm
# needs `docker exec` and a shell. Base images are digest-pinned, matching the
# sibling Dockerfiles.

FROM rust:1.94.1-slim-trixie@sha256:cf09adf8c3ebaba10779e5c23ff7fe4df4cccdab8a91f199b0c142c53fef3e1a AS build
WORKDIR /src

# `rusqlite` is built with `bundled`, so the SQLite amalgamation is compiled
# here, and `ring` builds its assembly: both need a C toolchain.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    perl \
    pkg-config \
  && rm -rf /var/lib/apt/lists/*

# THE TOOLCHAIN PIN IS ASSERTED, NOT INSTALLED, for the sibling's reason: a
# mismatch fails loudly with both numbers instead of a rustup sync failing
# behind a proxy.
COPY rust-toolchain.toml /tmp/rust-toolchain.toml
RUN set -eu; \
  want="$(sed -n 's/^channel[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' /tmp/rust-toolchain.toml | head -1)"; \
  got="$(rustc --version | cut -d' ' -f2)"; \
  if [ "$want" != "$got" ]; then \
    echo "deploy/gateway/Dockerfile: the base image is rustc $got and rust-toolchain.toml pins $want. Bump the FROM line (and its digest) to match." >&2; \
    exit 1; \
  fi; \
  echo "toolchain $got matches rust-toolchain.toml"; \
  rm /tmp/rust-toolchain.toml

# The whole workspace is copied because cargo reads every member's manifest
# to resolve one. `crates/gateway` keeps its SQL beside its adapter and
# reaches nothing in `contracts/`; it is copied so a member that does still
# resolves.
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
COPY contracts ./contracts
COPY buf.yaml buf.gen.yaml ./

# `--locked`: the image is the dependency graph the conformance suite passed
# against, never one resolved that morning.
RUN cargo build --locked --profile dist -p centraid-gateway --features server --bin centraid-gateway

# SYMBOLS ARE SPLIT, NOT DISCARDED (#1020): the image ships the stripped
# executable and the `.dwp` is kept beside it in the build stage for a release
# to publish.
RUN set -eu; \
  install -D target/dist/centraid-gateway /out/centraid-gateway; \
  cp target/dist/centraid-gateway.dwp /out/centraid-gateway.dwp; \
  objcopy --strip-debug /out/centraid-gateway; \
  ls -l /out

FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132 AS runtime

ARG VERSION=1.0.0-alpha.0
ARG REVISION=unknown
LABEL org.opencontainers.image.title="centraid-gateway" \
  org.opencontainers.image.description="The Centraid gateway, protocol v2: a blind store a phone backs its vault up to, directly (#1080)" \
  org.opencontainers.image.source="https://github.com/srikanth235/centraid" \
  org.opencontainers.image.url="https://github.com/srikanth235/centraid" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.revision="${REVISION}" \
  org.opencontainers.image.licenses="SEE LICENSE IN REPOSITORY"

# No CA bundle: the gateway dials nothing outward. Its one client call is
# `health` dialling itself, trusting its own certificate by its bytes. UID and
# GID 10001 match the sibling images, so a bind mount keeps its owner.
RUN groupadd --system --gid 10001 centraid \
  && useradd --system --uid 10001 --gid centraid --home-dir /var/lib/centraid --shell /usr/sbin/nologin centraid \
  && mkdir -p /var/lib/centraid \
  && chown centraid:centraid /var/lib/centraid \
  && chmod 0700 /var/lib/centraid

COPY --from=build /out/centraid-gateway /usr/local/bin/centraid-gateway

# AN UNPRIVILEGED USER, and the data directory is theirs: the container must
# not undo what the systemd unit's sandbox buys on a bare-metal install.
USER centraid
WORKDIR /var/lib/centraid

EXPOSE 8443

# `health` dials the address `serve` recorded in the data directory — its own
# loopback for a gateway bound to every interface — trusting the certificate
# beside it, and prints `GET /v2/info`. It answers on an empty gateway, before
# any phone has paired.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD ["/usr/local/bin/centraid-gateway", "health", "--data-dir", "/var/lib/centraid"]

ENTRYPOINT ["/usr/local/bin/centraid-gateway"]
CMD ["serve", "--data-dir", "/var/lib/centraid", "--bind", "0.0.0.0:8443"]
