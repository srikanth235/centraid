#!/usr/bin/env bash
# Type-aware lint pass (oxlint --type-aware via oxlint-tsgolint).
#
# Why this exists as a separate script rather than folding `--type-aware`
# into the root `oxlint .`: type-aware rules need a TypeScript program, and
# in this monorepo oxlint's automatic tsconfig discovery is unreliable — a
# root-level invocation silently activated ZERO type-aware rules on some
# packages (a green pass that checked nothing). So we run per-package with an
# explicit `--tsconfig`, exactly like the `typecheck` task, and we ASSERT that
# rules actually loaded (the "0 rules" guard) so a silent no-op fails the
# build instead of passing.
#
# Each package is linted through its `tsconfig.test.json` (which includes test
# files) when present, so tests are type-aware-linted too. The one exception:
# `no-floating-promises` is NOT applied to *.test.ts, because vitest's
# `it()`/`test()` calls are written as unawaited statements by design — flagging
# those is noise, not bugs. Every other type-aware rule applies to tests as well.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Applied everywhere (src + tests).
RULES_ALL=(
  -D typescript/no-misused-promises
  -D typescript/await-thenable
  -D typescript/switch-exhaustiveness-check
)
# Applied to source only (excluded from *.test.ts — vitest idiom).
RULES_SRC_ONLY=(-D typescript/no-floating-promises)

# Workspaces with real TS source. A missing entry means that package is
# unchecked — keep this in sync with the workspace list.
TARGETS=(
  packages/agent-runtime
  packages/app-engine
  packages/automation
  packages/blueprints
  packages/gateway
  packages/openclaw-plugin
  packages/skills
  apps/desktop
  apps/mobile
)

run() {
  # run <tsconfig> <ignore-glob-or-empty> <rules...> -- <target>
  local cfg="$1"; shift
  local ignore="$1"; shift
  local args=(--type-aware -A all --tsconfig "$cfg")
  [ -n "$ignore" ] && args+=(--ignore-pattern "$ignore")
  bunx oxlint "${args[@]}" "$@" 2>&1 || true
}

fail=0
for pkg in "${TARGETS[@]}"; do
  # Prefer the test-inclusive config so tests are part of the TS program.
  cfg="$pkg/tsconfig.test.json"
  [ -f "$cfg" ] || cfg="$pkg/tsconfig.json"
  [ -f "$cfg" ] || { echo "SKIP $pkg (no tsconfig)"; continue; }

  out_all="$(run "$cfg" "" "${RULES_ALL[@]}" "$pkg/src")"
  out_src="$(run "$cfg" '**/*.test.ts' "${RULES_SRC_ONLY[@]}" "$pkg/src")"

  # Silent-no-op guard: "with 0 rules" means type-aware never engaged.
  if echo "$out_all$out_src" | grep -qE 'with 0 rules'; then
    echo "FAIL $pkg — type-aware activated 0 rules (tsconfig resolution?)"
    echo "$out_all" | tail -2
    fail=1
    continue
  fi

  errs=0
  for out in "$out_all" "$out_src"; do
    n="$(echo "$out" | grep -oE 'and [0-9]+ error' | grep -oE '[0-9]+' || echo 0)"
    errs=$((errs + ${n:-0}))
  done
  if [ "$errs" != "0" ]; then
    echo "FAIL $pkg — $errs type-aware error(s)"
    echo "$out_all"
    echo "$out_src"
    fail=1
  else
    echo "ok   $pkg"
  fi
done

exit "$fail"
