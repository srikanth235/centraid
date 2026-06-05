# issue-212 — Testing strategy: vitest migration + repo-wide v8 coverage

GitHub issue: [#212](https://github.com/srikanth235/centraid/issues/212)

Issue #212 sets the testing strategy: maximal _meaningful_ coverage given that
coding agents author both the code and the tests. This work lands the strategy as
a durable doc **and** implements its keystone — adopting vitest as the single
runner, migrating the ~80 `node:test` files off `tsx --test`, wiring repo-wide
v8 coverage, and gating the engine packages on seeded line+branch floors enforced
in CI (which previously ran no tests at all). The deeper per-layer work the issue
itself scopes as incremental — expect-matcher conversion, renderer
logic-extraction, the thin Playwright/Maestro e2e journeys — is recorded as
follow-up.

## Checklist

- [x] Author TESTING.md capturing the #212 decisions and the test convention
- [x] Adopt vitest as the single runner and migrate the node:test files
- [x] Wire repo-wide v8 coverage and gate the engine packages
- [x] Run tests + coverage in CI
- [x] Wire TESTING.md into the doc map

## What changed

### Author TESTING.md capturing the #212 decisions and the test convention

New root [TESTING.md](../TESTING.md) records the guiding principle, the six
decisions, the **test convention** (behaviour over implementation, real deps fake
only at the edges, one behaviour per test, assert outcomes not mock calls,
deterministic, clear failure output), the coverage posture with the seeded floor
table, and resolves #212's four open decisions.

### Adopt vitest as the single runner and migrate the node:test files

- Added `vitest`, `@vitest/coverage-v8`, and `jsdom` as root dev dependencies.
- Migrated all 80 `*.test.ts` files off `node:test`: imports `node:test` →
  `vitest`, and `before`/`after` → `beforeAll`/`afterAll` (imports and call
  sites). `node:assert` is kept as-is — it runs unchanged under vitest — so the
  swap is mechanical and verifiable: **653 tests, green-before → green-after**.
- Each package gained a `vitest.config.ts` project; per-package `test` scripts
  changed from `tsx --test "src/**/*.test.ts"` to `vitest run`, and the now-unused
  `tsx` dev dependency was dropped from all eight packages (lockfile reconciled,
  `--frozen-lockfile` clean).
- vitest 3's default `forks` pool (real child processes) keeps `node:sqlite` and
  the worker-thread handler-runner behaving as they did under `node:test`; the
  worker-thread tests load the built `dist` worker.

### Wire repo-wide v8 coverage and gate the engine packages

Root [vitest.config.ts](../vitest.config.ts) aggregates every package as a
project so `bun run coverage` emits **one v8 report** across the repo. The engine
packages (`app-engine`, `gateway`, `automation`, `agent-runtime`, `blueprints`)
are gated on per-package line+branch floors seeded a conservative margin below the
measured baseline (e.g. app-engine 76.7%→72% lines), so they catch regression
without flaking and ratchet up over time. A global `lines: 28` threshold adds a
repo-wide anti-regression floor across every included file (seeded below the
measured ~31% total). Renderer/mobile are tracked, not gated. `coverage/` is
gitignored.

### Run tests + coverage in CI

[.github/workflows/ci.yml](../.github/workflows/ci.yml) gains `bun run build`
then `bun run coverage` after the type-aware lint step — so the suite **and** the
engine coverage floors are enforced on every PR. CI previously ran only
format/lint/typecheck and no tests.

### Wire TESTING.md into the doc map

[AGENTS.md](../AGENTS.md) links TESTING.md from Conventions (with the `test` /
`coverage` commands) and "Where to look"; [QUALITY.md](../QUALITY.md) tracks
what's landed vs. the remaining follow-up under `## Open`.

## Out of scope

- **expect-matcher conversion** — `assert.*` calls run fine under vitest and were
  kept to make the runner swap mechanical and green-before→green-after; rewriting
  ~1,700 assertions to vitest `expect` is follow-up polish, not a blocker.
- **Renderer logic-extraction + desktop jsdom units** — the `apps/desktop`
  god-file split into testable modules is its own change; the desktop project is
  wired for vitest but stays on the `node` environment until then.
- **Thin e2e journeys** — the Playwright `_electron` boot test and the 3–5
  Maestro mobile flows. #212 scopes these as nightly/on-demand, not per-PR;
  scaffolding exists under `tests/agent-e2e*`.
- **Mutation testing**, **jest-expo / RN component tests** — deferred by #212.

## Verification

- `bun run test` (turbo, per package) — 17/17 tasks pass; **653 pass / 1 skip**,
  unchanged from the pre-migration `node:test` baseline.
- `bun run coverage` (root vitest + v8) — 80 files, 653 pass / 1 skip, exit 0;
  all seeded engine floors met.
- `bun run typecheck` — 17/17 (test files import `vitest`; types resolve).
- `oxfmt --check .` clean; `oxlint .` 0 warnings / 0 errors; `lint:types`
  (type-aware, incl. tests) ok for all packages.
- `bun install --frozen-lockfile` clean after the `tsx` removal.
- Test files are analyzed, not skipped: oxfmt and standard `oxlint .` both
  process all 80 `*.test.ts` (verified by a planted `no-explicit-any` that
  repo-wide oxlint caught, then reverted), and the type-aware pass fires rules on
  them via each package's `tsconfig.test.json` (verified by a planted
  `await-thenable`, then reverted). `scripts/lint-types.sh` comments corrected
  from `node:test` to vitest.
