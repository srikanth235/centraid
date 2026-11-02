---
name: typescript
description: >-
  Write idiomatic, type-safe, maintainable TypeScript and JavaScript modules. Use this skill whenever you write, review, refactor, debug or explain .ts or .mjs code: type design, narrowing, errors, async code, modules, scripts and CLIs under Bun or Node, and vitest tests. Trigger on a tsc diagnostic, an oxlint finding, a vitest failure, `bun run check`, even when the user does not ask for "best practices". Closes with how Centraid's TypeScript tooling applies them.
---

# TypeScript best practices

Where common advice disagrees, this file says which to follow and why. The digests in `references/` go deeper on type patterns and vitest.

## 1. Mindset

- **Let the types carry the design.** A good TypeScript program is mostly types that make wrong code fail to compile; the runtime code is then short and boring.
- **Make invalid states unrepresentable.** Discriminated unions instead of objects with optional fields that "must be set together"; literal unions instead of free strings.
- **Trust nothing at the edge, everything inside.** Data from JSON, files, the network, `process.argv` or a `catch` is `unknown` until parsed. After that one parse, the type is true and the code stops checking.
- **Small modules with one job,** named for the domain, not `utils` or `helpers`.
- **Let the tools work.** The formatter owns layout, the linter owns idiom, the compiler owns types. Don't fight them with casts and suppressions.

## 2. Before you hand back code

- Type check, lint, format and tests all pass. Fix a diagnostic rather than silencing it.
- No `any`, no `@ts-ignore`, `@ts-expect-error` or `@ts-nocheck`, no `as unknown as T`. If a suppression is truly needed, put it on one line with the rule name and a reason.
- No `!` non-null assertions to quiet the compiler; narrow instead.

### Diagnostic to fix

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

## 3. Type design

| Need | Use |
| --- | --- |
| States that exclude each other | A discriminated union on a literal `kind` field |
| A closed set of names | A string-literal union or an `as const` object, not `enum` |
| A table keyed by a union | `Record<Kind, Handler>`; the compiler checks every case |
| Check a literal against a type without widening it | `satisfies T`, not `: T` or `as T` |
| Foreign data | `unknown`, narrowed by a type guard or parsed once at the edge |
| A reusable check | A guard `(x: unknown): x is T`, or `asserts x is T` |
| Ids of the same shape that must not mix | A branded type, where a mix-up is a real risk |
| Inputs a function must not change | `readonly T[]`, `ReadonlyMap`, `Readonly<T>` |

- **Exhaustiveness:** a `switch` over a union ends in a `never` default that throws, or the logic lives in a `Record<Union, …>` table. When the same branch on a kind appears in two places, make it one table.
- **Generics earn their place.** Add a type parameter when a type flows from input to output; otherwise use the concrete type. Constrain parameters (`<T extends Key>`) and let inference supply them at call sites.
- **Annotate what you export** (return types of exported functions, exported constants); let inference handle locals.
- **Prefer `type` aliases and unions; use `interface` for object shapes others extend.**
- **Type-only imports are separate statements:** `import type { X } from "./x"`.

## 4. Null, optional and errors

- `?.` and `??` belong where a value is genuinely optional. After a parse or a guard has proved a value present, use it directly; a defensive `?? ""` hides missing data.
- With `noUncheckedIndexedAccess`, `array[i]` and `map.get(k)` may be `undefined`: narrow with a check that throws a message naming the missing thing.
- **Throw `Error` objects,** never strings, with a message that names the bad value; use `cause` to keep the underlying error. Define an error subclass only when a caller branches on it.
- **Catch only to recover, translate or report at a boundary** (a CLI's top level, a request handler). No empty `catch`, no catch-log-and-continue. The caught value is `unknown`.
- A failure a user triggered reaches them as a structured error, not only a log line.
- A shim that tolerates an older data shape is tagged in a comment so it can be removed; an untagged default that papers over old data has no cleanup signal.

## 5. Async

- `async`/`await` over `.then` chains. Every promise is awaited, returned or explicitly handled; no floating promises.
- Independent work runs together with `Promise.all`; sequential work is deliberate and named, not an accidental `await` in a loop.
- Bound concurrency for large fan-outs; don't start ten thousand requests at once.
- Every timer, listener, subscription and poller has a stop path, and a poller needs a reason push cannot do the job.
- Pass an `AbortSignal` through long operations so callers can cancel.

## 6. Modules and files

- One concern per module, a small public surface, and imports through a package's public entry (its barrel or `exports` subpath), never its `src` internals.
- Keep files short; split by domain when a file grows past a few hundred lines.
- Change a module in place when replacing behaviour. No `foo-v2.ts` beside `foo.ts`, no dual exports kept "for migration".
- Pure functions at the core, side effects (file system, network, clock, randomness) at the edges, passed in so they can be replaced in tests.
- Comments state what the code cannot: contracts, the constraint behind an odd shape, the tempting edit that is wrong. No comments that narrate history or restate the code.

## 7. Scripts and CLIs (Bun and Node)

- Use `node:`-prefixed builtins and resolve paths from `import.meta.dirname`, never from the current directory.
- Never build a shell command from strings. Use `spawn`/`execFile` (or `Bun.spawn`) with an argument array, and check the exit code.
- Validate paths that come from input against an allowed root; reject `..` escapes.
- Exit non-zero with a one-line reason on failure; print machine-readable output when another tool reads it.
- Parse JSON into `unknown` and validate it before use.

## 8. Testing with vitest

- Test behaviour through the public API: inputs and observable outputs, not private helpers. A refactor that keeps behaviour should not need assertion changes.
- One scenario per test, named for the behaviour. Table-driven tests for many cases, with an assertion message naming the case.
- Exact matchers (`toBe`, `toEqual`, `toStrictEqual`) over vague ones (`toBeTruthy`).
- Deterministic by construction: inject or fake the clock, seed randomness, use temporary directories that are removed even when the test fails. Never compare against `Date.now()` captured in the expected value.
- Each rule is asserted in one owning test file; a second copy drifts.
- Type-level contracts get type tests (`expectTypeOf`), not runtime ones.

## 9. Performance: a measuring loop

Fast is a number, not a feeling. Every change starts and ends with a measurement.

```text
reproduce -> measure (the real runtime, not watch mode) -> find the line -> fix -> measure again -> commit with the numbers
```

1. **Reproduce** with one command that runs the slow thing (a script, one vitest file) and prints its wall time.
2. **Measure** with `performance.now()` around the suspect step, several runs, and the median. Run it under the runtime the repo ships (`bun` for scripts, `node` for the vitest runner), not under a debugger.
3. **Find the line** with the tool for the symptom (table below). Read the profile as text.
4. **Fix** the line the profile names: hoist repeated work out of the loop, index with a `Map`, stream instead of reading whole files, start independent work together with `Promise.all`, and keep cost that grows with the data off interactive paths.
5. **Measure again** with the same command. Put before and after in the commit message: "theme export 4 s, was 11 s".

| Symptom | Tool |
| --- | --- |
| A script is slow | `bun --cpu-prof --cpu-prof-md script.ts` (writes a markdown profile you can grep), or `node --cpu-prof --cpu-prof-dir=<dir> script.mjs` (a `.cpuprofile` for DevTools or speedscope) |
| Memory grows | `bun --heap-prof-md script.ts`, or `node --heap-prof` |
| One vitest file is slow | `bun run --cwd packages/<pkg> test -- <file> --reporter=verbose` shows per-test time; time the setup with `performance.now()` |
| A step wastes time waiting | Log `performance.now()` deltas between awaits; a sequential `await` chain of independent calls shows as a staircase |

A profile file records the process environment, and a shell started by an agent carries its tokens. Write profiles to the scratchpad or a temp directory, delete them after reading, never commit them.

## 10. Final checklist

- Type check, lint, format and tests are green with no new suppressions.
- No `any`, `!`, double casts or `@ts-` comments.
- Foreign data is `unknown` until parsed; validated values are not re-checked.
- Unions are exhaustive; repeated branches became a table.
- Every promise is handled; every timer and listener has a stop path.
- Errors are `Error`s with context, caught only where something can be done.
- Tests are deterministic and assert behaviour.

## 11. In this repo

TypeScript here is tooling: the design token registry and its emitters (`packages/design`, `contracts/tools`), the shared test kit (`packages/test-kit`) and repo scripts (`scripts/`). There is no React or web server.

- **The check is `bun run check`** (format, oxlint with warnings as errors, product lints, tsc, vitest, script tests). Run tools through `bun run`, never `npx`.
- **Compiler settings:** `strict`, `noUncheckedIndexedAccess`, ES2023. Nothing type checks `contracts/tools` or `scripts`; write them as if it did.
- **Lint rules that bite:** a 625-line ceiling per file (`max-lines`); no `any`; type-only imports as their own statement; no `await` in loops; the catch binding is named `error`.
- **Tests use the kit, not the raw APIs** (the raw forms are lint errors in tests): `tempDir()` instead of `mkdtemp`, `useFakeClock()` instead of `vi.useFakeTimers`, `seededRandom()` instead of `Math.random()`, all from `@centraid/test-kit`.
- **Emitted files are never hand-edited.** The native theme, catalogue and words for Kotlin and Swift and the site token CSS are generated from `packages/design`; change the registry or the emitter and regenerate. The gate fails on drift.
- **Budgets only go down.** Ratchet scripts fail when a count is over its budget; never raise one to pass.

### Pitfalls

- **Tokens have one source: `packages/design/src`.** Hardcoded hex or `rgb()`, a parallel CSS variable or Kotlin/Swift colour table, a deep import (`@centraid/design/src/themes/...`), or a font-family override in app CSS all cause drift across the shells and web surfaces. Use `var(--...)` or the emitted native theme. After a token edit, rerun `bun contracts/tools/export-native-theme.ts` and `bun run format`, commit the regenerated files, and run `bun run --cwd packages/design build` so `dist/` consumers see the change. Run `bun run --cwd packages/design test`.
- **Theme rules that fail silently.** The registry is `light` and `dark`, and a registry key must equal its `kind`, because stylesheets key on `[data-theme='dark']` (a dark preset under another key paints light chrome on a dark surface). An appearance pref written as an inline style on `<html>` outranks every theme block, so write it only when the member chose one and remove it otherwise. There is one dark ramp (neutral greyscale off `--bg-l`); when a declaration and the rendered product disagree, the product wins.
- **There is one page and one face.** Shell and every app share `--bg` / `colors.bg`; an app never retunes it (a per-app tone moved only `--bg` and inverted the paper metaphor; if a tone ever returns it must carry the whole surface set). `PAGE` and `WALL` are deliberately not re-exported. Every role is Instrument Sans; `--t-mono` is tabular figures, not monospace; `--font-code` is only for code, an inline literal or a path. Under 4px only `--sp-hair` (1px), `--sp-gutter` (2px) or `--sp-chip` (3px) exist. The element layer (`packages/design/src/elements`, `kit.css`) holds no design decisions: a literal or new `--name` there belongs in the token layer and `src/contract.ts`. No linter checks the face, radius and spacing rules; review does.
- **A guard on a generated-and-committed pair must watch the source.** When a file is generated and also committed (`mobile/iosApp/Resources/Info.plist` from `mobile/iosApp/project.yml`), a test pointed at the visible generated file goes green while the source is wrong, and the next regeneration restores the defect (a background-task identifier was right in the plist and wrong in `project.yml`, so iOS would have terminated the app). Assert against the source, and separately that the generated half matches it; if only one is affordable, take the source. Being in git says nothing about which file a human edits. To find the next pair, list the tracked files under `mobile/iosApp/Resources` and grep for `GENERATED` / `DO NOT EDIT`.

**Done when** `bun run check` is green: it runs `format:check`, oxlint with `--deny-warnings`, the product lints, `tsc` and vitest per workspace, and the release-script tests. A single package's vitest or `tsc` alone is not enough.

## References

Read when the task touches the area:

- `references/type-patterns.md`: unions, brands, `satisfies`, inference, wrong/right pairs.
- `references/vitest-fixtures.md`: shared fixtures with `test.extend`.
- `references/vitest-type-testing.md`: asserting type-level contracts.

From [typescript-best-practices](https://github.com/ofershap/typescript-best-practices) by Ofer Shapira and [antfu/skills](https://github.com/antfu/skills) by Anthony Fu (MIT; [licenses](licenses/)). The diagnostic table and the measuring loop adapt the Swift and performance skills of [Bama](https://github.com/daveebbelaar/bama) by Dave Ebbelaar (MIT, [license](licenses/Bama-LICENSE)).
