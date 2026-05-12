#!/usr/bin/env bash
# Directive: required-docs — a repo ships the baseline set of root-level documents
# and local-hook scaffolding. Rolls up: constitution-exists, agents-md-exists,
# readme-exists, license-exists, security-md-exists, architecture-doc-exists,
# ci-workflow-exists, env-example-current, hooks-configured.
#
# To carve out a sub-check for your repo, use `governance directive modify` to
# amend this script (or `governance directive remove` to drop the directive
# entirely). Threshold tunables — GOVERNANCE_AGENTS_MD_MIN / _MAX /
# _MIN_LINKS and GOVERNANCE_ARCHITECTURE_MIN — remain available below.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "required-docs"
require_git

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1

# ── constitution ────────────────────────────────────────────────
FILE="$ROOT/CONSTITUTION.md"
if [[ ! -f "$FILE" ]]; then
    violation "CONSTITUTION.md not found at repo root"
elif [[ ! -s "$FILE" ]]; then
    violation "CONSTITUTION.md exists but is empty"
elif [[ $(wc -l < "$FILE") -lt 10 ]]; then
    violation "CONSTITUTION.md has fewer than 10 lines — looks like a stub"
fi

# ── agents ──────────────────────────────────────────────────────
FILE="$ROOT/AGENTS.md"
if [[ ! -f "$FILE" ]]; then
    violation "AGENTS.md not found at repo root"
else
    lines=$(wc -l < "$FILE" | tr -d ' ')
    MIN_LINES="${GOVERNANCE_AGENTS_MD_MIN:-30}"
    MAX_LINES="${GOVERNANCE_AGENTS_MD_MAX:-250}"
    if [[ $lines -lt $MIN_LINES ]]; then
        violation "AGENTS.md has $lines lines — looks like a stub (min: $MIN_LINES)"
    fi
    if [[ $lines -gt $MAX_LINES ]]; then
        violation "AGENTS.md has $lines lines — drifting toward a manual (max: $MAX_LINES). Move detail into linked docs."
    fi
    link_count=$(grep -oE '\]\([^)]+\)' "$FILE" 2>/dev/null \
        | grep -cvE '\((https?://|mailto:|tel:|#)' 2>/dev/null || true)
    link_count="${link_count:-0}"
    MIN_LINKS="${GOVERNANCE_AGENTS_MD_MIN_LINKS:-3}"
    if [[ $link_count -lt $MIN_LINKS ]]; then
        violation "AGENTS.md has $link_count internal links — an index should link out (min: $MIN_LINKS)"
    fi
    # AGENTS.md should be a map to the bedrock durable docs. The
    # `constitution` sub-check already mandates CONSTITUTION.md at
    # root — require AGENTS.md to link to it so a fresh reader has
    # one anchored hop to the directive set.
    if [[ -f "$ROOT/CONSTITUTION.md" ]] \
        && ! grep -qE '\]\((\./)?CONSTITUTION\.md(#[^)]*)?\)' "$FILE"; then
        violation "AGENTS.md does not link to CONSTITUTION.md — an index should point at the bedrock durable docs"
    fi
fi

# ── readme ──────────────────────────────────────────────────────
README=""
for c in README.md README README.rst; do
    [[ -f "$ROOT/$c" ]] && { README="$ROOT/$c"; break; }
done
if [[ -z "$README" ]]; then
    violation "no README.md / README / README.rst at repo root"
else
    if ! grep -qE '^#[^#]' "$README" 2>/dev/null && ! grep -qE '^=+$' "$README" 2>/dev/null; then
        violation "$(basename "$README") has no top-level heading"
    fi
    if [[ $(wc -w < "$README") -lt 30 ]]; then
        violation "$(basename "$README") has fewer than 30 words — looks like a stub"
    fi
fi

# ── license ─────────────────────────────────────────────────────
LICENSE=""
for c in LICENSE LICENSE.md LICENSE.txt COPYING COPYING.md; do
    [[ -f "$ROOT/$c" ]] && { LICENSE="$c"; break; }
done
if [[ -z "$LICENSE" ]]; then
    violation "no LICENSE file at repo root (looked for LICENSE, LICENSE.md, LICENSE.txt, COPYING, COPYING.md)"
elif [[ ! -s "$ROOT/$LICENSE" ]]; then
    violation "$LICENSE exists but is empty"
fi

# ── security ────────────────────────────────────────────────────
SECURITY=""
for c in SECURITY.md docs/SECURITY.md .github/SECURITY.md; do
    [[ -f "$ROOT/$c" ]] && { SECURITY="$ROOT/$c"; break; }
done
if [[ -z "$SECURITY" ]]; then
    violation "no SECURITY.md (looked at: SECURITY.md, docs/SECURITY.md, .github/SECURITY.md)"
elif [[ ! -s "$SECURITY" ]]; then
    violation "$SECURITY exists but is empty"
elif ! grep -qE '([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|https?://|hackerone|bugcrowd)' "$SECURITY"; then
    violation "$SECURITY has no contact email, URL, or vulnerability-disclosure platform reference"
fi

# ── architecture ────────────────────────────────────────────────
ARCH=""
for c in ARCHITECTURE.md docs/ARCHITECTURE.md ARCHITECTURE.rst docs/architecture.md; do
    [[ -f "$ROOT/$c" ]] && { ARCH="$ROOT/$c"; break; }
done
if [[ -z "$ARCH" ]]; then
    violation "no ARCHITECTURE.md (looked at: ARCHITECTURE.md, docs/ARCHITECTURE.md, ARCHITECTURE.rst, docs/architecture.md)"
elif [[ ! -s "$ARCH" ]]; then
    violation "$ARCH exists but is empty"
else
    lines=$(wc -l < "$ARCH" | tr -d ' ')
    MIN_LINES="${GOVERNANCE_ARCHITECTURE_MIN:-20}"
    if [[ $lines -lt $MIN_LINES ]]; then
        violation "$ARCH has $lines lines — looks like a stub (min: $MIN_LINES)"
    fi
fi

# ── ci-workflow ─────────────────────────────────────────────────
WF_DIR="$ROOT/.github/workflows"
if [[ ! -d "$WF_DIR" ]]; then
    violation "no .github/workflows/ directory"
else
    shopt -s nullglob
    count=0
    for f in "$WF_DIR"/*.yml "$WF_DIR"/*.yaml; do
        bn="$(basename "$f")"
        [[ "$bn" == "governance.yml" || "$bn" == "governance.yaml" ]] && continue
        count=$((count + 1))
    done
    shopt -u nullglob
    if [[ $count -eq 0 ]]; then
        violation ".github/workflows/ has no non-governance workflow (CI is the backstop for skipped hooks)"
    fi
fi

# ── env-example ─────────────────────────────────────────────────
ENV_FILE="$ROOT/.env"
EXAMPLE_FILE="$ROOT/.env.example"
if [[ -f "$ENV_FILE" ]]; then
    if [[ ! -f "$EXAMPLE_FILE" ]]; then
        violation ".env exists but .env.example is missing"
    else
        _extract_keys() {
            grep -vE '^[[:space:]]*(#|$)' "$1" | sed -E 's/^[[:space:]]*export[[:space:]]+//' \
                | awk -F= '{print $1}' | sed 's/[[:space:]]*$//' | sort -u
        }
        _env_keys=$(_extract_keys "$ENV_FILE")
        _example_keys=$(_extract_keys "$EXAMPLE_FILE")
        while IFS= read -r key; do
            [[ -z "$key" ]] && continue
            if ! grep -qxF "$key" <<<"$_example_keys"; then
                violation ".env has key '$key' but .env.example does not"
            fi
        done <<<"$_env_keys"
    fi
fi

# ── hooks ───────────────────────────────────────────────────────
# The .githooks/ scaffolding is only meaningful when the installed hook
# strategy is `githooks`. Skip transparently for husky / pre-commit.com
# repos (the framework has its own tracked hook-config mechanism).
_hook_strategy="githooks"
_manifest="$ROOT/.governance/install.yaml"
if [[ -f "$_manifest" ]]; then
    _hs=$(grep -E '^hook_strategy:' "$_manifest" | head -1 | awk '{print $2}' | tr -d '"')
    [[ -n "$_hs" ]] && _hook_strategy="$_hs"
fi

if [[ "$_hook_strategy" == "githooks" ]]; then
    if ! git ls-files --error-unmatch .githooks/pre-commit >/dev/null 2>&1; then
        violation ".githooks/pre-commit is not tracked — bootstrap should ship it"
    elif [[ ! -x .githooks/pre-commit ]]; then
        violation ".githooks/pre-commit exists but is not executable (chmod +x .githooks/pre-commit)"
    fi

    if [[ -f .governance/packs/governance-kit/core/directives/commit-message-format/check.sh ]]; then
        if ! git ls-files --error-unmatch .githooks/commit-msg >/dev/null 2>&1; then
            violation ".githooks/commit-msg is not tracked — required because commit-message-format is installed"
        elif [[ ! -x .githooks/commit-msg ]]; then
            violation ".githooks/commit-msg exists but is not executable (chmod +x .githooks/commit-msg)"
        fi
    fi

    if [[ -z "${CI:-}" && -z "${GITHUB_ACTIONS:-}" ]]; then
        configured="$(git config --get core.hooksPath 2>/dev/null || true)"
        if [[ -z "$configured" ]]; then
            violation "core.hooksPath is not set — run: git config core.hooksPath .githooks"
        else
            if [[ "$configured" = /* ]]; then
                resolved="$configured"
            else
                resolved="$ROOT/$configured"
            fi
            if [[ "$(basename "$resolved")" != ".githooks" ]]; then
                violation "core.hooksPath is '$configured' — expected a path ending in '.githooks' (run: git config core.hooksPath .githooks)"
            elif [[ ! -d "$resolved" ]]; then
                violation "core.hooksPath is '$configured' but '$resolved' is not a directory"
            elif [[ ! -x "$resolved/pre-commit" ]]; then
                violation "core.hooksPath='$configured' but '$resolved/pre-commit' is missing or not executable"
            fi
        fi
    fi
fi

directive_end
