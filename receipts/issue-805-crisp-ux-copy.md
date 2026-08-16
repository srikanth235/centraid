# issue-805 — Crisp UX copy: rulebook, ratchet, shared seam, full audit

GitHub issue: [#805](https://github.com/srikanth235/centraid/issues/805)

One umbrella, one receipt, orchestrated slices. The app's copy was verbose in
one systemic way — state the fact, then reassure about what was NOT lost. This
umbrella lands the binding rulebook (DESIGN.md § Copy), a tighten-only
length/sentence/filler ratchet, one canonical home per shared string, and a
full audit of every user-facing string. Slices execute per
[docs/multi-agent.md](../docs/multi-agent.md): the root agent holds the plan
and cross-slice invariants; sub-agents work file-disjoint slices.

## Checklist

- [x] A — the rulebook
- [x] B — the ratchet
- [x] C — the shared copy seam
- [x] D1 — audit: client shell + Settings + Onboarding
- [x] D2 — audit: blueprints Photos
- [x] D3 — audit: blueprints Docs + Notes + remaining apps
- [x] D4 — audit: mobile screens + kit
- [x] D5 — audit: server-surfaced strings + desktop/web/extension shells
- [x] design-divergences register updated for any slice-kept divergence

## What changed

### Slice A — the rulebook (2026-08-16)

- `DESIGN.md` — new `## Copy` section between `## Components` and
  `## Responsive Behavior`: voice definition, per-surface budget table,
  reassurance placement rule, banned filler, four worked before/after pairs
  drawn from real strings. Copy guidance folded into `## Agent Prompt Guide`
  and `## Do's and Don'ts`; issue + ratchet paths added to References.
- `docs/decisions.md` — new `## Copy governance (#805)` section with rulings
  U-voice / U-ratchet / U-scope / U-reassurance / U-umbrella.
- `docs/glossary.md` — the "broader prose and dynamic copy remain judgment"
  concession now splits word choice (glossary) from length (DESIGN.md § Copy).
- `AGENTS.md` — umbrella bullet now states: one umbrella issue, no child
  issues — slices are sub-agents and PR waves under it, one receipt.
  (`CLAUDE.md` is a symlink to `AGENTS.md`.)
- `packages/design/src/design-md.test.ts` — canonical `##` section list gains
  `Copy` (the test pins DESIGN.md's section inventory).

### Slice B — the ratchet (2026-08-16)

- `tests/quality/user-facing-qualities.test.ts` — new U4 test: walks
  user-facing sources (`packages/client/src`, `packages/blueprints/apps`,
  `apps/mobile/src`, `apps/desktop/src`, `apps/web/src`, `apps/extension/src`,
  `packages/design/src` minus `roles.ts`, `packages/server/src/routes`),
  extracts prose string literals, and flags any that exceed ~120 chars,
  contain ≥ 2 sentences, or match the banned-filler regex. Stale allowlist
  entries are themselves violations, so seeds cannot outlive the copy they
  excuse.
- `tests/quality/copy-allowlist.json` — new `copyRatchet` key seeded with 255
  current offenders (D1 83 · D2 21 · D3 40 · D4 95 · D5 16), each with a
  slice-tagged reason; consent-surface seeds carry a consent reason so the
  disclosure survives its rewrite. Tighten-only: `maxEntries` in the JSON and
  a matching ceiling constant in the owning test both cap growth; audit
  slices lower them together as they drain seeds.

### Slice C — the shared copy seam (2026-08-16)

One canonical home per shared string, on the `home-copy.ts` precedent. 10
modules, 60 promoted constants; 21 strings rewritten to budget in the same
move, ~25 kept byte-identical (already compliant), 40 allowlist seeds drained
(`maxEntries` 255 → 216, in-test ceiling lowered to match, 1 real
destructive-confirm entry added for the Approvals deny sheet).

- `packages/client/src` gains nine copy modules, exported as package
  subpaths in `packages/client/package.json`: `surface-copy.ts` (the
  ops-state words all six operational pages share), `approvals-copy.ts`,
  `automations-copy.ts`, `connectors-copy.ts`, `data-copy.ts`,
  `devices-copy.ts`, `insights-copy.ts`, `notifications-copy.ts`,
  `sharing-copy.ts`. Client call sites re-point: `routeVitals.ts`,
  `approvalsData.ts`, `notifications-model.ts`, `gateway-client-push.ts`,
  `insights-model.ts`, `App.tsx`, and screens `ApprovalsScreen.tsx`,
  `AtlasScreen.tsx`, `AtlasKindsSection.tsx`,
  `AutomationsOverviewScreen.tsx`, `HouseholdScreen.tsx`,
  `InsightsScreen.tsx`, `LinkRow.tsx`, `SettingsConnectionsScreen.tsx`,
  `SharingCard.tsx`, `SharingRecoveryRows.tsx`, routes
  `ApprovalsRoute.tsx`, `InsightsRoute.tsx`, `SettingsRoute.tsx`.
- The drifted `App.tsx`/`SettingsRoute.tsx` near-twin is now one
  `forgetDeviceMessage(surface)` in `devices-copy.ts` — full sentences kept:
  destructive confirm, the one home the rulebook gives reassurance.
- `packages/blueprints`: `apps/photos/shared-copy.ts` extended (11
  constants); new `apps/_shared/shared-copy.ts` (cross-app machinery copy)
  and `pendingChangeLabel()` in `apps/_shared/pending-overlay.ts`.
  Blueprint call sites re-point: `apps/photos/view-copy.ts`, `viewer.ts`,
  `components/Editor.tsx`, `components/FaceReview.tsx`,
  `components/Lightbox.tsx`, `components/PlaceMap.tsx`,
  `components/Timeline.tsx`, `apps/docs/app-root.tsx`,
  `apps/docs/components/Details.tsx`, `apps/locker/app-root.tsx`,
  `apps/_shared/PendingWriteActions.tsx`, `apps/_shared/ShareSheet.tsx`.
- Mobile imports the constants the way it already imports `home-copy`
  (package subpaths; deep path for blueprints, which has no exports map).
  Re-pointed: `apps/mobile/src/screens/approvals/approvals-model.ts`,
  `screens/connectors/connectors-model.ts`, `screens/connectors/Connectors.tsx`,
  `screens/data/Data.tsx`, `screens/devices/Devices.tsx`,
  `screens/Sharing.tsx`, `screens/SharingLinkRow.tsx`,
  `apps/automations/automations-model.ts`, `apps/automations/Automations.tsx`,
  `apps/insights/insights-model.ts`, `apps/insights/Insights.tsx`,
  `apps/photos/AlbumDetail.tsx`, `apps/photos/DuplicatesShelf.tsx`,
  `apps/photos/FaceReview.tsx`, `apps/photos/PhotoLightbox.tsx`,
  `apps/photos/PhotoStateView.tsx`, `apps/photos/PhotosSearch.tsx`,
  `apps/photos/photo-edit-model.ts`, `apps/photos/places-model.ts`,
  `apps/photos/tile-overlays.ts`, `apps/photos/viewer-model.ts`,
  `apps/docs/DocsHome.tsx`, `apps/docs/DocumentViewer.tsx`,
  `apps/locker/LockerHome.tsx`, `kit/replica/PendingRowStatus.tsx`,
  `kit/share/ShareSheet.tsx`, `lib/notification-model.ts`,
  `lib/notifications-plan.ts`.
- Pinned-copy tests updated in the same move:
  `packages/client/src/react/screens/ApprovalsScreen.test.tsx`,
  `AtlasScreen.test.tsx`, `AutomationsOverviewScreen.test.tsx`,
  `HouseholdScreen.test.tsx`, `SettingsConnectionsScreen.test.tsx`,
  `packages/client/src/react/shell/routeVitals.test.ts`,
  `routes/ApprovalsRoute.test.tsx`, `routes/InsightsRoute.test.tsx`,
  `routes/approvalsData.test.ts`, `packages/blueprints/src/one-computation.test.ts`
  (LEGACY_COLLISIONS ratchet tightened 16 → 14),
  `apps/mobile/src/screens/approvals/Approvals.test.tsx`,
  `approvals-model.test.ts`, `screens/connectors/Connectors.test.tsx`,
  `connectors-model.test.ts`, `apps/automations/Automations.test.tsx`,
  `automations-model.test.ts`, `apps/insights/Insights.test.tsx`,
  `insights-model.health.test.ts`, `apps/photos/photo-edit-model.test.ts`,
  `kit/components/HealthLine.test.tsx`.
- Ratchet bookkeeping: `tests/quality/copy-allowlist.json` (−40 seeds, +1
  reasoned entry) and `tests/quality/user-facing-qualities.test.ts` (ceiling).

### Slice C file inventory

Every file the slice touched (generated from the diff):

```
apps/mobile/src/apps/automations/Automations.test.tsx
apps/mobile/src/apps/automations/Automations.tsx
apps/mobile/src/apps/automations/automations-model.test.ts
apps/mobile/src/apps/automations/automations-model.ts
apps/mobile/src/apps/docs/DocsHome.tsx
apps/mobile/src/apps/docs/DocumentViewer.tsx
apps/mobile/src/apps/insights/Insights.test.tsx
apps/mobile/src/apps/insights/Insights.tsx
apps/mobile/src/apps/insights/insights-model.health.test.ts
apps/mobile/src/apps/insights/insights-model.ts
apps/mobile/src/apps/locker/LockerHome.tsx
apps/mobile/src/apps/photos/AlbumDetail.tsx
apps/mobile/src/apps/photos/DuplicatesShelf.tsx
apps/mobile/src/apps/photos/FaceReview.tsx
apps/mobile/src/apps/photos/PhotoLightbox.tsx
apps/mobile/src/apps/photos/PhotoStateView.tsx
apps/mobile/src/apps/photos/PhotosSearch.tsx
apps/mobile/src/apps/photos/photo-edit-model.test.ts
apps/mobile/src/apps/photos/photo-edit-model.ts
apps/mobile/src/apps/photos/places-model.ts
apps/mobile/src/apps/photos/tile-overlays.ts
apps/mobile/src/apps/photos/viewer-model.ts
apps/mobile/src/kit/components/HealthLine.test.tsx
apps/mobile/src/kit/replica/PendingRowStatus.tsx
apps/mobile/src/kit/share/ShareSheet.tsx
apps/mobile/src/lib/notification-model.ts
apps/mobile/src/lib/notifications-plan.ts
apps/mobile/src/screens/Sharing.tsx
apps/mobile/src/screens/SharingLinkRow.tsx
apps/mobile/src/screens/approvals/Approvals.test.tsx
apps/mobile/src/screens/approvals/approvals-model.test.ts
apps/mobile/src/screens/approvals/approvals-model.ts
apps/mobile/src/screens/connectors/Connectors.test.tsx
apps/mobile/src/screens/connectors/Connectors.tsx
apps/mobile/src/screens/connectors/connectors-model.test.ts
apps/mobile/src/screens/connectors/connectors-model.ts
apps/mobile/src/screens/data/Data.tsx
apps/mobile/src/screens/devices/Devices.tsx
packages/blueprints/apps/_shared/PendingWriteActions.tsx
packages/blueprints/apps/_shared/ShareSheet.tsx
packages/blueprints/apps/_shared/pending-overlay.ts
packages/blueprints/apps/_shared/shared-copy.ts
packages/blueprints/apps/docs/app-root.tsx
packages/blueprints/apps/docs/components/Details.tsx
packages/blueprints/apps/locker/app-root.tsx
packages/blueprints/apps/photos/components/Editor.tsx
packages/blueprints/apps/photos/components/FaceReview.tsx
packages/blueprints/apps/photos/components/Lightbox.tsx
packages/blueprints/apps/photos/components/PlaceMap.tsx
packages/blueprints/apps/photos/components/Timeline.tsx
packages/blueprints/apps/photos/shared-copy.ts
packages/blueprints/apps/photos/view-copy.ts
packages/blueprints/apps/photos/viewer.ts
packages/blueprints/src/one-computation.test.ts
packages/client/package.json
packages/client/src/approvals-copy.ts
packages/client/src/automations-copy.ts
packages/client/src/connectors-copy.ts
packages/client/src/data-copy.ts
packages/client/src/devices-copy.ts
packages/client/src/gateway-client-push.ts
packages/client/src/insights-copy.ts
packages/client/src/notifications-copy.ts
packages/client/src/notifications-model.ts
packages/client/src/react/screens/ApprovalsScreen.test.tsx
packages/client/src/react/screens/ApprovalsScreen.tsx
packages/client/src/react/screens/AtlasKindsSection.tsx
packages/client/src/react/screens/AtlasScreen.test.tsx
packages/client/src/react/screens/AtlasScreen.tsx
packages/client/src/react/screens/AutomationsOverviewScreen.test.tsx
packages/client/src/react/screens/AutomationsOverviewScreen.tsx
packages/client/src/react/screens/HouseholdScreen.test.tsx
packages/client/src/react/screens/HouseholdScreen.tsx
packages/client/src/react/screens/InsightsScreen.tsx
packages/client/src/react/screens/LinkRow.tsx
packages/client/src/react/screens/SettingsConnectionsScreen.test.tsx
packages/client/src/react/screens/SettingsConnectionsScreen.tsx
packages/client/src/react/screens/SharingCard.tsx
packages/client/src/react/screens/SharingRecoveryRows.tsx
packages/client/src/react/screens/insights-model.ts
packages/client/src/react/shell/App.tsx
packages/client/src/react/shell/routeVitals.test.ts
packages/client/src/react/shell/routeVitals.ts
packages/client/src/react/shell/routes/ApprovalsRoute.test.tsx
packages/client/src/react/shell/routes/ApprovalsRoute.tsx
packages/client/src/react/shell/routes/InsightsRoute.test.tsx
packages/client/src/react/shell/routes/InsightsRoute.tsx
packages/client/src/react/shell/routes/SettingsRoute.tsx
packages/client/src/react/shell/routes/approvalsData.test.ts
packages/client/src/react/shell/routes/approvalsData.ts
packages/client/src/sharing-copy.ts
packages/client/src/surface-copy.ts
tests/quality/copy-allowlist.json
tests/quality/user-facing-qualities.test.ts
```

### Slices D1–D5 — the full audit (2026-08-16)

Every user-facing string in the app read once against the rulebook;
violations rewritten, compliant strings byte-identical, consent/destructive/
security surfaces allowlisted by name. Counts per slice are in the Audit
counts table. The allowlist drained 255 → 31 entries; every survivor names
its surface class (`maxEntries` and the in-test ceiling now 31).

- **D1 — audit: client shell + Settings + Onboarding** — 119 rewrites across
  86 files in `packages/client/src` (62 seeds + 57 judgment: placeholders,
  JSX prose, interpolated literals the ratchet cannot see). 3 kept as
  destructive confirms (outbox discard, webhook secret rotation ×2). 13
  pinned-copy test files updated.
- **D2 — audit: blueprints Photos** — 38 rewrites across
  `packages/blueprints/apps/photos` (16 seeds + 22 judgment); 3 kept as the
  enrichment-consent disclosure panel. 6 pinned test files updated; module
  header comments corrected where they claimed handoff-verbatim text.
- **D3 — audit: blueprints Docs + Notes + remaining apps** — 45 rewrites (3
  deletions: the `EMPTY_MODEL_NOTE` spec leak, the `TRASH_ASK` "no destroy
  verb" essay and its fact rows — the design rationale now lives in a code
  comment beside the constants). 6 kept: the four OCR capture-consent
  disclosures and two Docs capability disclosures. The seven `app-inline.tsx`
  intros lost their repeated approval-reassurance sentence — it lives where
  the decision is made.
- **D4 — audit: mobile screens + kit** — 96 rewrites across 73 files in
  `apps/mobile/src` (58 seeds + 38 judgment; 922 literals + 31 JSX text
  nodes audited). 18 kept: transfer/enrichment consent, camera-roll grant
  and faces privacy disclosures, Locker security notes, and the
  destructive confirms (merge, empty trash, duplicate trash, unpair,
  free-up-space). 12 pinned test files updated, including re-splitting the
  storage-full error contract across the exports the screen renders.
- **D5 — audit: server-surfaced strings + desktop/web/extension shells** —
  22 rewrites across 8 files; 0 kept. Connector setup steps split rather
  than padded; OAuth outcome pages, extension pairing, web offline banner
  and desktop notifications aligned to the error/banner budgets; the
  assistant `notice` strings (verified to render in the member transcript)
  lost their defensive second sentences.
- **Root seam closes (cross-slice, held by the orchestrator)** — the
  `tests/agent-e2e-mobile/flows/places-seat.mjs` pin follows the Places map
  rewrite; the share-invitation handoff note and redeem hint converge on one
  wording across `packages/blueprints/apps/_shared/ShareSheet.tsx`,
  `apps/mobile/src/kit/share/ShareSheet.tsx`,
  `packages/client/src/react/screens/SharingCard.tsx` and
  `apps/mobile/src/screens/Sharing.tsx`; the write-target read-only reasons
  converge on the client's phrasing across
  `packages/blueprints/apps/_shared/write-target.ts` and its four pinned
  suites; `home-copy.ts`'s three remaining flagged strings and the Photos
  `duplicatesLede` tightened to budget; the
  design-divergences register updated for any slice-kept divergence —
  `docs/design-divergences.md` gains the desktop crash-loop notification hold
  and the Docs two-action empty states.

### Wave 3 file inventory

Every file waves D1–D5 + root integration touched (generated from the diff):

```
apps/desktop/src/main/gateway-monitor.ts
apps/extension/src/pair.ts
apps/extension/src/popup.ts
apps/extension/src/transport-core.ts
apps/mobile/src/apps/agenda/AgendaCreateModal.tsx
apps/mobile/src/apps/agenda/AgendaEvent.tsx
apps/mobile/src/apps/agenda/AgendaHome.tsx
apps/mobile/src/apps/assistant/Assistant.tsx
apps/mobile/src/apps/assistant/assistant-companion.test.ts
apps/mobile/src/apps/assistant/assistant-companion.ts
apps/mobile/src/apps/automations/Automations.tsx
apps/mobile/src/apps/automations/useAutomations.ts
apps/mobile/src/apps/docs/DocsHome.tsx
apps/mobile/src/apps/locker/LockerHome.tsx
apps/mobile/src/apps/locker/LockerUnlockScreen.tsx
apps/mobile/src/apps/notes/NotesHome.tsx
apps/mobile/src/apps/people/PeopleHome.tsx
apps/mobile/src/apps/photos/AlbumDetail.tsx
apps/mobile/src/apps/photos/CameraRollImportOffer.tsx
apps/mobile/src/apps/photos/MemoriesView.tsx
apps/mobile/src/apps/photos/PhotoGrainView.tsx
apps/mobile/src/apps/photos/PhotoInfoSheet.tsx
apps/mobile/src/apps/photos/PhotoPicker.tsx
apps/mobile/src/apps/photos/PhotoStateView.tsx
apps/mobile/src/apps/photos/PhotosHome.test.tsx
apps/mobile/src/apps/photos/PhotosHome.tsx
apps/mobile/src/apps/photos/PhotosLibrary.tsx
apps/mobile/src/apps/photos/PhotosMoreSheet.test.tsx
apps/mobile/src/apps/photos/PhotosPeopleView.test.tsx
apps/mobile/src/apps/photos/PhotosPeopleView.tsx
apps/mobile/src/apps/photos/PhotosSearchRestingState.tsx
apps/mobile/src/apps/photos/PlacesMap.test.tsx
apps/mobile/src/apps/photos/PlacesMap.tsx
apps/mobile/src/apps/photos/PlacesView.test.tsx
apps/mobile/src/apps/photos/PlacesView.tsx
apps/mobile/src/apps/photos/people-model.ts
apps/mobile/src/apps/photos/photo-access.ts
apps/mobile/src/apps/photos/photos-backup.ts
apps/mobile/src/apps/photos/photos-band.ts
apps/mobile/src/apps/photos/photos-collections.ts
apps/mobile/src/apps/photos/viewer-model.test.ts
apps/mobile/src/apps/photos/viewer-model.ts
apps/mobile/src/apps/tally/TallyHome.tsx
apps/mobile/src/apps/tasks/TasksHome.tsx
apps/mobile/src/kit/hooks/share-ingest.ts
apps/mobile/src/kit/replica/ReplicaStateCard.tsx
apps/mobile/src/kit/security/AppLock.tsx
apps/mobile/src/kit/share/ShareSheet.tsx
apps/mobile/src/kit/storage/free-up-space.ts
apps/mobile/src/kit/transfer/backup-verdict.ts
apps/mobile/src/kit/transfer/transfer-consent.ts
apps/mobile/src/kit/transfer/transfer-policy.test.ts
apps/mobile/src/kit/transfer/transfer-policy.ts
apps/mobile/src/lib/connection-reauth.ts
apps/mobile/src/lib/gateway.ts
apps/mobile/src/lib/replica/mobile-gateway-compatibility-core.ts
apps/mobile/src/lib/replica/mobile-gateway-compatibility.test.ts
apps/mobile/src/lib/replica/replica-storage-error.test.ts
apps/mobile/src/lib/replica/replica-storage-error.ts
apps/mobile/src/screens/BackupHealth.custody.tsx
apps/mobile/src/screens/BackupHealth.tsx
apps/mobile/src/screens/Capture.tsx
apps/mobile/src/screens/Onboarding.tsx
apps/mobile/src/screens/PhoneStorage.tsx
apps/mobile/src/screens/Settings.tsx
apps/mobile/src/screens/Sharing.tsx
apps/mobile/src/screens/approvals/approvals-model.ts
apps/mobile/src/screens/data/Data.tsx
apps/mobile/src/screens/data/VaultSections.tsx
apps/mobile/src/screens/devices/Devices.tsx
apps/mobile/src/screens/home/TileBody.tsx
apps/mobile/src/screens/home/VaultsSwitcher.tsx
apps/mobile/src/screens/settings/AppearanceSection.tsx
apps/mobile/src/screens/settings/BandSection.tsx
apps/mobile/src/screens/signal-notification.ts
apps/mobile/src/screens/system-on-phone.test.ts
apps/mobile/src/screens/system-on-phone.ts
apps/web/src/web-chrome.ts
docs/design-divergences.md
packages/blueprints/apps/_shared/ShareSheet.tsx
packages/blueprints/apps/_shared/write-target.ts
packages/blueprints/apps/agenda/app-inline.tsx
packages/blueprints/apps/agenda/components/CreateModal.tsx
packages/blueprints/apps/docs/app-inline.tsx
packages/blueprints/apps/docs/capabilities.ts
packages/blueprints/apps/docs/components/DueRoute.tsx
packages/blueprints/apps/docs/components/EmptyState.module.css
packages/blueprints/apps/docs/components/EmptyState.tsx
packages/blueprints/apps/docs/components/FoldersRoute.tsx
packages/blueprints/apps/docs/components/TrashAsk.tsx
packages/blueprints/apps/docs/document-copy.ts
packages/blueprints/apps/docs/drive-copy.ts
packages/blueprints/apps/docs/view-copy.ts
packages/blueprints/apps/locker/app-inline.tsx
packages/blueprints/apps/notes/app-inline.tsx
packages/blueprints/apps/notes/components/Editor.tsx
packages/blueprints/apps/notes/components/QuickAdd.tsx
packages/blueprints/apps/notes/components/WikiLinks.tsx
packages/blueprints/apps/people/app-inline.tsx
packages/blueprints/apps/photos/app-inline.tsx
packages/blueprints/apps/photos/components/Editor.tsx
packages/blueprints/apps/photos/components/FaceReview.tsx
packages/blueprints/apps/photos/components/Import.tsx
packages/blueprints/apps/photos/components/Lightbox.tsx
packages/blueprints/apps/photos/components/LightboxInfo.tsx
packages/blueprints/apps/photos/components/People.test.tsx
packages/blueprints/apps/photos/components/Picker.tsx
packages/blueprints/apps/photos/components/PlaceMap.tsx
packages/blueprints/apps/photos/enrichment-consent.ts
packages/blueprints/apps/photos/selection.tsx
packages/blueprints/apps/photos/shared-copy.ts
packages/blueprints/apps/photos/view-copy.ts
packages/blueprints/apps/photos/viewer.ts
packages/blueprints/apps/tally/app-inline.tsx
packages/blueprints/apps/tally/components/Dashboard.tsx
packages/blueprints/apps/tally/components/GroupManager.tsx
packages/blueprints/apps/tally/components/Search.tsx
packages/blueprints/apps/tasks/app-inline.tsx
packages/blueprints/src/docs-drive.test.ts
packages/blueprints/src/docs-shelves.test.ts
packages/blueprints/src/photos-duplicates.test.ts
packages/blueprints/src/photos-people.test.ts
packages/blueprints/src/photos-picker.test.ts
packages/blueprints/src/photos-readonly-album.test.ts
packages/blueprints/src/photos-selection-bar.test.ts
packages/blueprints/src/photos-shelves-v4.test.ts
packages/blueprints/src/photos-view-state.test.ts
packages/blueprints/src/scope-kit.test.ts
packages/blueprints/src/write-target.test.ts
packages/client/src/assist-oauth-handoff.ts
packages/client/src/gateway-client-connections.ts
packages/client/src/gateway-client-core.ts
packages/client/src/home-copy.ts
packages/client/src/react/blueprints/centraid-inline.ts
packages/client/src/react/screens/AlertHistoryPanel.test.tsx
packages/client/src/react/screens/AlertHistoryPanel.tsx
packages/client/src/react/screens/ApprovalsScreen.test.tsx
packages/client/src/react/screens/ApprovalsScreen.tsx
packages/client/src/react/screens/AssistantScreen.tsx
packages/client/src/react/screens/AtlasRecordsSection.test.tsx
packages/client/src/react/screens/AtlasRecordsSection.tsx
packages/client/src/react/screens/AtlasRelationsTab.tsx
packages/client/src/react/screens/AtlasScreen.test.tsx
packages/client/src/react/screens/AtlasScreen.tsx
packages/client/src/react/screens/AutomationCompilePane.tsx
packages/client/src/react/screens/AutomationEditorConnectorsPicker.tsx
packages/client/src/react/screens/AutomationEditorScreen.test.tsx
packages/client/src/react/screens/AutomationEditorScreen.tsx
packages/client/src/react/screens/AutomationThreadScreen.tsx
packages/client/src/react/screens/AutomationsOverviewScreen.tsx
packages/client/src/react/screens/BackupCard.test.tsx
packages/client/src/react/screens/BackupCard.tsx
packages/client/src/react/screens/BackupCopyCards.tsx
packages/client/src/react/screens/BackupInventoryPanel.tsx
packages/client/src/react/screens/DevicePairPanel.test.tsx
packages/client/src/react/screens/DevicePairPanel.tsx
packages/client/src/react/screens/GatewayAlertsTab.tsx
packages/client/src/react/screens/GatewayScreen.test.tsx
packages/client/src/react/screens/GatewayScreen.tsx
packages/client/src/react/screens/GatewayServiceTip.tsx
packages/client/src/react/screens/HouseholdScreen.test.tsx
packages/client/src/react/screens/HouseholdScreen.tsx
packages/client/src/react/screens/ImportScreen.tsx
packages/client/src/react/screens/InsightsScreen.test.tsx
packages/client/src/react/screens/InsightsScreen.tsx
packages/client/src/react/screens/LinkRow.tsx
packages/client/src/react/screens/OnboardingScreen.test.tsx
packages/client/src/react/screens/OnboardingScreen.tsx
packages/client/src/react/screens/PaletteScreen.tsx
packages/client/src/react/screens/PhoneScreen.tsx
packages/client/src/react/screens/RecoveryKitGate.tsx
packages/client/src/react/screens/ResourceCompareDialog.tsx
packages/client/src/react/screens/ResourceModeCard.test.tsx
packages/client/src/react/screens/ResourceModeCard.tsx
packages/client/src/react/screens/RunViewScreen.test.tsx
packages/client/src/react/screens/SettingsAppearanceScreen.tsx
packages/client/src/react/screens/SettingsConnectionsScreen.test.tsx
packages/client/src/react/screens/SettingsConnectionsScreen.tsx
packages/client/src/react/screens/SettingsDeviceScreen.tsx
packages/client/src/react/screens/SettingsHarnessesScreen.tsx
packages/client/src/react/screens/SettingsProfileScreen.tsx
packages/client/src/react/screens/SettingsStorageScreen.test.tsx
packages/client/src/react/screens/SettingsStorageScreen.tsx
packages/client/src/react/screens/SettingsVaultScreen.tsx
packages/client/src/react/screens/SharingCard.tsx
packages/client/src/react/screens/StorageLimitsPanel.tsx
packages/client/src/react/screens/VaultScreen.tsx
packages/client/src/react/screens/atlasScreenModel.test.ts
packages/client/src/react/screens/atlasScreenModel.ts
packages/client/src/react/screens/device-errors.ts
packages/client/src/react/screens/localUsageView.test.ts
packages/client/src/react/screens/localUsageView.ts
packages/client/src/react/screens/networkCalls.ts
packages/client/src/react/screens/resource-presets.ts
packages/client/src/react/screens/resource-summary.ts
packages/client/src/react/shell/CaptureOverlay.tsx
packages/client/src/react/shell/CaptureScanPanel.tsx
packages/client/src/react/shell/assistant-companion/assistantCompanionModel.ts
packages/client/src/react/shell/routes/AssistantRoute.tsx
packages/client/src/react/shell/routes/AutomationEditorRoute.test.tsx
packages/client/src/react/shell/routes/AutomationEditorRoute.tsx
packages/client/src/react/shell/routes/AutomationViewRoute.tsx
packages/client/src/react/shell/routes/ConnectFlowDetailsStep.tsx
packages/client/src/react/shell/routes/ConnectFlowVaultStep.tsx
packages/client/src/react/shell/routes/ConnectTicketPanel.tsx
packages/client/src/react/shell/routes/SettingsRoute.tsx
packages/client/src/react/shell/routes/StarredRoute.tsx
packages/client/src/react/shell/routes/StorageRoute.tsx
packages/client/src/react/shell/routes/TemplatesRoute.tsx
packages/client/src/react/shell/routes/gatewayModals.ts
packages/client/src/react/shell/routes/runViewData.ts
packages/client/src/react/shell/routes/settingsStorageData.ts
packages/client/src/react/shell/webhookReveal.test.ts
packages/client/src/react/shell/webhookReveal.ts
packages/client/src/react/ui/Gallery.tsx
packages/client/src/react/ui/states.tsx
packages/server/src/acp/backends/acp/backend.ts
packages/server/src/routes/connection-providers.ts
packages/server/src/routes/connections-routes.ts
tests/agent-e2e-mobile/flows/places-seat.mjs
tests/quality/copy-allowlist.json
tests/quality/user-facing-qualities.test.ts
```

## Decisions

- The U4 scanner skips template literals containing `${…}` — a spliced value
  cannot be length-judged from source. Interpolated verbose strings are still
  caught by the audit slices (judgment pass), just not mechanically.
- `packages/server/src` is walked only at `src/routes/**` — the route layer is
  where the gateway mints strings the shell renders verbatim. The rest of the
  server tree (engine, automation, acp, serve, cli, …) is logs, protocol and
  internal diagnostics this literal-level walk cannot distinguish from
  member-facing copy; widening would trade precision for noise. Boundary
  stated here per issue B3.
- U4 is not registered as a `tests/matrix.json` gate in this wave: the A1
  gate-registry test validates declared gates but does not require every test
  to declare one, and registering would ripple into
  `classification-ratchet.json` fingerprints. Can be promoted later without
  changing the test's behavior.
- `packages/design/src/roles.ts` token rationales are developer-facing
  (per the issue's non-goals) and excluded from the walk.
- Slice C left five twin groups in place as not-UI: the change-feed HTTP
  error, the intent-store reuse invariant, the replica indexed-column
  invariant, the `ReplicaProtocolError` message + intent reason code, and
  the harness preflight text — replica-protocol and harness plumbing
  vocabulary, not screen copy. The `"s columns: SPEND per day…"` inventory
  item is a doc-comment fragment, a false twin.
- One pre-existing failure, unrelated to copy:
  `apps/mobile/src/apps/tally/PendingRestartJourney.test.tsx` cannot bundle
  `node:sqlite`. Verified against the base tree (nothing on this branch
  touches that driver, the vitest config, or mobile's dependencies) and now
  tracked in [QUALITY.md](../QUALITY.md); fixing it is a bundler-seam
  change, outside this umbrella's copy scope.
- `design:gallery` cannot run in the authoring container: the repo pins a
  Playwright build whose `chrome-headless-shell` (1234) is absent, while the
  image ships 1194. A browser-binary mismatch, independent of this diff; CI
  runs the gate.

## Out of scope

Per the issue's non-goals: no i18n framework, no new lint infrastructure, no
churn on compliant strings, no tone flattening of consent/destructive/security
copy, no copy changes to developer-facing prose.

## User impact

Every user-facing string in the app was read against the new copy budgets and
320 of them were rewritten. Nothing moved, disappeared, or changed behaviour —
the same screens, controls and states, said in one glance instead of two. The
house voice is intact: "your own photographs, noticed" stays; the restatement
after it is gone. Reassurance now lives only where the risk decision is made,
so consent screens, destructive confirms and security disclosures keep their
full sentences while the empty states, banners, toasts and settings
descriptions that merely echoed them lost their second sentence.

First-run: unchanged in structure. Home's first-run body is now one sentence
about what Home becomes, with custody stated where imports are decided rather
than repeated on the springboard; the sample-data offer hint and Onboarding's
start and failure copy are cut to budget. Evidence:
`artifacts/e2e/ui-impact/issue-805-crisp-ux-copy.png`, emitted by the
first-run Home case in `apps/desktop/tests/e2e/onboarding-home.spec.ts`.

## Verification

Slice A + B (root re-ran after integration):

```sh
bun run lint:design-md               # errors: 0 (87 pre-existing orphaned-token warnings)
bunx vitest run packages/design/src/design-md.test.ts   # 15 passed
bun run test:qualities               # 24 passed, incl. new U4 (green, seeded)
bunx tsc -p tests                    # clean
```

Demonstrated red for U4: appending a >120-char two-sentence "Please…" string
to `packages/client/src/home-copy.ts` fails U4 with
`unallowed length+sentences+filler …`; suffixing an allowlist literal fails
with `stale … (no longer in the source)`. Both reverted.

Slice C:

```sh
bun run test:qualities                          # 24 passed (U4 green at 216)
bunx turbo run typecheck --filter=@centraid/client --filter=@centraid/blueprints  # 14/14
cd apps/mobile && bun run typecheck && bun run lint   # clean
bun run lint && bun run format:check            # clean
# package-filtered vitest green for client, blueprints, mobile (norms: no full
# suite mid-orchestration); the one failure is the pre-existing node:sqlite
# bundling break in PendingRestartJourney.test.tsx, identical on base.
```

Slices D1–D5 + root integration (root re-ran on the integrated tree):

```sh
bun run test:qualities        # 24 passed — U4 green at 31 entries, no stale
bunx turbo run typecheck --filter=@centraid/client --filter=@centraid/blueprints --filter=@centraid/server  # green
cd apps/mobile && bun run typecheck && bun run lint   # clean
# package-filtered vitest green per slice: client 245 files/2206, blueprints
# 105 files/3740 (+56 seam tests re-run at root), mobile 1415 (the one
# failure is the pre-existing node:sqlite bundling break, identical on base).
bun run check:pr              # full PR gate — result recorded in the PR
```

## Audit counts (workstream D contract)

Per-slice audited / rewritten / allowlisted counts land here as D slices
complete.

| Slice | Audited | Rewritten | Allowlisted (reason) |
| --- | --- | --- | --- |
| D1 | 922 literals + ~73 JSX/template sites | 119 | 3 (destructive confirms) |
| D2 | 19 seeds + full photos sweep (~15 files) | 38 | 3 (enrichment consent) |
| D3 | 38 seeds + full non-photos blueprint sweep | 45 | 6 (OCR + capability consent) |
| D4 | 922 literals + 31 JSX nodes across 574 files | 96 | 18 (consent/privacy/security/destructive) |
| D5 | 16 seeds + ~120 judgment-audited strings | 22 | 0 |

## Audit

Two rounds of independent fresh-context attestation, both **PASS** on all
three criteria. Round 1 (waves A+B, recorded at the first commit) verified the
rulebook and ratchet against the then-staged diff. Round 2, below, audited
waves D1–D5 + root integration against `git diff --cached`, this receipt, and
issue #805.

### 1. "What changed" describes D1–D5 and the wave-3 diff faithfully — **PASS**

File inventory and ratchet state re-measured from the staged tree:

```sh
git diff --cached --stat | tail -1            # 223 files changed
git diff --cached --name-only | grep -c "^packages/client/src"        # 87 (D1)
git diff --cached --name-only | grep -c "^packages/blueprints/apps/photos"  # 14 (D2)
git diff --cached --name-only | grep "^packages/blueprints" | grep -cv photos  # 29 (D3)
git diff --cached --name-only | grep -c "^apps/mobile/src"            # 73 (D4)
jq '.copyRatchet.entries | length' tests/quality/copy-allowlist.json  # 31
jq '.copyRatchet.maxEntries' tests/quality/copy-allowlist.json        # 31
jq '.copyRatchet.entries[].reason' tests/quality/copy-allowlist.json | grep -c "seeded #805"  # 0
# every unique remaining reason names consent / destructive / privacy / security
```

Spot-checked rewrites confirmed in the diff for every slice (D1
SettingsConnectionsScreen label hints; D2 enrichment-consent filler removal;
D3 the TRASH_ASK rationale moving to a code comment; D4 people-model faces
empty state; D5 the desktop notification body), plus the root seam closes:
the places-seat.mjs pin, the ShareSheet/SharingCard/Sharing convergence, and
the design-divergences register rows.

### 2. Each `[x]` Checklist item is realized in the branch — **PASS**

A, B, C live in commits `dede29340` and `4f1dc9e1b`; D1–D5 and the
divergences-register item are present in the staged diff with rewrites
verified by spot-check.

### 3. Checklist mirrors the issue's execution-order checklist — **PASS**

Nine items map one-to-one onto issue #805's execution-order checkboxes (A ←
A1–A3, B ← B1–B3, C ← C1–C3, D1–D5, divergences register), all checked at
closure.

## Session

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-16 | claude-code | dbac2544-ca99-517e-8544-865eb760845c |
