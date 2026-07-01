#!/usr/bin/env bash
# Directive: A commit that modifies toolchain configuration — linter, formatter,
# type-checker, CI workflow, or git-hook config — must carry a
# `governance: allow-toolchain-config <reason>` line in its body.
#
# Rationale: When an agent hits a failing lint, type error, or CI gate, the
# tempting shortcut is to edit the *rule* instead of the *code* — loosen the
# eslint config, relax a ruff select, widen a tsconfig, weaken a workflow's
# permissions. That gaming is invisible in a green build. This directive does
# not forbid config changes — they are often legitimate — it forces each one to
# leave a one-line, `git blame`-visible reason in the commit body, so a reviewer
# can tell "tightened the harness" from "gamed the harness" without leaving the
# diff. It is the repo-level analogue of an editor hook that guards lint config
# from edits, and the harness-tampering sibling of `secrets-hygiene` /
# `doc-integrity` (same waiver shape, same commit-msg + CI plumbing).
#
# Protected paths come from the sibling `defaults.conf` (a built-in
# multi-ecosystem default list), layered with the user overlay
# `.governance/conf/governance-kit/audit/toolchain-config-protection.conf` — a bare line adds a
# pattern, `!<pattern>` removes a default. Match rules: a trailing `/` means
# directory prefix, a pattern with a `/` is matched against the full path,
# otherwise it matches the basename. Irrelevant patterns simply never match, so
# a Python-only repo pays nothing for the JavaScript entries. The default list
# deliberately omits `.governance/**`: governance's own managed files are
# already guarded by `version-consistency` (markers) and `doc-integrity`
# (ledgers), and routine `governance` verbs write there constantly.
#
# Modes:
#   Mode A — commit-msg hook:  bash check.sh <path-to-msg-file>
#       Reads the pending body from the msg file and uses the staged diff for
#       the touched-files check.
#   Mode B — CI / run.sh:      bash check.sh
#       Walks default-branch merge-base → HEAD and validates each commit
#       against its own body + tree-diff.
#
# Exceptions:
#   - Merge commits and revert commits are skipped.
#   - Per-commit waiver: a line `governance: allow-toolchain-config <reason>`
#     anywhere in the commit body. The reason is required — a bare token does
#     not waive. Bootstrap (`governance init`) and `governance kit update`
#     commits that necessarily touch CI / hook config should carry it.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "toolchain-config-protection"
require_git

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1

# ── Protected-path patterns ───────────────────────────────────
# The multi-ecosystem default pattern list ships in the sibling `defaults.conf`
# (pack-owned, refreshed on update). The effective list layers the user overlay
# `.governance/conf/governance-kit/audit/toolchain-config-protection.conf` on top: a bare line adds a
# pattern, `!<pattern>` removes a default. If the user removes every pattern the
# directive protects nothing — their explicit choice.
PATTERNS=()
while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    PATTERNS+=("$line")
done < <(conf_list toolchain-config-protection "$(dirname "$0")/defaults.conf")

# is_protected <path> — true if the path matches any protected pattern.
is_protected() {
    local f="$1" base p
    base="${f##*/}"
    for p in "${PATTERNS[@]}"; do
        case "$p" in
            */)   [[ "$f" == "$p"* ]] && return 0 ;;   # directory prefix
            */*)  [[ "$f" == $p ]]   && return 0 ;;    # full-path glob
            *)    [[ "$base" == $p ]] && return 0 ;;   # basename glob
        esac
    done
    return 1
}

# Returns 0 if the commit body carries a valid waiver line (reason required).
msg_has_waiver() {
    local msg="$1"
    printf '%s\n' "$msg" \
        | grep -qE '^[[:space:]]*(<!--)?[[:space:]]*governance:[[:space:]]*allow-toolchain-config[[:space:]]+.+'
}

# validate <label> <subject> <body> [changed-file ...]
validate() {
    local label="$1" subject="$2" body="$3"
    shift 3

    [[ "$subject" == Merge\ * ]] && return 0
    [[ "$subject" == Revert\ \"* ]] && return 0

    local hits=() f
    for f in "$@"; do
        is_protected "$f" && hits+=("$f")
    done
    [[ ${#hits[@]} -eq 0 ]] && return 0

    msg_has_waiver "$body" && return 0

    violation "$label — touches toolchain config [${hits[*]}] without a waiver (add 'governance: allow-toolchain-config <reason>' to the commit body if this rule/CI/hook change is intentional)"
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
    subject=$(grep -vE '^[[:space:]]*($|#)' "$msg_file" | head -n1)
    body=$(cat "$msg_file")

    changed=()
    while IFS= read -r f; do
        [[ -z "$f" ]] && continue
        changed+=("$f")
    done < <(git diff --cached --name-only --diff-filter=ACMR -- 2>/dev/null || true)

    if [[ ${#changed[@]} -eq 0 ]]; then
        validate "pending commit" "$subject" "$body"
    else
        validate "pending commit" "$subject" "$body" "${changed[@]}"
    fi
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

if [[ -z "$base" ]]; then
    directive_end
fi

while IFS= read -r sha; do
    [[ -z "$sha" ]] && continue
    parents=$(git log -1 --format=%P "$sha" 2>/dev/null || echo "")
    [[ "$parents" == *' '* ]] && continue
    subject=$(git log -1 --format=%s "$sha" 2>/dev/null || echo "")
    [[ "$subject" == Revert\ \"* ]] && continue
    body=$(git log -1 --format=%B "$sha" 2>/dev/null || echo "")

    changed=()
    while IFS= read -r f; do
        [[ -z "$f" ]] && continue
        changed+=("$f")
    done < <(git diff-tree --no-commit-id --name-only --diff-filter=ACMR -r "$sha" 2>/dev/null || true)

    if [[ ${#changed[@]} -eq 0 ]]; then
        validate "$sha" "$subject" "$body"
    else
        validate "$sha" "$subject" "$body" "${changed[@]}"
    fi
done < <(git log "$base..HEAD" --format='%H')

directive_end
