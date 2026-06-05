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

Centraid is a personal app builder. Its backend is a host-agnostic **gateway** ([`packages/gateway`](packages/gateway)) that wires the app engine ([`packages/app-engine`](packages/app-engine)), the agent runtime ([`packages/agent-runtime`](packages/agent-runtime)), the automation engine ([`packages/automation`](packages/automation)), the SQLite stores, and the chat/automation runners together. The same gateway runs embedded in the Electron desktop ([`apps/desktop`](apps/desktop)), as the standalone `centraid-gateway` daemon, and as an OpenClaw plugin ([`packages/openclaw-plugin`](packages/openclaw-plugin)). The desktop renderer is a thin HTTP client; the Expo mobile app ([`apps/mobile`](apps/mobile)) connects to a gateway over HTTP. App scaffolding + templates live in [`packages/blueprints`](packages/blueprints) and agent grounding in [`packages/skills`](packages/skills); both apps share visual identity through [`packages/design-tokens`](packages/design-tokens) and per-runtime TypeScript settings through [`packages/tsconfig`](packages/tsconfig). The full layout, runtime model, on-disk layout, and build orchestration live in [ARCHITECTURE.md](ARCHITECTURE.md).

The runtime stack is [Bun](https://bun.sh) (package manager, pinned in `packageManager`), [Turborepo](https://turbo.build) (task graph), and TypeScript. Linting and formatting are [oxlint](https://oxc.rs) and [oxfmt](https://github.com/oxc-project/oxfmt); tests run on [vitest](https://vitest.dev). See [README.md](README.md) for the develop / build / test / check commands.

## Conventions agents should know

- **Conventional Commits + issue suffix.** Commit messages match `<type>(scope)?!?: subject (#123)` — a trailing GitHub issue reference is now mandatory. Enforced by [.governance/packs/governance-kit/core/directives/commit-message-format/check.sh](.governance/packs/governance-kit/core/directives/commit-message-format/check.sh). Merges and reverts are exempt.
- **One receipt per issue.** Substantive work touches `receipts/issue-<N>-<slug>.md`, with `## Checklist`, `## What changed`, `## Out of scope`, and `## Verification` sections. See [CONSTITUTION.md](CONSTITUTION.md#receipt-per-issue) for the contract.
- **Audit trailers on every commit.** The `.githooks/` dispatchers stamp `Agent` / `Token-*` / `Cost-*` / `Steer-*` trailers automatically and write rows to [COSTS.md](COSTS.md) and [STEERING.md](STEERING.md). Skipping with `SKIP_GOVERNANCE=1` is allowed for true emergencies; CI still enforces.
- **Quality observations live in [QUALITY.md](QUALITY.md).** Bugs and rough edges between releases go in `## Open`; resolved items roll to `## Resolved`.
- **Tests follow [TESTING.md](TESTING.md).** One runner (vitest), behaviour-over-implementation convention, per-layer coverage intent. `bun run test` (per-package via turbo) and `bun run coverage` (repo-wide v8, enforces the seeded engine floors). Read it before writing or migrating a test.
- **Issue intake.** New work starts from a GitHub issue using the [proposal](.github/ISSUE_TEMPLATE/proposal.yml) or [bug](.github/ISSUE_TEMPLATE/bug.yml) template. Blank issues are disabled by design.

## Where to look

- [CONSTITUTION.md](CONSTITUTION.md) — the mechanical and judgmental rules.
- [ARCHITECTURE.md](ARCHITECTURE.md) — the gateway, the `conversation ⊃ turn ⊃ item` runtime model, full workspace layout, on-disk layout, and build orchestration.
- [README.md](README.md) — develop, build, test, and check commands.
- [TESTING.md](TESTING.md) — the testing strategy, runner, and test convention.
- [SECURITY.md](SECURITY.md) — vulnerability disclosure path.
- [scripts/enable-governance.sh](scripts/enable-governance.sh) — run once per fresh clone to activate the governance hooks.
