#!/usr/bin/env bash
# Type-aware lint pass (oxlint --type-aware via oxlint-tsgolint).
#
# Type-aware rules are only protection when oxlint both loads every requested
# rule and opens a non-empty TypeScript program. Its human summary disappears
# in --type-aware mode, so this script asserts the JSON envelope instead of
# attempting to parse prose. A non-zero oxlint exit is expected when a rule
# finds a diagnostic; the envelope remains the source of truth for the gate.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Load the canonical allowlist from the shared executable catalog. No rule is
# duplicated textually in this shell script, so deleting a command-line flag
# cannot make the expected count silently shrink with it.
RULES_ALL=()
while IFS= read -r rule; do
  [[ -n "$rule" ]] && RULES_ALL+=(-D "$rule")
done < <(node scripts/lint-types-rules.mjs all)

# Applied to source only. Vitest and Playwright deliberately use unawaited
# it()/test() calls.
RULES_SRC_ONLY=()
while IFS= read -r rule; do
  [[ -n "$rule" ]] && RULES_SRC_ONLY+=(-D "$rule")
done < <(node scripts/lint-types-rules.mjs source)

RULES_BLUEPRINT=()
while IFS= read -r rule; do
  [[ -n "$rule" ]] && RULES_BLUEPRINT+=(-D "$rule")
done < <(node scripts/lint-types-rules.mjs blueprint)

# Every workspace with src/ and a TypeScript program. Keep this explicit list
# so adding a workspace forces a conscious coverage decision.
TARGETS=(
  packages/agent-runtime
  packages/app-engine
  packages/automation
  packages/backup
  packages/blob-format
  packages/blueprints
  packages/cli
  packages/client
  packages/design
  packages/gateway
  packages/protocol
  packages/test-kit
  packages/time-engine
  packages/tunnel
  packages/vault
  apps/desktop
  apps/extension
  apps/mobile
  apps/oauth-worker
  apps/web
)

contains() {
  local needle="$1"
  shift
  local value
  for value in "$@"; do [[ "$value" == "$needle" ]] && return 0; done
  return 1
}

assert_workspace_coverage() {
  local workspace
  for workspace in packages/* apps/*; do
    [[ -d "$workspace/src" && -f "$workspace/tsconfig.json" ]] || continue
    if ! contains "$workspace" "${TARGETS[@]}"; then
      echo "FAIL $workspace — TypeScript workspace is not targeted"
      return 1
    fi
  done
}

run() {
  # run <tsconfig> <ignore-glob-or-empty> <rules...> -- <target>
  local cfg="$1"
  shift
  local ignore="$1"
  shift
  local rules=()
  while [[ "$1" != "--" ]]; do
    rules+=("$1")
    shift
  done
  shift
  local target="$1"
  local args=(
    -c oxlint.config.ts
    --type-aware
    --format=json
    --disable-nested-config
    # Ordinary lint owns directive hygiene; -A all makes that signal hollow in
    # this compatibility pass.
    --report-unused-disable-directives-severity=allow
    -A all
    --tsconfig "$cfg"
  )
  if [[ -n "$ignore" ]]; then
    local ignore_pattern
    while IFS= read -r ignore_pattern; do
      [[ -n "$ignore_pattern" ]] && args+=(--ignore-pattern "$ignore_pattern")
    done < <(tr "|" "\n" <<<"$ignore")
  fi
  oxlint "${args[@]}" "${rules[@]}" "$target"
}

assert_envelope() {
  # assert_envelope <package> <pass> <expected-rule-count> <json>
  local pkg="$1"
  local pass="$2"
  local expected="$3"
  local payload="$4"

  if ! node -e '
    const fs = require("node:fs");
    const expected = Number(process.argv[1]);
    const report = JSON.parse(fs.readFileSync(0, "utf8"));
    const diagnostics = report.diagnostics;
    const valid =
      Array.isArray(diagnostics) &&
      diagnostics.length === 0 &&
      report.number_of_rules === expected &&
      Number.isInteger(report.number_of_files) &&
      report.number_of_files > 0;
    if (!valid) {
      const compactDiagnostics = Array.isArray(diagnostics)
        ? diagnostics.map((diagnostic) => ({
            code: diagnostic.code,
            filename: diagnostic.filename,
            line: diagnostic.labels?.[0]?.span?.line,
            message: diagnostic.message,
          }))
        : diagnostics;
      process.stderr.write(JSON.stringify({
        diagnostics: compactDiagnostics,
        number_of_rules: report.number_of_rules,
        number_of_files: report.number_of_files,
        expected,
      }, null, 2) + "\n");
      process.exit(1);
    }
  ' "$expected" <<<"$payload"; then
    echo "FAIL $pkg ($pass) — expected no diagnostics, $expected rule(s), and non-zero files"
    return 1
  fi
}

assert_workspace_coverage

# The worker's TypeScript program depends on Wrangler's generated ambient
# bindings. Generate them when lint:types runs from a fresh checkout so worker
# coverage does not depend on a prior typecheck command.
if [[ ! -f apps/oauth-worker/worker-configuration.d.ts ]]; then
  bun run --cwd apps/oauth-worker cf-typegen >/dev/null
fi

policy_report="$(node scripts/lint-types-policy.mjs)"
echo "$policy_report"
baseline_rule_count="$(
  sed -n 's/.*baseline \([0-9][0-9]*\)).*/\1/p' <<<"$policy_report"
)"
if [[ -z "$baseline_rule_count" ]]; then
  echo "FAIL type-aware policy — baseline rule count was not reported"
  exit 1
fi
fail=0
for pkg in "${TARGETS[@]}"; do
  cfg="$pkg/tsconfig.test.json"
  [[ -f "$cfg" ]] || cfg="$pkg/tsconfig.json"
  if [[ ! -f "$cfg" ]]; then
    echo "FAIL $pkg — no tsconfig"
    fail=1
    continue
  fi

  # Diagnostics make oxlint return 1. Preserve its JSON output so the envelope
  # assertion can report the actual cause instead of discarding the failure.
  out_all="$(run "$cfg" "" "${RULES_ALL[@]}" -- "$pkg/src" || true)"
  out_src="$(run "$cfg" '**/*.{test,spec}.{ts,tsx}' "${RULES_SRC_ONLY[@]}" -- "$pkg/src" || true)"

  if ! assert_envelope "$pkg" "all" "$(( baseline_rule_count + ${#RULES_ALL[@]} / 2 ))" "$out_all" || \
    ! assert_envelope "$pkg" "source" "$(( baseline_rule_count + ${#RULES_SRC_ONLY[@]} / 2 ))" "$out_src"; then
    fail=1
    continue
  fi
  echo "ok   $pkg"
done

# Executable TypeScript outside workspace src/ trees has its own compiler
# program and explicit source/test profile. These targets close the historical
# gap for blueprint apps/kit, repository scripts/tests, and Playwright e2e.
EXTRA_TARGETS=(
  "blueprint-apps|packages/blueprints/tsconfig.apps.json|packages/blueprints/apps|source"
  "blueprint-kit|packages/blueprints/tsconfig.apps.json|packages/design/kit|source"
  "repository-scripts|scripts/tsconfig.json|scripts|source"
  "repository-tests|tests/tsconfig.json|tests|test"
  "desktop-e2e|apps/desktop/tests/e2e/tsconfig.json|apps/desktop/tests/e2e|test"
  "web-e2e|apps/web/tests/e2e/tsconfig.json|apps/web/tests/e2e|test"
)

for entry in "${EXTRA_TARGETS[@]}"; do
  IFS="|" read -r label cfg target profile <<<"$entry"
  if [[ ! -f "$cfg" ]]; then
    echo "FAIL $label — missing $cfg"
    fail=1
    continue
  fi

  all_ignore=""
  source_ignore='**/*.{test,spec}.{ts,tsx}'
  if [[ "$label" == "repository-scripts" ]]; then
    all_ignore='scripts/fixtures/**|**/*.{js,jsx,mjs,cjs}'
    source_ignore="$all_ignore"
  elif [[ "$label" == "repository-tests" ]]; then
    all_ignore='**/*.{js,jsx,mjs,cjs}'
  fi

  target_rules=("${RULES_ALL[@]}")
  if [[ "$label" == blueprint-* ]]; then
    target_rules=("${RULES_BLUEPRINT[@]}")
  fi

  out_all="$(run "$cfg" "$all_ignore" "${target_rules[@]}" -- "$target" || true)"
  if ! assert_envelope "$label" "all" "$(( baseline_rule_count + ${#target_rules[@]} / 2 ))" "$out_all"; then
    fail=1
    continue
  fi

  if [[ "$profile" == "source" ]]; then
    out_src="$(run "$cfg" "$source_ignore" "${RULES_SRC_ONLY[@]}" -- "$target" || true)"
    if ! assert_envelope "$label" "source" "$(( baseline_rule_count + ${#RULES_SRC_ONLY[@]} / 2 ))" "$out_src"; then
      fail=1
      continue
    fi
  fi
  echo "ok   $label"
done

exit "$fail"
