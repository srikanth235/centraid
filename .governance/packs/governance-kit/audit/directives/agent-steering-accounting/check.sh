#!/usr/bin/env bash
# Directive: human-steering events (interrupts, corrections) for the work in this
# change set are recorded by a fresh-context sub-agent in the issue's receipt —
# the rows under `## Accounting` → `### Steering`, and the verdict in a
# `## Steering` attestation section — and that ledger is well-formed.
#
# Why a sub-agent, not an in-hook classifier (issue #325): classifying whether a
# user message is a *correction* is an LLM judgment. The directive used to make
# that judgment inline by shelling out to `claude -p` from the pre-commit hook.
# That call wrote a throwaway transcript into the same `~/.claude/projects/<cwd>/`
# dir at commit time, which the token-accounting newest-mtime heuristic then
# mistook for the real session (the $0.37-for-a-20-minute-session bug), and it
# made the commit hook non-deterministic and online. Folding the judgment into a
# fresh-context sub-agent attestation removes the shell-out at the root: the
# commit hook now makes no `claude -p` / network call. The sub-agent — handed the
# session transcript — records every steering event AND renders the verdict;
# check.sh only gates that the `## Steering` section is present + verdict-bearing
# (via the shared `subagent_attest` infra) and that the rows are well-formed.
#
# Steering rows are well-formed — v2 is 9 columns
# (`steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp`).
# `validate-dir` checks per-row shape, type/tier in the allowed sets, the
# receipt-homed issue, append-only epoch order, per-session `ordinal`
# strict-increase, global steer-key uniqueness, and cross-receipt
# `(session, ordinal)` identity. Legacy v1 rows (7 columns) still parse.
#
# The `## Steering` attestation is gated only on receipts ADDED in the change set
# (forward-looking, same scope as receipt-per-issue's `## Audit`); pre-existing
# receipts are grandfathered. `validate-dir` runs repo-wide in every mode.
#
# Ledger row I/O lives in sibling lib/ledger.py.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "agent-steering-accounting"
require_git

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1
RECEIPTS_DIR="$ROOT/receipts"
LIB="$HERE/lib"

if [[ ! -f "$LIB/ledger.py" ]]; then
    violation "directive folder is missing lib/ledger.py — cannot validate"
    directive_end
fi

# ──────────────────────────────────────────────────────────────
# Receipt steering-ledger shape check (repo-wide, independent of any commit).
# ──────────────────────────────────────────────────────────────
if [[ -d "$RECEIPTS_DIR" ]]; then
    while IFS= read -r v; do
        [[ -z "$v" ]] && continue
        violation "$v"
    done < <(python3 "$LIB/ledger.py" validate-dir "$RECEIPTS_DIR" || true)
fi

# ──────────────────────────────────────────────────────────────
# `## Steering` attestation gate (issue #325), change-set scoped.
# Skip cleanly on an older runtime lib.sh that predates subagent_attest — the
# shape check above still runs, and the attestation auto-activates the moment
# this repo updates to a kit whose lib.sh defines the helper.
# ──────────────────────────────────────────────────────────────
if declare -F subagent_attest >/dev/null 2>&1 && [[ -d "$RECEIPTS_DIR" ]]; then
    # Build the set of receipts ADDED in the current change set — these owe the
    # attestation; pre-existing receipts are grandfathered. Union of staged
    # additions (pre-commit) and base..HEAD additions (CI), so the one argless
    # check covers both the hook and run.sh.
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

    # Per-receipt waiver: `governance: allow-agent-steering-accounting <reason>`
    # in the first 10 lines (reason required; HTML comment markers stripped).
    has_steering_waiver() {
        local file="$1"
        [[ -f "$file" ]] || return 1
        head -n 10 "$file" 2>/dev/null \
            | sed -E 's/<!--//g; s/-->//g' \
            | grep -qE 'governance:[[:space:]]*allow-agent-steering-accounting[[:space:]]+[^[:space:]]'
    }

    # Accounting-only stub: a receipt whose only level-2 heading is `## Accounting`
    # (created before the agent writes the narrative). Not a real receipt yet.
    is_accounting_stub() {
        local file="$1"
        [[ -f "$file" ]] || return 1
        local h2
        h2="$(grep -E '^##[[:space:]]+' "$file" 2>/dev/null | sed -E 's/^##[[:space:]]+//; s/[[:space:]]+$//')"
        [[ "$h2" == "Accounting" ]]
    }

    while IFS= read -r f; do
        [[ -z "$f" ]] && continue
        [[ -f "$f" ]] || continue
        is_accounting_stub "$f" && continue
        has_steering_waiver "$f" && continue
        # The judgment task is declared once in directive.yaml's `subagent:`
        # block. subagent_attest reads it, gates the section's presence +
        # verdict, and registers it (isolation: shared) so the run-level
        # orchestrator batches it with receipt-per-issue's `## Audit` into one
        # sub-agent per commit.
        subagent_attest "$f"
    done <<< "$ADDED_RECEIPTS"
fi

directive_end
