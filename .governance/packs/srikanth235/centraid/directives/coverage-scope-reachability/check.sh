#!/usr/bin/env bash
# Directive: coverage-scope-reachability (#532).
#
# Every packages/*, apps/*, or tools/* tree with non-test TS source must be:
#   (a) covered by a tests/coverage-floors.json glob, OR
#   (b) named as owner path prefix in tests/matrix.json, OR
#   (c) listed in this directive's allowlist.txt
#
# The bundled blueprint runtime is intentionally co-located outside `src/`.
# Treat its executable `apps/` and `kit/` trees as first-class scopes instead
# of collapsing them into `packages/blueprints`, whose `src/` floor cannot
# instrument either tree.
#
# Also: every coverage-floors.json path-scope must sit under packages/, apps/,
# or tools/.
#
# Bash 3.2 compatible (macOS /bin/bash) — no mapfile, no associative arrays.
#
# Self-test: GOVERNANCE_COVERAGE_SCOPE_SELFTEST=1 proves violation + exit
# wiring by emitting a synthetic unowned package id. It does not re-run the
# classification loop against a real packages/* tree — that is what the live
# check (scripts/test.sh step 2) covers.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "coverage-scope-reachability"
require_git

REPO_ROOT="$(git rev-parse --show-toplevel)"
DIR="$(cd "$(dirname "$0")" && pwd)"
FLOORS="$REPO_ROOT/tests/coverage-floors.json"
MATRIX="$REPO_ROOT/tests/matrix.json"
ALLOWLIST="$DIR/allowlist.txt"
VITEST_CFG="$REPO_ROOT/vitest.config.ts"

if [[ ! -f "$FLOORS" || ! -f "$MATRIX" ]]; then
    violation "tests/coverage-floors.json and tests/matrix.json are required"
    directive_end
    exit 0
fi

# --- self-test path (output/exit wiring only) ---
if [[ "${GOVERNANCE_COVERAGE_SCOPE_SELFTEST:-0}" == "1" ]]; then
    synthetic="tools/__coverage_scope_selftest_unowned__"
    if grep -q "$synthetic" "$FLOORS" 2>/dev/null; then
        echo "self-test: synthetic id unexpectedly present in floors" >&2
        exit 1
    fi
    if grep -q "$synthetic" "$MATRIX" 2>/dev/null; then
        echo "self-test: synthetic id unexpectedly present in matrix" >&2
        exit 1
    fi
    if grep -qE "^${synthetic}$" "$ALLOWLIST" 2>/dev/null; then
        echo "self-test: synthetic id unexpectedly allowlisted" >&2
        exit 1
    fi
    violation "$synthetic/src/index.ts - package has source but no coverage floor, matrix owner, or allowlist entry (self-test)"
    directive_end
    exit 0
fi

# Floor path scopes (object-valued keys in coverage-floors.json).
FLOOR_GLOBS="$(
    python3 - "$FLOORS" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
for k, v in data.items():
    if k.startswith("_") or k == "approvedDeviation":
        continue
    if isinstance(v, dict):
        print(k)
PY
)"

# Vitest coverage include must still instrument the conventional source roots
# plus tools and both non-standard blueprint runtime roots.
if [[ -f "$VITEST_CFG" ]]; then
    if ! grep -q "packages/\*/src/\*\*" "$VITEST_CFG" && ! grep -q 'packages/*/src/**' "$VITEST_CFG"; then
        violation "vitest.config.ts coverage.include must cover packages/*/src/** (floors would be unreachable)"
    fi
    if ! grep -q "tools/\*/src/\*\*" "$VITEST_CFG" && ! grep -q 'tools/*/src/**' "$VITEST_CFG"; then
        violation "vitest.config.ts coverage.include must cover tools/*/src/** (tool floors would be unreachable)"
    fi
    if ! grep -Fq "packages/blueprints/apps/**" "$VITEST_CFG"; then
        violation "vitest.config.ts coverage.include must cover packages/blueprints/apps/** (bundled app code would be invisible)"
    fi
    if ! grep -Fq "packages/design/kit/**" "$VITEST_CFG"; then
        violation "vitest.config.ts coverage.include must cover packages/design/kit/** (shared blueprint runtime would be invisible)"
    fi
fi

# Each floor glob must target packages/, apps/, or tools/.
while IFS= read -r glob; do
    [[ -z "$glob" ]] && continue
    case "$glob" in
    packages/* | apps/* | tools/*) ;;
    *)
        violation "coverage floor scope '$glob' is outside packages/*/src, apps/*/src, or tools/*/src — unreachable by default coverage include"
        ;;
    esac
done <<<"$FLOOR_GLOBS"

# Allowlist lines (non-comment).
ALLOW_LINES="$(
    if [[ -f "$ALLOWLIST" ]]; then
        grep -vE '^\s*(#|$)' "$ALLOWLIST" || true
    fi
)"

# Matrix owner paths.
OWNERS="$(
    python3 - "$MATRIX" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
for flow in data.get("flows", []):
    owner = flow.get("owner")
    if isinstance(owner, str) and owner.strip():
        print(owner.strip())
PY
)"

# Package/app ids that have non-test source.
# git's **/ requires an intervening directory, so also list flat src/*.ts
# (blob-format, blueprints, cli, protocol, test-kit, tunnel, extension,
# oauth-worker, web, …) — #545 A3.
PKG_IDS="$(
    git -C "$REPO_ROOT" ls-files \
        'packages/*/src/**/*.ts' 'packages/*/src/**/*.tsx' \
        'packages/*/src/*.ts' 'packages/*/src/*.tsx' \
        'apps/*/src/**/*.ts' 'apps/*/src/**/*.tsx' \
        'apps/*/src/*.ts' 'apps/*/src/*.tsx' \
        'tools/*/src/**/*.ts' 'tools/*/src/**/*.tsx' \
        'tools/*/src/*.ts' 'tools/*/src/*.tsx' 2>/dev/null \
        | grep -vE '\.(test|spec)\.(ts|tsx)$|\.d\.ts$' \
        | awk -F/ '{print $1"/"$2}' \
        | sort -u
)"

# Non-standard executable roots under packages/blueprints. Keep them separate:
# a floor on packages/blueprints/src/** must not accidentally satisfy either.
BLUEPRINT_SCOPE_IDS="$(
    for scope in packages/blueprints/apps packages/design/kit; do
        if git -C "$REPO_ROOT" ls-files \
            "$scope/**/*.ts" "$scope/**/*.tsx" "$scope/**/*.js" "$scope/**/*.mjs" \
            "$scope/*.ts" "$scope/*.tsx" "$scope/*.js" "$scope/*.mjs" 2>/dev/null \
            | grep -qvE '\.(test|spec)\.(ts|tsx|js|mjs)$|\.d\.ts$'; then
            echo "$scope"
        fi
    done
)"

is_floored() {
    local pkg="$1"
    local g
    while IFS= read -r g; do
        [[ -z "$g" ]] && continue
        case "$g" in
        "$pkg" | "$pkg"/*) return 0 ;;
        esac
    done <<<"$FLOOR_GLOBS"
    return 1
}

has_matrix_owner() {
    local pkg="$1"
    local o
    while IFS= read -r o; do
        [[ -z "$o" ]] && continue
        case "$o" in
        "$pkg" | "$pkg"/*) return 0 ;;
        esac
    done <<<"$OWNERS"
    return 1
}

is_allowlisted() {
    local pkg="$1"
    local a
    while IFS= read -r a; do
        [[ -z "$a" ]] && continue
        if [[ "$a" == "$pkg" ]]; then
            return 0
        fi
    done <<<"$ALLOW_LINES"
    return 1
}

while IFS= read -r pkg; do
    [[ -z "$pkg" ]] && continue
    if is_allowlisted "$pkg"; then
        continue
    fi
    if is_floored "$pkg"; then
        continue
    fi
    if has_matrix_owner "$pkg"; then
        continue
    fi
    violation "$pkg - has src/ TypeScript but no coverage floor, matrix owner, or allowlist entry (add a floor, matrix flow, or allowlist.txt row)"
done <<<"$PKG_IDS"

while IFS= read -r scope; do
    [[ -z "$scope" ]] && continue
    if is_allowlisted "$scope"; then
        continue
    fi
    if is_floored "$scope"; then
        continue
    fi
    if has_matrix_owner "$scope"; then
        continue
    fi
    violation "$scope - has executable blueprint code but no coverage floor, matrix owner, or allowlist entry (add a floor, matrix flow, or allowlist.txt row)"
done <<<"$BLUEPRINT_SCOPE_IDS"

directive_end
