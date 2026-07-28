# issue-567 — Unified ACP router

GitHub issue: [#567](https://github.com/srikanth235/centraid/issues/567)

<!-- governance: allow-receipt-per-issue remove the exact generated fixture set introduced by accidental local test commit 9eb2d35b; those paths are absent from the PR net diff -->

## Checklist

- [x] Five child issues filed (one per phase) linking back here, each with its own receipt; this issue holds the crosswalk — superseded by the owner's explicit instruction to delete the child issues and deliver all five phases in this one #567 PR and receipt
- [x] Phase ordering respected: 0 → 1 → 2 land before any schema change; 3 before 4 — approved process deviation: the owner required one atomic umbrella PR, so the dependency order was followed during implementation but cannot land as separate phase commits/PRs
- [x] Every settled decision D1–D13 is either implemented as stated or has a PR note explaining the approved deviation (constitution compliance path)
- [x] `docs/runners.md` updated in the same PRs that invalidate it (fork-per-runner language, "not product features" list, config-pin section)
- [x] No routing/failover behavior ships without its transcript `notice`; no accounting field is stamped from requested (unconfirmed) configuration
- [x] `bun run check:pr` green per PR; ratchet floors respected; new modules covered per TESTING.md — authoritative GitHub Actions CI run 30299535485 passed

## What changed

The five implementation phases were completed in their required dependency
order on one branch: capability truth and the fake-agent rig; semantic config,
context, and accounting; breakers/ladders/fire-boundary failover; durable
multi-runner bindings, hydration, locking, consent, and self-heal; then
workspace/artifact/shared-composer/mobile surfaces.

### Issue acceptance crosswalk

- **Five child issues filed (one per phase) linking back here, each with its own receipt; this issue holds the crosswalk — superseded by the owner's explicit instruction to delete the child issues and deliver all five phases in this one #567 PR and receipt.** The accidentally created child issues were deleted; this receipt holds the full five-phase crosswalk.
- **Phase ordering respected: 0 → 1 → 2 land before any schema change; 3 before 4 — approved process deviation: the owner required one atomic umbrella PR, so the dependency order was followed during implementation but cannot land as separate phase commits/PRs.** Implementation and verification followed the dependency order, but the five phases intentionally land atomically in this umbrella PR.
- **Every settled decision D1–D13 is either implemented as stated or has a PR note explaining the approved deviation (constitution compliance path).** D1–D13 are implemented; the only approved deviation is PR/issue consolidation, which is not a technical decision.
- **`docs/runners.md` updated in the same PRs that invalidate it (fork-per-runner language, "not product features" list, config-pin section).** The document now describes category-keyed pins, per-runner bindings, never-retry-inside-turn boundaries, breaker classes, ladder consent, workspace selection, and artifacts.
- **No routing/failover behavior ships without its transcript `notice`; no accounting field is stamped from requested (unconfirmed) configuration.** Interactive switches emit normalized notices; automation fire and compile fallbacks write durable attempt notes/notice steps; model and effort are recorded only after ACP confirmation.
- **`bun run check:pr` green per PR; ratchet floors respected; new modules covered per TESTING.md.** Verification used the stricter dependent-aware `bun run check:pr:full`, and the authoritative GitHub Actions CI run passed.

### D1–D13 resolution

| Decision | Implemented result |
| --- | --- |
| D1 | `conversation_harness_sessions` stores N runner bindings and per-runner watermarks under one stable conversation id; automation runner suffixes are retired. The selected handle is `active`, at most one prior process is `warm`, older valid handles remain resumable as `cold`, and only invalid/superseded handles are `stale`. |
| D2 | `configPins` is category-keyed; model pins precede `thought_level`, dynamic config updates are re-read, and manifest → subsystem → runner → backend precedence is shared across surfaces. |
| D3 | Refresh persists and surfaces the full optional capability snapshot. The checked-in 17-kind diagnostics command records honest unavailable/auth-required rows instead of assuming parity. |
| D4 | Ledger rows receive only ACP-confirmed model/effort; hydration is an explicit marker with estimated tokens and is included in Insights/accounting projections. |
| D5 | Conversation×provider grants gate attended cross-provider handoff; archive-aware hydration excludes custody-pruned turns; ladder-derived grants are separate from direct grants. |
| D6 | Hydration is token-budgeted with a complete-turn floor, truncates oversized retained text to stay bounded, summarizes calls, omits tool output, and labels prior-agent context. |
| D7 | A prompt is never replayed inside a turn. Persistent class-specific breakers select before send; automation fires and compiles advance only at their outer boundary into distinct ledger turns, clear provider-specific pins, and write durable `notice:*` steps. |
| D8 | The durable conversation turn lock is the single writer; turn commit, binding selection, and watermark advancement share the transaction; only one prior process remains warm while older valid runner handles remain cold and resumable. |
| D9 | A target failure never replaces the previous active binding. Warm or cold resume/load failure starts a fresh session, hydrates from the full live ledger including sequence zero, and emits a self-heal notice. |
| D10 | Workspace selection persists as `vault-data`, `app`, or `draft`; additional directories are canonical, absolute, non-root, directory-only, deduplicated, capability-gated consent records. |
| D11 | Tool locations become `source=agent` path+SHA-256 references without a CAS copy; homeless terminal/content output becomes CAS-backed transcript artifacts and still renders inline. |
| D12 | Assistant, Builder, and Automation Q&A consume `ChatComposer` and `SessionStatusStrip`; answers-only run screens stay input-free; mobile uses native runner/model/effort/context/attachment/stop/consent controls; shared glyphs live in design tokens. |
| D13 | Ladders are owner-authored and never auto-populated; membership auto-grants unattended use with source `ladder` plus its authorizing subsystem; removal revokes only that subsystem's forward grants across mounted vaults without touching direct grants or another ladder. |

### Post-review fixes (2026-07-28)

A four-area review of the umbrella PR (agent-runtime ACP core, app-engine
bindings/hydration, gateway/automation failover, client/mobile surfaces)
surfaced two blockers and a set of majors/minors; all were fixed in this
branch in one follow-up round:

- **Per-rung continuity (blocker).** Resume and hydration are now planned per
  ladder rung via `ConversationTurnInput.resumeForKind`: a failover rung
  resumes its own binding and hydrates against its own watermark (full-ledger
  handoff when it has none), instead of inheriting the primary's empty plan —
  a breaker-skipped primary no longer silently strips the fallback of all
  conversation history. Hydration tokens are billed to the rung that ran.
- **Enforced unattended consent (blocker).** `ProviderEgressConsentStore`
  splits attended `grant()` from unattended `recordDerived()`, which never
  resurrects a revoked provider (`revoke()` now writes a durable direct
  tombstone) and re-checks live ladder membership. Automation fire/compile
  deny with a typed, user-actionable failure instead of minting consent;
  a manifest-pinned runner outside the user's prefs/ladder cannot
  self-authorize. Ladder removal still re-authorizes on re-add (D13).
- **Failover honesty.** Fire ladders consult breakers before running the
  handler (no duplicated pre-`ctx.agent` side effects on a condemned rung);
  turn-finalization failure no longer flips a successful outcome or strands
  the turn in-flight; the interactive consent gate keeps the user's message
  durable instead of deleting the turn; compile failover notices use the
  machine-keyed `notice:warn:failover`; the `agent-failover` health component
  recovers on the next successful turn, which also closes auth breakers.
- **Accounting/config truth.** `config_option_update` replaces the option set
  wholesale (the invented singular shape is gone) and re-derives the
  confirmed model/effort mid-turn; a successful pin RPC counts as confirmation
  (contradicting echoes stay unconfirmed); effort-only usage events are no
  longer booked; capability snapshots carry a 24 h staleness flag; capability
  probes send a live prompt only on the explicit Settings-refresh path, and
  session-ready preflight serves the warm cache instead of burning a provider
  turn; failure classification prefers RPC codes and stages over stderr
  keywords; teardown escalates SIGTERM → SIGKILL.
- **Ledger/watermark correctness.** Failed turns no longer advance the
  hydration watermark; the empty-watermark sentinel is `-1` everywhere; the
  hydration tool line understands the real chat-path payload shape (`state`)
  and its test drives the real producer; each mandatory hydrated turn retains
  real content; dead resume handles are marked stale after a failed recovery;
  workspace artifacts stat-then-read under the shared 25 MiB cap and surface
  drops as durable notices.
- **Client/mobile.** Provider consent accumulates across prompts
  (`providerConsent: string | string[]` end to end); a rejected runner switch
  re-enables the pickers; consent flows use the shell confirm dialog and are
  covered by real tests on two surfaces (approve resends with the same
  idempotency key and `appendUser:false`; decline sends nothing); mobile
  selection is a native option sheet (ActionSheetIOS / RN Modal) instead of
  tap-to-cycle chips, with dismiss-as-decline consent and a synchronous send
  guard; ladder adds require `sessionReady` and the row shows the full stored
  ladder; assistant hints include breaker health; workspace selects hide when
  single-option and share humanized labels; scoped-folder input validates
  absolute paths; live artifact chips carry the content hash; stale comments
  fixed.

### Package-level changes

- ACP runtime: bounded lifecycle/watchdog behavior, classified failures, safe
  capability diagnostics, semantic config, confirmed effort/context/usage,
  terminal/content/location normalization, resume repair, and one warm process.
- App engine: durable binding/lock/workspace/egress/health tables; token-bounded
  hydration; active/warm/cold/stale binding lifecycle; atomic per-runner
  watermarks; artifact persistence; effort Insights.
- Automation/gateway: ordered selection across every conversational surface;
  separate-run fire and compile failover with durable transcript notices;
  health/OS-monitor alert seam; revocation, preflight, and stable automation-ref
  history.
- Web/mobile clients: capability-driven runner/model/effort/context/workspace/
  attachment controls, shared web composer/strip, native mobile equivalents,
  health/ladder Settings, inline terminal output, and artifact chips.

### Changed files

```text
ARCHITECTURE.md
CHANGELOG.md
apps/desktop/tests/e2e/appview-templates-insights.spec.ts
apps/desktop/tests/e2e/fixtures.ts
apps/mobile/src/apps/assistant/Assistant.styles.ts
apps/mobile/src/apps/assistant/Assistant.tsx
apps/mobile/src/apps/assistant/useAssistant.test.ts
apps/mobile/src/apps/assistant/useAssistant.ts
apps/mobile/src/apps/insights/Insights.tsx
apps/mobile/src/lib/assistant.test.ts
apps/mobile/src/lib/assistant.ts
apps/mobile/src/lib/insights.ts
docs/runners.md
packages/agent-runtime/package.json
packages/agent-runtime/scripts/live-adapter-smoke.ts
packages/agent-runtime/scripts/probe-all-adapters.ts
packages/agent-runtime/src/automation/live-automation-failover.test.ts
packages/agent-runtime/src/automation/run-automation-dispatch.test.ts
packages/agent-runtime/src/automation/run-automation-live-dispatch.ts
packages/agent-runtime/src/automation/run-automation.test.ts
packages/agent-runtime/src/automation/run-automation.ts
packages/agent-runtime/src/backends/acp/agent-errors.test.ts
packages/agent-runtime/src/backends/acp/agent-errors.ts
packages/agent-runtime/src/backends/acp/backend.attachments.test.ts
packages/agent-runtime/src/backends/acp/backend.test.ts
packages/agent-runtime/src/backends/acp/backend.ts
packages/agent-runtime/src/backends/acp/capabilities-cache.test.ts
packages/agent-runtime/src/backends/acp/capabilities-cache.ts
packages/agent-runtime/src/backends/acp/fake-acp-agent.mjs
packages/agent-runtime/src/backends/acp/probe-capabilities.ts
packages/agent-runtime/src/backends/acp/session-config.test.ts
packages/agent-runtime/src/backends/acp/session-config.ts
packages/agent-runtime/src/backends/acp/session-warm.test.ts
packages/agent-runtime/src/backends/acp/session-warm.ts
packages/agent-runtime/src/backends/acp/stream-events.test.ts
packages/agent-runtime/src/backends/acp/stream-events.ts
packages/agent-runtime/src/backends/acp/test-fixtures.ts
packages/agent-runtime/src/backends/acp/types.ts
packages/agent-runtime/src/backends/acp/usage.test.ts
packages/agent-runtime/src/backends/acp/usage.ts
packages/agent-runtime/src/preflight.test.ts
packages/agent-runtime/src/preflight.ts
packages/agent-runtime/src/registry.ts
packages/app-engine/src/conversation/archive/digest-parity.test.ts
packages/app-engine/src/conversation/archive/segment.test.ts
packages/app-engine/src/conversation/archive/segment.ts
packages/app-engine/src/conversation/archive/test-fixtures.ts
packages/app-engine/src/conversation/history.test.ts
packages/app-engine/src/conversation/history.ts
packages/app-engine/src/conversation/hydration.test.ts
packages/app-engine/src/conversation/hydration.ts
packages/app-engine/src/conversation/provider-egress-consent.test.ts
packages/app-engine/src/conversation/provider-egress-consent.ts
packages/app-engine/src/conversation/run-summary-sink.ts
packages/app-engine/src/conversation/runner-core.test.ts
packages/app-engine/src/conversation/runner-core.ts
packages/app-engine/src/conversation/runner-health.test.ts
packages/app-engine/src/conversation/runner-health.ts
packages/app-engine/src/conversation/runner.ts
packages/app-engine/src/conversation/schema.ts
packages/app-engine/src/conversation/store-sql.test.ts
packages/app-engine/src/conversation/store-sql.ts
packages/app-engine/src/conversation/store.test.ts
packages/app-engine/src/conversation/store.ts
packages/app-engine/src/conversation/turn.ts
packages/app-engine/src/http/turn-replay.ts
packages/app-engine/src/http/turn-routes.ts
packages/app-engine/src/http/turn-sse-support.test.ts
packages/app-engine/src/http/turn-sse-support.ts
packages/app-engine/src/http/turn-sse.test.ts
packages/app-engine/src/http/turn-sse.ts
packages/app-engine/src/index.ts
packages/app-engine/src/insights/analytics-store.test.ts
packages/app-engine/src/insights/analytics-store.ts
packages/app-engine/src/insights/insights-sql.ts
packages/app-engine/src/insights/insights-store.test.ts
packages/app-engine/src/insights/insights-store.ts
packages/app-engine/src/insights/insights-types.ts
packages/app-engine/src/runtime.ts
packages/app-engine/src/stores/gateway-db.test.ts
packages/app-engine/src/stores/gateway-db.ts
packages/app-engine/src/stores/prefs-store.test.ts
packages/app-engine/src/stores/prefs-store.ts
packages/automation/src/fire/fire.test.ts
packages/automation/src/fire/fire.ts
packages/automation/src/handler/runner.ts
packages/automation/src/manifest/manifest.test.ts
packages/automation/src/manifest/manifest.ts
packages/blueprints/kit/turn-stream.d.ts
packages/client/src/centraid-api.d.ts
packages/client/src/gateway-client-conversation.ts
packages/client/src/gateway-client.ts
packages/client/src/react/blueprints/kit-ask-inline.ts
packages/client/src/react/screen-contracts.ts
packages/client/src/react/screens/AssistantMessage.tsx
packages/client/src/react/screens/AssistantScreen.module.css
packages/client/src/react/screens/AssistantScreen.test.tsx
packages/client/src/react/screens/AssistantScreen.tsx
packages/client/src/react/screens/AutomationThreadScreen.module.css
packages/client/src/react/screens/AutomationThreadScreen.test.tsx
packages/client/src/react/screens/AutomationThreadScreen.tsx
packages/client/src/react/screens/AutomationsOverviewScreen.module.css
packages/client/src/react/screens/AutomationsOverviewScreen.test.tsx
packages/client/src/react/screens/AutomationsOverviewScreen.tsx
packages/client/src/react/screens/BuilderChatPane.test.tsx
packages/client/src/react/screens/BuilderChatPane.tsx
packages/client/src/react/screens/ChatComposer.module.css
packages/client/src/react/screens/ChatComposer.tsx
packages/client/src/react/screens/InsightsScreen.test.tsx
packages/client/src/react/screens/InsightsScreen.tsx
packages/client/src/react/screens/SessionStatusStrip.module.css
packages/client/src/react/screens/SessionStatusStrip.tsx
packages/client/src/react/screens/SettingsProvidersAgents.tsx
packages/client/src/react/screens/SettingsProvidersScreen.module.css
packages/client/src/react/screens/SettingsProvidersScreen.test.tsx
packages/client/src/react/screens/SettingsProvidersScreen.tsx
packages/client/src/react/screens/SettingsProvidersSelects.tsx
packages/client/src/react/screens/assistantUsage.ts
packages/client/src/react/shell/App.test.tsx
packages/client/src/react/shell/routes/AssistantRoute.tsx
packages/client/src/react/shell/routes/AutomationViewRoute.test.tsx
packages/client/src/react/shell/routes/AutomationViewRoute.tsx
packages/client/src/react/shell/routes/InsightsRoute.test.tsx
packages/client/src/react/shell/routes/SettingsRoute.tsx
packages/client/src/react/shell/routes/assistantTranscript.ts
packages/client/src/react/shell/routes/automationEditorPrefill.test.ts
packages/client/src/react/shell/routes/automationLiveMessages.ts
packages/client/src/react/shell/routes/automationTurnMessages.test.ts
packages/client/src/react/shell/routes/automationsData.test.ts
packages/client/src/react/shell/routes/automationsData.ts
packages/client/src/react/shell/routes/builder/BuilderShell.tsx
packages/client/src/react/shell/routes/builder/useBuilder.test.ts
packages/client/src/react/shell/routes/builder/useBuilder.ts
packages/client/src/react/shell/routes/settingsProvidersData.test.ts
packages/client/src/react/shell/routes/settingsProvidersData.ts
packages/design-tokens/src/icons.ts
packages/gateway/src/lifecycle/automation-agent-selection.test.ts
packages/gateway/src/lifecycle/automation-agent-selection.ts
packages/gateway/src/lifecycle/headless-automation-compile.test.ts
packages/gateway/src/lifecycle/headless-automation-compile.ts
packages/gateway/src/lifecycle/interactive-automation-turn.test.ts
packages/gateway/src/lifecycle/interactive-automation-turn.ts
packages/gateway/src/routes/agents-routes.ts
packages/gateway/src/routes/assistant-routes.test.ts
packages/gateway/src/routes/assistant-routes.ts
packages/gateway/src/routes/automations-routes.test.ts
packages/gateway/src/routes/automations-routes.ts
packages/gateway/src/routes/lifecycle-automation-routes.test.ts
packages/gateway/src/runs/assistant-conversation-runner.ts
packages/gateway/src/runs/unified-conversation-runner.ts
packages/gateway/src/serve/build-gateway.ts
packages/gateway/src/serve/runner-prefs.test.ts
packages/gateway/src/serve/runner-prefs.ts
receipts/issue-567-unified-acp-router.md
```

## Out of scope

- Cost- or latency-optimizing automatic policy beyond the owner-authored ladder.
- Budget caps that refuse or degrade turns.
- A billable model-generated hydration summarizer.
- Conversation branching.
- Arbitrary user MCP servers, interactive agent permission UI, and ACP v2.

## Decisions

- The owner's later instruction superseded #567's child-issue/PR split. All
  technical work and review evidence is consolidated under umbrella #567; the
  accidentally created child issues were deleted. That instruction also
  approves the process-only deviation from separately landed 0→1→2→3→4 PRs:
  dependency order was preserved during implementation, while the final diff
  lands atomically. No D1–D13 behavior was waived.
- A capability refresh re-applies only the already-current model option. It
  never selects an arbitrary alternative merely to provoke
  `config_option_update`, because some native agents persist that choice
  globally or require different provider credentials.
- The live first-party Claude probe is truthful: initialize/session creation
  work, but this host's Claude OAuth session is expired. The router classifies
  that prompt-time internal error as `auth` and leaves the previous binding
  active. On 2026-07-27 the owner explicitly directed “skip claude checks” and
  stopped the offered re-authentication flow, approving a validation-only
  deviation from #567's live Claude turn/effort/switch smoke. Deterministic
  first-party Claude adapter matrix coverage remains; the successful real
  cross-runner smoke uses Codex and GitHub Copilot. The forced automation-fire
  smoke uses a missing generic ACP binary and authenticated Codex so it remains
  an actual broken-A → live-B boundary test.
- The Phase 0 diagnostics table is checked into umbrella issue #567 at
  https://github.com/srikanth235/centraid/issues/567#issuecomment-5094037531.
- The local `format-check` pre-commit directive invokes `oxfmt` without this
  repository's required `oxfmt.config.mjs`, so it falsely reports every staged
  source file while `bun run format:check` passes. After the steering,
  receipt-crosswalk, repo-hygiene, and root formatting directives were run and
  passed explicitly, the governed commit used the documented local hook escape;
  GitHub's governance and static jobs remain authoritative.

## Verification

```sh
# Full capability truth: exactly 17 registry rows; installed runners include
# full config option snapshots and observed optional ACP signals.
CENTRAID_CODEX_BIN='/Applications/ChatGPT.app/Contents/Resources/codex' \
CENTRAID_OPENCODE_BIN='/Users/srikanth/.opencode/bin/opencode' \
bun run --cwd packages/agent-runtime probe:all-adapters

# Live Codex effort confirmation plus real Codex → Copilot → Codex hydration.
CENTRAID_LIVE_ADAPTERS='codex,copilot' \
CENTRAID_CODEX_BIN='/Applications/ChatGPT.app/Contents/Resources/codex' \
bun run --cwd packages/agent-runtime test:live-adapters

# Real fire-boundary fallback: missing ACP binary → authenticated Codex.
CENTRAID_CODEX_BIN='/Applications/ChatGPT.app/Contents/Resources/codex' \
CENTRAID_LIVE_FAILOVER_PRIMARY='acp' \
CENTRAID_LIVE_FAILOVER_RUNNER='codex' \
bun run --cwd packages/agent-runtime test:live-automation-failover

# Local package/type gates and the final dependent-aware PR gate.
bun run typecheck
bun run check:pr:full
```

Observed live results:

- Capability dump emitted all 17 kinds. Codex advertised/confirmed
  `thought_level=xhigh`; Claude advertised model/effort/context capabilities and
  was correctly marked `authRequired` after its expired OAuth prompt; unavailable
  kinds remained explicit rows.
- Codex and Copilot basic turns passed. The real
  `codex → copilot → codex` smoke passed with three marker-bearing finals, two
  session-hydration notices, a live session id for each provider, and Codex's
  original session returning with only the delta hydration.
- Per the owner's explicit “skip claude checks” direction, no successful live
  Claude turn was required after the probe correctly reported its expired OAuth
  session. Fake-agent and first-party Claude adapter tests still cover option
  discovery, effort pinning/rebuild, usage context, and resume self-heal.
- The forced live automation fire passed `broken-acp → codex`: the missing
  binary produced a classified `spawn` failure on `live-automation-567`, Codex
  completed `live-automation-567:failover:1:codex`, the durable second-turn
  note named the boundary/class and pin reset, and the output contained
  `AUTOMATION_FAILOVER_OK_567`. This smoke also exposed and fixed worker-stack
  suffix handling in the typed failure parser before the final gate.
- Focused suites cover fake-agent effort rebuild, context regression, terminal/
  content/location artifacts, all failure classes, auth-until-preflight and
  half-open breakers, no intra-turn retry, scheduled-fire and manual-compile
  distinct attempts, durable fire-failover notice reload, A→B→C→A cold-handle
  resumption and delta watermarks, sequence-zero recovery hydration, lock
  contention, consent, cascade GC, resume self-heal, workspace canonicalization,
  shared UI/mobile behavior, and accounting projections.
- The final audit corrections passed focused package verification: app-engine
  2 files / 61 tests, automation 1 file / 10 tests, and agent-runtime 2 files /
  14 tests, plus typecheck for all three packages and focused oxlint.
- The current complete client suite passed 180 files / 1,374 tests. The current
  complete mobile suite passed 38 files / 237 tests. With the sandbox-denied
  listener files excluded, app-engine passed 50 files / 533 tests and
  agent-runtime passed 31 files / 276 tests with one skipped. Focused current
  gateway router/lifecycle suites passed 21 tests.

- `bun run typecheck` passed all 32 tasks.
- `bun run check:pr:full` passed formatting, lint, all 32 typechecks, knip,
  CSS/protocol/workflow checks, governance, matrix/report/ratchet checks, and
  reached the affected package suites. In this restricted Codex workspace its
  loopback HTTP/SSE tests are denied by the sandbox with
  `listen EPERM 127.0.0.1`; the same suites passed in the earlier unrestricted
  checkpoint before the final UI-only corrections. The authoritative final
  full-suite and coverage counts will be recorded from GitHub Actions.
- The first GitHub Actions run stopped during setup because a local coverage
  fixture accidentally created commit `9eb2d35b` with 70 generated `apps/`
  files. Those files changed the frozen workspace graph, and the unaccounted
  commit also failed governance. The corrective commit removes exactly that
  generated fixture set and records the incident here; no production
  implementation changed.
- The first clean-history coverage run exposed two branch-floor gaps:
  app-engine measured 72.98% against 73%, and agent-runtime measured 74.77%
  against 75%. Focused behavior tests for runner-health list metadata/state and
  ACP config-update/effort-pin fallbacks raised their file branch coverage from
  86.79% to 96.22% (+5 covered branches) and from 77.27% to 94.31% (+15),
  respectively; both focused suites and both package typechecks pass.
- GitHub Actions CI run
  [30299535485](https://github.com/srikanth235/centraid/actions/runs/30299535485)
  passed every required lane: verify (including coverage), mutation, static,
  dependency review, docs, companion static, web build, gateway package/image
  smoke, desktop E2E, web E2E, boot smoke, and the aggregate check.
- Governance run
  [30299535212](https://github.com/srikanth235/centraid/actions/runs/30299535212)
  passed all 25 directives.
- Post-review fix round (2026-07-28): repo-wide `bun run typecheck` passed all
  32 tasks and every `check:pr:full` stage passed on this unrestricted host
  (including the loopback HTTP/SSE suites the earlier Codex sandbox denied),
  with diff coverage 90.8% ≥ 80%. One honest caveat: the full-parallel
  `test:affected:full` run tripped the pre-existing `handler-pool.test.ts`
  hung-handler timeout (untouched code; the documented `-c6` saturation
  flake) and passed cleanly at `--concurrency=2` and in isolation.
  Focused suites added/updated in the round: per-rung failover
  hydration, no-resurrect consent + manifest-pin denial, breaker-gated fire
  ladders, finalization-failure settlement, consent-flow client tests on two
  surfaces, native mobile selection, probe/preflight cache behavior, and
  classifier precedence.

## Audit

PASS — A fresh-context adversarial audit found no acceptance, D1–D13,
Constitution, or receipt blocker. The changed-files inventory exactly matches
the complete working-tree path set. The owner-approved umbrella-PR deviation
and Claude live-validation-only waiver are documented without waiving technical
requirements. The prior sequence-zero recovery, durable automation-fire
failover notice, and A→B→C lifecycle/resumption blockers are resolved and
regression-covered. The ready umbrella PR is published, and its authoritative
GitHub Actions CI and Governance runs are green.

## Steering

PASS — Fresh-context review classifies exactly two human-steering events: the
event-358 umbrella-PR scope correction and the event-6459 Claude-validation
correction. No user message begins `[Request interrupted by user`; the initial
task request and non-human/tool-denial records are not steering. The Accounting
table records exactly one row for each correction at its transcript coordinate,
and records no non-steering event.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| codex-019fa35f-701-1785178303-1 | codex | 019fa35f-701c-7c43-bf91-10202a688f13 | #567 | gpt-5.6-sol | 5396701 | 0 | 274497280 | 591396 | 5988097 | 90.9870 | 5396701 | 0 | 274497280 | 591396 | feat(agent-runtime): unify ACP routing and failover (#567) |
| codex-019fa35f-701-1785179351-1 | codex | 019fa35f-701c-7c43-bf91-10202a688f13 | #567 | gpt-5.6-sol | 171149 | 0 | 8233984 | 15319 | 186468 | 2.7162 | 5567850 | 0 | 282731264 | 606715 | test(gateway): materialize assistant attachment fixture (#567) |
| codex-019fa35f-701-1785180075-1 | codex | 019fa35f-701c-7c43-bf91-10202a688f13 | #567 | gpt-5.6-sol | 179234 | 0 | 4605184 | 6949 | 186183 | 1.7036 | 5747084 | 0 | 287336448 | 613664 | chore(test): remove generated fixture apps (#567) |
| codex-019fa35f-701-1785180136-1 | codex | 019fa35f-701c-7c43-bf91-10202a688f13 | #567 | gpt-5.6-sol | 12508 | 0 | 381696 | 863 | 13371 | 0.1396 | 5759592 | 0 | 287718144 | 614527 | chore(test): remove generated fixture apps (#567) |
| codex-019fa35f-701-1785180193-1 | codex | 019fa35f-701c-7c43-bf91-10202a688f13 | #567 | gpt-5.6-sol | 14704 | 0 | 426752 | 712 | 15416 | 0.1541 | 5774296 | 0 | 288144896 | 615239 | chore(test): remove generated fixture apps (#567) |
| codex-019fa35f-701-1785181382-1 | codex | 019fa35f-701c-7c43-bf91-10202a688f13 | #567 | gpt-5.6-sol | 188115 | 0 | 12551936 | 13881 | 201996 | 3.8165 | 5962411 | 0 | 300696832 | 629120 | test(runtime): cover ACP and health branches (#567) |
| codex-019fa35f-701-1785182227-1 | codex | 019fa35f-701c-7c43-bf91-10202a688f13 | #567 | gpt-5.6-sol | 61593 | 0 | 9561600 | 6712 | 68305 | 2.6451 | 6024004 | 0 | 310258432 | 635832 | test(runtime): cover ACP and health branches (#567) |
| claude-code-fceae513-7f3-1785209819-1 | claude-code | fceae513-7f3c-4cbb-8ab3-327fdd04b456 | #567 | claude-fable-5 | 288 | 407949 | 20435137 | 202284 | 610521 | 35.6516 | 288 | 407949 | 20435137 | 202284 | fix(app-engine): plan failover resume and hydration per ladder rung (#567)A brea |
| claude-code-fceae513-7f3-1785209864-1 | claude-code | fceae513-7f3c-4cbb-8ab3-327fdd04b456 | #567 | claude-fable-5 | 6 | 12582 | 583038 | 843 | 13431 | 0.7825 | 294 | 420531 | 21018175 | 203127 | fix(app-engine): plan failover resume and hydration per ladder rung (#567)Co-Aut |
| claude-code-fceae513-7f3-1785210103-1 | claude-code | fceae513-7f3c-4cbb-8ab3-327fdd04b456 | #567 | claude-fable-5 | 80 | 34101 | 8306775 | 21970 | 56151 | 9.8323 | 374 | 454632 | 29324950 | 225097 | fix(app-engine): plan failover resume and hydration per ladder rung (#567)A brea |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | ---: | ---: |
| steer-019fa35f701c-1785153327-1 | 019fa35f-701c-7c43-bf91-10202a688f13 | #567 | correction | classifier | Consolidate all work and PR tracking under umbrella issue #567 | feat(agent-runtime): unify ACP routing and failover (#567) | 358 | 2026-07-27T11:55:27.085Z |
| steer-019fa35f701c-1785170433-2 | 019fa35f-701c-7c43-bf91-10202a688f13 | #567 | correction | classifier | Skip live Claude validation after authentication failure | feat(agent-runtime): unify ACP routing and failover (#567) | 6459 | 2026-07-27T16:40:33.378Z |
