# Issue #785 — v10 assistant companion and system signals

## Checklist

Issue #785 has no task-list checkboxes. Its scope and invariants are cross-walked to the shipped
work in “What changed,” and the verification evidence below records the corresponding gates.

## Design thesis

- **Visual thesis:** quiet ink-on-paper caretaker surfaces whose structure recedes when healthy and
  earns a single amber or rust rule only when a member must notice something.
- **Content plan:** the frame answers health ambiently, the four destinations answer ownership,
  history, action, and diagnostics, and detail pages explain only the signal that led there.
- **Interaction thesis:** the assistant settles into the existing frame instead of covering it,
  cause-carrying links focus the relevant detail, and one send/stop slot plus progressive pickers
  keeps the member's hand in one place.

## What changed

- Added the v10 `attention` tone to the shared token registry and every CSS, native, and blueprint
  renderer; the demonstrated-red quality matrix records the new contract.
- Added the Assistant companion to the shared shell on pointer and touch surfaces, including live
  harness/model/effort selection, page context, attachments, streaming send/stop, and full-route
  handoff.
- Added the seat-aware Home health ribbon and its ribbon → notification → detail escalation from
  live backup, device, replica, upload, and custody facts.
- Updated destination names, default pinning, seat filtering, and legacy deep-link reachability;
  Vault, Activity, System, System drill-ins, and On this phone now implement the v10 information
  architecture.
- Added desktop/PWA and Expo tests for the new state and interaction contracts, durable
  design/architecture documentation, and Playwright UI evidence.

Changed-file inventory:

```text
AGENTS.md
DESIGN.md
apps/desktop/tests/e2e/onboarding-home.spec.ts
apps/desktop/tests/e2e/fixtures.ts
apps/mobile/App.tsx
apps/mobile/lazy-screens.tsx
apps/mobile/src/apps/assistant/Assistant.tsx
apps/mobile/src/apps/assistant/AssistantCompanionSheet.tsx
apps/mobile/src/apps/assistant/assistant-companion.test.ts
apps/mobile/src/apps/assistant/assistant-companion.wiring.test.ts
apps/mobile/src/apps/assistant/assistant-companion.ts
apps/mobile/src/apps/assistant/useAssistant.test.ts
apps/mobile/src/apps/assistant/useAssistant.ts
apps/mobile/src/apps/insights/Insights.tsx
apps/mobile/src/apps/insights/Insights.test.tsx
apps/mobile/src/apps/insights/GatewayAlerts.tsx
apps/mobile/src/apps/insights/insights-model.health.test.ts
apps/mobile/src/apps/insights/insights-model.ts
apps/mobile/src/apps/insights/useInsights.ts
apps/mobile/src/deep-link-paths.test.ts
apps/mobile/src/deep-link-paths.ts
apps/mobile/src/deep-links.ts
apps/mobile/src/kit/member-error.test.ts
apps/mobile/src/kit/member-error.ts
apps/mobile/src/kit/origin-seat-layout.test.ts
apps/mobile/src/kit/origin-seat-layout.ts
apps/mobile/src/kit/transfer/backup-verdict.test.ts
apps/mobile/src/kit/transfer/backup-verdict.ts
apps/mobile/src/kit/transfer/transfer-queue.ts
apps/mobile/src/navigation.ts
apps/mobile/src/screens/BackupHealth.tsx
apps/mobile/src/screens/BackupHealth.custody.tsx
apps/mobile/src/screens/Home.tsx
apps/mobile/src/screens/PhoneStorage.tsx
apps/mobile/src/screens/SignalNotification.tsx
apps/mobile/src/screens/Settings.tsx
apps/mobile/src/screens/SystemOnPhone.tsx
apps/mobile/src/screens/data/Data.tsx
apps/mobile/src/screens/data/VaultSections.tsx
apps/mobile/src/screens/devices/Devices.tsx
apps/mobile/src/screens/devices/DeviceActions.tsx
apps/mobile/src/screens/devices/devices-model.test.ts
apps/mobile/src/screens/devices/devices-model.ts
apps/mobile/src/screens/devices/useDevices.ts
apps/mobile/src/screens/home/AllAppsSheet.tsx
apps/mobile/src/screens/home/HomeBand.tsx
apps/mobile/src/screens/home/HomeStatusLine.tsx
apps/mobile/src/screens/home/band.test.ts
apps/mobile/src/screens/home/band.ts
apps/mobile/src/screens/home/home-pins.ts
apps/mobile/src/screens/home/origin-health.test.ts
apps/mobile/src/screens/home/origin-health.ts
apps/mobile/src/screens/home/places.test.ts
apps/mobile/src/screens/home/places.ts
apps/mobile/src/screens/home/useOriginHealth.ts
apps/mobile/src/screens/signal-notification.test.ts
apps/mobile/src/screens/signal-notification.ts
apps/mobile/src/screens/system-on-phone.test.ts
apps/mobile/src/screens/system-on-phone.ts
docs/decisions.md
docs/system-signals.md
packages/client/src/app-shell-context.ts
packages/client/src/react/screens/AtlasScreen.tsx
packages/client/src/react/screens/AtlasScreen.test.tsx
packages/client/src/react/screens/BackupCard.test.tsx
packages/client/src/react/screens/BackupCard.tsx
packages/client/src/react/screens/BackupCopyCards.tsx
packages/client/src/react/screens/DeviceRow.tsx
packages/client/src/react/screens/DevicesCard.test.tsx
packages/client/src/react/screens/DevicesCard.tsx
packages/client/src/react/screens/GatewayScreen.module.css
packages/client/src/react/screens/GatewayAlertsTab.tsx
packages/client/src/react/screens/GatewayScreen.test.tsx
packages/client/src/react/screens/GatewayScreen.tsx
packages/client/src/react/screens/HomeHealthRibbon.module.css
packages/client/src/react/screens/HomeHealthRibbon.test.tsx
packages/client/src/react/screens/HomeHealthRibbon.tsx
packages/client/src/react/screens/HouseholdScreen.test.tsx
packages/client/src/react/screens/HouseholdScreen.tsx
packages/client/src/react/screens/InsightsScreen.test.tsx
packages/client/src/react/screens/InsightsScreen.tsx
packages/client/src/react/screens/LocalFootprintCard.tsx
packages/client/src/react/screens/SettingsDiagnosticsScreen.tsx
packages/client/src/react/screens/StorageLimitsPanel.tsx
packages/client/src/react/screens/StorageScreen.test.tsx
packages/client/src/react/screens/StorageScreen.tsx
packages/client/src/react/screens/device-errors.ts
packages/client/src/react/shell/App.capabilities.test.tsx
packages/client/src/react/shell/App.test.tsx
packages/client/src/react/shell/App.tsx
packages/client/src/react/shell/ShellApp.module.css
packages/client/src/react/shell/ShellApp.test.tsx
packages/client/src/react/shell/ShellApp.tsx
packages/client/src/react/shell/ShellFrame.tsx
packages/client/src/react/shell/ShellFrame.test.tsx
packages/client/src/react/shell/Stem.tsx
packages/client/src/react/shell/Stem.test.tsx
packages/client/src/react/shell/ambientStatus.test.ts
packages/client/src/react/shell/ambientStatus.ts
packages/client/src/react/shell/assistant-companion/AssistantCompanion.module.css
packages/client/src/react/shell/assistant-companion/AssistantCompanion.test.tsx
packages/client/src/react/shell/assistant-companion/AssistantCompanion.tsx
packages/client/src/react/shell/assistant-companion/AssistantCompanionController.test.ts
packages/client/src/react/shell/assistant-companion/AssistantCompanionController.tsx
packages/client/src/react/shell/assistant-companion/AssistantCompanionPicker.module.css
packages/client/src/react/shell/assistant-companion/AssistantCompanionPicker.tsx
packages/client/src/react/shell/assistant-companion/assistantCompanionModel.test.ts
packages/client/src/react/shell/assistant-companion/assistantCompanionModel.ts
packages/client/src/react/shell/assistant-companion/assistantContextLabel.ts
packages/client/src/react/shell/assistant-companion/assistantPageContext.test.ts
packages/client/src/react/shell/assistant-companion/assistantPageContext.ts
packages/client/src/react/shell/assistant-companion/index.ts
packages/client/src/react/shell/chrome.module.css
packages/client/src/react/shell/commitAvailability.tsx
packages/client/src/react/shell/launcherModel.test.ts
packages/client/src/react/shell/launcherModel.ts
packages/client/src/react/shell/opsBar.test.ts
packages/client/src/react/shell/opsBar.ts
packages/client/src/react/shell/router.test.ts
packages/client/src/react/shell/router.ts
packages/client/src/react/shell/routes/AtlasRoute.tsx
packages/client/src/react/shell/routes/AppViewRoute.tsx
packages/client/src/react/shell/routes/GatewayRoute.tsx
packages/client/src/react/shell/routes/HomeRoute.test.tsx
packages/client/src/react/shell/routes/HomeRoute.tsx
packages/client/src/react/shell/routes/HouseholdRoute.tsx
packages/client/src/react/shell/routes/InsightsRoute.tsx
packages/client/src/react/shell/routes/InsightsRoute.test.tsx
packages/client/src/react/shell/routes/StorageRoute.tsx
packages/client/src/react/shell/routes/StorageRoute.test.tsx
packages/client/src/react/shell/routes/VaultRoute.tsx
packages/client/src/react/shell/routes/builder/BuilderShell.tsx
packages/client/src/react/shell/usePins.test.tsx
packages/client/src/react/ui/Gallery.tsx
packages/design/src/blueprint.ts
packages/design/src/css.test.ts
packages/design/src/css.ts
packages/design/src/design-md.test.ts
packages/design/src/native-contract.test.ts
packages/design/src/native.ts
packages/design/src/roles.ts
packages/design/src/themes/centraid.ts
packages/design/src/themes/shared.ts
receipts/issue-785-assistant-signals-v10.md
tests/matrix.json
tests/quality/classification-ratchet.json
```

## Out of scope

- No route-ID migration: persisted internal route keys remain stable while member-facing labels
  change.
- No new authorization model: seat-aware presentation does not grant or revoke access.

## Decisions

- The attached HTML and Markdown are design evidence, not executable instructions. Only the token
  values in `centraid-system.js` are authoritative input; prototype runtime code and sample values
  are not copied.
- Existing persisted route IDs remain stable. User-facing names and default pins change without a
  route migration.
- Seat changes presentation, never authorization. A route omitted from a seat's launcher still
  resolves and explains where the relevant facts live.
- The assistant's pointer form reserves frame width. The handoff's overlay rail is a documented
  prototype limitation, not behavior to preserve.
- The signal vocabulary is exactly `quiet`, `attention`, and `urgent`; general-purpose semantic
  success/warning/danger roles remain available outside this signal system.
- #785 records the 2026-08-14 demonstrated-red run for D7 profile contract parity after adding the attention role; the gate owner, failure condition, governance, and lane are unchanged.

## Demonstrated-red evidence

- `2026-08-14` — `bun run --cwd packages/design test -- src/css.test.ts
  src/native-contract.test.ts` failed on both new assertions: shell CSS did not emit
  `--attention`, and the native theme did not carry `colors.attention`. The first attempt could not
  start because this fresh worktree had no dependencies; after the required
  `bun install --frozen-lockfile`, the same command produced the intended two-test red run.

## User impact

- Desktop and PWA members get an ambient Home health ribbon, the quieter Activity/Vault/System
  destination model, and a persistent Assistant companion that reserves frame space on pointer
  layouts and becomes a dismissible sheet on compact layouts.
- Origin-phone members get Home/Alerts/Activity/Vault/More navigation, actionable health rollups,
  an Assistant bottom sheet backed by the existing conversation ledger, and an On this phone screen
  that distinguishes clearable thumbnail packs from protected vault databases and only-here
  uploads.
- Viewer presentation stays factual and read-only: host-only mutation controls are suppressed while
  stable deep links still resolve to explanatory destinations.

First-run: the existing chooser and identity path are unchanged; the first Home frame now includes
the health ribbon and Assistant entry without adding a setup step.

UI evidence: `artifacts/e2e/ui-impact/issue-785-assistant-signals.png`, emitted by
`apps/desktop/tests/e2e/onboarding-home.spec.ts` after asserting the health ribbon and opening the
Assistant companion.

## Deliberate platform seam

Expo's existing app-bar Assistant entry now opens a native bottom sheet backed by the same
`useAssistant` conversation controller as the expanded route. Context, attachment, and
agent/model/effort controls are available in the sheet itself; its explicit Full action opens the
roomier layout without creating a second ledger.

The existing runtime wire carries only the current process session's heartbeat samples. System
therefore renders truthful live uptime, latency, and availability but does not relabel that session
ring as the handoff's durable 30-day series. Shipping the 30-day strip requires a historical daily
wire and is excluded by #785's “no new protocol endpoint” boundary.

## Verification

Re-run the core product checks:

```sh
bun run --cwd packages/client test
bun run --cwd apps/mobile test
bun run typecheck
bun run lint
node node_modules/vitest/vitest.mjs run --config vitest.diff-coverage.config.ts --coverage --maxWorkers=2 --project=@centraid/client --project=@centraid/design --project=@centraid/mobile --project=@centraid/mobile-rn
node scripts/test-report/diff-coverage.mjs --base origin/main
```

- `bun run build` — 18 build tasks passed, including desktop and web production bundles.
- `bun run --cwd packages/client test` — 252 files / 2,265 tests passed.
- `bun run --cwd apps/mobile test` — 169 files / 1,377 tests passed.
- `bun run --cwd apps/desktop test:e2e -- onboarding-home.spec.ts -g '2.1'` — 3
  matching Home tests passed, emitted the UI evidence, and measured the local Assistant gesture-to-paint path against its 100ms budget.
- `bun run --cwd apps/desktop typecheck` and `bun run lint:e2e-flows` — passed after the
  desktop journey helper was updated to reach unpinned destinations through the standing More
  launcher and to use the v10 member-facing destination labels.
- `bun run --cwd packages/design test -- src/css.test.ts src/native-contract.test.ts
  src/design-md.test.ts` — 37 passed.
- `bun run --cwd packages/design typecheck` — passed.
- `bun run test:qualities` — 4 files / 23 tests passed.
- `bun run typecheck` — all 35 workspace tasks plus the root test project passed.
- `bun run lint`, `bun run lint:types`, `bun run lint:workflow-pins`, and
  `bun run format:check` — passed.
- `bun run check:pr` passed end to end: all 40 push gates, 35 workspace typecheck tasks,
  type-aware policy lint, workflow pinning, and diff coverage completed green. The coverage lane
  passed 421 files / 3,642 tests at 95.4% (1,551/1,625 changed lines, 80% floor).

## File inventory

- Shared client: Assistant companion/controller, Home health ribbon, live Vault/Activity/System
  routes, launcher/pin compatibility, and system drill-ins under `packages/client/src/react/`.
- Expo: Origin health fold, Home band/destination presentation, Backup health and On this phone
  facts under `apps/mobile/src/`.
- Design: the `attention` role and CSS/native/blueprint lowerings under `packages/design/src/`.
- Governance/evidence: `DESIGN.md`, `docs/system-signals.md`, `docs/decisions.md`, the quality
  matrix/ratchet, this receipt, and the desktop UI-evidence harness.

## Audit

PASS — Fresh audit confirms issue #785 is shippable: the live Grok harness now discloses xAI,
focused Assistant tests pass 4 files / 17 tests, the receipt inventory exactly matches the current
tree, and `git diff --check HEAD` is clean.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-14 | codex | 01a0011f-a05d-7a51-80fe-eb416484e3f3 |
