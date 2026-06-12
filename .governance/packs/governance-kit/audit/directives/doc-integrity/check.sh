#!/usr/bin/env bash
# Directive: System-of-record documents are append-only — once content lands on
# the default branch it is evidence of what was true then, and a later change set
# may only ADD to it, never rewrite or erase what is already there.
#
# What is protected ships as standard rules in the sibling `defaults.conf`,
# layered with the user overlay `.governance/conf/governance-kit/audit/doc-integrity.conf` (bare lines
# add rules, `!<rule>` drops a default). If the effective rule set is empty the
# directive is a no-op. Each rule is `<mode> <path> [arg]`:
#
#   frozen-files    <glob>             Every file matching <glob> that exists at
#                                      the baseline is immutable; new files may be
#                                      added.  (e.g. receipts/*.md)
#   append-only     <file>             The baseline version of <file> must be an
#                                      exact byte-prefix of the current version —
#                                      only appended content is allowed; existing
#                                      bytes may not change and the file may not
#                                      shrink or be deleted.  (e.g. COSTS.md)
#   frozen-section  <file> <heading>   Every line present under `## <heading>` (or
#                                      any heading level) at the baseline must
#                                      still be present, verbatim, under that
#                                      heading now. The rest of the file is free.
#                                      Additions and reordering are fine; editing
#                                      or deleting a baseline line is not.
#                                      (e.g. QUALITY.md Resolved)
#
# Baseline = merge-base(HEAD, default branch). Content authored within the current
# branch is absent at the baseline and stays editable until it merges — only what
# is already on the trunk is frozen. When no default branch resolves (a commit
# made directly on the trunk), the baseline falls back to HEAD.
#
# Modes:
#   Mode A — commit-msg hook:  bash check.sh <path-to-msg-file>
#       Compares the baseline against the staged tree (the pending commit).
#   Mode B — CI / run.sh:      bash check.sh
#       Compares the baseline against HEAD across base..HEAD.
#
# Exceptions:
#   - Path-scoped per-change-set waiver: a line
#     `governance: allow-doc-integrity <path> <reason>` in a commit body (Mode B:
#     any commit in base..HEAD; Mode A: the pending body) exempts <path> from the
#     check. Reason required — a bare `allow-doc-integrity <path>` does not waive.
#     For frozen-files, <path> is the specific file being rewritten. Reserve it
#     for a coordinated, reviewed rewrite. Audit: `git log --grep=allow-doc-integrity`.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "doc-integrity"
require_git

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1

# Effective rule set = pack-owned defaults.conf layered with the user overlay
# (.governance/conf/governance-kit/audit/doc-integrity.conf): bare lines add rules, `!<rule>` drops a
# default. Empty effective set → nothing to protect, no-op.
RULES="$(conf_list doc-integrity "$(dirname "$0")/defaults.conf")"
if [[ -z "$RULES" ]]; then
    directive_end   # nothing opted in
fi

# ── Resolve the change-set baseline: the default-branch merge-base, falling back
#    to HEAD when there is no new work relative to a default branch.
HEAD_SHA="$(git rev-parse --verify HEAD 2>/dev/null || echo "")"
BASE="$HEAD_SHA"
for candidate in origin/main origin/master main master; do
    if git rev-parse --verify "$candidate" >/dev/null 2>&1; then
        mb=$(git merge-base HEAD "$candidate" 2>/dev/null || echo "")
        if [[ -n "$mb" && "$mb" != "$HEAD_SHA" ]]; then
            BASE="$mb"
            break
        fi
    fi
done

# ── Determine how to read the "current" version of a path.
#    Mode A (commit-msg): the staged tree (stage 0, `:path`).
#    Mode B (run.sh):     HEAD.
MODE_A=0
PENDING_BODY=""
if [[ $# -gt 0 ]]; then
    MODE_A=1
    msg_file="$1"
    if [[ ! -f "$msg_file" ]]; then
        violation "commit-msg file not found: $msg_file"
        directive_end
    fi
    PENDING_BODY="$(cat "$msg_file")"
    CUR_REV=""        # `:path` → staged blob
else
    # Mode B: no new work relative to the trunk → nothing to compare. Mode A
    # guards any pending commit; re-flagging history already on the trunk is out
    # of scope (mirrors commit-issue-receipt-match).
    if [[ -z "$BASE" || "$BASE" == "$HEAD_SHA" ]]; then
        directive_end
    fi
    CUR_REV="HEAD"
fi

# ── Collect path-scoped waivers (`allow-doc-integrity <path> <reason>`) from the
#    relevant commit bodies. A waiver needs both a path and a reason.
WAIVED=$'\n'
collect_waivers() {
    local line p
    while IFS= read -r line; do
        # Strip everything up to and including the token, then take the first
        # field (path); a reason field must follow for the waiver to count.
        p="$(printf '%s\n' "$line" \
            | sed -E 's/^.*allow-doc-integrity[[:space:]]+//' \
            | awk 'NF>=2 {print $1}')"
        [[ -n "$p" ]] && WAIVED+="$p"$'\n'
    done < <(printf '%s\n' "$1" | grep -E 'governance:[[:space:]]*allow-doc-integrity[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]')
}
if [[ $MODE_A -eq 1 ]]; then
    collect_waivers "$PENDING_BODY"
else
    while IFS= read -r sha; do
        [[ -z "$sha" ]] && continue
        collect_waivers "$(git log -1 --format=%B "$sha" 2>/dev/null || echo "")"
    done < <(git log "$BASE..HEAD" --format='%H' 2>/dev/null || true)
fi
is_waived() {
    case "$WAIVED" in
        *$'\n'"$1"$'\n'*) return 0 ;;
        *) return 1 ;;
    esac
}

# ── Blob helpers. `base_*` reads the baseline; `cur_*` reads staged (Mode A) or
#    HEAD (Mode B). All are quiet — a missing blob simply fails.
base_exists() { git cat-file -e "${BASE}:$1" 2>/dev/null; }
cur_exists()  { git cat-file -e "${CUR_REV}:$1" 2>/dev/null; }
base_blob()   { git cat-file blob "${BASE}:$1" 2>/dev/null; }
cur_blob()    { git cat-file blob "${CUR_REV}:$1" 2>/dev/null; }

# frozen-files <glob> — every file matching <glob> present at the baseline must be
# byte-identical now; new files are unconstrained.
check_frozen_files() {
    local glob="$1" f
    [[ -n "$BASE" ]] || return 0
    # Enumerate every file at the baseline and match it against the glob with a
    # bash pattern (`*` crosses `/` here, which is what we want and is more
    # predictable than git's pathspec wildcard semantics).
    while IFS= read -r f; do
        [[ -z "$f" ]] && continue
        # shellcheck disable=SC2053
        [[ "$f" == $glob ]] || continue
        is_waived "$f" && continue
        if ! cur_exists "$f"; then
            violation "frozen-files: past document '$f' was deleted or renamed away; it is immutable once on the default branch (add a new file instead, or waive with 'governance: allow-doc-integrity $f <reason>')"
            continue
        fi
        if ! cmp -s <(base_blob "$f") <(cur_blob "$f"); then
            violation "frozen-files: '$f' was modified; it is immutable once on the default branch (add a new file instead, or waive with 'governance: allow-doc-integrity $f <reason>')"
        fi
    done < <(git ls-tree -r --name-only "$BASE" 2>/dev/null)
}

# append-only <file> — the baseline blob must be an exact byte-prefix of the
# current blob: existing bytes unchanged, file only grows.
check_append_only() {
    local file="$1" size
    base_exists "$file" || return 0     # absent at baseline → no constraint yet
    is_waived "$file" && return 0
    if ! cur_exists "$file"; then
        violation "append-only: '$file' was deleted; it is an append-only ledger (waive with 'governance: allow-doc-integrity $file <reason>')"
        return 0
    fi
    size="$(git cat-file -s "${BASE}:$file" 2>/dev/null || echo 0)"
    # The first <size> bytes of the current blob must equal the baseline blob.
    if ! cmp -s <(base_blob "$file") <(cur_blob "$file" | head -c "$size"); then
        violation "append-only: '$file' rewrote or removed existing content; only appended lines are allowed (waive with 'governance: allow-doc-integrity $file <reason>')"
    fi
}

# Print the body lines under `## <heading>` (any heading level), stopping at the
# next heading. Reads a blob on stdin.
extract_section() {
    awk -v h="$1" '
        /^#{1,6}[[:space:]]+/ {
            t = $0
            sub(/^#{1,6}[[:space:]]+/, "", t)
            sub(/[[:space:]]+$/, "", t)
            if (t == h) { inb = 1; next }
            else if (inb) { inb = 0 }
        }
        inb { print }
    '
}

# frozen-section <file> <heading> — every non-blank line under <heading> at the
# baseline must still appear verbatim under <heading> now. Reordering/insertion
# are fine; editing or deleting a baseline line is not.
check_frozen_section() {
    local file="$1" heading="$2" line
    base_exists "$file" || return 0
    is_waived "$file" && return 0
    if ! cur_exists "$file"; then
        violation "frozen-section: '$file' was deleted (its '## $heading' history is frozen; waive with 'governance: allow-doc-integrity $file <reason>')"
        return 0
    fi
    # Emit each non-blank baseline line that is absent verbatim from the current
    # section, then raise one violation per emitted line. A single awk
    # set-membership pass replaces a per-baseline-line `grep -Fxq`, which
    # allocates pathologically — out-of-memory, exit 2 — on multi-KB single-line
    # entries under some greps (notably ugrep on macOS); that non-zero exit was
    # then misread as "line missing" and reported as a false frozen-section
    # violation. awk keys whole lines exactly, so blank-line skipping and
    # verbatim matching are unchanged.
    while IFS= read -r line; do
        violation "frozen-section: a line under '## $heading' in '$file' was edited or removed — that section is frozen history. Removed line: '$line' (waive with 'governance: allow-doc-integrity $file <reason>')"
    done < <(
        awk 'NR==FNR { cur[$0] = 1; next }
             { s = $0; gsub(/[[:space:]]/, "", s); if (s == "") next
               if (!($0 in cur)) print }' \
            <(cur_blob "$file" | extract_section "$heading") \
            <(base_blob "$file" | extract_section "$heading")
    )
}

# ── Walk the effective rule set (defaults + overlay; comments already stripped).
while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    read -r mode target rest <<<"$line"
    case "$mode" in
        frozen-files)   check_frozen_files "$target" ;;
        append-only)    check_append_only "$target" ;;
        frozen-section)
            if [[ -z "$rest" ]]; then
                violation "doc-integrity config: frozen-section rule for '$target' is missing a heading argument"
            else
                check_frozen_section "$target" "$rest"
            fi
            ;;
        *) violation "doc-integrity config: unknown mode '$mode' (expected frozen-files | append-only | frozen-section)" ;;
    esac
done <<< "$RULES"

directive_end
