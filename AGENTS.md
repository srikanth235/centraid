# AGENTS.md

Map of the durable docs an agent (or human) should read before working in this repo. Start at the constitution; everything else is a pointer.

<!-- governance: rules-to-follow -->
## Rules to follow

If you are an agent — or a human — working in this repo, **read [CONSTITUTION.md](CONSTITUTION.md) and follow it**. It defines the principles, guidelines, and directives that every change in this repo must satisfy.

- The mechanical directives are enforced by `.governance/run.sh` (run via the pre-commit hook locally and the [governance.yml](.github/workflows/governance.yml) workflow in CI).
- The principles and guidelines cannot be mechanically checked — you are expected to read them and apply judgment. A change that defies a principle without explanation will block the PR.

See the **Compliance** section of [CONSTITUTION.md](CONSTITUTION.md) for the full directive, including how to document approved deviations.
<!-- /governance: rules-to-follow -->

## What this repo is

Centraid is a personal app builder shipped as two surfaces — an Electron desktop app under [`apps/desktop`](apps/desktop) and an Expo mobile app under [`apps/mobile`](apps/mobile). Both surfaces share visual identity through [`packages/design-tokens`](packages/design-tokens) and per-runtime TypeScript settings through [`packages/tsconfig`](packages/tsconfig). The full layout, build orchestration, and design-token sharing model live in [ARCHITECTURE.md](ARCHITECTURE.md).

The runtime stack is [Bun](https://bun.sh) (package manager + runtime, pinned in `packageManager`), [Turborepo](https://turbo.build) (task graph), and TypeScript. Linting and formatting are [oxlint](https://oxc.rs) and [oxfmt](https://github.com/oxc-project/oxfmt). See [README.md](README.md) for the develop / build / check commands.

## Conventions agents should know

- **Conventional Commits + issue suffix.** Commit messages match `<type>(scope)?!?: subject (#123)` — a trailing GitHub issue reference is now mandatory. Enforced by [.governance/packs/governance-kit/core/directives/commit-message-format/check.sh](.governance/packs/governance-kit/core/directives/commit-message-format/check.sh). Merges and reverts are exempt.
- **One receipt per issue.** Substantive work touches `receipts/issue-<N>-<slug>.md`, with `## Checklist`, `## What changed`, `## Out of scope`, and `## Verification` sections. See [CONSTITUTION.md](CONSTITUTION.md#receipt-per-issue) for the contract.
- **Audit trailers on every commit.** The `.githooks/` dispatchers stamp `Agent` / `Token-*` / `Cost-*` / `Steer-*` trailers automatically and write rows to [COSTS.md](COSTS.md) and [STEERING.md](STEERING.md). Skipping with `SKIP_GOVERNANCE=1` is allowed for true emergencies; CI still enforces.
- **Quality observations live in [QUALITY.md](QUALITY.md).** Bugs and rough edges between releases go in `## Open`; resolved items roll to `## Resolved`.
- **Issue intake.** New work starts from a GitHub issue using the [proposal](.github/ISSUE_TEMPLATE/proposal.yml) or [bug](.github/ISSUE_TEMPLATE/bug.yml) template. Blank issues are disabled by design.

## Where to look

- [CONSTITUTION.md](CONSTITUTION.md) — the mechanical and judgmental rules.
- [ARCHITECTURE.md](ARCHITECTURE.md) — full layout and design-token sharing model.
- [README.md](README.md) — develop, build, and check commands.
- [SECURITY.md](SECURITY.md) — vulnerability disclosure path.
- [scripts/setup-clone.sh](scripts/setup-clone.sh) — run once per fresh clone to activate the governance hooks.
