# Quality Tracker

## Open

- #212 — Testing strategy ([TESTING.md](TESTING.md)) follow-up: the three
  per-layer workstreams (`assert.*` → `expect`, coverage-floor ratchet, desktop
  renderer logic-extraction) landed under #214. **Still open:** the thin e2e
  journeys (Playwright `_electron` + Maestro, deferred to nightly/on-demand by
  #212), and the remaining renderer extraction — `app.ts` (6,803 lines) still
  holds pure logic (appearance-prefs bridge, profile view-models, insights
  formatters) plus a near-duplicate `relativeTime` to consolidate.

## Resolved

- #214 — Carried out #212's three deferred per-layer workstreams: converted all
  1,740 `assert.*` calls across the 80 test files to vitest `expect` matchers
  (AST codemod + by-hand conversion of the validator-function forms); extracted
  the first tranche of pure logic out of the `builder.ts` renderer god-file into
  tested `format.ts`/`cron.ts`/`diff.ts` modules and moved the desktop vitest
  project to `jsdom` (12 → 71 desktop tests); grew `agent-runtime` line coverage
  20.8% → 28.6% with real-dependency tests for the codex tool dispatch, tool
  normalization, and model enumeration, then ratcheted every engine floor up
  toward the 80% line / 70% branch target band.

- #210 — Made the oxlint profile intentional (correctness + suspicious + perf, explicit rules) instead of ultracite's maximal-then-suppressed set, added per-package type-aware linting (`oxlint --type-aware`) and brought all `*.test.ts` into both `tsc` typecheck and lint via per-package `tsconfig.test.json`. Fixed every surfaced finding (type-aware + 14 latent test type errors) and three file-relocation regressions the new coverage unmasked: the automation and app-engine handler-runners resolved the relocated worker at the wrong path (handlers couldn't execute), and agent-runtime's CLI smoke-test path + package `bin` pointed at the pre-move location.
- #180 — Removed dead `gatewayUrl` / `gatewayToken` / `appsDir` / `runtimeMode` / `remoteGateway*` fields from the settings `getSettings()` fallback object (leftovers from the retired local/remote form); only `chatModel` is read.
- #179 — Classified OpenClaw's concrete models into capability tiers (smart/balanced/fast) via a one-shot LLM prompt (`openclaw infer model run`), cached on disk keyed by the model-list hash, grouped the chat picker by tier, and wired the picker's Refresh button to force reclassification (`runner-status?refresh=1`).
- #178 — Wired per-runtime chat model enumeration: OpenClaw via `openclaw models list --json`, provider-agnostic capability tiers for claude-code (resolved to CLI aliases at turn time; codex stays on gateway default), surfaced through a new `RunnerStatus.models` field and read from the active gateway's runner-status in the picker.
- #176 — Removed two dead desktop Settings pages ("Where apps run" runtime page that rendered blank with a stale local/remote subtitle, and the unbuilt "Sync & backups" stub) and wired the chat model picker to the gateway's `/models` probe instead of a no-op empty list.
- #171 — Retired the crash-resume journal, dropped the `ctx.invoke` API surface, and consolidated `chat-runner-core` down beside the automation fire spine in one backend-agnostic engine: relocated the agent-turn contract to app-engine, renamed `@centraid/automation-engine` → `@centraid/conversation-engine`, and split its `src/` into `chat/` + `automation/`.
- #162 — Consolidated sibling packages: folded `@centraid/analytics` into app-engine's `insights/` sub-module and renamed `@centraid/automation` → `@centraid/automation-engine`.
