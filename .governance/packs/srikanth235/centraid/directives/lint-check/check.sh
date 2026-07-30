#!/usr/bin/env bash
# Directive: lint-check — staged files that oxlint owns must already be free of
# oxlint errors.
#
# Why this exists (#576): oxlint is the cheapest gate in the repo — 0.11s for
# two files, 1.7s for the whole tree — but until now nothing ran it until
# `check:pr` at push time, or the `static` CI job after that. A lint error
# committed at 10:00 was discovered at 10:40. Running it against the staged set
# closes that window for ~0.1s per commit.
#
# Scope is STAGED FILES ONLY, mirroring `format-check`. A repo-wide gate blocks
# on pre-existing debt in files the author never opened, which is how
# `--no-verify` becomes muscle memory.
#
# Warnings are denied by the root policy, matching `bun run lint` in CI.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "lint-check"
require_git

# oxlint is a devDependency; prefer the local binary so the hook never reaches
# for the network. If it is missing (fresh clone, no install yet) skip rather
# than block — an unrunnable gate must not stop a commit.
REPO_ROOT="$(git rev-parse --show-toplevel)"
OXLINT=""
for candidate in "$REPO_ROOT/node_modules/.bin/oxlint" "node_modules/.bin/oxlint"; do
    if [[ -x "$candidate" ]]; then
        OXLINT="$candidate"
        break
    fi
done
if [[ -z "$OXLINT" ]]; then
    directive_end
fi

# Extensions oxlint owns. Anything else staged is none of this check's
# business — notably .json/.css, which `format-check` covers and oxlint does not.
staged=()
while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    [[ -f "$file" ]] || continue
    case "$file" in
    *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs | *.mts | *.cts)
        staged+=("$file")
        ;;
    esac
done < <(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)

if [[ ${#staged[@]} -eq 0 ]]; then
    directive_end
fi

# Pin the repo's own config. Bare oxlint auto-discovers upward from the cwd,
# and a worktree under .claude/worktrees/ would otherwise pick up the PARENT
# checkout's config — a different tree, possibly a different oxlint era, and
# a parse error under this binary (#565). CI's static lane passes -c too, so
# this also keeps the hook's verdict identical to the gate it stands in for.
config_args=()
if [[ -f "$REPO_ROOT/oxlint.config.ts" ]]; then
    config_args=(-c "$REPO_ROOT/oxlint.config.ts" --disable-nested-config --deny-warnings)
fi

# oxlint's exit code is the verdict: non-zero means at least one error. Its
# diagnostics go to stdout, so capture both and replay the diagnostics as
# violation lines when it fails. A crash (config error, unreadable file) is
# also non-zero and surfaces the same way rather than passing silently.
output="$("$OXLINT" "${config_args[@]}" "${staged[@]}" 2>&1)"
status=$?

if [[ $status -ne 0 ]]; then
    while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        # Drop oxlint's trailing throughput line; the diagnostics are the signal.
        [[ "$line" == Finished\ in\ * ]] && continue
        violation "$line"
    done <<<"$output"
    # A non-zero exit with no printed diagnostic still has to fail closed.
    if [[ -z "$output" ]]; then
        violation "oxlint exited $status with no diagnostic (run: bun run lint)"
    fi
fi

directive_end
