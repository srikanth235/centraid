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

- **Issue first, then receipt.** Substantive work starts as a GitHub issue using the `proposal.yml` form (Context / Decision / Scope / Acceptance criteria / Validation / Open questions). The implementing commit lands a `receipts/issue-<N>.md` file with `## Checklist`, `## What changed`, `## Out of scope`, and `## Verification` — each `[x]` checklist item must appear (case-insensitive substring) in *What changed* or *Verification*. The directives `receipt-per-issue` and `commit-issue-receipt-match` enforce this.
- **Conventional Commits + issue ref.** Commit messages match `<type>(scope)?!?: subject (#N)`. The `commit-message-format` directive enforces this and merge / revert commits are exempt.
- **Token + steering trailers are auto-stamped.** The `agent-token-accounting` and `agent-steering-accounting` hooks read your active session JSONL and stamp `Token-Input/Output/Total/Cost-USD` and `Steer-Count/Types/Tiers` trailers, plus a matching row in [COSTS.md](COSTS.md) and (when steering events exist) in [STEERING.md](STEERING.md). Don't hand-write these trailers.
- **Open quality issues go in [QUALITY.md](QUALITY.md).** Use `## Open` / `## Resolved`. Bug or proposal issues on GitHub use the forms in `.github/ISSUE_TEMPLATE/`.

## Where work lives

- Open quality issues: [QUALITY.md](QUALITY.md)
- Token-spend ledger: [COSTS.md](COSTS.md)
- Human-steering ledger: [STEERING.md](STEERING.md)

## How to run governance locally

```sh
bash .governance/run.sh
```

The pre-commit hook runs the same checks before each commit. Use `SKIP_GOVERNANCE=1 git commit ...` only for emergency hotfixes — CI will re-enforce the directive.
