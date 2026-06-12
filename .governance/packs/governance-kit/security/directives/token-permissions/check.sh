#!/usr/bin/env bash
# Directive: token-permissions — every GitHub Actions workflow declares a
# `permissions:` block (top-level or per-job) so jobs run least-privilege
# instead of inheriting the repository's broad default token. This is the
# OpenSSF Scorecard "Token-Permissions" check.
#
# It is one half of the retired `workflows-hardened` directive; the other half
# — third-party action SHA pinning — now lives in `pinned-dependencies`.
#
# Rationale: a workflow with no `permissions:` block inherits a default that
# most jobs do not need. A compromised step (or action) then has write access
# it should never have had.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "token-permissions"
require_git

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1

shopt -s nullglob
workflows=(.github/workflows/*.yml .github/workflows/*.yaml)
shopt -u nullglob

# No workflows is the domain of required-docs (ci-workflow sub-check); no-op here.
[[ ${#workflows[@]} -eq 0 ]] && directive_end

for wf in "${workflows[@]}"; do
    if ! grep -qE '^[[:space:]]*permissions:' "$wf"; then
        # File-level waiver: a head-of-file token documents the exception.
        if head -n 10 "$wf" 2>/dev/null | grep -q "governance: allow-token-permissions"; then
            continue
        fi
        violation "$wf — no 'permissions:' block (least-privilege hardening)"
    fi
done

directive_end
