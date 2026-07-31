# Coding standards (agent failure modes)

House style for diffs agents produce. Goal: review becomes scanning, not archaeology. These rules target failure modes that burn review bandwidth — not a full language style guide.

## No just-in-case try/catch

Do not wrap code in `try/catch` "in case something throws."

- Catch only when you have a **recovery**, a **typed translation**, or a **boundary** (process edge, HTTP handler, worker host).
- Empty `catch`, catch-and-log-and-continue, and catch-to-return-null without a product reason are review blockers.
- Prefer letting failures surface to the existing error boundary / fallible-action contract.

## Justify `?.` and `??` past validation

Once a value has been validated (schema parse, type guard, route auth, Ajv), do **not** re-optional-chain it.

| Bad | Good |
| --- | --- |
| parse then `body?.id ?? ''` | parse then `body.id` |
| `config?.features?.x ?? default` after schema required `features` | `config.features.x` |
| `arr?.find(...)?.x ?? fallback` hiding missing data | assert length / throw with context |

Optional chaining is fine at **true** optionality (optional fields, partial records, foreign input before parse). Past a validation boundary it is usually a silent bug.

## Untagged `??` is not a compat strategy

Back-compat shims need `// COMPAT(name): …` ([protocol.md](protocol.md) C2). A bare `x ?? default` that papers over an old wire shape is banned — it becomes eternal defensive code with no cleanup signal.

## Refactors look like edits, not new layers

When replacing a path:

1. Change the existing module in place, or
2. Extract with a **single** clear owner and delete the old path in the same change series.

Do **not** leave `foo-v2.ts` beside `foo.ts`, dual exports "for migration," or a parallel package that re-exports the old one indefinitely. Parallel layers double review cost forever.

## Policy tables over discriminator branches

If the same `switch (kind)` / `if (type === …)` appears more than once, or grows every feature, replace it with a **table** keyed by discriminant:

```ts
const POLICY: Record<Kind, Handler> = { open: handleOpen, close: handleClose };
const run = POLICY[kind];
run(input);
```

Scattered branches for the same axis are how behavior drifts between call sites.

## Filename smells: `-utils` and `-manager`

| Smell | Problem | Prefer |
| --- | --- | --- |
| `*-utils.ts` / `*-helpers.ts` | Grab-bag with no ownership | Name the **domain** (`consent-parse.ts`, `wal-segment-key.ts`) |
| `*-manager.ts` / `*-service.ts` without a seam | God object that grows forever | Narrow verbs (`openVault`, `fireAutomation`) or a real port interface |

Shared test helpers live in `@centraid/test-kit`, not another `test-utils.ts` per package.

## Fallible-action contract

User-visible or IPC/HTTP-facing work that can fail must expose failure to the UI — not only log it.

- Return or throw a structured error the client can render.
- Do not set `error` on a store/provider that no consumer reads (see issue #468 K2).
- Pair new async surfaces with empty / loading / error (or equivalent) so a failure is not a blank screen.

## Prefer existing seams

- Handlers use `ctx.vault` / `ctx.*` — no provider SDKs in handler files (constitution).
- Import package **barrels**, not deep internals (governance `no-deep-imports`).
- Tools and checks: **repo scripts only** — `bun run …` / workspace scripts, never raw `npx <tool>` so the pinned toolchain always applies (issue #468 B2).
- Quality ownership and safe-fix policy live in [toolchain.md](toolchain.md). Fix code before suppressing a diagnostic; never weaken policy only to make a gate green.

## Test seams (mechanically enforced)

Three hand-rolled test constructs are **oxlint errors** inside vitest test files. Each one leaked something when a test failed, and each has a shorter kit replacement — see the `TEST_SEAM_PROPERTIES` block in [oxlint.config.ts](../oxlint.config.ts) for the rule and its message.

| Banned in tests | Use | Why it is a rule and not advice |
| --- | --- | --- |
| `mkdtemp` / `mkdtempSync` (called or imported from `node:fs*`) | `tempDir()` / `tempDirSync()` from `@centraid/test-kit/temp-dir` | The kit registers removal at creation, so a throwing test cannot leak the directory. `photos-asset-key.test.ts` leaked one per run from module top level. |
| `vi.useFakeTimers` / `vi.useRealTimers` / `vi.setSystemTime` | `useFakeClock()` from `@centraid/test-kit/fake-clock` | A fake clock installed by a test that then throws stays installed for the rest of the file, and the later failures report as timeouts, not as the leak. `useFakeClock` registers the restore at install time. |
| `Math.random()` | `seededRandom(<literal>)` from `@centraid/test-kit/random` | A failure found from an unseeded draw is not reproducible from the failing run's own output. |

Two things to know about `useFakeClock`:

- It uses `onTestFinished`, so it is callable from a test body or `beforeEach` — **not** from `beforeAll` or a bare `describe` body. A file-lifetime clock is out of scope by design; if you think you need one, the fixture probably belongs in `beforeEach`.
- The `use` prefix makes `react-hooks/rules-of-hooks` treat it as a React hook, so it must be called directly in the test body, never from a lowercase-named local helper. Inline the helper rather than renaming the kit export.

`bootstrappedVault()` from `@centraid/test-kit/vault` is the same idea for vault fixtures: it opens, bootstraps, and registers the close in one call, and it takes `{ openVaultDb, bootstrapVault }` by injection so `packages/vault`'s own suites (which import `../db.js` relatively) can use it without a package cycle.

**Not** banned: `Date.now()`. oxlint 1.76 has no `no-restricted-syntax`, so the shape that actually hurts — wall clock read inside an assertion's expected value — is not expressible; only a blanket ban is, and the sampled majority of the repo's 162 call sites are relative offsets, unique-id suffixes, and elapsed measurement, which a fake clock makes wrong rather than better. Prefer `clock.now()` where a clock is already installed.

Playwright's `apps/*/tests/e2e/**` are exempt: different runner, no `onTestFinished`, none of these helpers exist there.

## One law, one home (mechanically enforced)

A named product law gets a machine-readable tag in its test title:

```ts
test("[law:backup-no-change] no-change run registers nothing", async () => { … });
```

`bun run lint:law-registry` (in `check:pr`) fails when the same tag appears in more than one file. Several tests in the **owning** file are fine — that is one home. A second file asserting the same law is a restatement, and Layer 1D of #656 deleted a batch of exactly those; the tag is what stops them coming back.

The registry lives in `tests/matrix.json#laws` as `{ [tag]: { statement, owner, flow? } }`. Once a tag is registered the linter also fails an unregistered tag, an owner file that does not exist, and a registered law whose owner carries no such tag.

## Store atomicity

**Store APIs own atomicity.** Callers do not orchestrate read → merge → write against prefs, device tokens, enrollment, or session files.

| Bad | Good |
| --- | --- |
| `const j = read(); j.x = 1; write(j)` in a route | `store.setX(1)` / `store.update(…)` that locks and writes |
| Two handlers each rewriting the same JSON | One store method with a single persist path |

**Mechanical vs judgment:** judgment-only in review; prefer existing store methods in `packages/gateway/src/serve/*-store.ts`.

## Small invariants

- Behaviour-preserving refactors keep tests green without rewriting assertions to match new private helpers ([TESTING.md](../TESTING.md)).
- No hardcoded model ids in production source (constitution).
- Query handlers do not write; actions declare `writes:`.

## Related

- [CONSTITUTION.md](../CONSTITUTION.md) — mechanical directives
- [protocol.md](protocol.md) — COMPAT tagging, no-fallback features
- [glossary.md](glossary.md) — vocabulary
