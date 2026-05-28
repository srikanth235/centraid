#!/usr/bin/env bash
# Directive: GitHub Actions workflows are hardened against supply-chain abuse.
# Two sub-checks:
#   1. Each workflow declares a `permissions:` block (top-level or per-job)
#      to enforce least-privilege.
#   2. Every third-party action (anything outside the actions/* and github/*
#      namespaces) is pinned to a full 40-char commit SHA — not a moving tag.
# Rationale: GitHub Security explicitly recommends both. Tag-pinning is the gap
# the tj-actions/changed-files compromise exploited in 2025.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "workflows-hardened"
require_git

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1

shopt -s nullglob
workflows=(.github/workflows/*.yml .github/workflows/*.yaml)
shopt -u nullglob

if [[ ${#workflows[@]} -eq 0 ]]; then
    # No workflows is the domain of required-docs (ci-workflow sub-check); this directive is a no-op.
    directive_end
fi

# Trusted namespaces where tag pinning is acceptable.
allowlist_prefixes=(
    "actions/"
    "github/"
)

is_allowlisted() {
    local action="$1"
    for prefix in "${allowlist_prefixes[@]}"; do
        [[ "$action" == "$prefix"* ]] && return 0
    done
    return 1
}

for wf in "${workflows[@]}"; do
    # ── Sub-check 1: permissions block present somewhere ──
    if ! grep -qE '^[[:space:]]*permissions:' "$wf"; then
        violation "$wf — no 'permissions:' block (least-privilege hardening)"
    fi

    # ── Sub-check 2: third-party actions pinned to SHA ──
    # Match lines like:  uses: owner/repo@ref   or   - uses: owner/repo/path@ref
    # Skip local actions (./path) and docker actions (docker://...).
    while IFS= read -r line; do
        # Extract the "owner/repo...@ref" part.
        ref_spec=$(echo "$line" | sed -nE 's/.*uses:[[:space:]]*([^[:space:]#]+).*/\1/p')
        [[ -z "$ref_spec" ]] && continue
        [[ "$ref_spec" == ./* ]] && continue
        [[ "$ref_spec" == docker://* ]] && continue

        action="${ref_spec%@*}"
        ref="${ref_spec##*@}"

        # If no @ present, the spec is malformed — still flag it.
        if [[ "$action" == "$ref" ]]; then
            violation "$wf — action '$ref_spec' has no version ref"
            continue
        fi

        if is_allowlisted "$action"; then
            continue
        fi

        # Require a full 40-char hex SHA.
        if [[ ! "$ref" =~ ^[0-9a-f]{40}$ ]]; then
            violation "$wf — third-party action '$action@$ref' is not pinned to a commit SHA"
        fi
    done < <(grep -nE '^[[:space:]]*-?[[:space:]]*uses:' "$wf" 2>/dev/null || true)
done

directive_end
