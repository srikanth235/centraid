# AGENTS.md

Read **[CONSTITUTION.md](CONSTITUTION.md)** and follow it. Its directives are enforced by hooks and CI, which name what to fix when they fail. Its principles are not — passing every gate does not make a change compliant, and defying a principle without explanation blocks the PR.

Centraid is a personal, local-first superapp: one shell wrapping many first-party apps over a sovereign vault. A host-agnostic gateway ([`packages/gateway`](packages/gateway)) serves desktop, web PWA, and Expo mobile; the bundled system apps live in [`packages/blueprints`](packages/blueprints) and visual identity in [`packages/design`](packages/design). Wiring, runtime model, and layout: [ARCHITECTURE.md](ARCHITECTURE.md). Stack: Bun + Turborepo + TypeScript; oxlint/oxfmt; vitest. Commands: [README.md](README.md).

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
- **Design system**: [docs/design-machinery.md](docs/design-machinery.md) · [docs/design-divergences.md](docs/design-divergences.md) (do-not-fix-quietly registers)
- **Engineering**: [docs/coding-standards.md](docs/coding-standards.md) · [docs/toolchain.md](docs/toolchain.md) · [docs/protocol.md](docs/protocol.md) · [docs/platform-gating.md](docs/platform-gating.md) · [docs/client-keying.md](docs/client-keying.md) · [docs/config-ownership.md](docs/config-ownership.md) · [docs/harnesses.md](docs/harnesses.md) · [docs/dev-environment.md](docs/dev-environment.md) · [docs/multi-agent.md](docs/multi-agent.md) · [docs/cron-timezone.md](docs/cron-timezone.md)
- **Product areas**: [docs/blueprint-seats.md](docs/blueprint-seats.md) · [docs/system-signals.md](docs/system-signals.md) · [docs/photos/](docs/photos/README.md) · [docs/recognition-automations.md](docs/recognition-automations.md) · [docs/mobile-offline.md](docs/mobile-offline.md) · [docs/oauth-assist.md](docs/oauth-assist.md)
- **Release + ops**: [docs/release.md](docs/release.md) · [docs/release/oauth-assist-google.md](docs/release/oauth-assist-google.md) · [docs/identifiers.md](docs/identifiers.md) · [docs/enrollment.md](docs/enrollment.md) · [docs/logs.md](docs/logs.md) (**start every debug session here**) · [docs/recovery/](docs/recovery/)
- **Footguns**: [docs/traps/](docs/traps/README.md) — read the matching trap before working near its area

## Conventions

- **Never weaken policy to go green.** Fix the code, not the lint config, test, budget, or allowlist. Tools run only via repo scripts (`bun run test|typecheck|format|…`); the gate loop is in [docs/dev-environment.md](docs/dev-environment.md#the-local-gate-loop). Vitest green alone is not enough — run the package typecheck.
- **One receipt per issue** in `receipts/issue-<N>-<slug>.md`; new work starts from a GitHub proposal or bug issue; quality observations go in [QUALITY.md](QUALITY.md).
- **Umbrella issues are worked by orchestration.** The root agent is the central brain: it designs the plan, spawns sub-agents on well-scoped slices, and coordinates their results. Plain job dispatch is not enough — correctness lives in the plan's intricacies (ordering, shared files, cross-slice invariants), and only the root agent holds them. Norms and supervision caps: [docs/multi-agent.md](docs/multi-agent.md).
- **Vocabulary**: the runtime model is **conversation ⊃ turn ⊃ item** — never "chat" for the ledger.

On a fresh clone, run `git config core.hooksPath .githooks` once.
