#!/usr/bin/env bash
# Directive: Each tracked receipts/*.md file satisfies these shape rules:
#   1. Filename matches `issue-<N>-<slug>.md` where <slug> is one or more
#      kebab-case tokens (lowercase letters, digits, hyphens), and no two
#      receipts share the same issue number.
#   2. Body contains four required Markdown sections — `## Checklist`,
#      `## What changed`, `## Out of scope`, `## Verification` — checked on
#      every tracked receipt.
#   3. The `## Checklist` mirrors the GitHub issue's checklist; each
#      completed item (`- [x] …`) must have its text appear (case-insensitive
#      substring) in `## What changed` or `## Verification`. Unchecked items
#      (`- [ ] …`) are unconstrained — they represent remaining work.
#   4. A fifth section, `## Decisions`, is required ONLY on receipts ADDED in
#      the current change set (staged additions in pre-commit; base..HEAD
#      additions in CI). Receipts that predate the change set are
#      grandfathered — the section is forward-looking, so the historical
#      corpus is never retroactively swept. It records the off-spec
#      decisions, forced changes, and tradeoffs a reviewer should know about;
#      a receipt whose work followed the spec exactly writes "None".
#
# File-level waiver: `governance: allow-receipt-per-issue <reason>` in the
# first 10 lines of a receipt exempts that receipt from all shape rules.
# Reason required. Use sparingly — receipts are a fresh discipline, the
# waiver is for stub / WIP / handoff cases that legitimately can't meet the
# shape yet.
#
# Rationale: Receipts are the durable post-implementation audit trace for
# work an agent did against a GitHub issue. The one-to-one issue binding
# keeps the system of record unambiguous. The four always-checked sections
# force the agent to name the work plan (Checklist), the surface area touched
# (What changed), the deferred work (Out of scope), and the criteria a
# reviewer uses to judge completion (Verification). The Checklist mirrors the
# GitHub issue checklist (which the agent maintains as part of the receipt
# step), and the crosswalk to What changed / Verification is the trust
# boundary — a reviewer reads the receipt and confirms each claimed-done item
# maps to described work without leaving the diff. The change-set-scoped
# Decisions section captures the judgment calls the diff cannot show: why the
# agent diverged from the spec, what it had to change, and what it traded off.
# Scoping it to newly added receipts keeps the rule forward-looking — new
# work owes the new discipline, the historical corpus stays an honest record
# of what was true when it was written, and no blanket waiver or backfill is
# needed to grandfather it.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "receipt-per-issue"
require_git

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1

if [[ ! -d "$ROOT/receipts" ]]; then
    directive_end
fi

receipt_files=()
while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    receipt_files+=("$f")
done < <(git ls-files -- 'receipts/*.md' 2>/dev/null || true)

if [[ ${#receipt_files[@]} -eq 0 ]]; then
    directive_end
fi

required_sections=("Checklist" "What changed" "Out of scope" "Verification")

# Extract the body of a single `## <heading>` section. Stops at next `## `.
extract_section() {
    local file="$1" heading="$2"
    awk -v h="$heading" '
        BEGIN { in_section = 0 }
        /^##[[:space:]]+/ {
            if (in_section) exit
            line = $0
            sub(/^##[[:space:]]+/, "", line)
            sub(/[[:space:]]+$/, "", line)
            if (tolower(line) == tolower(h)) {
                in_section = 1
                next
            }
        }
        { if (in_section) print }
    ' "$file"
}

# Normalize a string for substring matching: lowercase, strip the markdown
# inline-formatting characters (backticks, asterisks, underscores), and
# collapse all whitespace runs (including newlines) to a single space. This
# means an item like `lib/trailers.py rewritten` matches a bullet that says
# "**lib/trailers.py** rewritten" without forcing the agent to keep the
# checklist and the prose stylistically identical, and a single-line item
# matches an evidence span that wraps across lines in the source.
normalize() {
    printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d '`*_' | tr -s '[:space:]' ' '
}

# File-level waiver: a comment `governance: allow-receipt-per-issue <reason>`
# in the first 10 lines of a receipt file exempts that receipt from all shape
# rules (filename, sections, crosswalk). Reason required; HTML comment markers
# are stripped before matching so `<!-- ... -->` does not count as the reason.
# The audit trail is `grep -r 'allow-receipt-per-issue' receipts/`.
has_receipt_waiver() {
    local file="$1"
    [[ -f "$file" ]] || return 1
    head -n 10 "$file" 2>/dev/null \
        | sed -E 's/<!--//g; s/-->//g' \
        | grep -qE 'governance:[[:space:]]*allow-receipt-per-issue[[:space:]]+[^[:space:]]'
}

# Build the set of receipts ADDED in the current change set — these owe a
# `## Decisions` section; pre-existing receipts are grandfathered. The set is
# the union of two sources so the same argless check covers both hooks:
#   * pre-commit — staged additions (`git diff --cached --diff-filter=A`).
#   * CI / run.sh — additions across the branch's own commits, walked from the
#     default-branch merge-base to HEAD. When no base resolves (e.g. on the
#     default branch itself) the branch source contributes nothing and only
#     the staged source applies; re-flagging receipts already on the default
#     branch is deliberately out of scope, matching commit-issue-receipt-match.
ADDED_RECEIPTS=$'\n'
add_to_scope() {
    local f
    while IFS= read -r f; do
        [[ -z "$f" ]] && continue
        case "$ADDED_RECEIPTS" in
            *$'\n'"$f"$'\n'*) ;;
            *) ADDED_RECEIPTS+="$f"$'\n' ;;
        esac
    done
}
add_to_scope < <(git diff --cached --diff-filter=A --name-only -- 'receipts/*.md' 2>/dev/null || true)
cs_base=""
for candidate in origin/main origin/master main master; do
    if git rev-parse --verify "$candidate" >/dev/null 2>&1; then
        mb=$(git merge-base HEAD "$candidate" 2>/dev/null || echo "")
        if [[ -n "$mb" && "$mb" != "$(git rev-parse HEAD 2>/dev/null)" ]]; then
            cs_base="$mb"
            break
        fi
    fi
done
if [[ -n "$cs_base" ]]; then
    while IFS= read -r sha; do
        [[ -z "$sha" ]] && continue
        add_to_scope < <(git diff-tree --no-commit-id --name-only --diff-filter=A -r "$sha" -- 'receipts/*.md' 2>/dev/null || true)
    done < <(git log "$cs_base..HEAD" --format='%H' 2>/dev/null || true)
fi

receipt_in_scope() {
    case "$ADDED_RECEIPTS" in
        *$'\n'"$1"$'\n'*) return 0 ;;
        *) return 1 ;;
    esac
}

seen_nums=()
seen_files=()
for f in "${receipt_files[@]}"; do
    if has_receipt_waiver "$f"; then
        continue
    fi
    base="${f##*/}"
    if [[ "$base" =~ ^issue-([0-9]+)-[a-z0-9]+(-[a-z0-9]+)*\.md$ ]]; then
        num="${BASH_REMATCH[1]}"
        dup_of=""
        for i in "${!seen_nums[@]}"; do
            if [[ "${seen_nums[$i]}" == "$num" ]]; then
                dup_of="${seen_files[$i]}"
                break
            fi
        done
        if [[ -n "$dup_of" ]]; then
            violation "$f — issue #$num already has a receipt at $dup_of"
        else
            seen_nums+=("$num")
            seen_files+=("$f")
        fi
    else
        violation "$f — receipt filename must match 'issue-<N>-<slug>.md' with a kebab-case slug (lowercase letters, digits, hyphens) — e.g. receipts/issue-63-replace-plans.md"
    fi

    has_all_sections=1
    for section in "${required_sections[@]}"; do
        if ! grep -qE "^##[[:space:]]+${section}\b" "$f"; then
            violation "$f — receipt is missing a '## ${section}' section"
            has_all_sections=0
        fi
    done

    # Decisions section: required only on receipts ADDED in this change set.
    # Pre-existing receipts are grandfathered — the section is forward-looking.
    # Presence-only (no crosswalk) — a receipt with no off-spec decisions
    # writes "None".
    if receipt_in_scope "$f"; then
        if ! grep -qE "^##[[:space:]]+Decisions\b" "$f"; then
            violation "$f — newly added receipt is missing a '## Decisions' section (record off-spec decisions, forced changes, and tradeoffs; write 'None' if the work followed the spec exactly)"
        fi
    fi

    # Crosswalk: only meaningful if all sections exist; otherwise the missing-
    # section violations already fired and the user should fix those first.
    if [[ "$has_all_sections" -eq 1 ]]; then
        checklist_body="$(extract_section "$f" "Checklist")"
        what_changed="$(extract_section "$f" "What changed")"
        verification="$(extract_section "$f" "Verification")"
        evidence="$(normalize "$what_changed"$'\n'"$verification")"

        while IFS= read -r line; do
            if [[ "$line" =~ ^[[:space:]]*[-*][[:space:]]+\[[xX]\][[:space:]]+(.+)$ ]]; then
                item="${BASH_REMATCH[1]}"
                item="${item%"${item##*[![:space:]]}"}"
                [[ -z "$item" ]] && continue

                item_norm="$(normalize "$item")"
                if [[ "$evidence" != *"$item_norm"* ]]; then
                    violation "$f — checked item '$item' not cited in '## What changed' or '## Verification'"
                fi
            fi
        done <<< "$checklist_body"
    fi
done

directive_end
