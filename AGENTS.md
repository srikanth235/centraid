# AGENTS.md

Map of the durable docs an agent (or human) should read before working in this repo. Start at the constitution; everything else is a pointer.

`CLAUDE.md` must be a **symlink to this file** (`ln -sf AGENTS.md CLAUDE.md`) so every agent CLI reads the same manual with zero sync burden (issue #468 A2).

<!-- governance: rules-to-follow -->
## Rules to follow

If you are an agent — or a human — working in this repo, **read [CONSTITUTION.md](CONSTITUTION.md) and follow it**. It defines the principles, guidelines, and directives that every change in this repo must satisfy.

- The mechanical directives are enforced by `.governance/run.sh` (run via the pre-commit hook locally and the [governance.yml](.github/workflows/governance.yml) workflow in CI).
- The principles and guidelines cannot be mechanically checked — you are expected to read them and apply judgment. A change that defies a principle without explanation will block the PR.

See the **Compliance** section of [CONSTITUTION.md](CONSTITUTION.md) for the full directive, including how to document approved deviations.
<!-- /governance: rules-to-follow -->

## What this repo is

Centraid is a personal app builder. Its backend is a host-agnostic **gateway** ([`packages/gateway`](packages/gateway)) that wires the app engine ([`packages/app-engine`](packages/app-engine)), the agent runtime ([`packages/agent-runtime`](packages/agent-runtime)), the automation engine ([`packages/automation`](packages/automation)), the SQLite stores, and the chat/automation runners together. The same gateway runs embedded in the Electron desktop ([`apps/desktop`](apps/desktop)) and as the standalone `centraid-gateway` daemon. Desktop and the installable web PWA ([`apps/web`](apps/web)) share the React shell and browser-safe HTTP client in [`packages/client`](packages/client); the Expo mobile app ([`apps/mobile`](apps/mobile)) connects to a gateway over HTTP. App scaffolding + templates live in [`packages/blueprints`](packages/blueprints) and agent grounding in [`packages/skills`](packages/skills); all clients share visual identity through [`packages/design-tokens`](packages/design-tokens) and per-runtime TypeScript settings through [`packages/tsconfig`](packages/tsconfig). The full layout, runtime model, on-disk layout, and build orchestration live in [ARCHITECTURE.md](ARCHITECTURE.md).

The runtime stack is [Bun](https://bun.sh) (package manager, pinned in `packageManager`), [Turborepo](https://turbo.build) (task graph), and TypeScript. Linting and formatting are [oxlint](https://oxc.rs) and [oxfmt](https://github.com/oxc-project/oxfmt); tests run on [vitest](https://vitest.dev). See [README.md](README.md) for the develop / build / test / check commands.

## Docs write-back loop (A1)

1. **Before non-trivial work**, skim the relevant rows in the [docs index](#docs-index) (and `docs/traps/` if you are near a known footgun).
2. **Code-level facts** belong in code comments next to the invariant.
3. **System / process facts** (workflows, ownership, recovery, vocabulary) belong under `docs/`.
4. When you learn a gotcha, convention, or workflow that **outlives the task**, update the matching doc in the same PR (or leave a short PR note proposing the doc change if out of scope).
5. Stale docs are bugs — same as broken links ([CONSTITUTION.md](CONSTITUTION.md)).

## Docs index

| Doc | What's in it |
| --- | --- |
| [CONSTITUTION.md](CONSTITUTION.md) | Principles + mechanically enforced directives |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Gateway, conversation⊃turn⊃item, workspace + on-disk layout |
| [README.md](README.md) | Product pitch, layout table, develop/build/check commands, support cadence |
| [CONTRIBUTING.md](CONTRIBUTING.md) | PR pre-filter, AI policy, path to maintainer |
| [TESTING.md](TESTING.md) | Suite strategy, PR vs nightly, conventions |
| [SECURITY.md](SECURITY.md) | Vulnerability disclosure + pairing/relay/gateway threat model |
| [CHANGELOG.md](CHANGELOG.md) | Keep a Changelog; release notes source (D3) |
| [docs/decisions.md](docs/decisions.md) | Settled #468 decisions (H1, C1, D4, F1, J5, signing, …) |
| [docs/glossary.md](docs/glossary.md) | Vocabulary + forbidden synonyms + code pointers |
| [docs/coding-standards.md](docs/coding-standards.md) | Agent failure modes (try/catch, `?.`, refactors, fallible actions) |
| [docs/protocol.md](docs/protocol.md) | C1 two-contract, COMPAT tags, wire-schema purity |
| [docs/release.md](docs/release.md) | Prepare vs publish, patch/minor, beta, skills |
| [docs/identifiers.md](docs/identifiers.md) | `dev.centraid.*` table (J5) |
| [docs/enrollment.md](docs/enrollment.md) | Human checklist: Apple / Azure / Play signing |
| [docs/config-ownership.md](docs/config-ownership.md) | Which writer wins for dual-write config surfaces |
| [docs/logs.md](docs/logs.md) | **Canonical log locations** (start every debug session here) |
| [docs/runners.md](docs/runners.md) | Coding-agent harnesses: ACP is the single path, adapters, adding a runner |
| [docs/dev-environment.md](docs/dev-environment.md) | Worktrees, ports, named services, launch.json |
| [docs/multi-agent.md](docs/multi-agent.md) | Parallel-agent norms + supervision caps |
| [docs/refactors/](docs/refactors/) | Multi-session plan format + progress logs |
| [docs/traps/](docs/traps/) | One doc per known footgun |
| [docs/recovery/](docs/recovery/) | Exact recovery steps (release, backup, pairing) |
| [docs/plans/](docs/plans/) | Design/measurement plans (examples for refactors) |

### Traps (one file each)

| Doc | Topic |
| --- | --- |
| [docs/traps/design-tokens.md](docs/traps/design-tokens.md) | Token source of truth vs hardcoded CSS |
| [docs/traps/worktrees.md](docs/traps/worktrees.md) | Install/build/data isolation in worktrees |
| [docs/traps/wal-checkpoint.md](docs/traps/wal-checkpoint.md) | Unsafe SQLite/WAL copies |
| [docs/traps/electron-screenshot.md](docs/traps/electron-screenshot.md) | Preview capture / Playwright screenshots |
| [docs/traps/blueprint-csp.md](docs/traps/blueprint-csp.md) | App CSP vs loose-file development |
| [docs/traps/manifest-regeneration.md](docs/traps/manifest-regeneration.md) | `manifest.json` / vendor rebuilds |

## Conventions agents should know

- **Conventional Commits + issue suffix.** Commit messages match `<type>(scope)?!?: subject (#123)` — a trailing GitHub issue reference is now mandatory. Enforced by [.governance/packs/governance-kit/commits/directives/commit-message-format/check.sh](.governance/packs/governance-kit/commits/directives/commit-message-format/check.sh). Merges and reverts are exempt.
- **One receipt per issue.** Substantive work touches `receipts/issue-<N>-<slug>.md`, with `## Checklist`, `## What changed`, `## Out of scope`, and `## Verification` sections. See [CONSTITUTION.md](CONSTITUTION.md#receipt-per-issue) for the contract.
- **Audit trailers on every commit.** The `.githooks/` dispatchers stamp `Agent` / `Token-*` / `Cost-*` / `Steer-*` trailers automatically and write rows to [COSTS.md](COSTS.md) and [STEERING.md](STEERING.md). Skipping with `SKIP_GOVERNANCE=1` is allowed for true emergencies; CI still enforces.
- **Quality observations live in [QUALITY.md](QUALITY.md).** Bugs and rough edges between releases go in `## Open`; resolved items roll to `## Resolved`.
- **Tests follow [TESTING.md](TESTING.md).** One runner (vitest), behaviour-over-implementation convention, per-layer coverage intent. `bun run test` (per-package via turbo) and `bun run coverage` (repo-wide v8, enforces the seeded engine floors). Read it before writing or migrating a test.
- **Pre-push PR gates (do not skip).** Governance hooks do **not** run format/lint/typecheck. Before every `git push` to a PR, agents **must** run `bun run check:pr` (or `bun run ci`) and fix failures locally. That script mirrors the **`static`** job in [`.github/workflows/ci.yml`](.github/workflows/ci.yml): `format:check`, `oxlint`, `lint:packages` (sherif — monorepo package.json hygiene), turbo `lint`, `typecheck` (includes test files), `lint:types`, `lint:css`, `test:matrix`. The `static` job additionally runs **actionlint** (pinned container, shellcheck gated at error severity) to lint the workflow YAML — that check is CI-only because it needs an external binary; run `bun run lint:actions` locally if you have actionlint installed. CI also runs a parallel **`verify`** job (build, native tunnel, data-plane, gateway perf, coverage) and a thin required **`check`** aggregator. Dead-code / unused-dependency scanning (**`knip`**) is now part of `check:pr` and the `static` job — it enforces unused files, unused/undeclared deps, unused exports/types (with `ignoreExportsUsedInFile`, so same-file-only `Props`/`Deps` interfaces don't count), and duplicate exports; only enum/class members stay excluded. Exports that are genuinely used but invisible to knip (dynamic import, script-level `cp`) are tagged `@public` or listed in `knip.json` with a reason. **Vitest green alone is not enough** — package typecheck catches TS errors that still execute under vitest. Pushing without `check:pr` wastes Actions minutes on fixable local gates.
- **Tools only via repo scripts (B2).** Invoke the toolchain through root/package `package.json` scripts (`bun run test`, `bun run typecheck`, `bun run format`, …). **Never** raw `npx <tool>` / ad-hoc global CLIs for format, lint, test, or typecheck — the pinned versions and flags must apply.
- **Canonical logs.** Start debugging at [docs/logs.md](docs/logs.md) (`gateway-logs/` under the gateway data dir / desktop `userData/gateways/<id>/`).
- **Issue intake.** New work starts from a GitHub issue using the [proposal](.github/ISSUE_TEMPLATE/proposal.yml) or [bug](.github/ISSUE_TEMPLATE/bug.yml) template. Blank issues are disabled by design.
- **Vocabulary.** Runtime model is **conversation ⊃ turn ⊃ item** — never "chat" for the ledger ([docs/glossary.md](docs/glossary.md)).

## Where to look

- [CONSTITUTION.md](CONSTITUTION.md) — the mechanical and judgmental rules.
- [ARCHITECTURE.md](ARCHITECTURE.md) — the gateway, the `conversation ⊃ turn ⊃ item` runtime model, full workspace layout, on-disk layout, and build orchestration.
- [README.md](README.md) — develop, build, test, and check commands.
- [TESTING.md](TESTING.md) — the testing strategy, runner, and test convention.
- [SECURITY.md](SECURITY.md) — vulnerability disclosure path + threat model.
- [docs/decisions.md](docs/decisions.md) — settled product/engineering decisions from #468.
- [docs/logs.md](docs/logs.md) — where logs live.

Governance hooks activate through git's `core.hooksPath` (pointed at `.githooks/`).
`governance install`/`update` set this; on a fresh clone run
`git config core.hooksPath .githooks` once.
