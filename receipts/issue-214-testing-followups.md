# issue-214 — Testing follow-ups: expect matchers, coverage ratchet, desktop logic-extraction

GitHub issue: [#214](https://github.com/srikanth235/centraid/issues/214)

The deeper per-layer testing work [#212](https://github.com/srikanth235/centraid/issues/212)
scoped as incremental and deferred "behind new work". This issue carries out the
three deferred workstreams, each as its own focused commit.

## Checklist

- [x] Convert assertions to expect matchers
- [x] Ratchet engine coverage floors up
- [x] Desktop renderer: extract logic, then test it

## What changed

### Convert assertions to expect matchers

Replaced every `node:assert` (strict) call across all 80 `*.test.ts` files with
the vitest `expect` matchers the convention ([TESTING.md](../TESTING.md) :128)
asks for — `expect(result).toEqual(...)` rather than `assert.*`. The bulk was an
AST-driven, semantics-preserving codemod (TypeScript compiler API, text-level so
formatting is untouched):

- `assert.equal`/`strictEqual` → `expect(a).toBe(b)`; `deepEqual`/`deepStrictEqual`
  → `toEqual`; `notEqual` → `not.toBe`; `notDeepEqual` → `not.toEqual`.
- `assert.ok(x)` → `expect(x).toBeTruthy()`; bare `assert(x)` likewise.
- `assert.match`/`doesNotMatch` → `toMatch` / `not.toMatch`.
- `assert.throws`/`doesNotThrow` → `expect(fn).toThrow(...)` / `not.toThrow()`;
  `assert.rejects` → `await expect(p).rejects.toThrow(...)` (thunks invoked).
- `assert.fail` → `expect.fail`. The `node:assert` import is dropped and `expect`
  merged into each file's existing `vitest` import.

The validator-function forms — `assert.throws(fn, (err) => …)` and
`assert.rejects(p, (err) => { … })`, which run nested assertions inside a
predicate and so are not a mechanical `.toThrow()` swap — were converted by hand
to a faithful capture-and-assert idiom (`try { … } catch (e) { err = e }` then
`expect(err instanceof X).toBeTruthy()` + an outcome assertion on the captured
error), matching the repo's existing `expect(err instanceof X).toBeTruthy()`
style. `worktree-store.test.ts` (13 occurrences) got a small local
`expectRejectsWithCode` helper to keep them DRY. Where the old `assert.ok(x)`
narrowed a `possibly-undefined` value for TypeScript, the equivalent
`expect(x).toBeTruthy()` does not narrow, so deref sites use the repo's existing
non-null (`x!`) idiom.

### Ratchet engine coverage floors up

Grew `agent-runtime` line coverage and ratcheted every engine package's floor up
toward the **80% line / 70% branch** target band (TESTING.md). The floors moved
from their seeded ~4–5-point margins to a tight ~1.5-point margin below the
measured baseline (coverage is deterministic, so the headroom is anti-noise, not
anti-flake-from-randomness):

| Package         | Lines (floor → floor) | Branches (floor → floor) |
| --------------- | --------------------- | ------------------------ |
| `app-engine`    | 72% → 75%             | 70% → 73%                |
| `automation`    | 65% → 68%             | 71% → 74%                |
| `blueprints`    | 80% → 83%             | 71% → 74%                |
| `gateway`       | 72% → 75%             | 68% → 71%                |
| `agent-runtime` | 18% → 27%             | 78% → 84%                |

The global repo-wide line floor went **28% → 30%** (measured ~32%).

`agent-runtime` was the real gap (20.8% lines — mostly untested CLI/backend
glue). Rather than chase the line number with vacuous over-mocked tests, the
growth targets its genuinely-pure surface with real-dependency tests:

- **codex tool dispatch** ([backends/codex/host-tools.ts](../packages/agent-runtime/src/backends/codex/host-tools.ts))
  — a new test drives `handleCentraidToolCall` end-to-end through a **real**
  app-engine `Dispatcher` (real manifest on disk, real sqlite): describe / read /
  write / ad-hoc `_sql`, plus the guard + error-mapping paths (unknown tool,
  missing query/action, dispatcher error → `success:false`). Also covers the pure
  `centraidDynamicToolSpecs`.
- **tool normalization** ([host-tools.ts](../packages/agent-runtime/src/host-tools.ts))
  — extended the `normalizeCodexTools` / `normalizeClaudeTools` /
  `claudeToolToHostTool` edge cases (custom tools, non-object entries, nameless
  entries, an `mcp__` name with no separator).
- **model enumeration** ([models/enumerators.ts](../packages/agent-runtime/src/models/enumerators.ts))
  — the no-enumerator fallback branch.

That lifted `agent-runtime` from **20.8% → 28.6%** lines (458 → 630 covered) and
85.2% branches. The remaining gap is the process-spawning drive loops, scoped to
the deferred e2e layer (recorded under _Out of scope_ + QUALITY.md).

### Desktop renderer: extract logic, then test it

Pulled the first tranche of pure logic out of the `builder.ts` renderer god-file
(4,381 lines) into three standalone, dependency-free modules and unit-tested them
richly — the god-file split TESTING.md §2 calls for, started on the file with the
densest pure logic:

- **[format.ts](../apps/desktop/src/renderer/format.ts)** — `escapeHtml`,
  `tokenize` (the Code-view syntax highlighter), `languageHint` + `LANG_DISPLAY`,
  `slugify`, `generateAppId`, `relativeWhen`, `formatBytes`, `shortVersionTitle`.
- **[cron.ts](../apps/desktop/src/renderer/cron.ts)** — the self-contained 5-field
  cron evaluator (`cronFieldMatch`, `cronNextRuns`, `describeCron`) behind the
  automation builder's next-run preview.
- **[diff.ts](../apps/desktop/src/renderer/diff.ts)** — the LCS `lineDiff` driving
  the Code view's Diff toggle.

`builder.ts` now imports these instead of defining them inline (≈280 lines moved
out); the IIFE body is unchanged otherwise. The renderer is bundled per-module
(`<script type="module">` + ESM imports), so the new files compile to `dist` and
resolve transitively with no `index.html` change. The **desktop vitest project
moved from `environment: 'node'` to `jsdom`** now that renderer logic exists to
test; the existing main-process logic test (`settings-merge`) still passes under
jsdom since node builtins remain available.

Tests added: **59** across the three modules (`format.test.ts`, `cron.test.ts`,
`diff.test.ts`) — desktop went from 12 to 71 tests. One test documents a real
behaviour quirk surfaced during extraction: `relativeWhen` returns the platform
`"Invalid Date"` string (not the raw input) for an unparseable date, because
`new Date(str)` yields `NaN` rather than throwing, so the `try/catch` never fires.

## Out of scope

- **agent-runtime process-spawning glue** — the codex/claude drive loops
  (`backend.ts`), the automation host, and the `enumerate*` spawners are best
  covered by the deferred Playwright/Maestro e2e layer (#212), not over-mocked
  unit tests; the line floor stays honest (anti-regression) rather than inflated.
- **Further renderer extraction** — `app.ts` (6,803 lines) still holds pure logic
  (appearance-prefs bridge, profile view-models, insights formatters) and a
  near-duplicate `relativeTime`; this commit extracts the `builder.ts` tranche and
  establishes the jsdom-capable project, leaving the `app.ts` split + dedup as
  follow-up.
- **e2e journeys** (Playwright `_electron` + Maestro), **mutation testing**, **RN
  component tests** — deferred by #212, not part of this issue.

## Verification

- **Convert assertions to expect matchers:** `bun run test` / `vitest run` — 80
  files, **653 pass / 1 skip**, identical to the pre-conversion baseline
  (green-before → green-after); zero `node:assert` imports and zero `assert.*`
  calls remain repo-wide. `bun run typecheck` 17/17 (the `expect`-narrowing `!`
  fixes resolve every surfaced `possibly-undefined`). `oxlint .` 0/0; `oxfmt
  --check .` clean.
- **Desktop renderer: extract logic, then test it:** `vitest run --project
  @centraid/desktop` — **71 pass** (was 12), the 59 new format/cron/diff units
  plus the pre-existing main-process test, all green under the new `jsdom`
  environment. `apps/desktop` builds clean (`tsc -p tsconfig.json`; format.js,
  cron.js, diff.js emitted to `dist/renderer/`).
- **Ratchet engine coverage floors up:** `bun run coverage` (root vitest + v8)
  exits 0 with every ratcheted floor met — measured app-engine 76.7/74.8,
  automation 69.4/75.2, blueprints 84.7/75.8, gateway 76.4/72.3, agent-runtime
  **28.6**/85.2 (up from 20.8/83.5), repo total ~32% ≥ the 30 global floor. The
  TESTING.md floor table + QUALITY.md are updated to match.
- **Repo-wide:** `bun run coverage` **733 pass / 1 skip** (85 files), `turbo run
  typecheck` 17/17, `oxlint .` 0/0 + `lint:types` (all packages incl.
  apps/desktop) clean, `oxfmt --check .` clean.
