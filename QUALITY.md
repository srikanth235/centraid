# Quality Tracker

## Open

- #496 — **Test infrastructure assurance** (enforcement, signal, coverage).
  Parent backlog for ruleset on `main`, nightly auto-issue + Pages main-only
  guard, floors/`minimumTests` ratchet, `requireAssertions`, affected vitest in
  `check:pr`, product journey owners (chat/ENOSPC/restore/multi-writer), matrix
  honesty, Android home-loads, CI latency pins, and hygiene chip-away
  (`toHaveBeenCalled` / fixed sleeps). See [TESTING.md](TESTING.md) Nightly SLA
  + confidence map. Residual hygiene debt: ~500 `toHaveBeenCalled` sites and
  remaining fixed sleeps; continue per-file chip-away.
- #212 — Testing strategy ([TESTING.md](TESTING.md)) follow-up: the three
  per-layer workstreams (`assert.*` → `expect`, coverage-floor ratchet, desktop
  renderer logic-extraction) landed under #214; the **desktop Playwright e2e
  journeys** landed under #225 (nightly/on-demand). **Still open:** the Maestro
  mobile flows (iOS landed; Android home-loads under #496 PC1), and the remaining
  renderer extraction — `app.ts` (6,803 lines) still holds pure logic
  (appearance-prefs bridge, profile view-models, insights formatters) plus a
  near-duplicate `relativeTime` to consolidate.

## Resolved

- #225 — Rebuilt the desktop Playwright e2e suite for the post-#109/#137/#141
  gateway-store architecture (the old `delete-app` suite had silently broken —
  all 8 tests failed — when it kept seeding a `gatewayUrl` settings no longer
  persists). Broadened from 1 journey to **all 14 surface areas, 59 passing
  tests** with SSE streaming in the mock, and wired it into a nightly +
  on-demand workflow (`e2e.yml`) so it can't rot unnoticed again. Adding the
  Cloud → Database coverage surfaced + fixed a row-browser pagination bug
  (`renderRowBrowser` captured the page once, so Next re-fetched offset 0).
- #218 — Fixed the blank-frame flicker on sidebar navigation. The Home,
  Discover, and Settings renders cleared the DOM up front and then awaited IPC
  before painting, so the window sat empty for the round-trips. Split `clear()`
  into a `teardownCurrent()` (cleanup + stale-render-guard bump, no DOM wipe)
  plus the wipe; the three async renders now keep the prior view on screen and
  swap the freshly-built shell in atomically with `root.replaceChildren`.
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
