#!/usr/bin/env bash
# Directive: every non-merge, non-revert commit stamps the always-on summary
# triple `Steer-Count`, `Steer-Types`, `Steer-Tiers` — even when zero events
# were detected. The summary numbers must agree with the rows newly added to
# STEERING.md by this commit: `Steer-Count` equals the number of added
# rows, and the type / tier breakdowns tally those rows' `type` and `tier`
# columns. The row → commit join uses STEERING.md's `commit |` column.
#
# Independent of agent-token-accounting: the contract applies to every
# in-scope commit, not gated on the `Agent:` trailer. Installation is the
# gate.
#
# Per-event `Steer-Key:` trailers were retired in #66. Historical commits
# in the repo's log may still carry them; the new check ignores them.
#
# Modes:
#   Mode A — commit-msg hook:  bash check.sh <path-to-msg-file>
#       Validates the pending message: summary triple is well-formed and
#       agrees with the rows the staged STEERING.md diff adds. Each newly
#       added row's `commit |` cell must equal the pending subject.
#   Mode B — CI / run.sh:      bash check.sh
#       Walks default-branch merge-base → HEAD and validates every
#       non-merge, non-revert commit against the same summary contract,
#       deriving "rows added by this commit" from `git show <sha>`. The
#       row.commit-cell == subject check is skipped here because squash
#       merges can rewrite the subject after the row was stamped. Mode B
#       additionally skips any commit whose first parent didn't already
#       carry this directive's check.sh — that's the self-bootstrapping
#       exemption, so the install commit isn't held to a contract that
#       wasn't in the tree before it.
#
# Skips merge commits and revert commits, identical to agent-token-accounting.
#
# Independent ledger-shape check runs first so even branches with no
# steering activity catch a malformed STEERING.md.

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "agent-steering-accounting"
require_git

ROOT="$(git rev-parse --show-toplevel)"
LEDGER="$ROOT/STEERING.md"
LIB="$HERE/lib"

if [[ ! -f "$LIB/ledger.py" || ! -f "$LIB/trailers.py" ]]; then
    violation "directive folder is missing lib/{ledger,trailers}.py — cannot validate"
    directive_end
fi

# ──────────────────────────────────────────────────────────────
# Ledger-shape check (independent of any commits).
# ──────────────────────────────────────────────────────────────
if [[ -f "$LEDGER" ]]; then
    while IFS= read -r v; do
        [[ -z "$v" ]] && continue
        violation "$v"
    done < <(python3 "$LIB/ledger.py" validate "$LEDGER" || true)
fi

# Print the steer-keys of rows newly added to STEERING.md in this commit.
# Mode A reads the staged diff (the pending commit's contribution); Mode B
# reads `git show <sha> -- STEERING.md`. In both cases, an added row is a
# `+| ... |` line and the steer-key is the first cell.
new_row_keys() {
    local mode="$1"
    local sha="${2:-}"
    if [[ "$mode" == "A" ]]; then
        git diff --cached -- "$LEDGER" 2>/dev/null || true
    else
        git show --no-color --format= "$sha" -- "$LEDGER" 2>/dev/null || true
    fi | python3 -c '
import re, sys
for line in sys.stdin:
    line = line.rstrip("\n")
    if not line.startswith("+") or line.startswith("+++"):
        continue
    body = line[1:].strip()
    if not body.startswith("|"):
        continue
    cells = [c.strip() for c in body.split("|")[1:-1]]
    if not cells:
        continue
    key = cells[0]
    if key in ("steer-key", "") or re.fullmatch(r"-+", key or ""):
        continue
    print(key)
'
}

validate_commit_message() {
    local label="$1"
    local mode="$2"   # A or B
    local sha="${3:-}"
    local subject="${4:-}"
    local msg
    msg="$(cat)"

    # Collect added keys into an array. Bash 3.2 compatible (no mapfile).
    local keys_raw
    keys_raw="$(new_row_keys "$mode" "$sha")"
    local -a keys=()
    if [[ -n "$keys_raw" ]]; then
        local k
        while IFS= read -r k; do
            [[ -z "$k" ]] && continue
            keys+=("$k")
        done <<<"$keys_raw"
    fi

    local -a args=("validate" "$label" "$LEDGER")
    if [[ -n "$subject" ]]; then
        args+=("--subject" "$subject")
    fi
    args+=("-")
    if (( ${#keys[@]} > 0 )); then
        args+=("${keys[@]}")
    fi

    while IFS= read -r v; do
        [[ -z "$v" ]] && continue
        violation "$v"
    done < <(printf '%s' "$msg" | python3 "$LIB/trailers.py" "${args[@]}" || true)
}

# ──────────────────────────────────────────────────────────────
# Mode A — commit-msg hook
# ──────────────────────────────────────────────────────────────
if [[ $# -gt 0 ]]; then
    msg_file="$1"
    if [[ ! -f "$msg_file" ]]; then
        violation "commit-msg file not found: $msg_file"
        directive_end
    fi
    pending_subject=$(grep -vE '^[[:space:]]*($|#)' "$msg_file" | head -n1)
    if [[ "$pending_subject" == Revert\ \"* ]]; then
        directive_end
    fi
    validate_commit_message "pending commit" "A" "" "$pending_subject" <"$msg_file"
    directive_end
fi

# ──────────────────────────────────────────────────────────────
# Mode B — CI / run.sh — walk base..HEAD
# ──────────────────────────────────────────────────────────────
base=""
for candidate in origin/main origin/master main master; do
    if git rev-parse --verify "$candidate" >/dev/null 2>&1; then
        mb=$(git merge-base HEAD "$candidate" 2>/dev/null || echo "")
        if [[ -n "$mb" && "$mb" != "$(git rev-parse HEAD)" ]]; then
            base="$mb"
            break
        fi
    fi
done

is_exempt_commit() {
    local sha="$1"
    local parents subject
    parents=$(git log -1 --format=%P "$sha" 2>/dev/null || echo "")
    if [[ "$parents" == *' '* ]]; then
        return 0
    fi
    subject=$(git log -1 --format=%s "$sha" 2>/dev/null || echo "")
    if [[ "$subject" == Revert\ \"* ]]; then
        return 0
    fi
    return 1
}

if [[ -z "$base" ]]; then
    directive_end
fi

DIRECTIVE_PATH=".governance/packs/governance-kit/core/directives/agent-steering-accounting/check.sh"

# Self-bootstrapping exemption: the directive applies to a commit only if
# its first parent already had this directive installed. That exempts the
# install commit itself (the parent didn't have it yet) while still
# enforcing on every subsequent commit, and lets the directive be
# upgraded in place — a commit that *modifies* check.sh inherits the
# enforcement contract from its parent's version.
directive_active_for() {
    local sha="$1"
    local parent
    parent="$(git rev-parse "${sha}^" 2>/dev/null || true)"
    [[ -z "$parent" ]] && return 1
    [[ -n "$(git ls-tree --name-only "$parent" -- "$DIRECTIVE_PATH" 2>/dev/null)" ]]
}

while IFS= read -r sha; do
    [[ -z "$sha" ]] && continue
    if is_exempt_commit "$sha"; then
        continue
    fi
    if ! directive_active_for "$sha"; then
        continue
    fi
    msg=$(git log -1 --format=%B "$sha")
    validate_commit_message "$sha" "B" "$sha" "" <<<"$msg"
done < <(git log "$base..HEAD" --format='%H')

directive_end
