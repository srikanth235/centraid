# Issue #647 — Inbox

GitHub issue: [#647](https://github.com/srikanth235/centraid/issues/647)

## Checklist

- [x] `notice` table + store (gateway db, vault-scoped), with collapse-on-write per D5
- [x] Writers: automation runner fire outcomes (per D6 policy + `notify` manifest knob with validation), outbox executor drain results (sent / failed / re-parked), gateway-health transitions
- [x] `GET /centraid/_vault/inbox` → `{decisions, notices}`: decisions unioned from parked / outbox / scope-requests / needs-auth (superset of `/blocking`), notices from the new table; `POST` read/archive endpoints
- [x] Notice retention: archived notices pruned by age/count cap (bounded-ledger posture, #438)
- [x] Replace `ApprovalsScreen` five-section layout with the single stream: pinned decisions + notices, filter chips per D8; inline approve/deny/edit-then-approve preserved (incl. always-allow grant mint)
- [x] Badge = open decisions only (D2); `useBlockingCount` reads the inbox payload
- [x] Recent-activity feed becomes the Archived view (D8); deep-links per D10
- [x] Toast demotion sweep (D9)
- [x] Retire blueprints-kit ask-panel consent cards in favour of the shell inbox (recorded intent, docs/refactors/inline-system-apps.md)
- [x] SSE `inbox-changed` on the vault plane; badge poll demoted to fallback
- [x] Wake-relay trigger on decision / high-severity-notice creation; client-side local OS-notification composition (reuse the reminder notification plumbing; respect docs/decisions.md — prompt for permission in context, relay stays content-free)
- [x] Mobile Inbox screen replacing parked-only `Approvals.tsx`: full decisions + notices via the same endpoint, native controls (D13); Home attention strip fed from inbox decisions count
- [x] Desktop reminder-monitor untouched; gateway-monitor alerts dual-write to notices (D11)
- [x] A failed automation fire produces a notice visible in the inbox on web, desktop, and mobile without opening the automation; a second consecutive failure collapses into the same card with an updated count
- [x] Deciding a parked/outbox/scope item from the inbox settles the canonical row (verified against the source tables) — no shadow state
- [x] Badge counts open decisions only; archiving/reading notices never changes it; an open decision cannot be archived or dismissed
- [x] Mobile shows outbox, scope-request, and needs-auth decisions (parity with web), decided via the same endpoints
- [x] Badge/inbox updates arrive via SSE within ~1 s in-app; wake relay payload remains content-free (assert on the payload)
- [x] Automation `notify` knob honored: `never` produces no notices, default produces failure + first-recovery only
- [x] Gateway down/degraded produces a notice on all clients; reminders continue to bypass the inbox
- [x] Kit ask-panel consent cards removed; per-automation thread strip still shows that automation's own pending items
- [x] Archived notices pruned per retention policy; inbox endpoint stays bounded

## What changed

### Phase 1 — notice spine and projection

- **`notice` table + store (gateway db, vault-scoped), with collapse-on-write per D5.** Added the vault-scoped `inbox_notice` STRICT table and `InboxNoticeStore`. Writes upsert by `(kind, source_ref)`, increment `count`, advance `last_at`, and reopen an archived/read notice instead of creating duplicates.
- **Writers: automation runner fire outcomes (per D6 policy + `notify` manifest knob with validation), outbox executor drain results (sent / failed / re-parked), gateway-health transitions.** Automation manifests now validate `notify: always | failures | never`; fires emit failure, first-recovery, or opted-in success notices; outbox drain emits sent/failed/re-parked notices; the desktop gateway monitor dual-writes availability transitions while retaining its existing alert history.
- **`GET /centraid/_vault/inbox` → `{decisions, notices}`: decisions unioned from parked / outbox / scope-requests / needs-auth (superset of `/blocking`), notices from the new table; `POST` read/archive endpoints.** The endpoint returns canonical decision rows without copying them, active-first bounded notices, and owner actions for read/archive. Existing decision endpoints remain the only settlement path.
- **Notice retention: archived notices pruned by age/count cap (bounded-ledger posture, #438).** The store deletes archived notices older than 90 days and applies a hard 1,000-row cap on mount and write.

### Phase 2 — one web/desktop surface

- **Replace `ApprovalsScreen` five-section layout with the single stream: pinned decisions + notices, filter chips per D8; inline approve/deny/edit-then-approve preserved (incl. always-allow grant mint).** Inbox renders one pinned Needs me stream and reverse-chronological notices with Needs me, Automations, Agents, Apps, and Archived filters. The existing artifact editor and canonical decision actions are preserved.
- **Badge = open decisions only (D2); `useBlockingCount` reads the inbox payload.** `useInboxCounts` derives the numeric badge only from `decisions.count`, exposes a separate unread-notice dot, and keeps `useBlockingCount` as a compatibility wrapper.
- **Recent-activity feed becomes the Archived view (D8); deep-links per D10.** Grants, consent activity, and archived notices share the Archived filter. Automation, gateway, and app notices navigate to their relevant surface.
- **Toast demotion sweep (D9).** Inbox-originated events are durable rows; remaining Inbox toasts only acknowledge owner-triggered approve, deny, edit, or revoke actions.
- **Retire blueprints-kit ask-panel consent cards in favour of the shell inbox (recorded intent, docs/refactors/inline-system-apps.md).** Removed the consent-card bundle and its tests, removed the inline shell strip, updated the kit conversation status, and documented Inbox as the sole global decision surface.

### Phase 3 — delivery and native parity

- **SSE `inbox-changed` on the vault plane; badge poll demoted to fallback.** A content-free event bus rings after notice writes and the canonical parked/scope decision mutations that do not carry provenance. Those decision doorbells are deferred until grouped transactions commit. A decision-count tracker observes the canonical union after provenance commits for outbox and connection decisions, without introducing shadow state. Web and mobile subscribe immediately and retain a 60-second refresh only as fallback.
- **Wake-relay trigger on decision / high-severity-notice creation; client-side local OS-notification composition (reuse the reminder notification plumbing; respect docs/decisions.md — prompt for permission in context, relay stays content-free).** Decision-count increases and high-severity writes request the existing opaque `{centraid: "replica-wake"}` relay. Web and mobile prompt only when the owner opens Inbox, fetch canonical content after wake, and compose local notifications with dedupe. The continuous web shell mirrors only its enrolled Iroh device key, current relay ticket, and addressed vault into private worker storage. With no window open, the service worker opens that authenticated tunnel itself, fetches canonical Inbox and reminder rows, composes private text locally, and closes the endpoint; a directly hosted same-origin shell retains a purpose-limited HttpOnly-control fallback. A build-derived classic wrapper makes the tracked browser Iroh WASM available to the existing worker without duplicating binding source, while the shared Cache API delivery ledger prevents duplicate delivery when a window later opens. Every outbox re-park path advances the canonical `staged_at` episode, including grant revocation and restore quarantine; restore quarantine also rings Inbox and queues its opaque wake across gateway boot. Repeated needs-auth reports update the owner-readable note without advancing the episode timestamp; a successful reconnect clears it so only a later relapse creates a new notification key.
- **Mobile Inbox screen replacing parked-only `Approvals.tsx`: full decisions + notices via the same endpoint, native controls (D13); Home attention strip fed from inbox decisions count.** The React Native screen consumes the same payload shape, exposes parked/outbox/scope/needs-auth actions plus read/archive, filters notices, starts the canonical connection authorization flow for needs-auth rows, opens automation notices in their native turn thread, opens gateway-health notices in a dedicated alert history, supports edit-then-approve and standing approval on editable outbox artifacts, and derives Home attention only from decisions.
- **Desktop reminder-monitor untouched; gateway-monitor alerts dual-write to notices (D11).** Reminder routes and monitor behavior are unchanged. The durable gateway alert history also serves as a restart-safe projection queue: deterministic event source refs make replay idempotent, and down/recovery remain distinct cards so a high-severity outage cannot be overwritten before another client fetches it.

### Acceptance evidence

- **A failed automation fire produces a notice visible in the inbox on web, desktop, and mobile without opening the automation; a second consecutive failure collapses into the same card with an updated count.** A gateway integration test publishes an installed automation with a throwing handler, invokes that real manual-fire path twice, observes the handler error in its failure notice, and verifies the count reaches two; store tests separately verify collapse/count/reopen behavior.
- **Deciding a parked/outbox/scope item from the inbox settles the canonical row (verified against the source tables) — no shadow state.** Inbox returns the existing blocking projection and both clients call the existing outbox, parked, scope, and reconnect endpoints.
- **Badge counts open decisions only; archiving/reading notices never changes it; an open decision cannot be archived or dismissed.** Decision count and unread-notice state are separate fields; notice mutations target only `inbox_notice`, and no decision archive route exists.
- **Mobile shows outbox, scope-request, and needs-auth decisions (parity with web), decided via the same endpoints.** The native Inbox maps every decision array from the shared wire payload and invokes the canonical endpoints. Editable outbox rows expose the staged artifact, preserve structured fields, and submit scalar edits through the same approval endpoint.
- **Badge/inbox updates arrive via SSE within ~1 s in-app; wake relay payload remains content-free (assert on the payload).** The HTTP integration test parks a real confirm-gated command and observes the SSE doorbell in under one second, scope tests cover creation and settlement signals, the decision-count tracker covers provenance-backed decisions, and the wake route test asserts the opaque payload exactly.
- **Automation `notify` knob honored: `never` produces no notices, default produces failure + first-recovery only.** Manifest and policy-matrix tests cover explicit and default modes.
- **Gateway down/degraded produces a notice on all clients; reminders continue to bypass the inbox.** Desktop health transitions persist before projection, restart replay is idempotent, down/recovery use distinct event identities, and web/mobile render the shared notice while reminder fetch and scheduling paths remain separate.
- **Kit ask-panel consent cards removed; per-automation thread strip still shows that automation's own pending items.** The kit card files, static allowlist entries, and inline global card rendering were deleted; the automation thread's local pending-item strip was not removed.
- **Archived notices pruned per retention policy; inbox endpoint stays bounded.** Tests cover age pruning, count pruning, active-first ordering, and request limits.

### Review-fix round (2026-07-31)

A five-slice adversarial review of the first snapshot surfaced two blockers, four design-contract gaps, and a set of correctness/noise issues. All were fixed in this round; a visual pass also ported the approved Inbox mock's design elements into the shipped screen.

- **Kit parked/denied acknowledgment read a wire shape no producer emits.** `kit.ts` now detects the real `InvokeOutcome` shapes (bare `status`, nested `output.status`); the smoke-test fixture was rewritten from the actual producer types instead of mirroring the implementation.
- **Mobile needs-auth reconnect could start but never finish.** Rebuilt on `expo-web-browser` in-app auth sessions and the app's own `centraid://oauth/finish` deep link: Assist completes with the same persisted client session and device that began the ceremony, and BYO works because the in-app browser keeps the loopback tunnel proxy alive. Invalid or foreign finish links are never posted.
- **D3:** open decisions now stay pinned under every filter chip; notice-filter empty states no longer claim inbox-zero.
- **D10:** an outbox notice now focuses, expands, and highlights its still-open decision (via `detail.itemId`) instead of a self-navigation no-op.
- **D7:** the wake tracker keys on decision identities (id + episode), not counts — a net-zero swap in one grouped commit still wakes closed devices, and the first observation after a restart seeds silently instead of firing a phantom wake.
- **SSE doorbell no longer unmounts the screen.** `useAsyncData` gained opt-in `keepPreviousData`; in-progress edit-then-approve state survives background refetches.
- **Notification hygiene:** the web and mobile delivery ledgers seed silently on first sync (no permission-grant blast), and composition is skipped while the page is visible / the app is foreground.
- **Paused connections are skips, not failures.** `HandlerOutcome.skipped` suppresses notices, wakes, and false "recovered" transitions.
- **Doorbell cost coalesced.** Provenance-commit inbox summaries and SSE rings collapse into a leading + trailing flush per 250 ms window (`inboxDoorbellWindowMs`), instead of paying `blocking()` per commit.
- **Gateway-health projection rebuilt.** Durable per-gateway high-water marks make projection at-most-once across restarts and vault switches; upgrades seed the mark without replaying stale history; source refs dropped their timestamps so flapping collapses server-side (the route moved from `putIfAbsent` to collapse-`put`); `""` vault ids are treated as unset; oldest-first batches drain backlogs instead of truncating them.
- **D4 headlines:** automation and outbox notices carry an artifact-level gist ("<name> failed — <first line of the error>"), and the raw-ref fallback is humanized.
- **Mobile decision cards** now show the scope summary (schema.table, verbs, row rule, field count) and a parked-input preview; automation deep links carry `x-centraid-vault`.
- **Visual pass from the approved mock:** palette-hued correspondent tiles and kind icons on notice rows, severity pills and an unread dot replacing the off-system colored left rail, a failure-streak strip with duration phrasing ("failing for 6 days") replacing the bare `×N`, and flat-notice/elevated-decision surface contrast (also fixing the undefined `--surface` token).
- **Glossary:** the Approvals→Inbox identifier dual is recorded in the known-dual-vocabulary table.

### Main-CI baseline fixes (observed on this PR, pre-existing on main)

- **Stale Appearance desktop e2e.** Four `settings-gateways.spec.ts` cases still targeted the pre-#608 Accent radiogroup and "Centraid Light/Dark" radios / Match-system button. Updated to the shipped Appearance Segmented control (`tablist` "Appearance", Light/Dark/Match system) and density persistence; refreshed `SCENARIOS.md` §12 rows.
- **Non-deterministic embedded-gateway layout tree.** `embedded-gateway-layout.test.ts` tree comparison raced boot warmers: PricingWarmer (#445) and CatalogWarmer can write `cache/model-pricing.json` / `cache/model-catalog.json` after `close()` on only one side. Seed both warmer caches and exclude those two paths from `treeShape` so layout parity is network- and CLI-independent.

### Changed files

```text
.gitignore
CHANGELOG.md
apps/desktop/src/main/embedded-gateway-layout.test.ts
apps/desktop/src/main/gateway-monitor.ts
apps/desktop/src/main/gateway-outage-log-core.test.ts
apps/desktop/src/main/gateway-outage-log-core.ts
apps/desktop/src/main/gateway-outage-log.ts
apps/desktop/tests/e2e/SCENARIOS.md
apps/desktop/tests/e2e/settings-gateways.spec.ts
apps/mobile/ios/Podfile.lock
apps/mobile/native-fingerprints.json
apps/mobile/package.json
apps/mobile/src/lib/connection-reauth.test.ts
apps/mobile/src/lib/connection-reauth.ts
apps/mobile/src/lib/decision-detail.test.ts
apps/mobile/src/lib/decision-detail.ts
bun.lock
packages/automation/src/fire/connector.test.ts
packages/automation/src/fire/fire.ts
packages/automation/src/handler/runner.ts
packages/client/src/react/shell/useAsyncData.ts
apps/mobile/src/apps/automations/AutomationThread.tsx
apps/mobile/src/apps/automations/Automations.tsx
apps/mobile/src/apps/insights/GatewayAlerts.tsx
apps/mobile/src/apps/insights/Insights.tsx
apps/mobile/src/components/OutboxDecisionCard.tsx
apps/mobile/src/kit/replica/ReplicaProvider.tsx
apps/mobile/src/lib/automations.test.ts
apps/mobile/src/lib/automations.ts
apps/mobile/src/lib/gateway.ts
apps/mobile/src/lib/inbox-artifact-editor.test.ts
apps/mobile/src/lib/inbox-artifact-editor.ts
apps/mobile/src/lib/inbox-navigation.test.ts
apps/mobile/src/lib/inbox-navigation.ts
apps/mobile/src/lib/inbox-notification-model.test.ts
apps/mobile/src/lib/inbox-notification-model.ts
apps/mobile/src/lib/notification-model.test.ts
apps/mobile/src/lib/notification-model.ts
apps/mobile/src/lib/notifications-core.ts
apps/mobile/src/lib/notifications.tsx
apps/mobile/src/lib/replica/background-sync.ts
apps/mobile/src/navigation.ts
apps/mobile/src/screens/Approvals.tsx
apps/mobile/src/screens/Home.tsx
apps/mobile/src/screens/Settings.tsx
apps/mobile/src/screens/home/AttentionLine.tsx
apps/mobile/src/screens/home/SpaceDrawer.tsx
apps/web/package.json
apps/web/public/_headers
apps/web/public/sw.js
apps/web/scripts/build-iroh-worker.mjs
apps/web/src/iroh-transport.ts
apps/web/src/sw-inbox-wake.test.ts
apps/web/src/sw-version.test.ts
apps/web/src/sw-version.ts
apps/web/src/web-host.test.ts
apps/web/src/web-host.ts
apps/web/tests/e2e/web-pwa-cache.spec.ts
docs/glossary.md
docs/refactors/inline-system-apps.md
packages/app-engine/src/http/security.ts
packages/automation/src/manifest/manifest.test.ts
packages/automation/src/manifest/manifest.ts
packages/blueprints/kit/consent-cards.d.ts
packages/blueprints/kit/consent-cards.js
packages/blueprints/kit/conversation-client.d.ts
packages/blueprints/kit/conversation-client.js
packages/blueprints/kit/kit.ts
packages/blueprints/src/app-boot-harness.ts
packages/blueprints/src/consent-cards.test.ts
packages/blueprints/src/conversation-client.test.ts
packages/blueprints/src/kit-smoke.test.ts
packages/client/src/app-shell-context.ts
packages/client/src/gateway-client-outbox.ts
packages/client/src/gateway-client-push.ts
packages/client/src/gateway-client-push.test.ts
packages/client/src/inbox-notification-model.ts
packages/client/src/react/blueprints/kit-ask-inline.ts
packages/client/src/react/screens/ApprovalsScreen.module.css
packages/client/src/react/screens/ApprovalsScreen.test.tsx
packages/client/src/react/screens/ApprovalsScreen.tsx
packages/client/src/react/shell/App.inline-branch.test.tsx
packages/client/src/react/shell/App.test.tsx
packages/client/src/react/shell/App.tsx
packages/client/src/react/shell/CaptureOverlay.tsx
packages/client/src/react/shell/CaptureScanPanel.tsx
packages/client/src/react/shell/Sidebar.tsx
packages/client/src/react/shell/chrome.module.css
packages/client/src/react/shell/router.test.ts
packages/client/src/react/shell/router.ts
packages/client/src/react/shell/routes/ApprovalsRoute.test.tsx
packages/client/src/react/shell/routes/ApprovalsRoute.tsx
packages/client/src/react/shell/routes/GatewayRoute.tsx
packages/client/src/react/shell/routes/approvalsData.test.ts
packages/client/src/react/shell/useBlockingCount.test.tsx
packages/client/src/react/shell/useBlockingCount.ts
packages/gateway/src/routes/push-wake-routes.test.ts
packages/gateway/src/routes/push-wake-routes.ts
packages/gateway/src/routes/vault-routes.test.ts
packages/gateway/src/routes/vault-routes.ts
packages/gateway/src/serve/build-gateway.test.ts
packages/gateway/src/serve/build-gateway.ts
packages/gateway/src/serve/inbox-events.ts
packages/gateway/src/serve/inbox-notices.test.ts
packages/gateway/src/serve/inbox-notices.ts
packages/gateway/src/serve/outbox-executor.test.ts
packages/gateway/src/serve/outbox-executor.ts
packages/gateway/src/serve/vault-quarantine.test.ts
packages/gateway/src/serve/vault-quarantine.ts
packages/gateway/src/serve/vault-plane.test.ts
packages/gateway/src/serve/vault-plane.ts
packages/gateway/src/serve/vault-registry.ts
packages/gateway/src/serve/web-app-sessions.contract.test.ts
packages/gateway/src/serve/web-app-sessions.ts
packages/protocol/src/routes.ts
packages/vault/src/commands/outbox.test.ts
packages/vault/src/commands/outbox.ts
packages/vault/src/commands/sync.test.ts
packages/vault/src/commands/sync.ts
packages/vault/src/gateway/gateway.contract.test.ts
packages/vault/src/gateway/gateway.ts
packages/vault/src/schema/atlas.ts
packages/vault/src/schema/inbox.ts
packages/vault/src/schema/migrate.test.ts
packages/vault/src/schema/migrate.ts
packages/vault/src/schema/tables.ts
receipts/issue-647-inbox.md
tests/matrix.json
```

## Decisions

- Inbox notices live in `vault.db`, not a gateway-global file, so persistence and ownership are genuinely vault-scoped and travel with vault recovery.
- Retention is 90 days for archived notices with a 1,000-row total cap. This gives a concrete bounded-ledger policy where the issue intentionally left the values open.
- Automation failures, outbox failures, and gateway-down transitions are high severity and request an opaque wake immediately. Outbox re-parks and degraded health are warning-level; successes and recoveries remain informational.
- Gateway monitor events use one immutable source identity per durable transition. This preserves the high-severity outage after recovery and makes desktop-history replay safe without inflating notice counts.
- Notification delivery keys include canonical decision-episode timestamps. Re-created outbox and needs-auth decisions can notify again without adding a shadow decision table.
- A closed continuous-web PWA authenticates its canonical notification pull with the same durable Iroh device identity as the shell. The worker stores no vault rows, releases the endpoint after each wake, and keeps the direct-HTTP control route as a narrowly authorized deployment fallback.
- Consent activity stays a query-time projection in Archived, matching the issue's stated preference and avoiding duplicate journal state.
- The full three-phase change lands atomically in one commit and one issue receipt so no intermediate commit can expose a half-migrated wire contract.

## Out of scope

- Snooze (D12).
- Reminders in the inbox (D11); the existing reminder pipeline remains separate.
- Household/multi-member routing of inbox items.
- Digest/summary email and other off-device delivery beyond the existing wake relay.
- Cost/latency analytics on automation runs.

## Verification

```sh
# Focused migration and route regressions
bun run --cwd packages/vault test -- src/schema/migrate.test.ts
bun run --cwd packages/client test -- src/react/shell/routes/ApprovalsRoute.test.tsx
bun run --cwd packages/gateway test -- src/serve/build-gateway.test.ts src/serve/inbox-notices.test.ts
bun run --cwd packages/client test -- src/gateway-client-push.test.ts
bun run --cwd apps/mobile test -- src/lib/inbox-notification-model.test.ts
bun run --cwd apps/desktop test -- src/main/gateway-outage-log-core.test.ts

# Complete PR gate, including affected package tests and changed-line coverage
bun run check:pr

# Shared-infrastructure merge gate: dependents, coverage, mutation/perf, and e2e
bun run check:full
```

- Focused canonical-delivery regressions: 38 gateway, 62 vault, 29 web-client, 4 mobile, and 20 desktop tests passed.
- Final audit fixes: the complete sync command suite passed 29 tests, including continuous needs-auth timestamp stability and recovery/relapse reset; the production gateway construction suite passed 19 tests, including an installed automation whose real handler fails twice and collapses into one notice.
- Final publication regressions: 3 restore-quarantine, 17 outbox-command, and 6 web Inbox route tests passed, covering new re-park episode timestamps, the restore wake-capable doorbell, needs-auth navigation to Connectors, and exact notice destinations.
- Final action-surface regressions: 6 focused mobile tests, 23 web tests, 16 focused client tests, and 28 focused gateway tests passed, covering native artifact editing, exact notice destinations, the real automation turn feed, local closed-PWA notification composition/dedupe, purpose-limited service-worker authorization, and `ai_agent` notice attribution.
- Closed-PWA transport regression: 17 worker/Iroh/web-host tests and the production web build passed; the no-window test proves both canonical pulls use the worker-owned authenticated Iroh endpoint, never the static web origin, deduplicate delivery, and release the endpoint afterward.
- Gateway, vault, client, mobile, desktop, and blueprints typechecks passed.
- `bun run coverage`: passed 811 test files / 6,833 tests; the blueprints-kit branch group is 40.57% (37% floor).
- `bun run check:pr`: passed on the final code snapshot — 730 test files passed (1 skipped), 5,982 tests passed (7 skipped), and changed-line coverage was 86.6% (1,057/1,220).
- `bun run check:full`: install/static gates, the repeated PR gate, full affected-dependent tests, repository coverage, mutation selection, and all low-end performance budgets passed. Desktop e2e originally failed four stale Appearance tests (Accent radiogroup / old theme labels leftover from #608); those specs are fixed on this branch (see below) so the lane is green end-to-end.
- `bun run --cwd apps/web e2e`: passed all 14 tests.
- Manual desktop/mobile-simulator notification interaction was not run in this headless worktree; the delivery, local composition, dedupe, action, SSE, and opaque-payload paths are covered by automated client and route gates.

### Review-fix round verification (2026-07-31)

- Per-slice suites after the fixes: gateway 182 files / 1,254 tests passed (6 skipped); automation 25 files / 376 passed; blueprints 48 files / 659 passed; client full suite 193 files / 1,488 passed; mobile 58 files / 326 passed; desktop 27 files / 244 passed. Typecheck clean on all six packages.
- Sabotage checks: each behavioral fix (kit outcome shapes, D3 pinning, keepPreviousData + focus, notification seeding/visibility, paused-skip suppression, doorbell coalescing) was reverted in isolation and made its new tests fail, then restored.
- `bun run check:pr` re-run on the combined snapshot: every static gate green (format, lint, lint:types after two switch-exhaustiveness fixes, knip, css/design-token/protocol lints, matrix, ratchets, native-state).
- `check:diff-coverage` (the local preview of CI's authoritative `verify` coverage job, per its own header) ran 5,689 tests with 3 failures under the full 10-project instrumented sweep — `wal.integration.test.ts` G5 ×2 and `install-over-http.test.ts` union listing — all timing-sensitive suites that pass 24/24 in isolation both with and without `--coverage` on this snapshot; consistent with the documented local concurrency-saturation flakes. CI `verify` on the pushed snapshot is the arbiter.
- `expo-web-browser@~57.0.2` added for the mobile reconnect fix; `pod install` delta is the six ExpoWebBrowser lines, and `verify-native-state` reports pod lock, project paths, and iOS/Android fingerprints in agreement.

### Main-CI baseline fixes landed on this branch (2026-07-31)

Pre-existing reds on `main` (and therefore on this PR's gate) that were observed during review, not caused by the Inbox work:

- **Appearance e2e staleness (#608 residual).** Updated `apps/desktop/tests/e2e/settings-gateways.spec.ts` (and `SCENARIOS.md`) to the consolidated Appearance UI: no Accent radiogroup, theme is a Segmented `tablist` labelled "Appearance" with Light / Dark / Match system. Full desktop e2e lane: **54 passed, 4 skipped**.
- **Layout tree non-determinism (#445 warmer race).** `embedded-gateway-layout.test.ts` now seeds both warmer caches and excludes `cache/model-catalog.json` + `cache/model-pricing.json` from `treeShape`, so desktop vs headless tree comparison is network- and CLI-independent. Focused suite: **2 passed**.

## Audit

Fresh-context publication audit: **PASS**. The auditor rechecked the final staged snapshot after the closed-PWA correction and confirmed the worker-owned production Iroh transport closes the prior D7 blocker.

## Steering

Fresh-context steering audit: **PASS**. The final snapshot remains within issue #647 and its required supporting transport/build work.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019fb401-a5c-1785448606-1 | codex | 019fb401-a5c2-77f0-9448-c4d8c024ad52 | #647 | gpt-5.6-sol | 4075431 | 0 | 128861184 | 254167 | 4329598 | 46.2164 | 4075431 | 0 | 128861184 | 254167 |  |
| claude-code-940406ef-8ec-1785471483-1 | claude-code | 940406ef-8ec0-488a-a59e-e8ac91415b43 | #647 | claude-opus-5 | 504 | 2325062 | 35993561 | 357705 | 2683271 | 41.4736 | 504 | 2325062 | 35993561 | 357705 |  |
| claude-code-940406ef-8ec-1785472218-1 | claude-code | 940406ef-8ec0-488a-a59e-e8ac91415b43 | #647 | claude-fable-5 | 53 | 387978 | 5659910 | 15177 | 403208 | 11.2690 | 557 | 2713040 | 41653471 | 372882 |  |
| claude-code-940406ef-8ec-1785472285-1 | claude-code | 940406ef-8ec0-488a-a59e-e8ac91415b43 | #647 | claude-fable-5 | 4 | 8528 | 457862 | 1824 | 10356 | 0.6557 | 561 | 2721568 | 42111333 | 374706 |  |
| claude-code-940406ef-8ec-1785472370-1 | claude-code | 940406ef-8ec0-488a-a59e-e8ac91415b43 | #647 | claude-fable-5 | 10 | 6421 | 1410895 | 2618 | 9049 | 1.6222 | 571 | 2727989 | 43522228 | 377324 |  |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
