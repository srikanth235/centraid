#!/usr/bin/env bash
# Type-aware lint pass (oxlint --type-aware via oxlint-tsgolint).
#
# Why this exists as a separate script rather than folding `--type-aware`
# into the root `oxlint .`: type-aware rules need a TypeScript program, and
# in this monorepo oxlint's automatic tsconfig discovery is unreliable — a
# root-level invocation silently activated ZERO type-aware rules on some
# packages (a green pass that checked nothing). So we run per-package with an
# explicit `--tsconfig`, exactly like the `typecheck` task, and we ASSERT that
# rules actually loaded so a silent no-op fails the build instead of passing.
#
# Each package is linted through its `tsconfig.test.json` (which includes test
# files) when present, so tests are type-aware-linted too. The one exception:
# `no-floating-promises` is NOT applied to *.test.ts, because vitest's
# `it()`/`test()` calls are written as unawaited statements by design — flagging
# those is noise, not bugs. Every other type-aware rule applies to tests as well.
#
# HOW RESULTS ARE READ (#616). This script used to parse oxlint's human summary
# line ("Found N warnings and M errors"). `--type-aware` does not print that
# line at all — it prints diagnostics and nothing else — so the error count
# always parsed as zero and the "0 rules" guard never matched. Every package
# reported `ok` while its findings were discarded, and four workspaces whose
# tsconfig oxlint-tsgolint outright rejects also reported `ok`. We now read the
# machine-readable `--format=json` envelope instead, and assert on three things
# per run: the diagnostic list is empty, `number_of_rules` equals the number of
# rules we asked for, and `number_of_files` is non-zero. A tsconfig oxlint
# cannot load surfaces as a `typescript(tsconfig-error)` diagnostic, so it now
# fails the package rather than passing silently.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OXLINT="$ROOT/node_modules/.bin/oxlint"
[ -x "$OXLINT" ] || { echo "FAIL — $OXLINT not found (run 'bun install')"; exit 1; }

# Applied everywhere (src + tests).
RULES_ALL=(
  typescript/no-misused-promises
  typescript/await-thenable
  typescript/switch-exhaustiveness-check
  # Adopted in #619 — measured cost at adoption was 13 sites repo-wide, all
  # fixed in the same change. The expensive candidates (no-unnecessary-condition
  # ~900, no-unsafe-argument ~440) were measured and deliberately deferred as
  # ratchet-scale work; see the #619 measurement table before adding them here.
  typescript/only-throw-error
  typescript/no-for-in-array
  typescript/require-array-sort-compare
  typescript/prefer-promise-reject-errors
)
# Applied to source only (excluded from *.test.ts — vitest idiom).
RULES_SRC_ONLY=(
  typescript/no-floating-promises
)

# Workspaces with real TS source, checked by this pass. Do not hand-maintain
# this against memory: `check_targets_complete` below walks packages/* and
# apps/* and fails the build if a workspace with TS sources under src/ is
# neither listed here nor given a reason in TARGETS_EXCLUDED. Adding a package
# to the repo therefore cannot silently opt it out of type-aware linting.
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
  packages/tunnel
  packages/vault
  apps/desktop
  apps/extension
  apps/mobile
  apps/web
)

# Workspaces deliberately outside the pass, each with the reason it cannot be
# linted here, as "<path>:<reason>". Keep this list short and keep the reasons
# honest — an entry added to silence a failure is the exact hazard this script
# exists to prevent. (Plain array, not an associative one: macOS ships bash
# 3.2, where `declare -A` does not exist.)
TARGETS_EXCLUDED=(
  # apps/oauth-worker's tsconfig `types` points at worker-configuration.d.ts,
  # which wrangler generates (`bun run cf-typegen`) and .gitignore excludes.
  # Without that file oxlint-tsgolint cannot build the program at all. The
  # package is three source files and its own `typecheck` script generates the
  # types first, so it is covered there rather than here.
  "apps/oauth-worker:generated worker-configuration.d.ts is gitignored; covered by its own typecheck"
)

check_targets_complete() {
  local missing=0 dir
  for dir in packages/*/ apps/*/; do
    dir="${dir%/}"
    [ -d "$dir/src" ] || continue
    # Only workspaces that actually have TypeScript sources.
    find "$dir/src" \( -name '*.ts' -o -name '*.tsx' \) -print -quit | grep -q . || continue

    local listed=0 t
    for t in "${TARGETS[@]}"; do
      [ "$t" = "$dir" ] && listed=1 && break
    done
    if [ "$listed" = 1 ]; then continue; fi

    local excluded=0 e
    for e in "${TARGETS_EXCLUDED[@]}"; do
      [ "${e%%:*}" = "$dir" ] && excluded=1 && break
    done
    if [ "$excluded" = 1 ]; then continue; fi

    echo "FAIL $dir — has TypeScript sources but is in neither TARGETS nor TARGETS_EXCLUDED in $0"
    missing=1
  done
  return "$missing"
}

# run <tsconfig> <ignore-glob-or-empty> <expected-rule-count> <rule...> -- <target-dir>
# Prints the JSON envelope on stdout; the caller asserts on it.
run() {
  local cfg="$1"; shift
  local ignore="$1"; shift
  # --disable-nested-config: oxlint auto-discovers per-directory `.oxlintrc.json`
  # files, and a nested config REPLACES the rule set rather than merging with the
  # `-D` flags below. `packages/blueprints/.oxlintrc.json` switches every
  # category off (it exists to scope browser globals for the blueprint apps), so
  # discovering it here silently reduced this pass to zero rules for that whole
  # package. The rule set for a type-aware run is decided here, not per-package.
  local args=(--type-aware -A all --disable-nested-config --format=json --tsconfig "$cfg")
  if [ -n "$ignore" ]; then args+=(--ignore-pattern "$ignore"); fi
  while [ "$1" != "--" ]; do args+=(-D "$1"); shift; done
  shift
  # oxlint exits non-zero when it reports anything; we assert on the JSON, so
  # the exit code is deliberately ignored here rather than aborting under -e.
  "$OXLINT" "${args[@]}" "$@" 2>/dev/null || true
}

# assert_clean <package> <expected-rule-count> <json>
# Fails when: JSON is unparseable, any diagnostic was reported, fewer rules
# than requested actually loaded, or zero files were linted.
assert_clean() {
  node -e '
    const [pkg, expected, json] = process.argv.slice(1);
    let env;
    try {
      env = JSON.parse(json);
    } catch {
      console.log(`FAIL ${pkg} — could not parse oxlint JSON output (type-aware pass produced no envelope)`);
      console.log(json.slice(0, 2000));
      process.exit(1);
    }
    const problems = [];
    if (env.number_of_rules !== Number(expected)) {
      problems.push(
        `type-aware activated ${env.number_of_rules} rule(s), expected ${expected} — tsconfig resolution or rule name drift`
      );
    }
    if (!env.number_of_files) {
      problems.push("linted 0 files — target path or ignore pattern is wrong");
    }
    const diagnostics = env.diagnostics ?? [];
    if (diagnostics.length) {
      problems.push(`${diagnostics.length} type-aware error(s)`);
    }
    if (!problems.length) {
      process.exit(0);
    }
    console.log(`FAIL ${pkg} — ${problems.join("; ")}`);
    for (const d of diagnostics) {
      const loc = d.labels?.[0]?.span;
      const at = loc ? `:${loc.line}:${loc.column}` : "";
      console.log(`  ${d.filename ?? "?"}${at} ${d.code}: ${d.message}`);
    }
    process.exit(1);
  ' "$1" "$2" "$3"
}

fail=0
check_targets_complete || fail=1

for pkg in "${TARGETS[@]}"; do
  # Prefer the test-inclusive config so tests are part of the TS program.
  cfg="$pkg/tsconfig.test.json"
  [ -f "$cfg" ] || cfg="$pkg/tsconfig.json"
  [ -f "$cfg" ] || { echo "FAIL $pkg — listed in TARGETS but has no tsconfig"; fail=1; continue; }

  out_all="$(run "$cfg" "" "${RULES_ALL[@]}" -- "$pkg/src")"
  # The glob covers .tsx as well as .ts: it read `**/*.test.ts` until #616, so
  # the vitest exclusion silently did not apply to React component tests.
  out_src="$(run "$cfg" '**/*.test.{ts,tsx}' "${RULES_SRC_ONLY[@]}" -- "$pkg/src")"

  pkg_ok=1
  assert_clean "$pkg" "${#RULES_ALL[@]}" "$out_all" || pkg_ok=0
  assert_clean "$pkg" "${#RULES_SRC_ONLY[@]}" "$out_src" || pkg_ok=0

  if [ "$pkg_ok" = 1 ]; then
    echo "ok   $pkg"
  else
    fail=1
  fi
done

exit "$fail"
