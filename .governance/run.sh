#!/usr/bin/env bash
# governance-kit:managed kit-version=0.3.5
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

# Single-directive filter: `run.sh required-docs` only runs that directive's check.sh.
if [[ $# -gt 0 ]]; then
    filter="$1"
    filtered=()
    for f in "${check_files[@]}"; do
        id=$(basename "$(dirname "$f")")
        [[ "$id" == "$filter" ]] && filtered+=("$f")
    done
    if [[ ${#filtered[@]} -eq 0 ]]; then
        echo "✗ no directive named '$filter' under $HERE"
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
