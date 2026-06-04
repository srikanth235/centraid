# issue-210 — Tests into typecheck + type-aware lint, intentional oxlint profile, handler-path regression fixes

GitHub issue: [#210](https://github.com/srikanth235/centraid/issues/210)

The lint/type setup was inherited (ultracite's maximal profile) rather than
chosen, and carried real gaps: no type-aware linting despite a large async
surface, and test files excluded from both `tsc` typecheck and lint — so ~79
test files were checked by nothing. Bringing tests into the type program and
turning on type-aware rules surfaced both latent test type errors and three
real production regressions (stale relative paths left by the #195–#199 file
relocations) that CI had been masking via cached test results.

## Checklist

- [x] Intentional oxlint profile
- [x] Type-aware linting
- [x] Tests in the type program
- [x] Findings fixed
- [x] Handler-path regressions

## What changed

### Intentional oxlint profile

Keep ultracite's deny-by-default baseline — all six categories
(`correctness`, `suspicious`, `pedantic`, `perf`, `restriction`, `style`) at
error, ~364 active rules — where the suppression list *is* the curation: a
documented record of the rules we opted out of. Disabling whole categories was
considered and rejected because it dropped ~170 rules the codebase already
passed (free guardrails against agent-written regressions) for thin benefit.

Layered on top: `no-restricted-imports` (ban deep imports into a package's
`src`/`dist`; plus per-package `overrides` enforcing that `app-engine` imports
no other `@centraid/*` and `automation` never imports an agent backend) and
`typescript/ban-ts-comment`. `no-non-null-assertion` is intentionally left off
(see Out of scope) — not on category grounds, but because its violations lack a
safe mechanical fix.

### Type-aware linting

`oxlint --type-aware` (via the `oxlint-tsgolint` dev dependency) runs through
`scripts/lint-types.sh`, wired into the root `ci` script as `lint:types` **and
into the CI workflow** (`.github/workflows/ci.yml` runs `bun run lint:types`
after typecheck, so the type-aware pass is actually enforced on PRs — the
workflow previously ran only `check` + `typecheck`). oxlint's automatic tsconfig
discovery is unreliable in this monorepo — a root invocation silently ran zero
type-aware rules on some packages — so the script runs per-package with an
explicit `--tsconfig` and asserts rules actually loaded (a "0 rules" result
fails the build). Enforces `no-floating-promises`, `no-misused-promises`,
`await-thenable`, and `switch-exhaustiveness-check`.

Multi-file analysis (oxlint's module-graph feature) is already active via the
ultracite baseline: the `import` plugin plus `import/no-cycle` give true
cross-file circular-dependency detection, complementing the syntactic
`no-restricted-imports` layering rules. The CI oxlint step uses `--format github`
for inline PR annotations.

### Tests in the type program

Each package with tests gains a `tsconfig.test.json` (extends the build config,
`noEmit`, `allowImportingTsExtensions`, includes `*.test.ts`); the build config
keeps excluding tests so `dist/` stays clean. Package `typecheck` scripts now
point at it, and the type-aware pass lints tests too — except
`no-floating-promises`, which is excluded from `*.test.ts` because node:test's
`it()`/`test()` return promises the runner intentionally does not await.

### Findings fixed

Type-aware: four floating promises (app-engine + automation worker IIFEs,
desktop + mobile startup), two non-exhaustive switches (app-engine turn event
ledger — now lists the no-op events explicitly so a new event type re-trips the
check; gateway flag parser), six misused-promise async handlers (gateway
SIGINT/SIGTERM, three desktop event handlers, mobile `onRefresh`). Plus 14
latent type errors in tests, fixed at the right level (e.g. narrowing
`buildSettingsInject`'s return to `Required<SettingsInject>` rather than
weakening the shared interface; loosely typing a manifest test fixture).

### Handler-path regressions (production bugs)

The #195–#199 relocations moved worker/CLI files but left stale relative paths:

- `automation` and `app-engine` `handler-runner` resolved the worker as
  `here/worker/runner.js` (→ `handlers/worker/…`) after the worker moved up to
  `worker/`; every handler invocation failed with `Cannot find module`. Fixed to
  `here/../worker/…` with a `.ts` fallback for tsx.
- `agent-runtime`'s CLI moved `src/` → `src/cli/`; the smoke test computed
  `src/dist/centraid-cli.js` and the package `bin` still pointed at
  `./dist/centraid-cli.js` (resolving only by luck to a stale artifact). Both
  repointed to `dist/cli/centraid-cli.js`.
- `turbo` `test` now depends on own `build` so the CLI smoke test reliably has a
  freshly built bin instead of relying on a stale `dist`.

## Out of scope

- **`no-non-null-assertion`**: 282 existing uses, mostly legitimate
  post-bounds-check `arr[i]!`. It is a style preference, not a bug-catcher;
  mass-rewriting to `?.`/guards would change semantics and risk masking bugs.
  Left off; `no-explicit-any` and `ban-ts-comment` remain on.
- **Governance directive for module-layering by-default**: the oxlint
  `no-restricted-imports` overrides are a blocklist (named packages); enforcing
  the full dependency DAG for new packages by default would be a separate
  governance check.
- **Migrating off ultracite entirely / formatter changes**: out of scope.

## Verification

- `bun run test` — 653 pass / 0 fail (17/17 package tasks; 1 conditional skip).
- `bunx oxlint .` — 0 warnings / 0 errors.
- `bun run lint:types` (type-aware, including tests) — all packages ok.
- `bun run typecheck` (now includes test files) — 17/17 tasks pass.
