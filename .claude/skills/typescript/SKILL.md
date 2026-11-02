---
name: typescript
description: TypeScript and .mjs rules for Centraid's Bun tooling (packages/design, packages/test-kit, contracts/tools, scripts/): strict typing, type design, errors, vitest, emitters, oxlint/oxfmt. Use when writing, reviewing or debugging TypeScript or .mjs here, a tsc diagnostic, an oxlint finding, a vitest failure, or `bun run check` red.
---

# TypeScript and .mjs

The code is right when `bun run check` is green: `format:check`, `lint` (oxlint, `--deny-warnings`), `lint:product`, `typecheck` (tsc per package), `test` (vitest) and `scripts:test`. TypeScript here is small and tooling-shaped: the design token registry, the test kit, the emitters, repo scripts. There is no React, Node server or framework code to imitate. The repo's own rules are [docs/coding-standards.md](../../../docs/coding-standards.md), linked below, never restated.

## Compiler assumptions

Root [tsconfig.base.json](../../../tsconfig.base.json) is the floor: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, ES2023, `isolatedModules`. Package tsconfigs extend it. `exactOptionalPropertyTypes` is **not** on: write `x?: T` and `x: T | undefined` as meaning the same thing.

- `packages/design` splits into a token program (`lib: ["ES2023"]`, no DOM, so a stray `document` fails to compile) and an element program (`src/elements/**`, DOM lib). A token module never touches `document`/`window`.
- Nothing typechecks `contracts/tools/*.ts`, `scripts/**` or `.mjs`; `oxlint` and `oxfmt` are their only gate. Write them as if `tsc` were watching.

## Type design

| Need | Use |
| --- | --- |
| States that exclude each other | Discriminated union on a literal field, never optional fields |
| Closed set of names | `as const` object or string-literal union, then `keyof typeof` / `(typeof X)[number]`; no TS `enum` (the only `enum ` text in the tree is emitted Swift) |
| Table keyed by a union | `Record<Kind, Handler>`, or `satisfies Record<Kind, T>` to keep literal types; the table is the policy ([coding-standards](../../../docs/coding-standards.md#policy-tables-over-discriminator-branches)) |
| Validate a literal without widening | `satisfies`, not `as T` |
| Foreign data (JSON, `process.argv`, fs reads, `catch`) | `unknown`, narrow with a guard or parse once at the edge |
| Narrowing helper | `(x: unknown): x is T`, or `asserts x is T` for a throw-on-fail check |
| Read-only inputs | `readonly T[]`, `ReadonlyMap`, `Readonly<...>` in parameters and exported constants |
| Same-shaped ids that must not mix | A brand (`string & { readonly __brand: "X" }`) only where a mix-up already happened; this repo has none by default |
| Exhaustive handling | `switch` with a `never` default that throws, or a `Record<Union, ...>` table the compiler checks |
| Type-only import | top-level `import type { X } from "..."`; inline `{ type X }` is a lint error |

- Return types on exported functions; inference inside bodies.
- Function signatures name their units and invariants in types, not comments ([Comments face forward](../../../docs/coding-standards.md#comments-face-forward)).
- Depth, with wrong/right pairs: [references/type-patterns.md](references/type-patterns.md).

## Null, optionality, errors

- `?.` and `??` only at true optionality, never after a parse or guard; untagged `??` is not a compat shim: [Justify `?.` and `??`](../../../docs/coding-standards.md#justify--and--past-validation).
- `noUncheckedIndexedAccess` makes `a[i]` `T | undefined`. Narrow with a check that throws with context (`if (!role) throw new Error("missing role")`, the shape in `packages/design/src/stage.test.ts` and `roles.ts`), not `!` and not `?? ""`.
- `throw new Error(message)` for impossible states and bad input; the message names the offending value. Never throw a non-Error (`no-throw-literal`).
- `catch` only for recovery, typed translation or a process edge ([No just-in-case try/catch](../../../docs/coding-standards.md#no-just-in-case-trycatch)). The caught binding is named `error` (`unicorn/catch-error-name`) and is `unknown`.
- UI/IPC-facing failures reach the caller as a structured error, not a log line: [Fallible-action contract](../../../docs/coding-standards.md#fallible-action-contract).

## Async

- No `await` in a loop (`no-await-in-loop` is an error). Independent work is `Promise.all`; deliberately ordered work goes through a named primitive (`forEachSequentially` in `@centraid/test-kit/sequential`).
- No `new Promise` executor that returns a value (`no-promise-executor-return`): wrap in braces, `new Promise((resolve) => { setTimeout(resolve, 0); })`.
- Every timer, listener and poller has a stop path ([Every poller is visibility-gated](../../../docs/coding-standards.md#every-poller-is-visibility-gated)).
- Work whose cost grows with the vault stays off the request path: [Nothing O(vault-size)](../../../docs/coding-standards.md#nothing-ovault-size-on-the-request-path).

## Modules and files

- One domain per file, named for the domain. `*-utils.ts`, `*-helpers.ts`, `*-manager.ts` are review smells (`unicorn/filename-case` is off) ([Filename smells](../../../docs/coding-standards.md#filename-smells--utils-and--manager)).
- A source file stops at **625 lines** (`max-lines`, error). `packages/design/src/roles.ts` is the only exemption; split before adding to it. A new file gets none ([File length](../../../docs/coding-standards.md#file-length-mechanically-enforced)).
- Cross-package imports go through the package barrel or a declared `exports` subpath (`@centraid/design/elements`), never `@centraid/*/src/*` or `/dist/*` (`no-restricted-imports`).
- Import style follows the tree you are in: `packages/design/src` uses extensionless relative specifiers; `contracts/tools/*.ts` run directly under Bun and use `.ts` specifiers. oxfmt sorts imports (builtin, external, `@centraid/`, relative); never hand-sort.
- Change a module in place; no `foo-v2.ts`, no dual exports ([Refactors look like edits](../../../docs/coding-standards.md#refactors-look-like-edits-not-new-layers)).
- Comments: four species, deletion test, `// ─── name ─────` banners if any, suppressions `// oxlint-disable-next-line <rule> -- reason` ([Comments face forward](../../../docs/coding-standards.md#comments-face-forward)).

## Generated output

`design/native-theme.json`, `Tokens.kt`, `Catalog.kt`, `Words.kt`, `Theme.swift`, `Catalog.swift`, `Words.swift`, `design/identity-corpus.json` and the two `scripts/*-site/public/assets/centraid-tokens.css` are **emitted, never hand-edited**. Change the registry in `packages/design/src` (or the emitter in `contracts/tools/`), then regenerate:

```
bun contracts/tools/export-native-theme.ts
bun run format
git diff --exit-code design mobile
```

`bun run site:tokens` rewrites the public-site CSS. The `emitters` step of `cargo xtask gate --profile pr` fails on drift and on a new untracked file under the emitted trees. Owner doc: [design-machinery.md](../../../docs/design-machinery.md). An emitter writes a value once per syntax; it never invents a design decision.

## Tests (vitest, and `node --test` for .mjs)

- Projects come from `nodeProject()` / `jsdomProject()` in `@centraid/test-kit/vitest` (a package's `vitest.config.ts` is one call). `requireAssertions` is on: a test with no `expect` fails; an intentionally assertion-free test says `expect.assertions(0)`.
- Import `describe, expect, test` from `"vitest"` explicitly; files are `*.test.ts` beside the module.

| Test needs | Use (the raw form is an oxlint error in test files) |
| --- | --- |
| A temp directory | `tempDir()` / `tempDirSync()` from `@centraid/test-kit/temp-dir`, never `mkdtemp*` |
| A fake clock | `useFakeClock()` from `@centraid/test-kit/fake-clock`, never `vi.useFakeTimers` / `setSystemTime` |
| Random input | `seededRandom(<literal>)` from `@centraid/test-kit/random`, never `Math.random()` |
| Yield a macrotask | `flushMacrotasks()` from `@centraid/test-kit/flush` |
| Property tests | `fc` from `@centraid/test-kit/fast-check` |

- Assertion messages on loops: `expect(x, "concept -> name").toBe(true)` (`valid-expect` allows 2 args). Prefer exact matchers (`toBe(true)`) over `toBeTruthy()`; max 31 `expect` per test.
- One named law has one owning test file; a second file asserting it is deleted ([One law, one home](../../../docs/coding-standards.md#one-law-one-home)). Test seams rationale: [Test seams](../../../docs/coding-standards.md#test-seams-mechanically-enforced); strategy: [TESTING.md](../../../TESTING.md).
- `.test.mjs` under `node:test` cannot use the kit (it registers vitest hooks); it suppresses `no-restricted-imports` per line with the issue and removes its temp dir in `finally` (see `scripts/lint-copy.test.mjs`).
- Fixtures: [references/vitest-fixtures.md](references/vitest-fixtures.md); type-level assertions: [references/vitest-type-testing.md](references/vitest-type-testing.md).

## Bun and .mjs scripts

- Run tools only through `bun run <script>` ([coding-standards](../../../docs/coding-standards.md#prefer-existing-seams)), never `npx`. `bun contracts/tools/x.ts` runs TypeScript directly; there is no build step for tools.
- `scripts/*.mjs` are plain ESM with a `#!/usr/bin/env node` (or `bun`) shebang, `node:` prefixed builtins, root from `path.resolve(import.meta.dirname, "..")`. `scripts/site-tokens.mjs` is the one that needs Bun.
- Ratchet scripts (`lint-copy`, `lint-native-controls`) fail when a count is over **or** under its budget, and a number only shrinks. Never raise a budget.
- No dependency without need: add to the `catalog:` / package.json deliberately; `bun.lock` is audited by the `lockfile` and `osv` gate steps.

## Never

- `any` (`no-explicit-any` is an error): `unknown` and narrow.
- `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` (`ban-ts-comment`): fix the type. The tree has zero today.
- `as unknown as T` to silence a mismatch. It exists in a few DOM-timer and `File` test doubles; a new one needs a reason in a comment.
- Silencing a rule or editing `oxlint.config.ts` / `oxfmt.config.ts` / a tsconfig to go green; fix the code ([AGENTS.md](../../../AGENTS.md) conventions).
- `Date.now()` or `new Date()` baked into an expected value; read `clock.now()`.
- `-utils`/`-manager` grab-bags, a comment that narrates history, an empty `catch`.
- Hand-edited generated files, or an emitter that is not the one command that writes everything.

## Errors and fixes

| Diagnostic | Fix |
| --- | --- |
| TS2532 / TS18048 `Object is possibly undefined` on `a[i]`, `map.get(k)` | Narrow: `const v = a[i]; if (v === undefined) throw new Error("...")` |
| TS2345 `string` not assignable to a union | The value is not narrowed: declare it `as const`, or guard it with a `x is Union` predicate |
| TS2322 object literal too wide/narrow | `satisfies T` instead of `: T` or `as T` |
| TS7053 element implicitly `any` indexing by string | Key the table by the union (`Record<Kind, V>`), or narrow the key first |
| TS2307 cannot find module `@centraid/x/src/y` | Import the barrel/`exports` subpath, never `src`/`dist` |
| TS5097 import path ends in `.ts` | Only `packages/design`'s test program sets `allowImportingTsExtensions`; drop the extension in `packages/*/src` |
| TS2339 property missing after `typeof`/`in` check | Narrow with a discriminant or a user-defined guard, not a cast |
| TS7030 / fall-through | `noFallthroughCasesInSwitch`: `return`/`break` each case, or use a table |
| `no-explicit-any` | `unknown` + guard; generic parameter if the type flows through |
| `typescript/consistent-type-imports`, `import/consistent-type-specifier-style` | `import type { X } from "..."` as its own statement |
| `max-lines` | Split by domain; do not add an override |
| `no-await-in-loop` | `Promise.all(items.map(...))`, or `forEachSequentially` when order is the behavior |
| `no-shadow` | Rename the inner binding |
| `unicorn/catch-error-name` | `catch (error)` |
| `no-restricted-properties` / `no-restricted-imports` in a test | Use the named kit helper in the message |
| `vitest/max-expects` | One scenario per test, or a table-driven loop with messages |
| `reportUnusedDisableDirectives` | Delete the stale `oxlint-disable`; every directive must suppress something |
| `format:check` red | `bun run format`; do not hand-format. Copied/generated trees are regenerated, then formatted |
| "no assertions" vitest failure | Add the `expect`, or `expect.assertions(0)` if truly assertion-free |
| `emitters` drift | Rerun the emitter, `bun run format`, commit the output with the source change |

## References

| Open when | File |
| --- | --- |
| Designing a union, brand, `satisfies`, `NoInfer`, `using` | [references/type-patterns.md](references/type-patterns.md) |
| Building a shared test fixture with `test.extend` | [references/vitest-fixtures.md](references/vitest-fixtures.md) |
| Asserting a type-level contract | [references/vitest-type-testing.md](references/vitest-type-testing.md) |
| Where this repo overrides the packs | [CENTRAID.md](CENTRAID.md) |
| Provenance and licenses | [SOURCES.md](SOURCES.md) |

Done when `bun run check` is green; for emitter or token changes also `cargo xtask gate --profile pr` ([docs/toolchain.md](../../../docs/toolchain.md)).
