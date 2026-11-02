# AGENTS.md

Centraid is a personal, local-first superapp: one shell wrapping many first-party apps over a sovereign vault. **The phone is the vault**: the Rust core on the phone is the vault's only writer, and any machine the member controls runs `centraid-gateway` as a blind store for its sealed backup.

## Checks

- `cargo xtask gate --profile <local|pr|nightly|release|mobile-jvm>` is the gate; `bun run check` covers TypeScript. Run the profile that matches the change before calling it done.
- On a fresh clone run `git config core.hooksPath .githooks`. Commit subjects read `type(scope): subject (#N)`.
- Fix the code, not the check. Do not loosen a lint, test, budget or allowlist to get green.

## Skills

How to write code here lives in [`.claude/skills/`](.claude/skills): `centraid-engineering` for the rules every language shares, and `rust`, `swift-swiftui`, `kotlin-compose`, `typescript`, `sqlite` and `python` for each language.

## Conventions

- **Docs describe current state.** When a change makes a doc wrong, fix the doc in the same change.
- **Decisions** live in [docs/decisions.md](docs/decisions.md). Judge a ruling on its merits for the product as it is now, and raise it with the owner if it no longer holds.
- **Vocabulary**: a machine running `centraid-gateway` is a _gateway_, not a server or host. See [docs/glossary.md](docs/glossary.md).
