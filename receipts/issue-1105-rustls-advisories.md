# Issue #1105 — rustls 0.23.46 for RUSTSEC-2026-0346 to 0349

## What changed

- `Cargo.lock`: rustls 0.23.45 to 0.23.46 (version and checksum), nothing else.
- `CHANGELOG.md`: a `### Fixed` line under `[Unreleased]`.
- `receipts/issue-1105-rustls-advisories.md`: this receipt.

`cargo update -p rustls --precise 0.23.46` also flipped tempfile's `getrandom` from 0.4.3 to 0.3.4. That line was put back by hand; `cargo metadata --locked` accepts the lock, so the resolver does not require the flip.

## Verification

```sh
cargo deny --all-features --config deny.toml check
```

On the base before the bump: fail, advisories FAILED on RUSTSEC-2026-0346, 0347, 0348 and 0349; bans, licenses and sources ok.

```sh
cargo update -p rustls --precise 0.23.46
```

Outcome: pass. It also flipped tempfile's getrandom from 0.4.3 to 0.3.4; that line was put back by hand, leaving 2 removed and 2 added lines (rustls version and checksum).

```sh
cargo metadata --locked --format-version 1
```

Outcome: pass, exit 0 with the hand-reverted lock.

```sh
cargo deny --all-features --config deny.toml check
```

After the bump (cargo-deny 0.20.2): pass, advisories ok, bans ok, licenses ok, sources ok.

```sh
cargo build --locked -p centraid-gateway -p centraid-core
```

Outcome: pass, exit 0.

```sh
cargo test --locked -p centraid-gateway
```

Outcome: pass, every suite ok, 0 failed.

```sh
bun run check:push:static
```

Outcome: pass, 4 of 4 gates (format:check, lint, turbo:lint, typecheck:affected); run before the final receipt commit.

## Decisions

## Audit

**PASS.** An independent read-only Sonnet verifier, a separate agent from the author, checked the result:

- The lock diff is rustls's version and checksum only.
- `cargo metadata --locked` exits 0. `cargo update --workspace --dry-run` reports "Locking 0 packages", and a real `cargo update --workspace` leaves the lock byte-identical, so the hand-reverted getrandom line is stable.
- `cargo deny ... check advisories` passes on this branch and fails on main e08ef1b5 with RUSTSEC-2026-0346 to 0349.

Limits: the verifier did not rerun the build, the gateway tests or `check:push:static`; those outcomes above are the author's own.
