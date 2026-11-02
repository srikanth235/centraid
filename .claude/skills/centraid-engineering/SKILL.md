---
name: centraid-engineering
description: Centraid's cross-language engineering rules — error handling, optional values past validation, compat shims, refactors, policy tables, module naming, failure reaching the UI, atomicity, cost that grows with the vault, scale tests, pollers, comments. Use with the language skill (rust, swift-swiftui, kotlin-compose, typescript, sqlite, python) whenever you write, refactor or review code in this repo.
---

# Engineering rules for every language

These rules hold in Rust, Swift, Kotlin, TypeScript and Python alike. The language skill says how to apply them in its idiom; this file is the one home for the rule itself.

## Errors

- **No just-in-case catch.** Catch (`catch`, `do/catch`, `runCatching`, `match` on `Err`, `except`) only for a **recovery**, a **typed translation**, or a **boundary** (the C ABI, a process edge, a shell effect performer). An empty catch, catch-log-and-continue, or catch-and-return-null with no product reason is a defect. Let the failure reach the existing boundary.
- **Failure reaches the member.** Work that can fail and that the member started returns a typed error the screen can render — the core answers a typed refusal, never `null` ([crates/core-ffi/CONTRACT.md](../../../crates/core-ffi/CONTRACT.md)) — and the screen has an error state for it. A failure that is only logged is a blank screen.

## Optional values

- **Don't re-check what was validated.** After a parse, a guard or a type that proves presence, use the value directly. `?.`, `??`, `?:`, `if let … else default`, `.unwrap_or_default()` past a validation boundary hide missing data. They are fine at true optionality: optional fields, foreign input before parsing.
- **A compat shim is tagged.** Code that tolerates an older peer's shape carries `COMPAT(name)` ([docs/protocol.md](../../../docs/protocol.md#c2--compatname-tagging)). An untagged default that papers over an old shape has no cleanup signal and is banned.

## Structure

- **Refactors look like edits.** Change the module in place, or extract with one owner and delete the old path in the same change. No `foo_v2` beside `foo`, no dual exports "for migration", no re-exporting shim package.
- **Policy tables over repeated branches.** When the same `match`/`switch`/`when` on a kind appears twice, or grows with every feature, make it one table keyed by the kind (`Record<Kind, Handler>`, a `match` in one function, a map). Scattered branches on one axis drift apart.
- **Name the domain.** `utils`, `helpers`, `common`, `manager`, `service` (file, module or type) is a grab-bag with no owner. Name what it does: `wal_segment_key.rs`, `consentParse.ts`. Shared TypeScript test helpers live in `@centraid/test-kit`.
- **Use existing seams.** Go through a crate's or package's public API, never a sibling's internals. Run tools through the repo's entrypoints (`cargo xtask`, `cargo test -p`, `mobile/gradlew`, `bun run`), never a raw `npx` or a globally installed tool, so the pinned versions apply ([docs/toolchain.md](../../../docs/toolchain.md)).
- **One law, one home.** A product rule is asserted in one test file, the one that owns it. A second file asserting the same rule is a restatement that will drift: delete it.

## State and cost

- **The owner of the data owns atomicity.** Callers never read, merge and write in separate steps. A vault write is one `Vault::commit`; anything else with read-modify-write gets one method on its owner that does it under one lock or transaction.
- **Nothing that grows with the vault runs on the request or UI path.** No unbounded query, whole-blob hash/compress/key-derivation, or full sweep on a core request, the main thread or a timer. Bounded work is fine: a `LIMIT`ed or keyed query, a fixed-size digest. Unbounded work goes to a background job that pages with a cursor and caps what one pass touches.
- **"This table stays small" is not a bound.** Put the bound in code — a `LIMIT`, a retention cap, a paged cursor, a budget assertion in a test — or write code that survives the table being large.
- **Compute once, share the result.** When several consumers need the same derived value, derive it once, invalidated by the write path. Per-consumer recompute is correct, survives review, and shows up only as cost that grows with consumers.
- **Scale tests use year-3 volumes.** A perf test seeded with unit-test fixtures proves an empty vault is fast. Seed to the declared year-3 volume for the surface (the `tests/year3.rs` rigs in `crates/apps/*`), keep the volume table beside the rig, and move the measured value and its volume together. A ceiling with no stated volume is not a budget.
- **Pollers stop when nobody is looking.** A repeating timer stops when the app goes to the background or the screen goes away, and refreshes once on return. Prefer an event over polling; a new poller says why push cannot carry it and uses the longest interval the feature tolerates.

## Comments

A comment is an obligation to the next editor: something the code cannot say, kept only while deleting it would mislead.

- Four kinds only: **contract** (what callers rely on beyond the signature), **rationale** (the constraint that forced this shape), **warning** (the obvious edit that is wrong), **orientation** (module headers: the mental model). Anything else is deleted.
- **The deletion test:** which future edit does this comment prevent or permit? No answer, delete it. Delete rather than reword.
- **Facts live at the strongest level that holds them:** type, then test or assertion, then check script, then comment.
- **No history.** "was", "used to", "replaced", "until #N" either becomes a present obligation or goes. Cite history as a bare issue link.
- **Name symbols, not files,** and only ones that exist. A long invariant block gets a capitalised heading per invariant (`// WHY THE HEAD IS NOT JUST THE OLDEST.`). Banners are `// ─── name ─────`. A suppression names the real tool (`oxlint-disable…`, `#[allow(…, reason = …)]`) and gives a reason.
- Keep comments sparse: about a tenth of a file's characters, a block over 10 lines is a smell. When you edit commented code, re-run the deletion test on the comments next to it.

## Small rules

- A behaviour-preserving refactor keeps tests green without rewriting their assertions to fit new private helpers ([TESTING.md](../../../TESTING.md)).
- No hard-coded model ids in product source.
- A new hot path ships with a measured latency budget.
- Query handlers do not write.
- Fix the code, not the check: never loosen a lint, test, budget or allowlist to get green.
