# Issue #1105 — rustls 0.23.46 for RUSTSEC-2026-0346 to 0349

## What changed

- `Cargo.lock`: rustls 0.23.45 to 0.23.46 (version and checksum), nothing else.
- `CHANGELOG.md`: a `### Fixed` line under `[Unreleased]`.
- `receipts/issue-1105-rustls-advisories.md`: this receipt.

`cargo update -p rustls --precise 0.23.46` also flipped tempfile's `getrandom` from 0.4.3 to 0.3.4. That line was put back by hand; `cargo metadata --locked` accepts the lock, so the resolver does not require the flip.

## Verification

- `cargo deny --all-features --config deny.toml check` on the base (before the bump): advisories FAILED (RUSTSEC-2026-0346, 0347, 0348, 0349), bans ok, licenses ok, sources ok.
- `cargo update -p rustls --precise 0.23.46`: updated rustls only; `git diff Cargo.lock` shows 2 lines changed after the getrandom revert.
- `cargo deny --all-features --config deny.toml check` after the bump (cargo-deny 0.20.2): advisories ok, bans ok, licenses ok, sources ok.
- `cargo build --locked -p centraid-gateway -p centraid-core`: finished.
- `cargo test --locked -p centraid-gateway`: all test results ok, 0 failed.
- `bun run check:push:static`: 4 of 4 gates passed (format:check, lint, turbo:lint, typecheck:affected).

## Decisions

## Audit

There was no independent reviewer.
