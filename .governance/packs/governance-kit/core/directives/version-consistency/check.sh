#!/usr/bin/env bash
# Directive: version-consistency — every kit-version stamp in an installed repo
# agrees. The kit (framework) version is pinned once in
# `.governance/install.yaml` (`kit_version`) and re-stamped into each managed
# runtime file as a `# governance-kit:managed kit-version=<v>` marker. This
# directive asserts they are all identical, so a hand edit, a partial
# `kit update`, or a botched merge can't leave the repo straddling two
# kit versions.
#
# No-op when `.governance/install.yaml` is absent or carries no `kit_version`
# — the repo isn't governance-installed in a way this can validate (mirrors
# how doc-freshness is a no-op without its config).
#
# Managed files are derived from the manifest (`tests_dir`, `ci_workflow`,
# `enable_governance_script`, `hook_strategy`) so the set matches exactly what
# `init` wrote — the directive never guesses at marker-bearing files, which
# keeps it from tripping over generator code or fixtures that merely mention
# the marker string.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "version-consistency"
require_git

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1

MANIFEST=".governance/install.yaml"
[[ -f "$MANIFEST" ]] || directive_end   # no-op: nothing installed to validate

manifest_field() {  # scalar value of a top-level key, quotes/comments stripped
    sed -nE "s/^$1:[[:space:]]*\"?([^\"#[:space:]]*)\"?.*/\1/p" "$MANIFEST" | head -1
}

expected="$(manifest_field kit_version)"
[[ -n "$expected" ]] || directive_end    # no-op: no kit_version pin to check against

read_marker() {  # prints the kit-version value from the first marker line of $1
    awk '/^# governance-kit:managed/ {
        if (match($0, /kit-version=[^[:space:]]+/)) print substr($0, RSTART + 12, RLENGTH - 12)
        exit
    }' "$1"
}

tests_dir="$(manifest_field tests_dir)"; tests_dir="${tests_dir:-.governance}"
ci_workflow="$(manifest_field ci_workflow)"
enable_script="$(manifest_field enable_governance_script)"
hook_strategy="$(manifest_field hook_strategy)"

managed=("$tests_dir/run.sh" "$tests_dir/lib.sh")
[[ -n "$ci_workflow"   ]] && managed+=("$ci_workflow")
[[ -n "$enable_script" ]] && managed+=("$enable_script")
if [[ "$hook_strategy" == "githooks" && -d .githooks ]]; then
    while IFS= read -r h; do managed+=("$h"); done < <(find .githooks -maxdepth 1 -type f | sort)
fi

checked=0
for f in "${managed[@]}"; do
    [[ -f "$f" ]] || continue
    v="$(read_marker "$f")"
    [[ -n "$v" ]] || continue   # unmanaged / bare marker — out of this directive's scope
    checked=$((checked + 1))
    if [[ "$v" != "$expected" ]]; then
        violation "$f is stamped kit-version=$v but .governance/install.yaml pins kit_version=$expected — run 'governance kit update' or re-stamp so every managed file agrees"
    fi
done

directive_end
