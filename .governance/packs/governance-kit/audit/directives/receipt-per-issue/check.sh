#!/usr/bin/env bash
# Directive: Each tracked receipts/*.md file satisfies these shape rules:
#   1. Filename matches `issue-<N>[-<slug>].md`. A receipt ADDED in the change
#      set must carry a kebab-case <slug> (lowercase letters, digits, hyphens) —
#      the bare `issue-<N>.md` form is rejected for new receipts. Accounting-only
#      stubs (the hooks create them slugless) and pre-existing (grandfathered)
#      receipts may use the bare form. No two receipts share the same issue number.
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
#   5. On receipts ADDED in the current change set, the `## Verification`
#      section must contain at least one fenced code block (```). "Ran the
#      tests" is a claim; a command a reviewer can copy and re-run is a
#      receipt. Same forward-looking scope as rule 4 — pre-existing receipts
#      are grandfathered.
#   6. File coverage (change-set scoped, issue #272): every file changed in
#      the current change set (added/copied/modified/renamed across the staged
#      tree at pre-commit and `base..HEAD` in CI) must be named — its path as a
#      case-insensitive substring — somewhere in one of the receipts ADDED in
#      that same change set. This is the one substance check the closed-loop
#      crosswalk structurally cannot make: the crosswalk only relates two
#      strings the agent wrote, never the diff, so a diff that silently touches
#      files the receipt never mentions (scope creep) passes today. Comparing
#      `git diff --name-only` against the receipt prose catches it, for free
#      and deterministically. The receipts themselves and the auto-maintained
#      system-of-record ledgers (`COSTS.md`, `STEERING.md`, `CONSTITUTION.md`)
#      are excluded — they are not change surface a receipt is expected to
#      narrate. Skipped entirely when the change set adds no receipt (nothing
#      to anchor coverage to).
#   7. A sixth section, `## Audit`, is required ONLY on receipts ADDED in the
#      current change set (same forward-looking scope as rules 4–5, issue
#      #272). The mechanical checks above prove a receipt is *internally
#      consistent* (its checklist echoes its own prose); they never prove it
#      *corresponds to reality* — they read neither the diff nor the issue.
#      The `## Audit` section closes that gap by recording the verdict of a
#      fresh-context sub-agent that DID read the two ground truths. check.sh
#      enforces only that the section exists and carries a PASS/REFUTED verdict
#      (it cannot verify the verdict is true — that is the merge-time sweep
#      lane, deliberately out of scope here). The violation message is the
#      authoring instruction: the harness agent spawns the sub-agent, which
#      writes the block; the hook never spawns anything itself. A bare commit
#      or CI run with no agent simply hard-fails on the missing block — correct
#      (the audit step did not run), and demanding presence is all the hook can
#      do without an LLM judge on the commit path.
#
#      The sub-agent prompt (what the harness agent runs on a small, low-cost
#      model — the shared attestation_prompt envelope requests the low capability
#      tier; see kit/references/SUBAGENT_ATTESTATION.md "Model tier" — with the
#      diff, this receipt, and `gh issue view <N>` as the only inputs):
#        You are auditing a receipt against ground truth. For each check report
#        PASS or REFUTED plus evidence: (1) `## What changed` faithfully
#        describes the diff — no misrepresentation, no omission; (2) each
#        `- [x]` item is actually realized in the diff; (3) the `## Checklist`
#        mirrors the issue's checklist. Default to REFUTED if uncertain. Write
#        your findings into the receipt's `## Audit` section.
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
# needed to grandfather it. The file-coverage and `## Audit` rules (issue #272)
# attack the directive's substance gap from two angles the closed-loop
# crosswalk cannot: file coverage is a free mechanical win (the diff names
# files no receipt section does → scope creep), while `## Audit` records an
# independent fresh-context sub-agent's adversarial verdict against the diff
# and the issue — the author≠auditor split happening at author-time. The hook
# guarantees the audit was *recorded*, not that its verdicts are *true*; a
# merge-time re-audit (the sweep lane) is the deferred other half.
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

# Section extraction is the shared `extract_md_section` helper from lib.sh.

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

# Accounting-only stub: a receipt whose only level-2 (`## `) heading is
# `## Accounting` — what the agent-token/steering pre-commit hooks create
# before the agent writes the narrative (issue #201). `### Costs`/`### Steering`
# are level-3 and don't count. A stub is exempt from the shape rules.
is_accounting_stub() {
    local file="$1"
    [[ -f "$file" ]] || return 1
    local h2
    h2="$(grep -E '^##[[:space:]]+' "$file" 2>/dev/null \
        | sed -E 's/^##[[:space:]]+//; s/[[:space:]]+$//')"
    [[ "$h2" == "Accounting" ]]
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
add_to_scope < <(git diff --cached --no-renames --diff-filter=A --name-only -- 'receipts/*.md' 2>/dev/null || true)
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
        add_to_scope < <(git diff-tree --no-commit-id --no-renames --name-only --diff-filter=A -r "$sha" -- 'receipts/*.md' 2>/dev/null || true)
    done < <(git log "$cs_base..HEAD" --format='%H' 2>/dev/null || true)
fi

receipt_in_scope() {
    case "$ADDED_RECEIPTS" in
        *$'\n'"$1"$'\n'*) return 0 ;;
        *) return 1 ;;
    esac
}

# Build the set of files CHANGED in the current change set, for the rule-6
# file-coverage check. Same staged ∪ base..HEAD union as ADDED_RECEIPTS, but
# over every added/copied/modified/renamed path (diff-filter ACMR — a deletion
# leaves nothing for a receipt to "name"), not just receipts. cs_base was
# resolved above for the ADDED_RECEIPTS branch walk; reuse it.
CHANGED_FILES=$'\n'
add_to_changed() {
    local f
    while IFS= read -r f; do
        [[ -z "$f" ]] && continue
        case "$CHANGED_FILES" in
            *$'\n'"$f"$'\n'*) ;;
            *) CHANGED_FILES+="$f"$'\n' ;;
        esac
    done
}
add_to_changed < <(git diff --cached --no-renames --diff-filter=ACMR --name-only 2>/dev/null || true)
if [[ -n "$cs_base" ]]; then
    while IFS= read -r sha; do
        [[ -z "$sha" ]] && continue
        add_to_changed < <(git diff-tree --no-commit-id --no-renames --name-only --diff-filter=ACMR -r "$sha" 2>/dev/null || true)
    done < <(git log "$cs_base..HEAD" --format='%H' 2>/dev/null || true)
fi

# A changed file is exempt from rule-6 coverage if it is a receipt itself or
# one of the auto-maintained system-of-record ledgers — neither is change
# surface a receipt is expected to narrate.
coverage_exempt() {
    local path="$1" base="${1##*/}"
    case "$path" in
        receipts/*) return 0 ;;
    esac
    case "$base" in
        COSTS.md|STEERING.md|CONSTITUTION.md) return 0 ;;
    esac
    return 1
}

seen_nums=()
seen_files=()
inscope_receipts=()
for f in "${receipt_files[@]}"; do
    if has_receipt_waiver "$f"; then
        continue
    fi
    base="${f##*/}"
    # Display issue number for remediation messages (the filename rule below
    # validates the shape; this is best-effort for the message text).
    issue_ref="${base#issue-}"; issue_ref="${issue_ref%%[-.]*}"
    [[ "$issue_ref" =~ ^[0-9]+$ ]] || issue_ref="<N>"
    # Slug policy: a receipt ADDED in this change set must carry a kebab-case
    # slug — `issue-<N>-<slug>.md`. The bare `issue-<N>.md` form is accepted only
    # for accounting-only stubs (the hooks create them slugless; the agent adds a
    # slug when fleshing out the narrative) and for pre-existing receipts on HEAD,
    # which are grandfathered. Same forward-only change-set scope as rules 4–7.
    if receipt_in_scope "$f" && ! is_accounting_stub "$f"; then
        fname_re='^issue-([0-9]+)-[a-z0-9]+(-[a-z0-9]+)*\.md$'
        fname_msg="$f — a newly added receipt filename must match 'issue-<N>-<slug>.md' with a kebab-case slug (lowercase letters, digits, hyphens) — e.g. receipts/issue-63-replace-plans.md"
    else
        fname_re='^issue-([0-9]+)(-[a-z0-9]+(-[a-z0-9]+)*)?\.md$'
        fname_msg="$f — receipt filename must match 'issue-<N>.md' or 'issue-<N>-<slug>.md' with a kebab-case slug (lowercase letters, digits, hyphens) — e.g. receipts/issue-63-replace-plans.md"
    fi
    if [[ "$base" =~ $fname_re ]]; then
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
        violation "$fname_msg"
    fi

    # Accounting-only stub: the agent-token/steering pre-commit hooks create
    # receipts/issue-<N>.md carrying just a `## Accounting` section when a
    # commit's first accounted event fires before the agent has fleshed out
    # the narrative (issue #201). Such a stub is exempt from the shape /
    # crosswalk / Decisions / Verification rules until the agent adds a
    # narrative section; the Accounting tables themselves are validated by the
    # accounting directives. Filename + duplicate checks above still apply.
    if is_accounting_stub "$f"; then
        continue
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
        inscope_receipts+=("$f")
        if ! grep -qE "^##[[:space:]]+Decisions\b" "$f"; then
            violation "$f — newly added receipt is missing a '## Decisions' section (record off-spec decisions, forced changes, and tradeoffs; write 'None' if the work followed the spec exactly)"
        fi
        # Verification must carry at least one runnable command (fenced code
        # block) on newly added receipts. Only meaningful if the section
        # exists; its absence is already flagged by the required-sections loop.
        if grep -qE "^##[[:space:]]+Verification\b" "$f"; then
            verif_body="$(extract_md_section "$f" "Verification")"
            if ! printf '%s\n' "$verif_body" | grep -qE '^[[:space:]]*```'; then
                violation "$f — newly added receipt's '## Verification' has no fenced code block; include at least one runnable command a reviewer can re-run (e.g. a \`\`\`sh … \`\`\` block), not just prose"
            fi
        fi
        # `## Audit` (issues #272, #325): a newly added receipt must carry a
        # fresh-context sub-agent's adversarial verdict against the diff and the
        # issue — the substance the closed-loop crosswalk never touches. The
        # judgment task is declared once in directive.yaml's `subagent:` block;
        # `subagent_attest` reads it, gates the section's presence + verdict, and
        # registers it (isolation: shared) so the run-level orchestrator batches
        # it with any other pending shared attestation into one sub-agent. The
        # hook never spawns anything itself; a bare/CI run with no agent simply
        # hard-fails on the missing section. On an older lib.sh (no
        # subagent_attest) fall back to the per-section require_attestation gate.
        if declare -F subagent_attest >/dev/null 2>&1; then
            subagent_attest "$f"
        else
            require_attestation "$f" "Audit" \
                "The mechanical checks prove this receipt is internally consistent, never that it matches reality (they read neither the diff nor the issue)." \
                "the diff (\`git diff\`), this receipt, and the linked issue (\`gh issue view $issue_ref\`)" \
                "'## What changed' faithfully describes the diff (no misrepresentation, no omission)" \
                "each '- [x]' item is realized in the diff" \
                "the '## Checklist' mirrors the issue's checklist"
        fi
    fi

    # Crosswalk: only meaningful if all sections exist; otherwise the missing-
    # section violations already fired and the user should fix those first.
    if [[ "$has_all_sections" -eq 1 ]]; then
        checklist_body="$(extract_md_section "$f" "Checklist")"
        what_changed="$(extract_md_section "$f" "What changed")"
        verification="$(extract_md_section "$f" "Verification")"
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

# ── Rule 6: file coverage (change-set scoped, issue #272) ──────────────────
# The crosswalk above relates only two strings the agent wrote; it never reads
# the diff, so a change set that silently touches files no receipt names (scope
# creep) passes today. Compare the changed-file list against the prose of the
# receipts ADDED in this same change set: every changed file must be named (its
# path, case-insensitive substring) in at least one of them. Skipped when the
# change set adds no (non-stub, non-waivered) receipt — there is nothing to
# anchor coverage to, and `commit-issue-receipt-match` is the directive that
# requires a substantive change set to carry a receipt at all.
coverage_anchors=()
for r in "${inscope_receipts[@]:-}"; do
    [[ -z "$r" ]] && continue
    is_accounting_stub "$r" && continue   # a stub names nothing
    coverage_anchors+=("$r")
done

if [[ ${#coverage_anchors[@]} -gt 0 ]]; then
    # Combined, normalized prose of every anchor receipt (whole file body —
    # any section may name a changed file).
    coverage_evidence=""
    for r in "${coverage_anchors[@]}"; do
        coverage_evidence+="$(normalize "$(cat "$r" 2>/dev/null)")"$'\n'
    done

    while IFS= read -r cf; do
        [[ -z "$cf" ]] && continue
        coverage_exempt "$cf" && continue
        cf_norm="$(normalize "$cf")"
        if [[ "$coverage_evidence" != *"$cf_norm"* ]]; then
            violation "$cf — file changed in this change set but named in no receipt section (possible scope creep). Name it in '## What changed' (or another section) of the receipt for this change, or add a 'governance: allow-receipt-per-issue <reason>' waiver to that receipt if the omission is deliberate."
        fi
    done <<< "$CHANGED_FILES"
fi

directive_end
