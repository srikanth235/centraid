# issue-214 — Testing follow-ups: expect matchers, coverage ratchet, desktop logic-extraction

GitHub issue: [#214](https://github.com/srikanth235/centraid/issues/214)

The deeper per-layer testing work [#212](https://github.com/srikanth235/centraid/issues/212)
scoped as incremental and deferred "behind new work". This issue carries out the
three deferred workstreams, each as its own focused commit.

## Checklist

- [x] Convert assertions to expect matchers
- [ ] Ratchet engine coverage floors up
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

- **Coverage ratcheting** — the remaining deferred workstream from #212; lands as
  its own commit on this issue.
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
  cron.js, diff.js emitted to `dist/renderer/`). Repo-wide: `vitest run` **717
  pass / 1 skip**, `turbo run typecheck` 15/15, `oxlint .` + `lint:types` (incl.
  apps/desktop) clean, `oxfmt --check` clean.
