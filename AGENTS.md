# AGENTS.md

Read **[CONSTITUTION.md](CONSTITUTION.md)** and follow it. Its directives are enforced by hooks and CI, which name what to fix when they fail. Its principles are not — passing every gate does not make a change compliant, and defying a principle without explanation blocks the PR.

Centraid is a personal, local-first superapp: one shell wrapping many first-party apps over a sovereign vault. **The phone is the vault** ([#1029](https://github.com/srikanth235/centraid/issues/1029), [scope amendment 2026-09-21](https://github.com/srikanth235/centraid/issues/1029#issuecomment-5755559795)): the Rust core on the phone is the vault's sole authority and writer, and the member's own laptop runs `centraid-gateway` as a blind store for its sealed backup. A Rust workspace ([`crates/`](crates)) holds the identity model, the vault and its backup plane, the ontology, the gateway protocol and its one deployment, the byte plane, the first-party apps ([`crates/apps`](crates/apps)) and the operator's `centraid` binary. The only shell is mobile: Kotlin Multiplatform with SwiftUI and Compose views ([`mobile/`](mobile)), linking the core through [`crates/core-ffi`](crates/core-ffi). There is no desktop shell, no browser extension and no hosted tier in v0. Shared contracts and fixtures live in [`contracts/`](contracts) and visual identity in [`packages/design`](packages/design). Wiring and layout: [ARCHITECTURE.md](ARCHITECTURE.md); the gateway protocol: [docs/gateway.md](docs/gateway.md). Stack: Rust (cargo), Kotlin/Gradle and Swift/XcodeGen, and Bun + TypeScript for `packages/design`, `packages/test-kit` and repo tooling; oxlint/oxfmt; vitest. The gate is `cargo xtask gate --profile <local|pr|nightly|release|mobile-jvm>` ([crates/xtask](crates/xtask/README.md)). Commands: [README.md](README.md).

## Docs

Docs describe **current state** — cite history by issue link, never by narration; current decisions, deliberate non-goals, and supersession markers are state. Code-level facts live in code comments next to the invariant. When you learn something that outlives the task, update the matching doc in the same PR — stale docs are bugs, same as broken links.

The durable layers, and what belongs where:

- **State** — `docs/`, the root docs: freely revised, always current.
- **Decisions** — [docs/decisions.md](docs/decisions.md): dated rulings + supersession chains over the evidence.
- **Evidence** — receipts, CHANGELOG, ledgers: append-only; never copied into state docs.
- **Intent** — proposal issues, not files: plans, checklists, open questions.

Skim the relevant docs before non-trivial work:

- **Core**: [ARCHITECTURE.md](ARCHITECTURE.md) · [README.md](README.md) · [CONTRIBUTING.md](CONTRIBUTING.md) · [TESTING.md](TESTING.md) · [SECURITY.md](SECURITY.md) · [CHANGELOG.md](CHANGELOG.md) · [DESIGN.md](DESIGN.md) (binding design rulebook)
- **Decisions + vocabulary**: [docs/decisions.md](docs/decisions.md) (current decisions, non-goals, supersessions) · [docs/glossary.md](docs/glossary.md)
- **The model**: [docs/vault-ontology.md](docs/vault-ontology.md) (the vault ontology's state, enforced commitments, drift register) · the published design at [centraid.dev/docs/ontology](https://centraid.dev/docs/ontology/)
- **Design system**: [docs/design-machinery.md](docs/design-machinery.md) (includes the public-site and test-report registers)
- **Engineering**: [docs/coding-standards.md](docs/coding-standards.md) · [docs/toolchain.md](docs/toolchain.md) · [docs/protocol.md](docs/protocol.md) · [docs/config-ownership.md](docs/config-ownership.md) · [docs/harnesses.md](docs/harnesses.md) · [docs/dev-environment.md](docs/dev-environment.md) · [docs/multi-agent.md](docs/multi-agent.md)
- **Product areas**: [docs/blueprint-seats.md](docs/blueprint-seats.md) · [docs/system-signals.md](docs/system-signals.md) · [docs/photos/](docs/photos/README.md) · [docs/recognition-automations.md](docs/recognition-automations.md) · [docs/mobile-offline.md](docs/mobile-offline.md) · [docs/gateway.md](docs/gateway.md)
- **Release + ops**: [docs/release.md](docs/release.md) · [docs/release/v1-handoffs.md](docs/release/v1-handoffs.md) (every v1 hand-off and open owner question, with its command and its destination) · [docs/identifiers.md](docs/identifiers.md) · [docs/enrollment.md](docs/enrollment.md) · [docs/external-review-scope.md](docs/external-review-scope.md) · [docs/logs.md](docs/logs.md) (**start every debug session here**) · [docs/recovery/](docs/recovery/)
- **Footguns**: [docs/traps/](docs/traps/README.md) — read the matching trap before working near its area

## Conventions

- **Never weaken policy to go green.** Fix the code, not the lint config, test, budget, or allowlist. Tools run only via repo entrypoints (`cargo xtask gate`, `bun run format|typecheck|…`); the gate loop is in [docs/dev-environment.md](docs/dev-environment.md#the-local-gate-loop). One crate's `cargo test` or one package's vitest green alone is not enough — run the gate profile, and for TypeScript the package typecheck.
- **One receipt per issue** in `receipts/issue-<N>-<slug>.md`; new work starts from a GitHub proposal or bug issue; quality observations go in [QUALITY.md](QUALITY.md).
- **Umbrella issues are worked by orchestration.** The root agent is the central brain: it designs the plan, spawns sub-agents on well-scoped slices, and coordinates their results. Plain job dispatch is not enough — correctness lives in the plan's intricacies (ordering, shared files, cross-slice invariants), and only the root agent holds them. One umbrella issue, no child issues — slices are sub-agents and PR waves under it, one receipt. Slices are grouped into lanes by reading set, briefs carry the reading set and a doctrine digest, a standalone verifier runs only for red-first slices, and the doc pass is per umbrella at close. Norms and supervision caps: [docs/multi-agent.md](docs/multi-agent.md).
- **A citation is not a justification.** In a review, every "deliberate", "by design" or `#NNN`-ruled seam is re-judged on its merits for the product as it is now — the ruling explains why it was chosen, not whether it should stay. An item you would keep gets an explicit question to the owner, with the options and a recommendation, never a silent "deliberate" row in a register; an item that survives only because someone ruled it, with no consumer or security property depending on it, is a finding. The wave under [#916](https://github.com/srikanth235/centraid/issues/916) filed polymorphic references, the favorite mirror and the consent plane as settled on exactly this deference and had to reopen all three. Mechanical sweeps (every CHECK value against its writers, every FK's delete rule against its siblings, every table's timestamps) and an adversarial run against the real gateway are part of a model review, not optional extras — reading alone found none of the reproduced purge and merge bugs.
- **Vocabulary**: **the phone is the vault** and the laptop is a _gateway_, never a server or a host. A _drain_ is a pass that uploads the spool; a _generation_ is a base plus its segments. The conversation/turn/item ledger is **gone** — its tables were dropped in rung five (#1029 W19) and nothing writes it.

On a fresh clone, run `git config core.hooksPath .githooks` once.
