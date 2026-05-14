#!/usr/bin/env bash
# Directive: Each tracked receipts/*.md file satisfies four shape rules:
#   1. Filename matches `issue-<N>-<slug>.md` where <slug> is one or more
#      kebab-case tokens (lowercase letters, digits, hyphens), and no two
#      receipts share the same issue number.
#   2. Body contains four required Markdown sections — `## Checklist`,
#      `## What changed`, `## Out of scope`, `## Verification`.
#   3. The `## Checklist` mirrors the GitHub issue's checklist; each
#      completed item (`- [x] …`) must have its text appear (case-insensitive
#      substring) in `## What changed` or `## Verification`. Unchecked items
#      (`- [ ] …`) are unconstrained — they represent remaining work.
#
# File-level waiver: `governance: allow-receipt-per-issue <reason>` in the
# first 10 lines of a receipt exempts that receipt from all four shape
# rules. Reason required. Use sparingly — receipts are a fresh discipline,
# the waiver is for stub / WIP / handoff cases that legitimately can't
# meet the shape yet.
#
# Rationale: Receipts are the durable post-implementation audit trace for
# work an agent did against a GitHub issue. The one-to-one issue binding
# keeps the system of record unambiguous. The four required sections force
# the agent to name the work plan (Checklist), the surface area touched
# (What changed), the deferred work (Out of scope), and the criteria a
# reviewer uses to judge completion (Verification). The Checklist mirrors
# the GitHub issue checklist (which the agent maintains as part of the
# receipt step), and the crosswalk to What changed / Verification is the
# trust boundary — a reviewer reads the receipt and confirms each
# claimed-done item maps to described work without leaving the diff.
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
# in the first 10 lines of a receipt file exempts that receipt from all four
# shape rules (filename, sections, crosswalk). Reason required; HTML comment
# markers are stripped before matching so `<!-- ... -->` does not count as
# the reason. The audit trail is `grep -r 'allow-receipt-per-issue' receipts/`.
has_receipt_waiver() {
    local file="$1"
    [[ -f "$file" ]] || return 1
    head -n 10 "$file" 2>/dev/null \
        | sed -E 's/<!--//g; s/-->//g' \
        | grep -qE 'governance:[[:space:]]*allow-receipt-per-issue[[:space:]]+[^[:space:]]'
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
