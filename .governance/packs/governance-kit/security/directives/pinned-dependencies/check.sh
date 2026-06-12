#!/usr/bin/env bash
# Directive: pinned-dependencies — every third-party GitHub Action (anything
# outside the actions/* and github/* namespaces) is pinned to a full 40-char
# commit SHA, not a moving tag. This is the OpenSSF Scorecard
# "Pinned-Dependencies" check.
#
# It is one half of the retired `workflows-hardened` directive; the other half
# — workflows declaring a permissions block — now lives in `token-permissions`.
# This directive is the future home for the rest of the pinning family:
# container-image digests, install-command pinning (`curl | bash` bans), and
# manifest/lockfile sync.
#
# Rationale: tag pins are mutable; SHA pins are not. Tag-pinning is the gap the
# tj-actions/changed-files compromise exploited in 2025 — a moved tag silently
# swapped trusted code for an attacker's.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "pinned-dependencies"
require_git

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1

shopt -s nullglob
workflows=(.github/workflows/*.yml .github/workflows/*.yaml)
shopt -u nullglob

# No workflows is the domain of required-docs (ci-workflow sub-check); no-op here.
[[ ${#workflows[@]} -eq 0 ]] && directive_end

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
    # Match lines like:  uses: owner/repo@ref   or   - uses: owner/repo/path@ref
    # Skip local actions (./path) and docker actions (docker://...).
    while IFS=: read -r line_no line; do
        ref_spec=$(echo "$line" | sed -nE 's/.*uses:[[:space:]]*([^[:space:]#]+).*/\1/p')
        [[ -z "$ref_spec" ]] && continue
        [[ "$ref_spec" == ./* ]] && continue
        [[ "$ref_spec" == docker://* ]] && continue

        action="${ref_spec%@*}"
        ref="${ref_spec##*@}"

        # If no @ present, the spec is malformed — still flag it.
        if [[ "$action" == "$ref" ]]; then
            has_waiver "$wf" "$line_no" "pinned-dependencies" && continue
            violation "$wf — action '$ref_spec' has no version ref"
            continue
        fi

        if is_allowlisted "$action"; then
            continue
        fi

        # Require a full 40-char hex SHA.
        if [[ ! "$ref" =~ ^[0-9a-f]{40}$ ]]; then
            has_waiver "$wf" "$line_no" "pinned-dependencies" && continue
            violation "$wf — third-party action '$action@$ref' is not pinned to a commit SHA"
        fi
    done < <(grep -nE '^[[:space:]]*-?[[:space:]]*uses:' "$wf" 2>/dev/null || true)
done

directive_end
