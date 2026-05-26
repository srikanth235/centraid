#!/usr/bin/env bash
# Pre-commit format + lint guard. Invoked by .githooks/pre-commit when
# SKIP_LINT != "1". Runs oxfmt --check and oxlint against the files that
# would actually land in this commit.
#
# Staged-only matters for two reasons:
#   - Speed: ~100ms vs ~500ms for `bun run check` over the whole repo.
#   - Scope: don't fail a commit on pre-existing issues in files the user
#     didn't touch (e.g. right after pulling a merge).
#
# CI still runs `bun run check` over the whole repo, so anything this hook
# misses (a file edited *after* it was staged, an issue in an unrelated
# file) gets caught there.
#
# Bypass:  SKIP_LINT=1 git commit ...     (CI still enforces)
#
# Compatible with macOS's default bash 3.2 — no mapfile / readarray.

set -u

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1

# Files that are staged AND will exist in the commit (Added, Copied,
# Modified, Renamed). Deletions are out — nothing to check.
staged=()
while IFS= read -r line; do
    [[ -n "$line" ]] && staged+=("$line")
done < <(
    git diff --cached --name-only --diff-filter=ACMR \
        | grep -E '\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|mdx|yaml|yml)$' || true
)

if [[ ${#staged[@]} -eq 0 ]]; then
    exit 0
fi

OXFMT="$ROOT/node_modules/.bin/oxfmt"
OXLINT="$ROOT/node_modules/.bin/oxlint"

if [[ ! -x "$OXFMT" || ! -x "$OXLINT" ]]; then
    echo "lint-staged: oxfmt or oxlint not installed — run \`bun install\`" >&2
    exit 1
fi

if ! "$OXFMT" --check --no-error-on-unmatched-pattern "${staged[@]}"; then
    cat >&2 <<'EOF'

✗ Commit blocked by oxfmt.
  Fix:    bun run format
  Bypass: SKIP_LINT=1 git commit ...  (CI still enforces)
EOF
    exit 1
fi

# oxlint takes file lists positionally; the .oxlintrc.json at the repo
# root applies automatically.
if ! "$OXLINT" "${staged[@]}"; then
    cat >&2 <<'EOF'

✗ Commit blocked by oxlint.
  Fix:    address the rules above
  Bypass: SKIP_LINT=1 git commit ...  (CI still enforces)
EOF
    exit 1
fi
