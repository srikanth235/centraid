# Cloud Agent base image for Centraid monorepo development.
# Stable OS packages and toolchains live here; repository setup runs in install.
FROM node:24.4.1-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    git \
    python3 \
  && rm -rf /var/lib/apt/lists/* \
  && if ! id ubuntu >/dev/null 2>&1; then useradd -m -s /bin/bash ubuntu; fi

USER ubuntu

ENV BUN_INSTALL=/home/ubuntu/.bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/home/ubuntu/.bun/bin:${PATH}"

# fnm keeps Node aligned with .node-version when /exec-daemon/node overrides PATH.
ENV FNM_DIR=/home/ubuntu/.local/share/fnm
RUN curl -fsSL https://fnm.vercel.app/install | bash -s -- --install-dir "${FNM_DIR}" --skip-shell
ENV PATH="${FNM_DIR}:${PATH}"
RUN fnm install 24.4.1 && fnm default 24.4.1
