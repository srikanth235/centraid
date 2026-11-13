# TypeScript in Centraid

## Workflow and done criteria

Run `bun run check` for changes. It covers format, oxlint with warnings denied, product lints, configured TypeScript checks, vitest, and release-script tests. Run tools through `bun run`; do not use `npx`.

The compiler uses `strict`, `noUncheckedIndexedAccess`, and ES2023. The configured typecheck includes packages plus the TypeScript in `scripts` through `tsconfig.tooling.json`. JavaScript scripts are linted and tested but are not checked with `checkJs`.

**Done** when `bun run check` is green. Follow the generated-output instructions below whenever an emitter or generated file changes.

## Centraid constraints

- TypeScript is repository tooling: the test kit and the scripts (release, docs and home sites, product lints). There is no React app or web server, and no design code: design values are `design/tokens.toml`, owned by Rust.
- Generated files are outputs: edit `design/tokens.toml` (or `design/icons.toml`) and run `cargo xtask design`; never hand-edit emitted Kotlin, Swift, catalogue, words, CSS or a dark mockup.
- Tests use `@centraid/test-kit`: `tempDir()`, `useFakeClock()`, and `seededRandom()` instead of raw APIs.
- Token changes come from `design/tokens.toml`; use the semantic tokens and regenerate consumers. Budgets only go down.
- Design token, theme, font and generated-source pitfalls are recorded below.

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
| `design` step or `mobile-jvm` reports drift in `design/`, `mobile` or a site's `assets/` | Never edit the generated file: change `design/tokens.toml` (or `design/icons.toml`, or the light mockup), run `cargo xtask design`, commit the result |

### Pitfalls

- **Tokens have one source: `design/tokens.toml`.** Hardcoded hex or `rgb()`, a parallel CSS variable or Kotlin/Swift colour table, or a font-family override in a site's CSS all cause drift across the shells and the two web sites. Use `var(--...)` from the sheet `cargo xtask design` generates. After a token edit run `cargo xtask design` and commit the regenerated files; its `--check` (the gate's `design` step) also lints what the sites author on top of the sheet.
- **Theme rules that fail silently.** The themes are `light` and `dark`, and the sites key on `[data-theme='dark']` (no attribute follows the system). An appearance pref written as an inline style on `<html>` outranks every theme block, so write it only when the member chose one and remove it otherwise. When a declaration and the rendered product disagree, the product wins.
- **There is one page and one face.** The sites and the shells share `--bg` / `colors.bg`; nothing retunes it. Every role is Instrument Sans; `--t-mono` is tabular figures, not monospace; `--font-code` is only for code, an inline literal or a path. Under 4px only `--sp-hair` (1px), `--sp-gutter` (2px) or `--sp-chip` (3px) exist. The `design` step lints the face (no literal `font-family`, no font CDN) and unresolved `var()`s in the sites' authored files; no linter checks radius and spacing, review does.
- **A guard on a generated-and-committed pair must watch the source.** When a file is generated and also committed (`mobile/iosApp/Resources/Info.plist` from `mobile/iosApp/project.yml`), a test pointed at the visible generated file goes green while the source is wrong, and the next regeneration restores the defect (a background-task identifier was right in the plist and wrong in `project.yml`, so iOS would have terminated the app). Assert against the source, and separately that the generated half matches it; if only one is affordable, take the source. Being in git says nothing about which file a human edits. To find the next pair, list the tracked files under `mobile/iosApp/Resources` and grep for `GENERATED` / `DO NOT EDIT`.

## General TypeScript guidance

Read [`general/general-practices.md`](general/general-practices.md) for type design, errors, async, modules, scripts, vitest, and performance. Focused references: [`type-patterns.md`](general/type-patterns.md), [`vitest-fixtures.md`](general/vitest-fixtures.md), and [`vitest-type-testing.md`](general/vitest-type-testing.md).

The diagnostic and performance guidance adapts [Bama](https://github.com/daveebbelaar/bama) by Dave Ebbelaar (MIT, [`licenses/Bama-LICENSE`](licenses/Bama-LICENSE)); source attributions remain in [`general/general-practices.md`](general/general-practices.md).
