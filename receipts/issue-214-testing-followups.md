# issue-214 — Testing follow-ups: expect matchers, coverage ratchet, desktop logic-extraction

GitHub issue: [#214](https://github.com/srikanth235/centraid/issues/214)

The deeper per-layer testing work [#212](https://github.com/srikanth235/centraid/issues/212)
scoped as incremental and deferred "behind new work". This issue carries out the
three deferred workstreams, each as its own focused commit.

## Checklist

- [x] Convert assertions to expect matchers
- [ ] Ratchet engine coverage floors up
- [ ] Desktop renderer: extract logic, then test it

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

## Out of scope

- **Coverage ratcheting** and **desktop renderer logic-extraction** — the other
  two deferred workstreams from #212; each lands as its own commit on this issue.
- **e2e journeys** (Playwright `_electron` + Maestro), **mutation testing**, **RN
  component tests** — deferred by #212, not part of this issue.

## Verification

- **Convert assertions to expect matchers:** `bun run test` / `vitest run` — 80
  files, **653 pass / 1 skip**, identical to the pre-conversion baseline
  (green-before → green-after); zero `node:assert` imports and zero `assert.*`
  calls remain repo-wide. `bun run typecheck` 17/17 (the `expect`-narrowing `!`
  fixes resolve every surfaced `possibly-undefined`). `oxlint .` 0/0; `oxfmt
  --check .` clean.
