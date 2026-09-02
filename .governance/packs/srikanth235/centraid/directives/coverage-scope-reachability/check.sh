#!/usr/bin/env bash
# Directive: coverage-scope-reachability (#532).
#
# Every packages/* or apps/* tree with non-test TS source must be:
#   (a) covered by a tests/floors.json#coverage glob, OR
#   (b) named as an owner path prefix in the DERIVED flow view
#       (`node scripts/test-report/derive-flows.mjs --json`), OR
#   (c) listed in this directive's allowlist.txt
#
# #915 replaced `tests/matrix.json` with `tests/claims.json` plus the mobile
# roster, so flow ownership is no longer readable from one file. The derived
# view is a deterministic, offline CLI over both - one place to change when the
# sources move again, and the same view the report renders from.
#
# #915 Wave 4 merged the twenty tighten-only ledgers under tests/ into four.
# The coverage floors are the `coverage` SECTION of tests/floors.json - the
# same object, the same object-valued-key rule, one level deeper.
#
# Executable code co-located OUTSIDE `src/` is its own scope, not part of the
# package's. A floor on `packages/<pkg>/src/**` cannot instrument a sibling
# tree, so collapsing the two would let any non-`src` runtime tree ride into
# "floored" on a floor that never measures it. This is why the bundled
# blueprint `apps/` runtime is a separate scope (#630, #725) — and, since
# #781, why every such tree is discovered rather than named:
# `packages/model-runtime/automation-handlers` (the hand-authored source of
# the published recognition bundles) was invisible for exactly this reason
# while `packages/model-runtime/src/**` reported the package "floored".
#
# The shared browser substrate was a second named tree (`packages/design/kit`)
# until #799 folded it into `packages/design/src/elements`. A tree that moves
# INTO `src/` stops being a scope of its own and rides its package's `src/**`
# floor and the conventional coverage include — so the named assertion below
# is one line shorter, and the generic discovery keeps watch over whatever
# lands outside `src/` next.
#
# Also: every tests/floors.json#coverage path-scope must sit under packages/ or
# apps/.
#
# Bash 3.2 compatible (macOS /bin/bash) — no mapfile, no associative arrays.
#
# Self-test: GOVERNANCE_COVERAGE_SCOPE_SELFTEST=1 replaces the discovered ids
# with one synthetic package id and one synthetic non-`src` scope id, then runs
# the real classification loops over them — so it proves violation + exit
# wiring for BOTH scope classes without depending on the state of any real
# packages/* tree. The live check (scripts/test.sh step 2) covers the real
# trees.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "coverage-scope-reachability"
require_git

REPO_ROOT="$(git rev-parse --show-toplevel)"
DIR="$(cd "$(dirname "$0")" && pwd)"
FLOORS="$REPO_ROOT/tests/floors.json"
CLAIMS="$REPO_ROOT/tests/claims.json"
DERIVE_FLOWS="$REPO_ROOT/scripts/test-report/derive-flows.mjs"
ALLOWLIST="$DIR/allowlist.txt"
VITEST_CFG="$REPO_ROOT/vitest.config.ts"

if [[ ! -f "$FLOORS" || ! -f "$CLAIMS" || ! -f "$DERIVE_FLOWS" ]]; then
    violation "tests/floors.json, tests/claims.json and scripts/test-report/derive-flows.mjs are required"
    directive_end
    exit 0
fi

# --- self-test guard: the synthetic ids must be genuinely unowned ---
SELFTEST="${GOVERNANCE_COVERAGE_SCOPE_SELFTEST:-0}"
SYNTHETIC_PKG="packages/__coverage_scope_selftest_unowned__"
SYNTHETIC_SCOPE="packages/__coverage_scope_selftest_unowned__/runtime"
if [[ "$SELFTEST" == "1" ]]; then
    for synthetic in "$SYNTHETIC_PKG" "$SYNTHETIC_SCOPE"; do
        if grep -q "$synthetic" "$FLOORS" 2>/dev/null; then
            echo "self-test: synthetic id unexpectedly present in floors" >&2
            exit 1
        fi
        if grep -q "$synthetic" "$CLAIMS" 2>/dev/null; then
            echo "self-test: synthetic id unexpectedly present in the claims file" >&2
            exit 1
        fi
        if grep -qE "^${synthetic}$" "$ALLOWLIST" 2>/dev/null; then
            echo "self-test: synthetic id unexpectedly allowlisted" >&2
            exit 1
        fi
    done
fi

# Floor path scopes (object-valued keys in tests/floors.json#coverage).
FLOOR_GLOBS="$(
    python3 - "$FLOORS" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)["coverage"]
for k, v in data.items():
    if k.startswith("_") or k == "approvedDeviation":
        continue
    if isinstance(v, dict):
        print(k)
PY
)"

# Vitest coverage include must still instrument the conventional source roots
# plus the non-standard blueprint runtime root.
if [[ -f "$VITEST_CFG" ]]; then
    if ! grep -q "packages/\*/src/\*\*" "$VITEST_CFG" && ! grep -q 'packages/*/src/**' "$VITEST_CFG"; then
        violation "vitest.config.ts coverage.include must cover packages/*/src/** (floors would be unreachable)"
    fi
    if ! grep -Fq "packages/blueprints/apps/**" "$VITEST_CFG"; then
        violation "vitest.config.ts coverage.include must cover packages/blueprints/apps/** (bundled app code would be invisible)"
    fi
fi

# Each floor glob must target packages/ or apps/.
while IFS= read -r glob; do
    [[ -z "$glob" ]] && continue
    case "$glob" in
    packages/* | apps/*) ;;
    *)
        violation "coverage floor scope '$glob' is outside packages/*/src or apps/*/src — unreachable by default coverage include"
        ;;
    esac
done <<<"$FLOOR_GLOBS"

# Allowlist lines (non-comment).
ALLOW_LINES="$(
    if [[ -f "$ALLOWLIST" ]]; then
        grep -vE '^\s*(#|$)' "$ALLOWLIST" || true
    fi
)"

# Flow owner paths, from the derived view. The CLI is deterministic and does no
# network or clock work, so this stays a pure function of the working tree.
OWNERS="$(
    node "$DERIVE_FLOWS" --json | python3 -c '
import json, sys
data = json.load(sys.stdin)
for flow in data.get("flows", []):
    owner = flow.get("owner")
    if isinstance(owner, str) and owner.strip():
        print(owner.strip())
'
)"
if [[ -z "$OWNERS" ]]; then
    violation "scripts/test-report/derive-flows.mjs emitted no flow owners - a silent empty view would let every unfloored package pass"
fi

# Package/app ids that have non-test source.
# git's **/ requires an intervening directory, so also list flat src/*.ts
# (blob-format, blueprints, cli, protocol, test-kit, tunnel, extension,
# oauth-worker, web, …) — #545 A3.
PKG_IDS="$(
    git -C "$REPO_ROOT" ls-files \
        'packages/*/src/**/*.ts' 'packages/*/src/**/*.tsx' \
        'packages/*/src/*.ts' 'packages/*/src/*.tsx' \
        'apps/*/src/**/*.ts' 'apps/*/src/**/*.tsx' \
        'apps/*/src/*.ts' 'apps/*/src/*.tsx' 2>/dev/null \
        | grep -vE '\.(test|spec)\.(ts|tsx)$|\.d\.ts$' \
        | awk -F/ '{print $1"/"$2}' \
        | sort -u
)"

# Executable trees co-located OUTSIDE `src/` inside a package or app, e.g.
# packages/blueprints/apps, packages/model-runtime/automation-handlers.
# Discovered, not enumerated
# (#781): a hardcoded list only ever names the trees someone already thought
# about, and the next one lands invisible. Each is its own scope id, so the
# package's `src/**` floor cannot satisfy it.
#
# Skipped by directory name: `src` (owned by the package loop above) and the
# dirs that are by definition not product runtime — build/dev scripts, test
# trees, fixtures, and build output. Files nested under one of those inside a
# scope are skipped too, so a tree whose only code is a generator script is not
# a runtime scope.
SCOPE_SKIP_DIRS='src|scripts|tests|test|spec|e2e|__tests__|benchmarks|fixtures|node_modules|dist|build|coverage|target'
EXTRA_SCOPE_IDS="$(
    git -C "$REPO_ROOT" ls-files 'packages/*/*/**' 'apps/*/*/**' 2>/dev/null \
        | grep -E '\.(ts|tsx|js|jsx|mjs|cjs)$' \
        | grep -vE '\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$|\.d\.ts$' \
        | awk -F/ -v skip="^($SCOPE_SKIP_DIRS)$" '
            $3 ~ skip { next }
            {
                for (i = 4; i < NF; i++)
                    if ($i ~ skip) next
                print $1"/"$2"/"$3
            }' \
        | sort -u
)"

if [[ "$SELFTEST" == "1" ]]; then
    PKG_IDS="$SYNTHETIC_PKG"
    EXTRA_SCOPE_IDS="$SYNTHETIC_SCOPE"
fi

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

has_flow_owner() {
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

# An allowlisted package or app covers its own non-`src` trees too: a surface
# that is deliberately ungated as a whole (apps/mobile, apps/web, …) does not
# become gated by moving code out of src/.
is_allowlisted() {
    local pkg="$1"
    local a
    while IFS= read -r a; do
        [[ -z "$a" ]] && continue
        case "$pkg" in
        "$a" | "$a"/*) return 0 ;;
        esac
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
    if has_flow_owner "$pkg"; then
        continue
    fi
    violation "$pkg - has src/ TypeScript but no coverage floor, derived flow owner, or allowlist entry (add a floor, a tests/claims.json flow, or an allowlist.txt row)"
done <<<"$PKG_IDS"

while IFS= read -r scope; do
    [[ -z "$scope" ]] && continue
    if is_allowlisted "$scope"; then
        continue
    fi
    if is_floored "$scope"; then
        # A floored non-`src` tree is only floored if the coverage tool
        # instruments it — `packages/*/src/**` never will (#781).
        if [[ "$SELFTEST" != "1" && -f "$VITEST_CFG" ]] \
            && ! grep -Fq "$scope/" "$VITEST_CFG"; then
            violation "vitest.config.ts coverage.include must cover $scope/** (its floor measures nothing without it)"
        fi
        continue
    fi
    if has_flow_owner "$scope"; then
        continue
    fi
    violation "$scope - executable code outside src/ with no coverage floor, derived flow owner, or allowlist entry; the package's src/** floor cannot instrument it (add a floor, a tests/claims.json flow, or an allowlist.txt row)"
done <<<"$EXTRA_SCOPE_IDS"

directive_end
