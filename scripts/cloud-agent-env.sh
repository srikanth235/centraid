#!/usr/bin/env bash
# Shared toolchain PATH for Cloud Agent scripts. Centraid requires Node 24.4.1
# (node:sqlite FTS5); the VM's /exec-daemon/node is v22 and must not win.
export PATH="${HOME}/.bun/bin:${HOME}/.local/share/fnm:${PATH}"

if command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env)"
  fnm use 24.4.1 2>/dev/null || fnm install 24.4.1
  fnm use 24.4.1
elif [ -x "${HOME}/.local/share/fnm/node-versions/v24.4.1/installation/bin/node" ]; then
  export PATH="${HOME}/.local/share/fnm/node-versions/v24.4.1/installation/bin:${PATH}"
fi
