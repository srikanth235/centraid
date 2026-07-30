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

# Applied everywhere (source + tests).
RULES_ALL=(
  -D typescript/no-misused-promises
  -D typescript/await-thenable
  -D typescript/switch-exhaustiveness-check
)
# Applied to source only. Vitest deliberately uses unawaited it()/test() calls.
RULES_SRC_ONLY=(-D typescript/no-floating-promises)

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
  packages/design-tokens
  packages/gateway
  packages/protocol
  packages/test-kit
  packages/time-engine
  packages/tunnel
  packages/vault
  apps/desktop
  apps/extension
  apps/mobile
  apps/web
)

# oauth-worker is intentionally excluded: its tsconfig depends on the
# gitignored wrangler-generated worker-configuration.d.ts. Its package-local
# typecheck runs `cf-typegen` before tsc, which is the only valid program setup.
EXCLUDED=(apps/oauth-worker)

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
    if ! contains "$workspace" "${TARGETS[@]}" && ! contains "$workspace" "${EXCLUDED[@]}"; then
      echo "FAIL $workspace — TypeScript workspace is neither targeted nor excluded with a reason"
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
    -A all
    --tsconfig "$cfg"
  )
  [[ -n "$ignore" ]] && args+=(--ignore-pattern "$ignore")
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
      process.stderr.write(JSON.stringify({
        diagnostics,
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
  out_src="$(run "$cfg" '**/*.test.{ts,tsx}' "${RULES_SRC_ONLY[@]}" -- "$pkg/src" || true)"

  if ! assert_envelope "$pkg" "all" "$(( ${#RULES_ALL[@]} / 2 ))" "$out_all" || \
    ! assert_envelope "$pkg" "source" "$(( ${#RULES_SRC_ONLY[@]} / 2 ))" "$out_src"; then
    fail=1
    continue
  fi
  echo "ok   $pkg"
done

exit "$fail"
