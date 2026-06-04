# Quality Tracker

## Open

- #212 — Testing strategy ([TESTING.md](TESTING.md)) is partially landed: vitest
  is the single runner (migrated off `node:test`/`tsx --test`, 653 tests
  unchanged), repo-wide v8 coverage is wired (`bun run coverage`), and the engine
  packages are gated on seeded line+branch floors enforced in CI. Still open:
  ratcheting the floors up, converting `assert.*` to vitest `expect` matchers,
  extracting desktop renderer logic into testable modules, and the thin e2e
  journeys (Playwright `_electron` + Maestro). These proceed behind new work.

## Resolved

- #210 — Made the oxlint profile intentional (correctness + suspicious + perf, explicit rules) instead of ultracite's maximal-then-suppressed set, added per-package type-aware linting (`oxlint --type-aware`) and brought all `*.test.ts` into both `tsc` typecheck and lint via per-package `tsconfig.test.json`. Fixed every surfaced finding (type-aware + 14 latent test type errors) and three file-relocation regressions the new coverage unmasked: the automation and app-engine handler-runners resolved the relocated worker at the wrong path (handlers couldn't execute), and agent-runtime's CLI smoke-test path + package `bin` pointed at the pre-move location.
- #180 — Removed dead `gatewayUrl` / `gatewayToken` / `appsDir` / `runtimeMode` / `remoteGateway*` fields from the settings `getSettings()` fallback object (leftovers from the retired local/remote form); only `chatModel` is read.
- #179 — Classified OpenClaw's concrete models into capability tiers (smart/balanced/fast) via a one-shot LLM prompt (`openclaw infer model run`), cached on disk keyed by the model-list hash, grouped the chat picker by tier, and wired the picker's Refresh button to force reclassification (`runner-status?refresh=1`).
- #178 — Wired per-runtime chat model enumeration: OpenClaw via `openclaw models list --json`, provider-agnostic capability tiers for claude-code (resolved to CLI aliases at turn time; codex stays on gateway default), surfaced through a new `RunnerStatus.models` field and read from the active gateway's runner-status in the picker.
- #176 — Removed two dead desktop Settings pages ("Where apps run" runtime page that rendered blank with a stale local/remote subtitle, and the unbuilt "Sync & backups" stub) and wired the chat model picker to the gateway's `/models` probe instead of a no-op empty list.
- #171 — Retired the crash-resume journal, dropped the `ctx.invoke` API surface, and consolidated `chat-runner-core` down beside the automation fire spine in one backend-agnostic engine: relocated the agent-turn contract to app-engine, renamed `@centraid/automation-engine` → `@centraid/conversation-engine`, and split its `src/` into `chat/` + `automation/`.
- #162 — Consolidated sibling packages: folded `@centraid/analytics` into app-engine's `insights/` sub-module and renamed `@centraid/automation` → `@centraid/automation-engine`.
