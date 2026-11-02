# AGENTS.md

Centraid is a personal, local-first superapp: one shell wrapping many first-party apps over a sovereign vault. **The phone is the vault**: the Rust core on the phone is the vault's only writer, and any machine the member controls (a laptop, a VPS, a NAS) runs `centraid-gateway` as a blind store for its sealed backup.

## Layout

- [`crates/`](crates): the Rust workspace: identity, vault and backup, ontology, gateway protocol and binary, byte plane, first-party apps ([`crates/apps`](crates/apps)), the C ABI ([`crates/core-ffi`](crates/core-ffi)) and the `centraid` operator binary.
- [`mobile/`](mobile): the only shell, Kotlin Multiplatform with Compose (Android) and SwiftUI (iOS) views over the core.
- [`contracts/`](contracts): shared schemas and fixtures. [`packages/design`](packages/design): visual identity and token emitters (Bun + TypeScript).
- [`experiments/toolchat/native`](experiments/toolchat/native): the on-device model's training and eval pipeline (Python).

Wiring: [ARCHITECTURE.md](ARCHITECTURE.md). Gateway protocol: [docs/gateway.md](docs/gateway.md). Commands: [README.md](README.md).

## Checks

- `cargo xtask gate --profile <local|pr|nightly|release|mobile-jvm>` is the gate ([crates/xtask](crates/xtask/README.md)); `bun run check` covers TypeScript. Run the profile that matches the change before calling it done; one crate's tests passing is not enough.
- On a fresh clone run `git config core.hooksPath .githooks`: `pre-commit` runs oxfmt and oxlint on staged files, `commit-msg` requires `type(scope): subject (#N)`.
- Fix the code, not the check. Do not loosen a lint, test, budget or allowlist to get green.

## Language skills

Per-language guidance lives in [`.claude/skills/`](.claude/skills): `rust`, `swift-swiftui`, `kotlin-compose`, `typescript`, `sqlite`, `python`. Each has a short `SKILL.md`, reference files for depth, and a `CENTRAID.md` listing where this repo departs from common practice.

## Conventions

- **Docs describe current state.** Cite history by issue link rather than narrating it. When a change makes a doc wrong, fix the doc in the same change.
- **Decisions** live in [docs/decisions.md](docs/decisions.md). A ruling explains why something was chosen, not whether it should stay: judge it on its merits for the product as it is now, and raise it with the owner if it no longer holds.
- **Vocabulary**: a machine running `centraid-gateway` is a _gateway_, not a server or host. A _pass_ (the core's `drain`) prepares, moves and settles; a _snapshot_ is the vault copied page for page into 64 KiB ranges plus a manifest; _backed up_ means a gateway acknowledged it and the phone recorded that. See [docs/glossary.md](docs/glossary.md).
- New work starts from a GitHub issue.

## Where to look

- Before non-trivial work: [ARCHITECTURE.md](ARCHITECTURE.md), [docs/coding-standards.md](docs/coding-standards.md), [TESTING.md](TESTING.md), and the matching trap in [docs/traps/](docs/traps/README.md).
- The vault model: [docs/vault-ontology.md](docs/vault-ontology.md). Design rules: [DESIGN.md](DESIGN.md), [docs/design-machinery.md](docs/design-machinery.md).
- Debugging: start at [docs/logs.md](docs/logs.md).
- Release: [docs/release.md](docs/release.md). Security: [SECURITY.md](SECURITY.md).
