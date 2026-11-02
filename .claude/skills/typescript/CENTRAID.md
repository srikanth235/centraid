# Where this repo departs from the packs

Repo docs win ([AGENTS.md](../../../AGENTS.md)). The packs are [ofershap/typescript-best-practices](https://github.com/ofershap/typescript-best-practices) and [antfu/skills](https://github.com/antfu/skills) (vitest); see [SOURCES.md](SOURCES.md). The repo's own TypeScript rules live in [docs/coding-standards.md](../../../docs/coding-standards.md) and are linked from [SKILL.md](SKILL.md), not copied here.

| Pack says | Repo says | Winner and why |
| --- | --- | --- |
| Turn on `exactOptionalPropertyTypes` | [tsconfig.base.json](../../../tsconfig.base.json) sets `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch` and not this flag | Repo. Do not add the flag in a feature change;. |
| Target ES2022 | ES2023, `module: Preserve`, `moduleResolution: bundler` at the base | Repo. |
| "NEVER use `enum`" as a hard rule | Not lint-enforced; the tree has no TS `enum` anyway | Same outcome; SKILL.md states it as a default, not a gate. |
| Brand every id (`UserId`) | No branded ids in the TypeScript tree | Repo. Brand only where a real mix-up occurred. |
| Use `using` for resources | Not used in the tree; tests register cleanup with `onTestFinished` / kit helpers (`tempDir`) | Repo. Cleanup is registered at creation by the kit. |
| `vi.useFakeTimers()`, `vi.setSystemTime()`, `Math.random()`, `mkdtemp` in tests (vitest pack mocking and examples) | oxlint errors in test files; use `useFakeClock`, `seededRandom`, `tempDir` from `@centraid/test-kit` ([Test seams](../../../docs/coding-standards.md#test-seams-mechanically-enforced)) | Repo. |
| Vitest pack is generated for Vitest 5; its other files cover coverage, snapshots, projects, benchmarks | Repo pins `vitest` 4.1.10; the tree has no snapshots, type tests or `test.extend` today | Only the fixtures and type-testing pages are kept, with v5-only lines removed. Check the API against the pinned version before using a pack example. |
| Default `maxExpects` of 5 (ultracite vitest preset) | `vitest/max-expects` is 31 by ruling | Repo ([oxlint.config.ts](../../../oxlint.config.ts)). |
| `toBeTruthy()`/`toBeFalsy()` preferred by the preset | Turned off; exact `toBe(true)` | Repo ([TESTING.md](../../../TESTING.md)). |
| Tests may ship with zero assertions | `requireAssertions: true` in the kit's project presets | Repo. |
| `try/finally` or optional chaining liberally for safety | No just-in-case `try/catch`, justified `?.`/`??` | Repo ([coding-standards](../../../docs/coding-standards.md)). |
| `const _exhaustive: never` default branch | Repo prefers a policy table keyed by the discriminant when the same switch repeats | Repo; the `never` default remains right for a one-off switch. |
