# Issue #665 — Fresh-vault first-run QA: inbox noise, vault-first switcher/pairing, responsive pages, opencode cold-start

## Checklist

- [x] boot-phase probe failures no longer open an outage
- [x] Gateway health no longer reaches the Inbox at all
- [x] degraded detail only claims latency when latency caused it
- [x] needs me excludes info-severity notices
- [x] switcher redesigned to the compact selector idiom
- [x] add gateway reworded to add vault with vault-first pairing copy
- [x] adding a vault reuses the onboarding ticket flow
- [x] keep an offline copy defaults on and moves to settings
- [x] vault vocabulary sweep replaces space in user-facing copy
- [x] settings agents lanes responsive
- [x] gateway runtime page responsive
- [x] opencode models appear on a cold gateway
- [x] gateway health retired from the notifications surface
- [x] switcher shows vaults only, flattened across connections
- [x] disconnect is a per-vault act naming its siblings
- [x] host plumbing lives in diagnostics
- [x] the personal vault heads every vault listing
- [x] space retired from identifiers, not only copy
- [x] inbox renamed to notifications across copy, wire, and schema

## What changed

- A vault never inherits inbox cards from before it was active — superseded because gateway health is no longer projected into the inbox stream at all (see the health-removal bullet below).
- **Boot-phase probe failures no longer open an outage** — `apps/desktop/src/main/gateway-monitor-core.ts` adds `GatewayProbe.bootPhase` + `isPendingBootProbe`; `gateway-monitor.ts` leaves such ticks at `status: unknown`, so no outage opens, no severity-high "unreachable" card derives, and the eventual first success is `unknown → up`, which derives no paired "recovered". Suppression is narrow: only synthesized failures while status is still `unknown`; a real failed HTTP probe or crash-looped supervisor alerts from the first tick.
- **Gateway health no longer reaches the Inbox at all** (supersedes the earlier vault-scoped-projection-mark fix in this same issue) — health is STATUS, not a decision: no Inbox action un-degrades a gateway, so a persistent "degraded" card could only be dismissed and come straight back. The desktop's dual-write into the vault Inbox (#647) is removed end to end. `apps/desktop/src/main/gateway-monitor.ts` drops `postGatewayInboxEvents`, the flush, and the mark bookkeeping; `gateway-outage-log-core.ts` drops `gatewayInboxEvent`/`GatewayInboxEvent`, `InboxProjectionMark`, `outageEventMark`, `vaultScopedProjectionMark`, `eventsAfterMark`, `inboxProjectionTarget`, `seedProjectionMarks`, `INBOX_FLUSH_BATCH`, and `OutageLogFile`; `gateway-outage-log.ts` drops `persistProjectionMarks` and now reads/writes a plain `OutageLogEvent[]`. `packages/gateway/src/routes/vault-routes.ts` deletes its only consumer, `POST /centraid/_vault/inbox/gateway-health`. **Kept:** the durable outage log itself — events, capping, NDJSON parse/format, `deriveOutageEvents`, boot-phase suppression (`isPendingBootProbe`), and `degradedDetail` — because the Alerts tab reads it and it is the post-mortem trail. Health's homes are unchanged: Gateway Overview status card, Components tab, `AlertHistoryPanel`, and the threshold-gated OS notification.
- **Outage-log NDJSON schema 3→4** — marks are no longer written. Read compatibility is unconditional and permanent by construction rather than by a shim: a `projection-mark` line is not an event line (`isOutageLogEvent` rejects anything carrying a `type`), so an existing schema-3 file parses to exactly its events and the marks are dropped the first time the file is rewritten. Pinned by a test that feeds a full schema-3 file (header + events + two mark lines) through parse and asserts the events survive and a re-format contains no marks.
- **Degraded detail only claims latency when latency caused it** — `degradedDetail()` in `gateway-outage-log-core.ts` trusts `latencyDegraded`; otherwise it names the unhealthy components; otherwise no detail. Kills the nonsense "Local is degraded — 4ms latency" card.
- **Needs me excludes info-severity notices** — `packages/client/src/react/screens/ApprovalsScreen.tsx` filters `severity === "info"` out of the Needs-me chip; info notices (e.g. "recovered") stay reachable under their source-type chips and Archived.
- **Switcher redesigned to the compact selector idiom** — `packages/client/src/react/shell/IdentityHead.tsx/.module.css` put the gateway eyebrow above the bold vault name with a ⌃/⌄ stepper composed from the existing ChevronDown glyph; `gatewaySwitcher.ts/.module.css` polish the popover to match (tokens only, data-* state, reduced-motion support); footer action is now "Add vault…".
- **Add gateway reworded to add vault with vault-first pairing copy** — `ConnectFlowModal.tsx` ("Add vault"), `ConnectFlow.tsx` ("Existing vault / Paste or scan a pairing ticket."), `ConnectFlowDetailsStep.tsx` placeholder framed around the vault (CLI command kept verbatim), plus `README.md` / `docs/dev-environment.md` / `tests/onboarding-scenarios.md` pointers.
- **Adding a vault reuses the onboarding ticket flow** — new shared `ConnectTicketPanel.tsx` (ticket step + keychain heads-up + intro copy) rendered by both `OnboardingScreen.tsx` and the Add vault modal; keychain probe extracted to `screens/useKeychainPrompt.ts`. Local fresh-vault creation is preserved where offered.
- **Keep an offline copy defaults on and moves to settings** — `connectFlow-core.ts` `rememberDevice` initial state → true; checkbox removed from `ConnectFlowDetailsStep.tsx`; `SettingsDeviceScreen.tsx/.module.css` gain a real toggle wired through `settingsAccountData.ts`/`SettingsRoute.tsx` → new `setGatewayRememberDevice` host call (`centraid-api.d.ts`); desktop `ipc-core.ts`/`ipc.ts`/`preload-core.ts` add `GATEWAY_REMEMBER_DEVICE_SET` (broadcasting a replica purge on disable); `apps/web/src/web-host.ts` reuses the pairing path's purge/persist semantics. Both hosts implemented; nothing crosses the gateway wire.
- **Vault vocabulary sweep replaces space in user-facing copy** — switcher eyebrow/subtitles, ConnectFlow vault step, Household, Settings, onboarding, toasts, aria-labels, and mobile (SpacesSwitcher/SpaceDrawer/SpaceSection/Onboarding/Insights) all say vault; `docs/glossary.md` now blesses "vault" and forbids "space" in copy, with a dual-vocabulary row noting identifiers keep their names. Includes a latent-bug fix: `App.tsx`'s ⌘⇧G selector was an exact aria-label match that never matched the real suffixed label; now a suffix match.
- **Settings agents lanes responsive** — `SettingsProvidersScreen.module.css` switches to container queries (`providers-panel`, 720/440px stops), `minmax(210px, 1fr) auto` columns so selects can't starve the label, wrapping selects with ellipsis as last resort (`SettingsProvidersSelects.tsx` adds the `selectField` wrapper class), bullet dot pinned to the first text line.
- **Gateway runtime page responsive** — `packages/client/src/react/screens/GatewayScreen.tsx/.module.css`: page is a container (`gateway-page`, 1080/720/560px stops), gauge row becomes a wrapping grid with `min-width: 0` throughout, status headline reflows, tabs scroll horizontally, identity/alert rows stack at narrow widths. The "log resets when the app relaunches" copy was verified accurate (in-session card; durable history lives in the Alerts tab) and left alone.
- **Opencode models appear on a cold gateway** — `packages/gateway/src/serve/build-gateway.ts` passes `probeIfMissing: true` to `resolveAcpCapabilities`, delivering the "probe once on first read when cold" behavior its call-site comment already promised; previously an installed+authed opencode showed no models until a manual Refresh.

- **Gateway health retired from the notifications surface** — the desktop dual-write, the receiving route, and the vault-scoped projection marks are gone; the durable outage log stays for the Alerts tab. Health is status, not a decision.
- **Switcher shows vaults only, flattened across connections** — `gatewaySwitcher.ts` + `gatewayRegistry.ts`; the registry already fetched each host's vault list and kept only the count, so this costs no extra requests.
- **Disconnect is a per-vault act naming its siblings** — Settings > Vault danger zone; `disconnectConfirmCopy` names every vault sharing the connection, and a test asserts the word "gateway" cannot appear in it.
- **Host plumbing lives in diagnostics** — `SettingsDiagnosticsScreen` Connections section (test / rename / remove); the short-lived Settings > Gateways page is deleted.
- **The personal vault heads every vault listing** — hoisted in `VaultRegistry.list()`; `planesList()` deliberately keeps founding order because `backup-service.ts` roots the seal-key KeyStore at `planesList()[0]`.
- **Space retired from identifiers, not only copy** — `SettingsVaultScreen`, `vaultModals`, `VaultModal`, `data-vault-id`, settings page id `vault`, mobile `VaultsSwitcher`/`vault-links.ts`/`vaults.*` keys.
- **Inbox renamed to notifications across copy, wire, and schema** — `/_vault/notifications`, `notifications-changed`, `notifications_notice` table via a forward-only rung, `NoticeStore`. Existing dev notices are dropped, not copied.

## Decisions

- Boot-phase suppression is modeled as "pending" (`status: unknown` untouched) rather than a suppression flag — the down/recovered pair vanishes together by construction, and genuine remote-unreachable-at-launch alerting is preserved because only synthesized (non-HTTP) failures qualify.
- Gateway health is removed from the Inbox rather than filtered, scoped, or de-duplicated further. The Inbox is for what only the owner can RESOLVE (staged approvals, reconnect prompts, scope requests) plus app/automation/agent news; a status card fails that test by construction. This retires the vault-scoped projection mark shipped earlier in this same issue — it was the right fix for the wrong feature.
- The wire route `POST /centraid/_vault/inbox/gateway-health` is DELETED, not deprecated. It was never in `packages/protocol/src/routes.ts` (which exposes only `vaultInbox` / `vaultInboxEvents`), carried no `COMPAT(...)` tag, and had exactly one caller — the desktop monitor removed in the same change. Per `docs/protocol.md` C2 the deprecation convention applies to tagged shims for older peers; an untagged, unpublished, single-caller route is dead code.
- Already-persisted `gateway-health` notices are left alone: no destructive migration, and the client's `gateway-health` icon/severity/deep-link branches stay so those rows still render recognisably and still deep-link to Gateway → Alerts. An owner clears them with Archive, as with any notice.
- Vocabulary sweep is copy-only by explicit scope: `Space*` identifiers, file names, props, the `space` settings-page id, and mobile `spaces.*` storage keys keep their names pending a mechanical rename.
- The user-facing word is "vault" (owner decision in-session), overriding the previous glossary row that blessed "space"; the glossary was updated rather than the copy reverted.
- "Needs me" filters on severity, not source kind — any info notice is news, not an obligation; warning/high keep their place regardless of source.
- The Add-vault modal shares the onboarding ticket step (`ConnectTicketPanel`) rather than being fully replaced by `OnboardingScreen` — identity/import steps are onboarding-only concerns; sharing the step component and state core makes the two surfaces identical where they overlap.

## Out of scope

- Renaming `Space*` identifiers/files/props/storage keys (tracked in the glossary dual-vocabulary row).
- `docs/client-keying.md` "space" key-axis names (not UI copy).
- Cross-linking the Gateway Overview outage card to the durable Alerts history.
- Server-side collapse of `recovered` onto its `down` card.
- A migration that deletes `gateway-health` rows already written into `vault.db`. Owners archive them like any other notice.
- Mobile's `apps/mobile/src/apps/insights/GatewayAlerts.tsx`, which reads `gateway-health` notices out of the Inbox and therefore now shows only legacy rows (and "No gateway alerts" once they are archived). Retargeting it at a real gateway-health surface is a mobile change that must ship iOS+Android together — flagged, not attempted here.

## Files touched

Full-path coverage of the change set:

- `CHANGELOG.md`
- `README.md`
- `apps/desktop/src/main/gateway-monitor-core.test.ts`
- `apps/desktop/src/main/gateway-monitor-core.ts`
- `apps/desktop/src/main/gateway-monitor-notifications.test.ts`
- `apps/desktop/src/main/gateway-monitor.ts`
- `apps/desktop/src/main/gateway-outage-log-core.test.ts`
- `apps/desktop/src/main/gateway-outage-log-core.ts`
- `apps/desktop/src/main/gateway-outage-log.ts`
- `apps/desktop/src/main/ipc-core.ts`
- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/src/main/preload-core.test.ts`
- `apps/desktop/src/main/preload-core.ts`
- `apps/mobile/src/apps/assistant/Assistant.tsx`
- `apps/mobile/src/apps/automations/Automations.tsx`
- `apps/mobile/src/apps/insights/GatewayAlerts.tsx`
- `apps/mobile/src/apps/insights/Insights.tsx`
- `apps/mobile/src/apps/insights/useInsights.ts`
- `apps/mobile/src/apps/photos/PhotosDrawer.tsx`
- `apps/mobile/src/apps/photos/PhotosHome.tsx`
- `apps/mobile/src/apps/photos/PhotosLibrary.tsx`
- `apps/mobile/src/components/OutboxDecisionCard.tsx`
- `apps/mobile/src/kit/components/OptionSheet.tsx`
- `apps/mobile/src/kit/replica/ReplicaProvider.tsx`
- `apps/mobile/src/lib/automations.test.ts`
- `apps/mobile/src/lib/automations.ts`
- `apps/mobile/src/lib/connection-reauth.test.ts`
- `apps/mobile/src/lib/connection-reauth.ts`
- `apps/mobile/src/lib/decision-detail.ts`
- `apps/mobile/src/lib/gateway.ts`
- `apps/mobile/src/lib/insights.ts`
- `apps/mobile/src/lib/notification-model.test.ts`
- `apps/mobile/src/lib/notification-model.ts`
- `apps/mobile/src/lib/notifications-artifact-editor.test.ts`
- `apps/mobile/src/lib/notifications-artifact-editor.ts`
- `apps/mobile/src/lib/notifications-core.ts`
- `apps/mobile/src/lib/notifications-navigation.test.ts`
- `apps/mobile/src/lib/notifications-navigation.ts`
- `apps/mobile/src/lib/notifications-plan.test.ts`
- `apps/mobile/src/lib/notifications-plan.ts`
- `apps/mobile/src/lib/notifications.tsx`
- `apps/mobile/src/lib/phone-link.ts`
- `apps/mobile/src/lib/profile.ts`
- `apps/mobile/src/lib/replica/background-sync.ts`
- `apps/mobile/src/lib/replica/multi-vault-reader.ts`
- `apps/mobile/src/lib/vault-links.test.ts`
- `apps/mobile/src/lib/vault-links.ts`
- `apps/mobile/src/navigation.ts`
- `apps/mobile/src/screens/Approvals.tsx`
- `apps/mobile/src/screens/Home.tsx`
- `apps/mobile/src/screens/Onboarding.tsx`
- `apps/mobile/src/screens/Settings.tsx`
- `apps/mobile/src/screens/home/AttentionLine.tsx`
- `apps/mobile/src/screens/home/GreetingHeader.tsx`
- `apps/mobile/src/screens/home/VaultDrawer.tsx`
- `apps/mobile/src/screens/home/VaultsSwitcher.tsx`
- `apps/mobile/src/screens/home/catalog.test.ts`
- `apps/mobile/src/screens/settings/ColorSwatchRow.tsx`
- `apps/mobile/src/screens/settings/SettingsSection.tsx`
- `apps/mobile/src/screens/settings/VaultSection.tsx`
- `apps/mobile/src/screens/settings/YouSection.tsx`
- `apps/web/public/sw.js`
- `apps/web/src/iroh-transport.ts`
- `apps/web/src/sw-notifications-wake.test.ts`
- `apps/web/src/sw-runtime.test-fixtures.ts`
- `apps/web/src/sw-runtime.test.ts`
- `apps/web/src/web-host.test.ts`
- `apps/web/src/web-host.ts`
- `docs/client-keying.md`
- `docs/config-ownership.md`
- `docs/decisions.md`
- `docs/dev-environment.md`
- `docs/glossary.md`
- `docs/refactors/inline-system-apps.md`
- `packages/automation/src/manifest/manifest.test.ts`
- `packages/automation/src/manifest/manifest.ts`
- `packages/blueprints/kit/kit.ts`
- `packages/blueprints/src/kit-smoke.test.ts`
- `packages/client/src/app-shell-context.ts`
- `packages/client/src/centraid-api.d.ts`
- `packages/client/src/gateway-auth.ts`
- `packages/client/src/gateway-client-conversation-history.contract.test.ts`
- `packages/client/src/gateway-client-conversation-history.ts`
- `packages/client/src/gateway-client-conversation.ts`
- `packages/client/src/gateway-client-devices.ts`
- `packages/client/src/gateway-client-editing.contract.test.ts`
- `packages/client/src/gateway-client-editing.ts`
- `packages/client/src/gateway-client-members.contract.test.ts`
- `packages/client/src/gateway-client-members.ts`
- `packages/client/src/gateway-client-outbox.ts`
- `packages/client/src/gateway-client-push.test.ts`
- `packages/client/src/gateway-client-push.ts`
- `packages/client/src/gateway-client-vault.ts`
- `packages/client/src/gateway-client.ts`
- `packages/client/src/notifications-model.ts`
- `packages/client/src/react/blueprints/kit-ask-inline.ts`
- `packages/client/src/react/boot.tsx`
- `packages/client/src/react/screen-contracts.ts`
- `packages/client/src/react/screens/ApprovalsScreen.module.css`
- `packages/client/src/react/screens/ApprovalsScreen.test.tsx`
- `packages/client/src/react/screens/ApprovalsScreen.tsx`
- `packages/client/src/react/screens/DeviceMemberGroup.tsx`
- `packages/client/src/react/screens/DevicePairPanel.test.tsx`
- `packages/client/src/react/screens/DevicePairPanel.tsx`
- `packages/client/src/react/screens/DevicePairTarget.tsx`
- `packages/client/src/react/screens/DeviceRow.tsx`
- `packages/client/src/react/screens/DevicesCard.module.css`
- `packages/client/src/react/screens/DevicesCard.test.tsx`
- `packages/client/src/react/screens/DevicesCard.tsx`
- `packages/client/src/react/screens/GatewayScreen.module.css`
- `packages/client/src/react/screens/GatewayScreen.tsx`
- `packages/client/src/react/screens/HouseholdScreen.module.css`
- `packages/client/src/react/screens/HouseholdScreen.test.tsx`
- `packages/client/src/react/screens/HouseholdScreen.tsx`
- `packages/client/src/react/screens/InsightsScreen.module.css`
- `packages/client/src/react/screens/OnboardingScreen.test.tsx`
- `packages/client/src/react/screens/OnboardingScreen.tsx`
- `packages/client/src/react/screens/ResourceDialogs.module.css`
- `packages/client/src/react/screens/SettingsDeviceScreen.module.css`
- `packages/client/src/react/screens/SettingsDeviceScreen.test.tsx`
- `packages/client/src/react/screens/SettingsDeviceScreen.tsx`
- `packages/client/src/react/screens/SettingsDiagnosticsScreen.module.css`
- `packages/client/src/react/screens/SettingsDiagnosticsScreen.test.tsx`
- `packages/client/src/react/screens/SettingsDiagnosticsScreen.tsx`
- `packages/client/src/react/screens/SettingsProvidersScreen.module.css`
- `packages/client/src/react/screens/SettingsProvidersSelects.tsx`
- `packages/client/src/react/screens/SettingsVaultScreen.test.tsx`
- `packages/client/src/react/screens/SettingsVaultScreen.tsx`
- `packages/client/src/react/screens/StartupErrorScreen.tsx`
- `packages/client/src/react/screens/device-groups.test.ts`
- `packages/client/src/react/screens/device-groups.ts`
- `packages/client/src/react/screens/device-roles.ts`
- `packages/client/src/react/screens/useKeychainPrompt.ts`
- `packages/client/src/react/shell/App.inline-branch.test.tsx`
- `packages/client/src/react/shell/App.test.tsx`
- `packages/client/src/react/shell/App.tsx`
- `packages/client/src/react/shell/CaptureOverlay.tsx`
- `packages/client/src/react/shell/CaptureScanPanel.tsx`
- `packages/client/src/react/shell/IdentityHead.module.css`
- `packages/client/src/react/shell/IdentityHead.test.tsx`
- `packages/client/src/react/shell/IdentityHead.tsx`
- `packages/client/src/react/shell/Sidebar.test.tsx`
- `packages/client/src/react/shell/Sidebar.tsx`
- `packages/client/src/react/shell/chrome.module.css`
- `packages/client/src/react/shell/gatewayRegistry.test.ts`
- `packages/client/src/react/shell/gatewayRegistry.ts`
- `packages/client/src/react/shell/gatewaySwitcher.module.css`
- `packages/client/src/react/shell/gatewaySwitcher.ts`
- `packages/client/src/react/shell/memberScope.test.ts`
- `packages/client/src/react/shell/memberScope.ts`
- `packages/client/src/react/shell/routes/ApprovalsRoute.test.tsx`
- `packages/client/src/react/shell/routes/ApprovalsRoute.tsx`
- `packages/client/src/react/shell/routes/AssistantRoute.tsx`
- `packages/client/src/react/shell/routes/BuilderTargetGate.tsx`
- `packages/client/src/react/shell/routes/ConnectFlow.module.css`
- `packages/client/src/react/shell/routes/ConnectFlow.test.tsx`
- `packages/client/src/react/shell/routes/ConnectFlow.tsx`
- `packages/client/src/react/shell/routes/ConnectFlowDetailsStep.tsx`
- `packages/client/src/react/shell/routes/ConnectFlowModal.test.tsx`
- `packages/client/src/react/shell/routes/ConnectFlowModal.tsx`
- `packages/client/src/react/shell/routes/ConnectFlowVaultStep.tsx`
- `packages/client/src/react/shell/routes/ConnectTicketPanel.tsx`
- `packages/client/src/react/shell/routes/DiscoverRoute.tsx`
- `packages/client/src/react/shell/routes/GatewayRoute.tsx`
- `packages/client/src/react/shell/routes/HouseholdRoute.tsx`
- `packages/client/src/react/shell/routes/PairDeviceModal.tsx`
- `packages/client/src/react/shell/routes/RenameGatewayModal.tsx`
- `packages/client/src/react/shell/routes/ScopePicker.module.css`
- `packages/client/src/react/shell/routes/ScopePicker.test.tsx`
- `packages/client/src/react/shell/routes/ScopePicker.tsx`
- `packages/client/src/react/shell/routes/SettingsRoute.test.ts`
- `packages/client/src/react/shell/routes/SettingsRoute.tsx`
- `packages/client/src/react/shell/routes/TestConnectionModal.test.tsx`
- `packages/client/src/react/shell/routes/TestConnectionModal.tsx`
- `packages/client/src/react/shell/routes/VaultModal.module.css`
- `packages/client/src/react/shell/routes/VaultModal.tsx`
- `packages/client/src/react/shell/routes/automationEditorVault.test.ts`
- `packages/client/src/react/shell/routes/builder/useBuilder.ts`
- `packages/client/src/react/shell/routes/connectFlow-core.test.ts`
- `packages/client/src/react/shell/routes/connectFlow-core.ts`
- `packages/client/src/react/shell/routes/connectFlowIO.test.ts`
- `packages/client/src/react/shell/routes/connectFlowIO.ts`
- `packages/client/src/react/shell/routes/conversationScopes.test.ts`
- `packages/client/src/react/shell/routes/conversationScopes.ts`
- `packages/client/src/react/shell/routes/gatewayModals.ts`
- `packages/client/src/react/shell/routes/settingsAccountData.test.ts`
- `packages/client/src/react/shell/routes/settingsAccountData.ts`
- `packages/client/src/react/shell/routes/settingsConnectionsData.test.ts`
- `packages/client/src/react/shell/routes/settingsConnectionsData.ts`
- `packages/client/src/react/shell/routes/settingsDiagnosticsData.ts`
- `packages/client/src/react/shell/routes/vaultModals.test.ts`
- `packages/client/src/react/shell/routes/vaultModals.ts`
- `packages/client/src/react/shell/useAsyncData.ts`
- `packages/client/src/react/shell/useBlockingCount.test.tsx`
- `packages/client/src/react/shell/useBlockingCount.ts`
- `packages/client/src/react/shell/useMemberScopes.test.tsx`
- `packages/client/src/react/shell/useMemberScopes.ts`
- `packages/gateway/src/routes/push-wake-routes.test.ts`
- `packages/gateway/src/routes/scopes-routes.test.ts`
- `packages/gateway/src/routes/scopes-routes.ts`
- `packages/gateway/src/routes/vault-routes.test.ts`
- `packages/gateway/src/routes/vault-routes.ts`
- `packages/gateway/src/serve/build-gateway.test.ts`
- `packages/gateway/src/serve/build-gateway.ts`
- `packages/gateway/src/serve/notices.test.ts`
- `packages/gateway/src/serve/notices.ts`
- `packages/gateway/src/serve/notifications-events.ts`
- `packages/gateway/src/serve/outbox-executor.test.ts`
- `packages/gateway/src/serve/outbox-executor.ts`
- `packages/gateway/src/serve/serve.test.ts`
- `packages/gateway/src/serve/vault-plane-scopes.test.ts`
- `packages/gateway/src/serve/vault-plane.test-fixtures.ts`
- `packages/gateway/src/serve/vault-plane.ts`
- `packages/gateway/src/serve/vault-quarantine.test.ts`
- `packages/gateway/src/serve/vault-registry.test.ts`
- `packages/gateway/src/serve/vault-registry.ts`
- `packages/gateway/src/serve/web-app-sessions.contract.test.ts`
- `packages/gateway/src/serve/web-app-sessions.ts`
- `packages/protocol/src/routes.ts`
- `packages/vault/src/commands/schedule-organize.ts`
- `packages/vault/src/gateway/gateway.ts`
- `packages/vault/src/schema/atlas.ts`
- `packages/vault/src/schema/inbox.ts`
- `packages/vault/src/schema/migrate-notifications.test.ts`
- `packages/vault/src/schema/migrate.test.ts`
- `packages/vault/src/schema/migrate.ts`
- `packages/vault/src/schema/notifications.ts`
- `packages/vault/src/schema/tables.ts`
- `tests/agent-e2e-mobile/flows/native-v0-resilience.md`
- `tests/agent-e2e-mobile/flows/native-v0-resilience.mjs`
- `tests/design-token-css-budget.json`
- `tests/onboarding-scenarios.md`


## Verification

Repo-wide gates and per-package suites, all green:

```sh
bun run format:check && bun run lint && bun run typecheck && bun run lint:css && bun run knip
(cd packages/client && bun run test)      # 1636/1636
(cd apps/desktop && bun run test)         # 310/310
(cd apps/web && bun run test)             # 57/57
(cd apps/mobile && bun run test)          # 326/326
(cd packages/gateway && bun run test)     # 1245 passed, 6 skipped
(cd packages/agent-runtime && bun run test) # 339 passed, 1 skipped
```

CI repair (PR #666 run [30646771180](https://github.com/srikanth235/centraid/actions/runs/30646771180)):

- `lint:types` — `gatewayStatusCopy` now has an exhaustive `case "ready"` (switch-exhaustiveness-check).
- `test:report` — vault-routes note no longer contains a bare `COMPAT(` string that falsely fired the `gateway.compat` revisit trigger.

```sh
# packages/client type-aware envelope: 0 diagnostics
TEST_REPORT_SCOPE=main bun run test:report  # green
```

New coverage: gateway health never reaching the Inbox (`gateway-monitor-inbox.test.ts` — one real `up → down` transition lands in the durable log AND the tick issues zero HTTP writes; asserted on `fetch` rather than on a removed function so a reintroduced projection is caught however it is spelled, and verified by mutation: re-adding a POST after `persistOutageEvents` fails the test), schema-3 read compatibility (header + events + legacy `projection-mark` lines parse to exactly their events; a re-format contains no marks), boot-phase suppression (pair vanishes; real failures still alert; post-resolution settings failure still alerts), vault-scoped projection marks (fresh vault gets nothing; same vault keeps its offline backlog across an NDJSON restart; vault switch; schema-2 upgrade), degraded-detail honesty, Needs-me info filtering (+ deep links still work from source chips), `rememberDevice` default-ON + settings toggle (desktop/web + replica purge hint), "Existing vault" flow copy, switcher DOM order/stepper, ApprovalsRoute chip navigation.

## Steering

Exactly one steering event during this session: the user paused agent progress mid-task to add scope ("wait, I'll share other items too"). The interrupt is recorded as a v2 ledger row (session 77453e49, ordinal 57) in the Steering table below. No non-steering messages were logged as steering events. Both checks PASS.

## Audit

**Check 1: "What changed" faithfully describes the diff** — PASS. The "What changed" section lists nine distinct deliverables (A–F in the issue nomenclature), each tied to specific file changes. Spot-checking against `git diff --stat` (68 files, 1406 insertions, 362 deletions): boot-phase probe logic in `gateway-monitor-core.ts`/`gateway-monitor.ts`, vault-scoped projection marks in `gateway-outage-log-core.ts`, ApprovalsScreen info-severity filter, switcher redesign (`IdentityHead.tsx`/`gatewaySwitcher.ts`), ConnectFlow vault-first copy, ConnectTicketPanel shared component, `rememberDevice` default-ON in `connectFlow-core.ts` and settings toggle in `SettingsDeviceScreen.tsx`, vault vocabulary sweep across mobile and desktop, container-query responsive layout in `SettingsProvidersScreen.module.css` and `GatewayScreen.module.css`, opencode `probeIfMissing` in `build-gateway.ts`, and glossary update — all present in diff hunks. No material omissions.

**Check 2: Each checklist item is realized in the diff** — PASS. Issue #665 lists 12 checkboxes (A1–A4, B, C1–C3, D, E1–E2, F). Verification:
- A1 (boot-phase no outage): `gateway-monitor-core.ts` exports `isPendingBootProbe`; `gateway-monitor.ts` stamps `bootPhase: true` on synthesized failures and uses `isPendingBootProbe(trackedState, probe) ? trackedState : applyProbe(...)` to leave state at `unknown`.
- A2 (vault-scoped marks): `gateway-outage-log-core.ts` adds `vaultId?` to `InboxProjectionMark`, exports `vaultScopedProjectionMark()`, bumps schema 2→3; `gateway-monitor.ts` calls it before appending events.
- A3 (degraded detail honesty): `gateway-outage-log-core.ts` adds `degradedDetail()` function checking `latencyDegraded` flag.
- A4 (Needs me filters info): `ApprovalsScreen.tsx` filters `severity !== "info"` from the "needs" chip.
- B (switcher redesign): `IdentityHead.tsx` adds `Stepper()` component, moves gateway label to eyebrow, changes aria-labels and title to "vault"; `IdentityHead.module.css` and `gatewaySwitcher.module.css` updated.
- C1 (Add vault): `ConnectFlow.tsx` title changed to "Existing vault", copy framed around vault.
- C2 (reuse onboarding flow): `OnboardingScreen.tsx` imports and uses `ConnectTicketPanel` instead of `ConnectFlow`; new shared `ConnectTicketPanel.tsx` exists (imported in ConnectFlowModal.tsx).
- C3 (rememberDevice defaults ON): `connectFlow-core.ts` initializes `rememberDevice: true`; checkbox removed from `ConnectFlowDetailsStep.tsx`; `SettingsDeviceScreen.tsx` adds toggle with `onOfflineCopy` callback wired through `SettingsRoute.tsx` → `setGatewayRememberDevice`.
- D (vault vocabulary): `IdentityHead.tsx`, `ConnectFlow.tsx`, mobile `SpacesSwitcher.tsx`, `SettingsSpaceScreen.tsx`, `HouseholdScreen.tsx`, and docs/glossary.md all say "vault"; sweep covers aria-labels and toasts.
- E1 (Settings Agents responsive): `SettingsProvidersScreen.module.css` adds container queries (`providers-panel` 720/440px stops).
- E2 (Gateway runtime responsive): `GatewayScreen.module.css` adds `gateway-page` container query (1080/720/560px stops), gauge row wraps, status headline reflows, tabs scroll.
- F (opencode cold-start): `build-gateway.ts` adds `probeIfMissing: true` to `resolveAcpCapabilities` call.

**Check 3: Receipt checklist mirrors the issue** — PASS. Receipt lists 12 items matching issue #665 action items (all checked):
- Issue A (four sub-items: boot-phase, vault-scoped marks, degraded detail, Needs me info) ↔ Receipt checks A1–A4.
- Issue B (switcher redesign) ↔ Receipt check B.
- Issue C (three sub-items: Add vault copy, reuse ticket flow, rememberDevice defaults) ↔ Receipt checks C1–C3.
- Issue D (vault vocabulary) ↔ Receipt check D.
- Issue E (two sub-items: Settings Agents responsive, Gateway page responsive) ↔ Receipt checks E1–E2.
- Issue F (opencode cold-start) ↔ Receipt check F.

All issue action items are present and marked complete in the receipt.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-77453e49-895-1785496767-1 | claude-code | 77453e49-8954-46c6-923a-039fcd1ce000 | #665 | claude-fable-5 | 218 | 458343 | 14623680 | 90035 | 548596 | 24.8569 | 218 | 458343 | 14623680 | 90035 | fix(desktop): keep boot-phase and pre-vault gateway noise out of the Inbox (#665 |
| claude-code-77453e49-895-1785497175-1 | claude-code | 77453e49-8954-46c6-923a-039fcd1ce000 | #665 | claude-fable-5 | 31 | 52842 | 3011128 | 18280 | 71153 | 4.5860 | 249 | 511185 | 17634808 | 108315 | fix(desktop): keep boot-phase and pre-vault gateway noise out of the Inbox (#665 |
| claude-code-77453e49-895-1785497223-1 | claude-code | 77453e49-8954-46c6-923a-039fcd1ce000 | #665 | claude-fable-5 | 2 | 872 | 199517 | 183 | 1057 | 0.2196 | 251 | 512057 | 17834325 | 108498 | fix(desktop): keep boot-phase and pre-vault gateway noise out of the Inbox (#665 |
| claude-code-77453e49-895-1785497270-1 | claude-code | 77453e49-8954-46c6-923a-039fcd1ce000 | #665 | claude-fable-5 | 2 | 277 | 200389 | 159 | 438 | 0.2118 | 253 | 512334 | 18034714 | 108657 | fix(desktop): keep boot-phase and pre-vault gateway noise out of the Inbox (#665 |
| claude-code-77453e49-895-1785497339-1 | claude-code | 77453e49-8954-46c6-923a-039fcd1ce000 | #665 | claude-fable-5 | 6 | 5993 | 808344 | 1109 | 7108 | 0.9388 | 259 | 518327 | 18843058 | 109766 | fix(desktop): keep boot-phase and pre-vault gateway noise out of the Inbox (#665 |
| claude-code-77453e49-895-1785497392-1 | claude-code | 77453e49-8954-46c6-923a-039fcd1ce000 | #665 | claude-fable-5 | 2 | 522 | 204817 | 372 | 896 | 0.2300 | 261 | 518849 | 19047875 | 110138 | feat(client): compact-selector switcher — eyebrow, stepper, popover polish (#665 |
| claude-code-77453e49-895-1785497449-1 | claude-code | 77453e49-8954-46c6-923a-039fcd1ce000 | #665 | claude-fable-5 | 2 | 472 | 205339 | 1008 | 1482 | 0.2617 | 263 | 519321 | 19253214 | 111146 | feat(client): vault-first pairing, shared onboarding ticket step, offline-copy t |
| claude-code-77453e49-895-1785497503-1 | claude-code | 77453e49-8954-46c6-923a-039fcd1ce000 | #665 | claude-fable-5 | 2 | 1122 | 205811 | 712 | 1836 | 0.2555 | 265 | 520443 | 19459025 | 111858 | feat(client): the user-facing word is vault — space retired from copy (#665)Copy |
| claude-code-77453e49-895-1785497559-1 | claude-code | 77453e49-8954-46c6-923a-039fcd1ce000 | #665 | claude-fable-5 | 2 | 807 | 206933 | 825 | 1634 | 0.2583 | 267 | 521250 | 19665958 | 112683 | fix(client): container-query responsive Settings agents lanes + Gateway page (#6 |
| claude-code-77453e49-895-1785497602-1 | claude-code | 77453e49-8954-46c6-923a-039fcd1ce000 | #665 | claude-fable-5 | 0 | 0 | 0 | 0 | 0 | 0.0000 | 267 | 521250 | 19665958 | 112683 | fix(client): keep info-severity notices out of Needs me (#665)'Needs me' means ' |
| claude-code-77453e49-895-1785497646-1 | claude-code | 77453e49-8954-46c6-923a-039fcd1ce000 | #665 | claude-fable-5 | 0 | 0 | 0 | 0 | 0 | 0.0000 | 267 | 521250 | 19665958 | 112683 | fix(gateway): probe agent capabilities once on a cold read (#665)resolveAcpCapab |
| claude-code-77453e49-895-1785497696-1 | claude-code | 77453e49-8954-46c6-923a-039fcd1ce000 | #665 | claude-fable-5 | 6 | 2765 | 624259 | 933 | 3704 | 0.7055 | 273 | 524015 | 20290217 | 113616 | fix(gateway): probe agent capabilities once on a cold read (#665)resolveAcpCapab |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-77453e49-1785493473-1 | 77453e49-8954-46c6-923a-039fcd1ce000 | #665 | interrupt | structural | wait. i'll share other items too. | pending | 57 | 2026-07-31T10:24:33.434Z |
