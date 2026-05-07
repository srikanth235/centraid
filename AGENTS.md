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

<!-- TODO(@you): Replace this placeholder. Describe what the repo does, the top-level layout (apps/, packages/), and the runtime stack (bun, turbo). The required-docs directive enforces 30-250 lines and ≥ 3 internal doc links here. -->

## Where work lives

- Open quality issues: [QUALITY.md](QUALITY.md)
- Token-spend ledger: [COSTS.md](COSTS.md)
- Human-steering ledger: [STEERING.md](STEERING.md)

## How to run governance locally

```sh
bash .governance/run.sh
```

The pre-commit hook runs the same checks before each commit. Use `SKIP_GOVERNANCE=1 git commit ...` only for emergency hotfixes — CI will re-enforce the directive.
