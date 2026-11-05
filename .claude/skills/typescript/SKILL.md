---
name: typescript
description: >-
  Write, review, refactor, debug, or explain TypeScript and JavaScript in Centraid. Trigger on .ts/.mjs code, Bun or Node scripts, TypeScript diagnostics, oxlint, vitest, or `bun run check`. Focuses on canonical checks, generated outputs, and current type-check coverage gaps.
---

# TypeScript in Centraid

## Workflow and done criteria

Run `bun run check` for changes. It covers format, oxlint with warnings denied, product lints, configured TypeScript checks, vitest, and release-script tests. Run tools through `bun run`; do not use `npx`.

The compiler uses `strict`, `noUncheckedIndexedAccess`, and ES2023. The configured typecheck includes packages plus TypeScript in `contracts/tools` and `scripts` through `tsconfig.tooling.json`. JavaScript scripts are linted and tested but are not checked with `checkJs`.

**Done** when `bun run check` is green. Follow the generated-output instructions below whenever an emitter or generated file changes.

## Centraid constraints

- TypeScript is repository tooling: the test kit, release tools and scripts. Design values and native exporters are Rust-owned. There is no React app or web server.
- Generated files are outputs: edit the registry or emitter and regenerate; never hand-edit emitted Kotlin, Swift, catalogue, words, or CSS.
- Tests use `@centraid/test-kit`: `tempDir()`, `useFakeClock()`, and `seededRandom()` instead of raw APIs.
- Token changes come from `design/tokens.toml`; use semantic tokens and regenerate consumers with `cargo xtask design`. Budgets only go down.
- Design token, theme, font, spacing, and generated-source assertion pitfalls are recorded below.

### Diagnostic table

Fix the first error first: later ones are often its echo. Rerun after each fix.

| Diagnostic | Fix |
| --- | --- |
| TS2532 / TS18048 "possibly undefined" on `a[i]` or `map.get(k)` | `noUncheckedIndexedAccess`: narrow with `if (x === undefined) throw new Error("missing <what>")`, not `!` |
| TS2322 "not assignable" on a literal typed `: T` | Use `satisfies T` so the literal keeps its narrow type, then fix the property the message names |
| TS7053 "implicitly has an 'any' type" indexing an object | Type the key as `keyof typeof obj`, or make the object a `Record<Key, V>` |
| TS2345 `unknown` / `string` not assignable to a union | Narrow with a guard or a parse at the edge; do not cast |
| oxlint `typescript/no-explicit-any` | Use `unknown` and narrow, or a generic |
| `typescript/consistent-type-imports`, `import/consistent-type-specifier-style` | `import type { X } from "./x"` as its own statement, not `import { type X }` |
| `eslint/no-await-in-loop` | `await Promise.all(items.map(...))`; if order is the point, name it and suppress on that line with the reason |
| `eslint/max-lines` (625) | Split the file by domain; do not raise the ceiling |
| `unicorn/catch-error-name` | Name the catch binding `error` |
| A restricted `mkdtemp`, `vi.useFakeTimers`, `Math.random` in a test | `tempDir()`, `useFakeClock()`, `seededRandom()` from `@centraid/test-kit` (the lint message names the subpath) |
| vitest fails a test with no assertions | `expect.requireAssertions` is on in the kit presets: assert something, or call `expect.assertions(0)` for a deliberate assertion-free test |
| Design generation or `mobile-jvm` reports drift | Never edit the generated file: change `design/tokens.toml`, the Rust generator, the string catalogue or the light mockup; rerun `cargo xtask design` and commit the result |

### Pitfalls

- **Tokens have one source: `design/tokens.toml`.** Do not add a TypeScript palette, font registry or design emitter. The Rust compiler produces native resources, dark mockups and shared design artifacts; consumers read those outputs. A visual or UX change starts in `design/mockups/` in the same PR.
- **Themes and accessibility are designed together.** Light and dark use the explicit values in the tokens and mockups. A stored appearance preference must not defeat the system choice when the member has not selected an override. Large text reflows rather than being capped; content colours are preserved.
- **A guard on a generated-and-committed pair must watch the source.** When a file is generated and also committed (`mobile/iosApp/Resources/Info.plist` from `mobile/iosApp/project.yml`), a test pointed at the visible generated file goes green while the source is wrong, and the next regeneration restores the defect (a background-task identifier was right in the plist and wrong in `project.yml`, so iOS would have terminated the app). Assert against the source, and separately that the generated half matches it; if only one is affordable, take the source. Being in git says nothing about which file a human edits. To find the next pair, list the tracked files under `mobile/iosApp/Resources` and grep for `GENERATED` / `DO NOT EDIT`.

## General TypeScript guidance

Read [`references/general-practices.md`](references/general-practices.md) for type design, errors, async, modules, scripts, vitest, and performance. Focused references: [`type-patterns.md`](references/type-patterns.md), [`vitest-fixtures.md`](references/vitest-fixtures.md), and [`vitest-type-testing.md`](references/vitest-type-testing.md).

The diagnostic and performance guidance adapts [Bama](https://github.com/daveebbelaar/bama) by Dave Ebbelaar (MIT, [`licenses/Bama-LICENSE`](licenses/Bama-LICENSE)); source attributions remain in [`references/general-practices.md`](references/general-practices.md).
