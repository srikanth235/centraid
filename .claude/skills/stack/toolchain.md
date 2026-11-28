# Repository toolchain

**Bun and Node are refused for repository tooling (B1).** Every cross-cutting check, linter, code generator, design emitter, and release command lives in `crates/xtask` and runs as `cargo xtask <command>` (plus fast POSIX `sh` hooks under `.githooks/`).

## What owns what

| Job | Owner | Command |
| --- | --- | --- |
| Gate profiles (`local`, `pr`, `nightly`, `release`, `mobile-jvm`) | `crates/xtask` | `cargo xtask gate --profile <name>` |
| Structural rules, copy ratchet, journey ledger, skills | `crates/xtask` | `cargo xtask rules [copy\|journeys\|skills]` |
| Design tokens, native tables, icons, site sheet, dark mockups | `crates/xtask` | `cargo xtask design [--check]` |
| Release classification, matrix, prepare, publish, restamp, versions, secrets | `crates/xtask` | `cargo xtask release <subcommand>` |
| Pre-commit hygiene (secrets, size, images, model names, security sync) | `.githooks/pre-commit` | `sh .githooks/pre-commit [--all]` |
| Static docs & home sites (`scripts/docs-site`, `scripts/home-site`) | Astro + Pagefind via Bun | `bun run docs:build && bun run docs:smoke` |

## Rules

- Do not add `.ts`, `.mjs`, or `.js` scripts for repo checks, generators, or release automation; write them in `crates/xtask`.
- Do not add `oxfmt`, `oxlint`, `vitest`, `typescript`, or workspace packages back to `package.json`.
- `package.json` and `bun.lock` exist solely for `scripts/docs-site` and `scripts/home-site` (`astro`, `jsdom`, `pagefind`).
- In CI, `.github/actions/setup` defaults `bun` to `"false"`; only jobs that run the `sites` gate step opt in with `bun: "true"`.
