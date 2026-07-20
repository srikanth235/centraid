# Contributing

Centraid is a **solo-maintained** project. Review bandwidth is the bottleneck. This document is a pre-filter (issue [#468](https://github.com/srikanth235/centraid/issues/468) B4): please meet it before opening a PR.

## Before you write code

1. **Open or link an issue** using the [proposal](.github/ISSUE_TEMPLATE/proposal.yml) or [bug](.github/ISSUE_TEMPLATE/bug.yml) template. Blank issues are disabled.
2. **Discuss features before implementing** — a short issue beats a large surprise PR.
3. **Read** [AGENTS.md](AGENTS.md) / [CLAUDE.md](CLAUDE.md), [CONSTITUTION.md](CONSTITUTION.md), and any linked `docs/` for the area you touch.

## PR requirements

| Requirement | Detail |
| --- | --- |
| **One focused change** | One concern per PR. No drive-by refactors. |
| **Linked issue** | `Fixes #N` / `Refs #N` in the description. |
| **Testing evidence** | Commands run and results (or why not). Follow [TESTING.md](TESTING.md). |
| **Screenshots** | For UI changes: each affected platform you claim (desktop / web / mobile). |
| **Green local gates** | `bun run check:pr` before push (see [AGENTS.md](AGENTS.md)). |

Low-effort, fully generated PRs with no issue link, no tests, and no evidence the author ran the app will be closed.

## AI assistance policy

- Using agents is fine and expected in this repo's own workflow.
- **Your agents must read the repo docs** (`AGENTS.md`, constitution, relevant `docs/`).
- **You must understand and be able to defend** every line you submit.
- **You must test** what you submit — "the model said it passed" is not enough without command output.
- Do not submit secrets, signing material, or production vault data.

## Path to maintainer trust

Rough ladder (not a bureaucracy — signal only):

1. **Good citizen** — small, linked, tested PRs that match house style ([docs/coding-standards.md](docs/coding-standards.md)).
2. **Area regular** — repeated solid work in one package; reviews get lighter.
3. **Delegate** — maintainer may ask you to drive a follow-up issue; still solo-merge by default.

There is no guaranteed commit bit. Response cadence: see [README.md](README.md).

## House rules pointers

- Conventional Commits + issue suffix: `type(scope): subject (#123)`
- One receipt per substantive issue under `receipts/`
- Docs write-back: if you learn a gotcha, update `docs/` ([AGENTS.md](AGENTS.md))
- Tools via repo scripts only — never raw `npx <tool>` for the toolchain

## Security

Report vulnerabilities privately per [SECURITY.md](SECURITY.md) — not as public issues.
