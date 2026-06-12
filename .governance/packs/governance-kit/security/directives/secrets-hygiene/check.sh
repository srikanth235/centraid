#!/usr/bin/env bash
# Directive: secrets-hygiene — no plaintext secret patterns in tracked files and
# `.env` is gitignored / untracked. Rolls up: hardcoded-credentials (CWE-798),
# dotenv-gitignored.
#
# To carve out a sub-check for your repo, use `governance directive modify` to
# amend this script (or `governance directive remove` to drop the directive
# entirely). Per-occurrence waivers via `# governance: allow-secrets-hygiene
# <reason>` remain available for the hardcoded-credentials sub-check.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "secrets-hygiene"
require_git

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1

# ── hardcoded-credentials (CWE-798) ─────────────────────────────
_patterns=(
    "AWS access key|AKIA[0-9A-Z]{16}"
    "AWS secret key|aws_secret_access_key[[:space:]]*=[[:space:]]*['\"]?[A-Za-z0-9/+=]{40}"
    "GCP service account|-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----"
    "GitHub token|gh[pousr]_[A-Za-z0-9]{36,}"
    "Slack token|xox[baprs]-[A-Za-z0-9-]{10,}"
    "Generic API key|api[_-]?key[[:space:]]*[:=][[:space:]]*['\"][A-Za-z0-9]{32,}['\"]"
    "Stripe live key|sk_live_[A-Za-z0-9]{24,}"
)
_excludes=(
    ":!.governance/packs/governance-kit/security/directives/secrets-hygiene/**"
    ":!CONSTITUTION.md"
    ":!packs/*/directives/*/evals/**"
    ":!*.lock"
    ":!*.lockfile"
    ":!package-lock.json"
    ":!yarn.lock"
    ":!pnpm-lock.yaml"
    ":!Cargo.lock"
    ":!poetry.lock"
    ":!Pipfile.lock"
    ":!go.sum"
)
for entry in "${_patterns[@]}"; do
    label="${entry%%|*}"
    pattern="${entry#*|}"
    while IFS=: read -r file line_no _; do
        [[ -z "$file" ]] && continue
        has_waiver "$file" "$line_no" "secrets-hygiene" && continue
        violation "$file:$line_no — possible $label"
    done < <(git grep -InE "$pattern" -- "${_excludes[@]}" 2>/dev/null || true)
done

# ── dotenv ──────────────────────────────────────────────────────
while IFS= read -r tracked; do
    [[ -z "$tracked" ]] && continue
    violation "$tracked is tracked — remove with: git rm --cached $tracked"
done < <(git ls-files -- '.env' '.env.*' ':!.env.example' ':!.env.sample' ':!.env.template' 2>/dev/null || true)

if [[ ! -f .gitignore ]]; then
    violation ".gitignore is missing at repo root"
elif ! git check-ignore -q .env 2>/dev/null; then
    if ! grep -qE '^\.env(\s|$|#)' .gitignore && ! grep -qE '^\*\.env(\s|$|#)' .gitignore; then
        violation ".gitignore does not list .env"
    fi
fi

directive_end
