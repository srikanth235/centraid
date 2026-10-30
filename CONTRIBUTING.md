# Contributing

Centraid is a **solo-maintained** project. Review bandwidth is the bottleneck. This document is a pre-filter (issue [#468](https://github.com/srikanth235/centraid/issues/468) B4): please meet it before opening a PR.

## Before you write code

1. **Open or link an issue** using the [proposal](.github/ISSUE_TEMPLATE/proposal.yml) or [bug](.github/ISSUE_TEMPLATE/bug.yml) template. Blank issues are disabled.
2. **Discuss features before implementing** — a short issue beats a large surprise PR.
3. **Read** [AGENTS.md](AGENTS.md) / [CLAUDE.md](CLAUDE.md) and any linked `docs/` for the area you touch.

## PR requirements

| Requirement | Detail |
| --- | --- |
| **One focused change** | One concern per PR. No drive-by refactors. |
| **Linked issue** | `Fixes #N` / `Refs #N` in the description. |
| **Testing evidence** | Commands run and results (or why not). Follow [TESTING.md](TESTING.md). |
| **Screenshots** | For UI changes: each affected platform you claim (iOS / Android). |
| **Green local gates** | `cargo xtask gate --profile local` while iterating, and `bun run check` when TypeScript changed; `--profile pr` before you push is the entrypoint CI runs. A change under `mobile/` should also pass `cargo xtask gate --profile mobile-jvm`, which CI runs nightly. |

Low-effort, fully generated PRs with no issue link, no tests, and no evidence the author ran the app will be closed.

## AI assistance policy

- Using agents is fine and expected in this repo's own workflow.
- **Your agents must read the repo docs** (`AGENTS.md`, relevant `docs/`).
- **You must understand and be able to defend** every line you submit.
- **You must test** what you submit — "the model said it passed" is not enough without command output.
- Do not submit secrets, signing material, or production vault data.

## Path to maintainer trust

Rough ladder (not a bureaucracy — signal only):

1. **Good citizen** — small, linked, tested PRs that match house style ([docs/coding-standards.md](docs/coding-standards.md)).
2. **Area regular** — repeated solid work in one area; reviews get lighter.
3. **Delegate** — maintainer may ask you to drive a follow-up issue; still solo-merge by default.

There is no guaranteed commit bit. Response cadence: see [README.md](README.md).

## What the tree refuses

The product is one Rust core under `crates/`, with `contracts/`, `mobile/`, `design/`, `copy/` and `deploy/` around it ([ARCHITECTURE.md](ARCHITECTURE.md)). Two rules bite hardest on a first change:

- **The gate is one command.** `cargo xtask gate --profile <local|pr|nightly|release|mobile-jvm>`, each profile a concatenation of the one before. Budgets live in `contracts/ledgers/` and **only fall**; `cargo xtask measure --write` is the only writer and only ever lowers a number. A raise needs an owner ruling, not a flag. Give every worktree its own `CARGO_TARGET_DIR` ([docs/traps/shared-cargo-target.md](docs/traps/shared-cargo-target.md)).
- **`sql-confinement`.** SQL string literals appear only under `crates/{ontology,vault,seat,search}` and `crates/apps/kit` — an app crate holds no SQL and never sees a `Connection`. The rule has moved real APIs rather than being widened for them, and widening it to go green is weakening a gate.

Every user-facing gate lands with a **demonstrated red** recorded in the receipt, and a claim of absence names the grep that establishes it.

## House rules pointers

- Conventional Commits + issue suffix: `type(scope): subject (#123)`, checked by `.githooks/commit-msg` on each commit and on the PR title (enable the hooks once with `git config core.hooksPath .githooks`)
- One receipt per substantive issue under `receipts/`
- Docs write-back: if you learn a gotcha, update `docs/` ([AGENTS.md](AGENTS.md)) — and a footgun that cost you an hour earns a doc under [docs/traps/](docs/traps/README.md)
- Tools via repo entrypoints only — `cargo xtask` for the gate and repo scripts for the TypeScript toolchain; never raw `npx <tool>`

Receipts are **append-only**: a multi-PR issue keeps one receipt and each PR adds one section at the end, so the trunk's copy stays a byte-prefix of yours. The root `.gitattributes` marks `receipts/*.md merge=union`, so two branches appending to the same receipt rebase cleanly with the upstream section first instead of conflicting. The driver cannot tell an append from an edit, so the rule it does not replace still stands: never change text above your own section. Details and limits: [docs/dev-environment.md](docs/dev-environment.md#receipts-are-append-only-and-sibling-appends-merge-by-union).

## Security

Report vulnerabilities privately per [SECURITY.md](SECURITY.md) — not as public issues.
