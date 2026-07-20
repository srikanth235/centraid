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

## Small invariants

- Behaviour-preserving refactors keep tests green without rewriting assertions to match new private helpers ([TESTING.md](../TESTING.md)).
- No hardcoded model ids in production source (constitution).
- Query handlers do not write; actions declare `writes:`.

## Related

- [CONSTITUTION.md](../CONSTITUTION.md) — mechanical directives
- [protocol.md](protocol.md) — COMPAT tagging, no-fallback features
- [glossary.md](glossary.md) — vocabulary
