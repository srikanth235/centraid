# AGENTS.md

Centraid is a personal, local-first superapp: one shell wrapping many first-party apps over a sovereign vault. **The phone is the vault**: the Rust core on the phone is the vault's only writer, and any machine the member controls runs `centraid-gateway` as a blind store for its sealed backup.

## Checks

- `cargo xtask gate --profile <local|pr|nightly|release|mobile-jvm>` is the gate; `bun run check` covers TypeScript. Run the profile that matches the change before calling it done.
- On a fresh clone run `git config core.hooksPath .githooks`. Commit subjects read `type(scope): subject (#N)`.
- Fix the code, not the check. Do not loosen a lint, test, budget or allowlist to get green. The budgets that remain are counts and sizes (the copy and native-controls ratchets, the spool's byte budget, `library-size.json`, the query-plan allowlist). Wall-clock budgets were removed by the owner's ruling of 2026-11-04 (they flaked on loaded machines and blocked unrelated changes), so no gate step or test asserts on seconds. Keep it that way: bound work by construction and assert on counts (statements, calls, rows), never durations.

## Skills

Guidance lives in [`.claude/skills/`](.claude/skills): `product-intuition` for what to build and how it should behave; one skill per language (`rust`, `swift-swiftui`, `kotlin-compose`, `typescript`, `sqlite`, `python`); and one per kind of change (`screen-change`, `core-ffi`, `vault-change`, `mobile-verify`).

## Conventions

- **Docs describe current state.** When a change makes a doc wrong, fix the doc in the same change.
- **Product calls go to the owner.** When a choice is about what the product should be and the `product-intuition` skill does not settle it, ask rather than guess.
- **Vocabulary**: a machine running `centraid-gateway` is a _gateway_, not a server or host.
