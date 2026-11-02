---
name: typescript
description: >-
  Write, review, refactor, debug, or explain TypeScript and JavaScript in Centraid. Trigger on .ts/.mjs code, Bun or Node scripts, TypeScript diagnostics, oxlint, vitest, or `bun run check`. Focuses on canonical checks, generated outputs, and current type-check coverage gaps.
---

# TypeScript in Centraid

## Workflow and done criteria

Run `bun run check` for changes. It covers format, oxlint with warnings denied, product lints, configured TypeScript checks, vitest, and release-script tests. Run tools through `bun run`; do not use `npx`.

The compiler uses `strict`, `noUncheckedIndexedAccess`, and ES2023. The configured typecheck does **not** include `contracts/tools` or `scripts`; treat them as type-check coverage gaps and write them to the same standards. Do not imply `bun run check` typechecks those trees.

**Done** when `bun run check` is green. Follow the generated-output instructions below whenever an emitter or generated file changes.

## Centraid constraints

- TypeScript is repository tooling: the design token registry and emitters, test kit, and scripts. There is no React app or web server.
- Generated files are outputs: edit the registry or emitter and regenerate; never hand-edit emitted Kotlin, Swift, catalogue, words, or CSS.
- Tests use `@centraid/test-kit`: `tempDir()`, `useFakeClock()`, and `seededRandom()` instead of raw APIs.
- Token changes come from `packages/design/src`; use semantic tokens and regenerate consumers. Budgets only go down.
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
| `emitters` step or `mobile-jvm` reports drift in `packages/design` or `mobile` | Never edit the generated file: change the registry or emitter, rerun `bun contracts/tools/export-native-theme.ts` and `bun run format`, commit the result |

### Pitfalls

- **Tokens have one source: `packages/design/src`.** Hardcoded hex or `rgb()`, a parallel CSS variable or Kotlin/Swift colour table, a deep import (`@centraid/design/src/themes/...`), or a font-family override in app CSS all cause drift across the shells and web surfaces. Use `var(--...)` or the emitted native theme. After a token edit, rerun `bun contracts/tools/export-native-theme.ts` and `bun run format`, commit the regenerated files, and run `bun run --cwd packages/design build` so `dist/` consumers see the change. Run `bun run --cwd packages/design test`.
- **Theme rules that fail silently.** The registry is `light` and `dark`, and a registry key must equal its `kind`, because stylesheets key on `[data-theme='dark']` (a dark preset under another key paints light chrome on a dark surface). An appearance pref written as an inline style on `<html>` outranks every theme block, so write it only when the member chose one and remove it otherwise. There is one dark ramp (neutral greyscale off `--bg-l`); when a declaration and the rendered product disagree, the product wins.
- **There is one page and one face.** Shell and every app share `--bg` / `colors.bg`; an app never retunes it (a per-app tone moved only `--bg` and inverted the paper metaphor; if a tone ever returns it must carry the whole surface set). `PAGE` and `WALL` are deliberately not re-exported. Every role is Instrument Sans; `--t-mono` is tabular figures, not monospace; `--font-code` is only for code, an inline literal or a path. Under 4px only `--sp-hair` (1px), `--sp-gutter` (2px) or `--sp-chip` (3px) exist. The element layer (`packages/design/src/elements`, `kit.css`) holds no design decisions: a literal or new `--name` there belongs in the token layer and `src/contract.ts`. No linter checks the face, radius and spacing rules; review does.
- **A guard on a generated-and-committed pair must watch the source.** When a file is generated and also committed (`mobile/iosApp/Resources/Info.plist` from `mobile/iosApp/project.yml`), a test pointed at the visible generated file goes green while the source is wrong, and the next regeneration restores the defect (a background-task identifier was right in the plist and wrong in `project.yml`, so iOS would have terminated the app). Assert against the source, and separately that the generated half matches it; if only one is affordable, take the source. Being in git says nothing about which file a human edits. To find the next pair, list the tracked files under `mobile/iosApp/Resources` and grep for `GENERATED` / `DO NOT EDIT`.

## General TypeScript guidance

Read [`references/general-practices.md`](references/general-practices.md) for type design, errors, async, modules, scripts, vitest, and performance. Focused references: [`type-patterns.md`](references/type-patterns.md), [`vitest-fixtures.md`](references/vitest-fixtures.md), and [`vitest-type-testing.md`](references/vitest-type-testing.md).

The diagnostic and performance guidance adapts [Bama](https://github.com/daveebbelaar/bama) by Dave Ebbelaar (MIT, [`licenses/Bama-LICENSE`](licenses/Bama-LICENSE)); source attributions remain in [`references/general-practices.md`](references/general-practices.md).
