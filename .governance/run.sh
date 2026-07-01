#!/usr/bin/env bash
# governance-kit:managed kit-version=0.12.0
# Governance test runner. Discovers every directive under ./packs/<owner>/<name>/.
# Directives are folder-shaped — each directive is `directives/<id>/check.sh`.
# Anything the directive needs (lib/, hooks/, runtimes/) lives in the same folder.
# Exits 0 if all directive checks pass, 1 if any fails.
#
# Usage:
#   bash .governance/run.sh              # run all directive checks
#   bash .governance/run.sh required-docs   # run a single directive by id
#
# Environment:
#   SKIP_GOVERNANCE=1   skip all directive checks (for emergency commits)

set -u

if [[ "${SKIP_GOVERNANCE:-0}" == "1" ]]; then
    echo "⊘ governance skipped (SKIP_GOVERNANCE=1)"
    exit 0
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
PACKS_DIR="$HERE/packs"

# Sub-agent attestation orchestration (issue #325). A directive that declares a
# `subagent:` block registers any pending attestation into a shared ledger when
# its check.sh runs; after the whole run we emit ONE grouped remediation
# instruction (shared-batched + isolated). Sourcing lib.sh provides
# attestation_remediation; exporting the ledger path makes it visible to each
# `bash "$check"` subprocess. Guarded so an older lib.sh (no helper) is a no-op.
ATTEST_LEDGER=""
if [[ -f "$HERE/lib.sh" ]]; then
    # shellcheck disable=SC1091
    source "$HERE/lib.sh"
    if declare -F attestation_remediation >/dev/null 2>&1; then
        ATTEST_LEDGER="$(mktemp)"
        export GOVERNANCE_ATTEST_LEDGER="$ATTEST_LEDGER"
        trap 'rm -f "$ATTEST_LEDGER"' EXIT
    fi
fi

check_files=()
while IFS= read -r f; do
    [[ -n "$f" ]] && check_files+=("$f")
done < <(
    [[ -d "$PACKS_DIR" ]] && find "$PACKS_DIR" -type f -path '*/directives/*/check.sh' | sort
)

if [[ ${#check_files[@]} -eq 0 ]]; then
    echo "⊘ no governance directives defined under $HERE/packs"
    exit 0
fi

# Single-directive filter. A bare id (`run.sh required-docs`) runs every
# directive with that id — across packs, all homonyms run. A pack-qualified id
# (`run.sh governance-kit/foundation/repo-hygiene`) runs exactly one. Identity
# is `<owner>/<pack>/<id>`; the short id is a given name, not a global claim.
if [[ $# -gt 0 ]]; then
    filter="$1"
    filtered=()
    for f in "${check_files[@]}"; do
        # $f = $PACKS_DIR/<owner>/<pack>/directives/<id>/check.sh
        dir="$(dirname "$f")"                       # .../directives/<id>
        id="$(basename "$dir")"
        pack="$(basename "$(dirname "$(dirname "$dir")")")"
        owner="$(basename "$(dirname "$(dirname "$(dirname "$dir")")")")"
        qualified="$owner/$pack/$id"
        case "$filter" in
            */*/*) [[ "$qualified" == "$filter" ]] && filtered+=("$f") ;;
            *)     [[ "$id" == "$filter" ]] && filtered+=("$f") ;;
        esac
    done
    if [[ ${#filtered[@]} -eq 0 ]]; then
        echo "✗ no directive matching '$filter' under $HERE"
        exit 1
    fi
    check_files=("${filtered[@]}")
fi

fail_count=0
pass_count=0
for check in "${check_files[@]}"; do
    if bash "$check"; then
        pass_count=$((pass_count + 1))
    else
        fail_count=$((fail_count + 1))
    fi
done

# Emit the single grouped sub-agent remediation instruction for whatever the
# directive checks registered as pending (no-op when nothing did).
[[ -n "$ATTEST_LEDGER" ]] && attestation_remediation "$ATTEST_LEDGER"

echo
echo "────────────────────────────────────────"
if [[ $fail_count -eq 0 ]]; then
    echo "✓ governance: all $pass_count directive(s) passed"
    exit 0
fi
echo "✗ governance: $fail_count directive(s) failed, $pass_count passed"
echo
echo "To bypass temporarily (CI will still enforce):"
echo "    SKIP_GOVERNANCE=1 git commit ..."
echo "    git commit --no-verify"
exit 1
