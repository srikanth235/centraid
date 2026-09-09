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
| **Green local gates** | `bun run check:push` before push — the pre-push hook runs it for you (see [AGENTS.md](AGENTS.md)). |

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

Receipts are **append-only**: a multi-PR issue keeps one receipt and each PR adds one section at the end, because `doc-integrity` requires the trunk's copy to stay a byte-prefix of yours. The root `.gitattributes` marks `receipts/*.md merge=union`, so two branches appending to the same receipt rebase cleanly with the upstream section first instead of conflicting. The driver cannot tell an append from an edit, so the rule it does not replace still stands: never change text above your own section — `doc-integrity` enforces that. Details and limits: [docs/dev-environment.md](docs/dev-environment.md#receipts-are-append-only-and-sibling-appends-merge-by-union).

## Amending the law

The repo's directives are ESLint rules under [`.governance/law/`](.governance/law/README.md), and changing one is an **amendment**, not an edit. Four things move together, in a single commit, or `amendment-pairing` refuses it:

1. the rule — `.governance/law/rules/<id>.mjs`, carrying `meta.door` (`hook`, `window` or `owner`) and its statute link;
2. its cases — `.governance/law/rules/<id>.test.mjs`. The `invalid` case is the demonstrated red; a directive with no enforcing test is a wish;
3. its row — the pack declaration under `.governance/law/packs/`, which sets the severity (`error` blocks, `warn` is a front-page finding, `off` repeals);
4. its statute — a `### <id>` section in [CONSTITUTION.md](CONSTITUTION.md) stating the door, what the **host** enforces and what the rule only observes. `constitution-coverage` fails on a rule with no section and on a principle that resolves to neither a rule id nor a `docs/decisions.md` anchor.

A change to the law estate is also separated from product code by `estate-separation`: one commit edits the law or the territory, never both. Registry files (`receipts/**`, `docs/**`, `CHANGELOG.md`, `QUALITY.md`, the docket) may ride with either.

An exception to a rule is not a code comment. `eslint-disable-next-line <rule> -- docket:<id>` points at a row in `.governance/law/docket.json` carrying reason, authority, issue and expiry. **Anyone may file a row; only the owner grants one**, by merging it under owner review before it is spent — a row filed and used in the same change is refused by `waiver-docket` as a permission slip its author wrote itself.

Run it: `bun run governance:law` for the window door, `bun run governance:law:test` for the cases, `bash .governance/run.sh` for everything. Do not weaken a rule to go green; the amendment is the supported path, and the law estate requires owner review to merge ([#1005](https://github.com/srikanth235/centraid/issues/1005)).

## Security

Report vulnerabilities privately per [SECURITY.md](SECURITY.md) — not as public issues.
