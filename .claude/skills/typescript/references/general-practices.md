# General TypeScript practices

Detailed language, testing, and performance guidance. Centraid-specific commands and generated-file rules in [`../SKILL.md`](../SKILL.md) take precedence.

## 1. Mindset

- **Let the types carry the design.** A good TypeScript program is mostly types that make wrong code fail to compile; the runtime code is then short and boring.
- **Make invalid states unrepresentable.** Discriminated unions instead of objects with optional fields that "must be set together"; literal unions instead of free strings.
- **Trust nothing at the edge, everything inside.** Data from JSON, files, the network, `process.argv` or a `catch` is `unknown` until parsed. After that one parse, the type is true and the code stops checking.
- **Small modules with one job,** named for the domain, not `utils` or `helpers`.
- **Let the tools work.** The formatter owns layout, the linter owns idiom, the compiler owns types. Don't fight them with casts and suppressions.

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

Fast is a number, not a feeling. For performance changes, start and end with a measurement.

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

Adapted from [typescript-best-practices](https://github.com/ofershap/typescript-best-practices) by Ofer Shapira and [antfu/skills](https://github.com/antfu/skills) by Anthony Fu (MIT; [`licenses/ofershap-typescript-best-practices-LICENSE`](../licenses/ofershap-typescript-best-practices-LICENSE), [`licenses/antfu-skills-LICENSE`](../licenses/antfu-skills-LICENSE)). The diagnostic table and measuring loop adapt the Swift and performance skills of [Bama](https://github.com/daveebbelaar/bama) by Dave Ebbelaar (MIT, [`../licenses/Bama-LICENSE`](../licenses/Bama-LICENSE)).
