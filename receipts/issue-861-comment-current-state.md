# issue-861 — Code comments are current-state only (umbrella)

GitHub issue: [#861](https://github.com/srikanth235/centraid/issues/861)

The umbrella receipt for extending the #767 current-state ruling to code
comments: a rulebook section, two warn-only sweep checks, and a repo-wide
sweep (narration conversion, dangling-ref repair, `eslint-disable` →
`oxlint-disable` renames, banner normalization) executed as root-orchestrated
sub-agent slices per [docs/multi-agent.md](../docs/multi-agent.md) — one
receipt, no child issues.

## Checklist

- [x] `docs/coding-standards.md` carries the "Comments describe now" section: tense test, rewrite table, live-file-ref/prefer-symbol rule, blessed heading idiom, blessed banner style, and the explicit non-goals (density unregulated, no JSDoc tags).
- [x] Both warn-only checks exist and run; the dangling-file-ref check reports zero findings on the final tree.
- [x] Every Wave 1 site in the issue appendix is fixed with the current truth verified by grep — no guessed successor filenames.
- [x] Narration tripwire output on the final tree is reviewed line-by-line; every residual match is a present-tense constraint.
- [x] Zero `eslint-disable` strings remain in `.ts`/`.tsx` comments; every suppression verified still effective under its oxlint name.
- [x] One banner style repo-wide.
- [x] Every sweep change touches comment lines only (plus the sanctioned Wave-3 relocations); no test, type, or behavior changes.
- [x] Wave 3 verdict (keep / compress / relocate) recorded per ratio-offender file; `perf-budgets.ts` runbook relocated.
- [x] QUALITY.md carries the module-size observation (settled Q4).
- [x] The dangling-ref promotion decision (settled Q2) is recorded as a comment on issue #861.

## What changed

**Wave 0 — policy before sweep (root agent):**

- `docs/coding-standards.md` — new section **"Comments describe now"**: the
  tense test, a Bad→Good rewrite table, the live-file-ref / prefer-symbol
  rule, the capitalized-heading idiom, the box-drawing banner style, and the
  section's explicit non-goals (density unregulated; no JSDoc tag vocabulary).
- `scripts/lint-comment-file-refs.mjs` — warn-only dangling comment
  file-reference sweep: extracts backticked `*.ts`/`*.tsx` basenames from
  comment lines under `packages/` + `apps/` and warns when the basename exists
  nowhere in the tree. Always exits 0 (promotion to a blocking directive is a
  separate ruling, recorded on the issue).
- `scripts/lint-comment-narration.mjs` — warn-only historical-narration
  tripwire: flags past-tense markers (`used to`, `until #N`, `replaced`,
  `retired`, `previously`, `was a`) in comment lines for review. Fuzzy by
  design; warn-only permanently (settled Q2 on the issue).

**Wave 3 — judgment pass on the ratio-offender files (root agent, per settled
Q4/Q5 the prose largely stays; verdicts below):**

| File | Verdict |
| --- | --- |
| `apps/web/tests/e2e/perf-budgets.ts` | **Compress + relocate** — the duplicated HOW-TO-UPDATE runbook becomes a pointer to `scripts/perf/README.md` (which already carries it); the Vite-8 re-baselining narrative compresses to the present blank-page constraint; `approvedDeviation` (ratchet evidence) untouched |
| `scripts/perf/README.md` | Relocation target — two future-tense phrasings made timeless |
| `packages/design/src/blocks/contracts.ts` | **Keep** — glossary is the contract; pre-#765 drift retelling compresses to a citation; banners normalized |
| `packages/design/src/density.ts` | **Keep** — 48px-retirement and v7-audit narration converted to present-tense constraints |
| `packages/design/src/themes/shared.ts` | **Keep** — ramp "now/previously" narrative converted; retired tone axis restated as a deliberate absence ("dead by decision") |
| `packages/client/src/home-copy.ts` | **Keep** — v3-brief sentence deleted; filling-state history converted to the fallback-not-state rationale |
| `apps/mobile/src/apps/photos/photos-band.ts` | **Keep** — "used to carry six" and band-owner provenance converted to one-door / one-namespace rationale |
| `packages/blueprints/apps/photos/enrichment-consent.ts` | **Keep** — consent prose is a promise surface; toggle-defect and tier-enforcement history converted to present tense |
| `packages/blueprints/src/types.ts` | **Keep** — one banner normalized |

Two ratio-offender files got a **Keep, no edit** verdict and therefore appear
in no diff: `packages/vault/src/blob/custody-types.ts` and
`packages/server/src/acp/backends/acp/types.ts` are already clean — no
narration, no banners, rationale prose only.

- `QUALITY.md` — new Open observation: banner-heavy modules
  (`dispatcher.ts`, `store.ts`, `build-gateway.ts`, `integrity-checks.ts`,
  `acp/`) are a module-size smell out of this umbrella's scope (settled Q4).

**Waves 1–2 + hygiene — six ownership slices, all landed (sub-agents per
[docs/multi-agent.md](../docs/multi-agent.md), one per package group, no
shared files):**

| Slice | Files | Narration | Dangling refs | Renames | Banners |
| --- | --- | --- | --- | --- | --- |
| `packages/server` | 129 | 146 sites: 129 rewritten, 17 deleted, 17 survivors | 15 fixed (incl. `vault-registry.ts` → `useOwnerScopes`, `diagnostics-redaction.ts`/`support-bundle.ts` present policy fact, `store-sql.ts`, `runtime.ts`, both backup test refs) | 12 | 61 |
| `packages/client` | 130 | 183 sites: ~147 converted, ~24 deleted, 12 survivors | 10 fixed (incl. `statusChannel.ts` provenance deleted, `gateway-client-conversation.ts` both refs, `Logo.tsx` canonical delete) | 10 | 28 |
| `apps/mobile` | 113 | 158 sites: 148 handled, 10 survivors | 12 fixed (incl. the contradicting `timeline-rows.ts` → `buildPeriods`, the one caller of `describeCounts`; `band-owner.ts` twin claim deleted — no web twin exists) | 4 | 53 |
| `packages/blueprints` | 108 | 128 sites: 112 handled, 16 survivors | 7 handled (`placement-registry.ts` rewritten to live consumers `ShareSheet.tsx`/`grant-plane.ts`; `scope-kit.ts` provenance deleted; 3 linter false positives verified live) | 16 | 146 |
| vault/design/core/backup/tunnel/model-runtime/cli | 83 | 89 sites: 72 handled, 17 survivors | list empty; fresh run clean | 10 | 148 |
| `apps/web` + `apps/desktop` | 36 | 53 sites: 50 handled, 3 survivors | 6 handled (`ipc.ts`, `ipc-core.ts`, `apps-store-client.ts` claim deleted — no successor exists) | 4 | 39 |

Slice-fix follow-ups by the root after integration: `tests/` and `scripts/`
and root-level configs added to the check's living-basename set (the shells
slice escalated two false positives on `tests/perf/*.perf.test.ts` refs);
bare-extension tokens (`` `.d.ts` ``) skipped as conventions, not filenames;
38 leftover ASCII banner lines outside the slice work lists
(`packages/design/src/blocks/contracts.ts`, `apps/mobile/src/screens/home/tile-model.ts`,
`apps/mobile/src/screens/home/springboard-policy.ts`, `packages/vault/src/wal-shipper.ts`,
`packages/vault/src/wal-shipper.test.ts`, `packages/vault/src/wal-shipper-detectors.test.ts`,
and `packages/vault/src/gateway/ext.ts` — hand-written source whose embedded
NUL template strings make plain grep call it binary; `git grep` sees it)
converted, leaving zero ASCII banners repo-wide.

### Change surface (every file in this umbrella's diff)

- `tests/quality/classification-ratchet.json`
- `tests/schema-export-fingerprint.json`
- `packages/vault/src/gateway/portable-export.ts`
- `QUALITY.md`
- `apps/desktop/src/main.ts`
- `apps/desktop/src/main/apps-store-client.ts`
- `apps/desktop/src/main/auth-injector.ts`
- `apps/desktop/src/main/detached-gateway.ts`
- `apps/desktop/src/main/gateway-monitor-core.ts`
- `apps/desktop/src/main/gateway-monitor-notifications.test.ts`
- `apps/desktop/src/main/gateway-outage-log-core.ts`
- `apps/desktop/src/main/ipc-core.ts`
- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/src/main/login-item.ts`
- `apps/desktop/src/main/preload-core.ts`
- `apps/desktop/src/main/settings.ts`
- `apps/desktop/tests/e2e/appview-templates-insights.spec.ts`
- `apps/desktop/tests/e2e/automations.spec.ts`
- `apps/desktop/tests/e2e/fixtures.ts`
- `apps/desktop/tests/e2e/household.spec.ts`
- `apps/desktop/tests/e2e/onboarding-home.spec.ts`
- `apps/desktop/tests/e2e/settings-gateways.spec.ts`
- `apps/mobile/src/ErrorBoundary.tsx`
- `apps/mobile/src/apps/automations/automations-model.ts`
- `apps/mobile/src/apps/docs/DocsHome.tsx`
- `apps/mobile/src/apps/docs/docs-band.ts`
- `apps/mobile/src/apps/docs/docs-copy.ts`
- `apps/mobile/src/apps/docs/docs-projection.ts`
- `apps/mobile/src/apps/docs/document-read-model.ts`
- `apps/mobile/src/apps/insights/insights-model.test.ts`
- `apps/mobile/src/apps/insights/insights-model.ts`
- `apps/mobile/src/apps/notes/NotesHome.tsx`
- `apps/mobile/src/apps/people/people-model.ts`
- `apps/mobile/src/apps/people/people-share-model.ts`
- `apps/mobile/src/apps/people/usePeople.ts`
- `apps/mobile/src/apps/photos/AlbumDetail.styles.ts`
- `apps/mobile/src/apps/photos/AlbumDetail.tsx`
- `apps/mobile/src/apps/photos/EnrichmentConsent.test.tsx`
- `apps/mobile/src/apps/photos/EnrichmentConsent.tsx`
- `apps/mobile/src/apps/photos/FaceReview.test.tsx`
- `apps/mobile/src/apps/photos/FaceReview.tsx`
- `apps/mobile/src/apps/photos/MediaPage.tsx`
- `apps/mobile/src/apps/photos/MemoriesView.test.tsx`
- `apps/mobile/src/apps/photos/MemoriesView.tsx`
- `apps/mobile/src/apps/photos/PhotoAccessPanel.tsx`
- `apps/mobile/src/apps/photos/PhotoLightbox.styles.ts`
- `apps/mobile/src/apps/photos/PhotoLightboxChrome.tsx`
- `apps/mobile/src/apps/photos/PhotoTimeline.tsx`
- `apps/mobile/src/apps/photos/PhotosBand.tsx`
- `apps/mobile/src/apps/photos/PhotosCollectionsView.tsx`
- `apps/mobile/src/apps/photos/PhotosHome.styles.ts`
- `apps/mobile/src/apps/photos/PhotosHome.tsx`
- `apps/mobile/src/apps/photos/PhotosMoreSheet.test.tsx`
- `apps/mobile/src/apps/photos/PhotosMoreSheet.tsx`
- `apps/mobile/src/apps/photos/PhotosPeopleView.test.tsx`
- `apps/mobile/src/apps/photos/PhotosPeopleView.tsx`
- `apps/mobile/src/apps/photos/PhotosScreen.tsx`
- `apps/mobile/src/apps/photos/PhotosSearch.tsx`
- `apps/mobile/src/apps/photos/PlacesMap.test.tsx`
- `apps/mobile/src/apps/photos/PlacesView.test.tsx`
- `apps/mobile/src/apps/photos/PlacesView.tsx`
- `apps/mobile/src/apps/photos/TimelineGrainControl.tsx`
- `apps/mobile/src/apps/photos/device-media.test.ts`
- `apps/mobile/src/apps/photos/face-review-queue.ts`
- `apps/mobile/src/apps/photos/image-cache.ts`
- `apps/mobile/src/apps/photos/lightbox-gestures.ts`
- `apps/mobile/src/apps/photos/memories-model.test.ts`
- `apps/mobile/src/apps/photos/photo-access.ts`
- `apps/mobile/src/apps/photos/photo-edit-model.ts`
- `apps/mobile/src/apps/photos/photo-edit-save.ts`
- `apps/mobile/src/apps/photos/photo-grants.test.tsx`
- `apps/mobile/src/apps/photos/photo-share.ts`
- `apps/mobile/src/apps/photos/photos-band.test.ts`
- `apps/mobile/src/apps/photos/photos-band.ts`
- `apps/mobile/src/apps/photos/photos-collections.ts`
- `apps/mobile/src/apps/photos/photos-library-menu.ts`
- `apps/mobile/src/apps/photos/photos-more-router.test.ts`
- `apps/mobile/src/apps/photos/places-model.ts`
- `apps/mobile/src/apps/photos/search-hits.test.ts`
- `apps/mobile/src/apps/photos/tile-overlays.test.ts`
- `apps/mobile/src/apps/photos/tile-overlays.ts`
- `apps/mobile/src/apps/photos/timeline-engine.ts`
- `apps/mobile/src/apps/photos/timeline-rows.ts`
- `apps/mobile/src/apps/photos/use-photo-selection-share.ts`
- `apps/mobile/src/apps/photos/viewer-menu.ts`
- `apps/mobile/src/apps/photos/viewer-model.test.ts`
- `apps/mobile/src/apps/photos/viewer-model.ts`
- `apps/mobile/src/apps/photos/viewer-read-only-reason.test.ts`
- `apps/mobile/src/apps/tasks/tasks-band.ts`
- `apps/mobile/src/kit/band-surface.ts`
- `apps/mobile/src/kit/band/band-owner.ts`
- `apps/mobile/src/kit/components/BarsBlock.styles.ts`
- `apps/mobile/src/kit/components/BarsBlock.test.tsx`
- `apps/mobile/src/kit/components/BarsBlock.tsx`
- `apps/mobile/src/kit/components/ConsentGate.tsx`
- `apps/mobile/src/kit/components/OptionSheet.tsx`
- `apps/mobile/src/kit/components/PanelBlock.tsx`
- `apps/mobile/src/kit/fetch-gate/gate.ts`
- `apps/mobile/src/kit/fetch-gate/policy.ts`
- `apps/mobile/src/kit/media/grid-image.ts`
- `apps/mobile/src/kit/replica/mount-plan.test.ts`
- `apps/mobile/src/kit/replica/mount-plan.ts`
- `apps/mobile/src/kit/replica/pending-changes.ts`
- `apps/mobile/src/kit/replica/replica-mount.ts`
- `apps/mobile/src/kit/schedule/recurrence.ts`
- `apps/mobile/src/kit/storage/custody-status.ts`
- `apps/mobile/src/kit/transfer/transfer-policy.ts`
- `apps/mobile/src/kit/transfer/transfer-run.test.ts`
- `apps/mobile/src/lib/connection-reauth.ts`
- `apps/mobile/src/lib/daily-brief.ts`
- `apps/mobile/src/lib/decision-detail.ts`
- `apps/mobile/src/lib/notifications-navigation.ts`
- `apps/mobile/src/lib/phone-link.test.ts`
- `apps/mobile/src/lib/replica/edges-transport.ts`
- `apps/mobile/src/lib/replica/links-transport.ts`
- `apps/mobile/src/lib/replica/native-change-feed.ts`
- `apps/mobile/src/lib/replica/node-sqlite-driver.jsdom.test.ts`
- `apps/mobile/src/lib/replica/replica-read-pushdown.ts`
- `apps/mobile/src/lib/replica/sqlite-intent-store.ts`
- `apps/mobile/src/lib/replica/thumbnail-pack.ts`
- `apps/mobile/src/lib/upload/cbsf.ts`
- `apps/mobile/src/lib/upload/file-source.ts`
- `apps/mobile/src/navigation.ts`
- `apps/mobile/src/screens/Home.tsx`
- `apps/mobile/src/screens/Scan.test.tsx`
- `apps/mobile/src/screens/Settings.tsx`
- `apps/mobile/src/screens/SharingLinkRow.tsx`
- `apps/mobile/src/screens/data/Data.tsx`
- `apps/mobile/src/screens/data/VaultSections.tsx`
- `apps/mobile/src/screens/home/AllAppsSheet.tsx`
- `apps/mobile/src/screens/home/HomeBand.tsx`
- `apps/mobile/src/screens/home/HomeTitleRow.tsx`
- `apps/mobile/src/screens/home/VaultHeader.tsx`
- `apps/mobile/src/screens/home/springboard-policy.ts`
- `apps/mobile/src/screens/home/tile-model.ts`
- `apps/mobile/src/screens/scan-consent.ts`
- `apps/mobile/test/fixtures/fake-direct-transfer.ts`
- `apps/web/src/client-globals.d.ts`
- `apps/web/src/generated/centraid_web_iroh.d.ts`
- `apps/web/src/generated/centraid_web_iroh_bg.wasm.d.ts`
- `apps/web/src/iroh-transport.ts`
- `apps/web/src/sw-runtime.test.ts`
- `apps/web/src/web-health.ts`
- `apps/web/src/web-host.test.ts`
- `apps/web/src/web-host.ts`
- `apps/web/src/web-state.ts`
- `apps/web/tests/e2e/accessibility.spec.ts`
- `apps/web/tests/e2e/leak-probe.ts`
- `apps/web/tests/e2e/offline-reconnect.spec.ts`
- `apps/web/tests/e2e/offline-search.spec.ts`
- `apps/web/tests/e2e/perf-budgets.ts`
- `apps/web/tests/e2e/perf-waterfall.spec.ts`
- `apps/web/tests/e2e/playwright.config.ts`
- `apps/web/tests/e2e/renderer-leak.spec.ts`
- `apps/web/tests/e2e/server.ts`
- `apps/web/tests/e2e/web-pwa.spec.ts`
- `docs/coding-standards.md`
- `packages/backup/src/crypto-properties.test.ts`
- `packages/backup/src/crypto.ts`
- `packages/backup/src/engine.test.ts`
- `packages/backup/src/engine.ts`
- `packages/backup/src/interop-clawgnition.test.ts`
- `packages/backup/src/local-provider.ts`
- `packages/backup/src/provider.ts`
- `packages/backup/src/wal-address.test-fixtures.ts`
- `packages/backup/src/wal-format.test.ts`
- `packages/backup/src/wal-format.ts`
- `packages/backup/src/wal-restore.test.ts`
- `packages/blueprints/apps/_shared/Avatar.tsx`
- `packages/blueprints/apps/_shared/LoadingSkeleton.tsx`
- `packages/blueprints/apps/_shared/Meter.tsx`
- `packages/blueprints/apps/_shared/capture-consent.ts`
- `packages/blueprints/apps/_shared/placement-registry.ts`
- `packages/blueprints/apps/_shared/scope-kit.ts`
- `packages/blueprints/apps/_shared/shared-copy.ts`
- `packages/blueprints/apps/agenda/Chrome.tsx`
- `packages/blueprints/apps/agenda/app-root.tsx`
- `packages/blueprints/apps/agenda/logic.ts`
- `packages/blueprints/apps/agenda/queries/day-context.ts`
- `packages/blueprints/apps/docs/Chrome.tsx`
- `packages/blueprints/apps/docs/app-root.tsx`
- `packages/blueprints/apps/docs/capabilities.ts`
- `packages/blueprints/apps/docs/components/FoldersRoute.tsx`
- `packages/blueprints/apps/docs/components/List.tsx`
- `packages/blueprints/apps/docs/components/QuickLookStage.tsx`
- `packages/blueprints/apps/docs/components/QuickLookText.tsx`
- `packages/blueprints/apps/docs/components/SearchField.tsx`
- `packages/blueprints/apps/docs/components/ShelfStrip.tsx`
- `packages/blueprints/apps/docs/components/Sidebar.tsx`
- `packages/blueprints/apps/docs/components/VersionsRoute.tsx`
- `packages/blueprints/apps/docs/document-copy.ts`
- `packages/blueprints/apps/docs/drive-copy.ts`
- `packages/blueprints/apps/docs/icons.ts`
- `packages/blueprints/apps/docs/kind-colours.test.ts`
- `packages/blueprints/apps/docs/logic.ts`
- `packages/blueprints/apps/docs/nav.ts`
- `packages/blueprints/apps/docs/pdf-text.ts`
- `packages/blueprints/apps/docs/queries/_shared.ts`
- `packages/blueprints/apps/docs/types.ts`
- `packages/blueprints/apps/docs/uploads.ts`
- `packages/blueprints/apps/docs/view-copy.ts`
- `packages/blueprints/apps/docs/view-state.ts`
- `packages/blueprints/apps/locker/app-root.tsx`
- `packages/blueprints/apps/locker/components/EditModal.tsx`
- `packages/blueprints/apps/locker/logic.ts`
- `packages/blueprints/apps/locker/totp.ts`
- `packages/blueprints/apps/notes/Chrome.tsx`
- `packages/blueprints/apps/notes/app-root.tsx`
- `packages/blueprints/apps/notes/logic.ts`
- `packages/blueprints/apps/people/app-root.tsx`
- `packages/blueprints/apps/people/logic.ts`
- `packages/blueprints/apps/people/people-copy.ts`
- `packages/blueprints/apps/people/queries/_shared.ts`
- `packages/blueprints/apps/people/types.ts`
- `packages/blueprints/apps/people/writes.ts`
- `packages/blueprints/apps/photos/Chrome.tsx`
- `packages/blueprints/apps/photos/app-root.tsx`
- `packages/blueprints/apps/photos/assets-actions.ts`
- `packages/blueprints/apps/photos/components/AlbumBar.tsx`
- `packages/blueprints/apps/photos/components/AlbumGrid.tsx`
- `packages/blueprints/apps/photos/components/Editor.tsx`
- `packages/blueprints/apps/photos/components/FaceReview.tsx`
- `packages/blueprints/apps/photos/components/LightboxInfo.tsx`
- `packages/blueprints/apps/photos/components/People.test.tsx`
- `packages/blueprints/apps/photos/components/People.tsx`
- `packages/blueprints/apps/photos/components/PlaceMap.tsx`
- `packages/blueprints/apps/photos/components/ShelfStrip.tsx`
- `packages/blueprints/apps/photos/components/Storage.tsx`
- `packages/blueprints/apps/photos/components/Tile.tsx`
- `packages/blueprints/apps/photos/components/Timeline.tsx`
- `packages/blueprints/apps/photos/duplicates-actions.ts`
- `packages/blueprints/apps/photos/duplicates.tsx`
- `packages/blueprints/apps/photos/enrichment-consent.test.ts`
- `packages/blueprints/apps/photos/enrichment-consent.ts`
- `packages/blueprints/apps/photos/enrichment-gate.ts`
- `packages/blueprints/apps/photos/faces.ts`
- `packages/blueprints/apps/photos/format.ts`
- `packages/blueprints/apps/photos/frame.tsx`
- `packages/blueprints/apps/photos/grouping.test.ts`
- `packages/blueprints/apps/photos/grouping.ts`
- `packages/blueprints/apps/photos/media.ts`
- `packages/blueprints/apps/photos/nav-rail.ts`
- `packages/blueprints/apps/photos/outcomes.ts`
- `packages/blueprints/apps/photos/queries/faces.ts`
- `packages/blueprints/apps/photos/queries/people.ts`
- `packages/blueprints/apps/photos/share-place.test.ts`
- `packages/blueprints/apps/photos/shared-copy.ts`
- `packages/blueprints/apps/photos/shelves.ts`
- `packages/blueprints/apps/photos/upload.ts`
- `packages/blueprints/apps/photos/view-copy.ts`
- `packages/blueprints/apps/photos/viewer.test.ts`
- `packages/blueprints/apps/tasks/app-root.tsx`
- `packages/blueprints/apps/tasks/components/Screens.tsx`
- `packages/blueprints/apps/tasks/scope-fanout.ts`
- `packages/blueprints/apps/tasks/view-copy.ts`
- `packages/blueprints/src/app-boot-harness.ts`
- `packages/blueprints/src/day-context-journal-queries.test.ts`
- `packages/blueprints/src/docs-media.test.ts`
- `packages/blueprints/src/docs-shelves.test.ts`
- `packages/blueprints/src/handler-crud-smoke.integration.test.ts`
- `packages/blueprints/src/index.ts`
- `packages/blueprints/src/photos-duplicates.test.ts`
- `packages/blueprints/src/photos-editor-guard.test.ts`
- `packages/blueprints/src/photos-face-review.test.ts`
- `packages/blueprints/src/photos-faces.test.ts`
- `packages/blueprints/src/photos-frame.test.ts`
- `packages/blueprints/src/photos-grant-entry.test.tsx`
- `packages/blueprints/src/photos-media.test.ts`
- `packages/blueprints/src/photos-people.test.ts`
- `packages/blueprints/src/photos-readonly-album.test.ts`
- `packages/blueprints/src/photos-selection-bar.test.ts`
- `packages/blueprints/src/photos-shelves-v4.test.ts`
- `packages/blueprints/src/photos-view-state.test.ts`
- `packages/blueprints/src/photos-viewer.test.ts`
- `packages/blueprints/src/query-handlers.test.ts`
- `packages/blueprints/src/token-purity-allowlist.ts`
- `packages/blueprints/src/types.ts`
- `packages/blueprints/types/centraid.d.ts`
- `packages/cli/src/auth.ts`
- `packages/cli/src/cli.ts`
- `packages/client/src/app-shell-context.ts`
- `packages/client/src/approvals-copy.ts`
- `packages/client/src/automation-identity.ts`
- `packages/client/src/automations-copy.ts`
- `packages/client/src/capture.ts`
- `packages/client/src/centraid-api.d.ts`
- `packages/client/src/device-enrichment-compute.ts`
- `packages/client/src/gateway-client-atlas.ts`
- `packages/client/src/gateway-client-automation-editing.ts`
- `packages/client/src/gateway-client-automations.contract.test.ts`
- `packages/client/src/gateway-client-connections.ts`
- `packages/client/src/gateway-client-contract-fixtures.ts`
- `packages/client/src/gateway-client-conversation.ts`
- `packages/client/src/gateway-client-device-work-source.test.ts`
- `packages/client/src/gateway-client-edges.ts`
- `packages/client/src/gateway-client-editing.ts`
- `packages/client/src/gateway-client-owners.ts`
- `packages/client/src/gateway-client-storage.ts`
- `packages/client/src/gateway-client.ts`
- `packages/client/src/home-copy.ts`
- `packages/client/src/react/blueprints/blob-auth.ts`
- `packages/client/src/react/blueprints/inline-blob-images.ts`
- `packages/client/src/react/boot.tsx`
- `packages/client/src/react/css-modules.d.ts`
- `packages/client/src/react/host-platform.ts`
- `packages/client/src/react/screen-contracts.ts`
- `packages/client/src/react/screens/AssistantScreen.test.tsx`
- `packages/client/src/react/screens/AssistantScreen.tsx`
- `packages/client/src/react/screens/AtlasKindsSection.tsx`
- `packages/client/src/react/screens/AtlasScreen.tsx`
- `packages/client/src/react/screens/AutomationEditorScreen.test.tsx`
- `packages/client/src/react/screens/AutomationEditorScreen.tsx`
- `packages/client/src/react/screens/AutomationThreadScreen.tsx`
- `packages/client/src/react/screens/AutomationsOverviewScreen.tsx`
- `packages/client/src/react/screens/BackupCard.tsx`
- `packages/client/src/react/screens/BackupDeviceList.tsx`
- `packages/client/src/react/screens/FirstRunGate.tsx`
- `packages/client/src/react/screens/GatewayScreen.test.tsx`
- `packages/client/src/react/screens/GatewayScreen.tsx`
- `packages/client/src/react/screens/GatewayServiceTip.test.tsx`
- `packages/client/src/react/screens/GatewayServiceTip.tsx`
- `packages/client/src/react/screens/HomeSpringboard.test.tsx`
- `packages/client/src/react/screens/HouseholdScreen.test.tsx`
- `packages/client/src/react/screens/HouseholdScreen.tsx`
- `packages/client/src/react/screens/LinkRow.tsx`
- `packages/client/src/react/screens/SettingsDiagnosticsScreen.test.tsx`
- `packages/client/src/react/screens/SettingsDiagnosticsScreen.tsx`
- `packages/client/src/react/screens/SettingsEnrichmentCapabilities.tsx`
- `packages/client/src/react/screens/SettingsEnrichmentRules.tsx`
- `packages/client/src/react/screens/SettingsHarnessEntries.tsx`
- `packages/client/src/react/screens/SettingsHarnessesScreen.test.tsx`
- `packages/client/src/react/screens/SettingsHarnessesScreen.tsx`
- `packages/client/src/react/screens/SettingsHarnessesSelects.tsx`
- `packages/client/src/react/screens/SettingsVaultScreen.test.tsx`
- `packages/client/src/react/screens/SharingCard.tsx`
- `packages/client/src/react/screens/StartupErrorScreen.tsx`
- `packages/client/src/react/screens/StorageLimitsPanel.tsx`
- `packages/client/src/react/screens/StorageScreen.test.tsx`
- `packages/client/src/react/screens/VaultFootprintRows.tsx`
- `packages/client/src/react/screens/atlasOrreryGeometry.ts`
- `packages/client/src/react/screens/atlasScreenModel.ts`
- `packages/client/src/react/screens/automationsOverviewGrouping.ts`
- `packages/client/src/react/screens/composerMentions.ts`
- `packages/client/src/react/screens/device-groups.test.ts`
- `packages/client/src/react/screens/insights-model.ts`
- `packages/client/src/react/shell/App.inline-branch.test.tsx`
- `packages/client/src/react/shell/App.tsx`
- `packages/client/src/react/shell/ErrorBoundary.tsx`
- `packages/client/src/react/shell/StatusLine.tsx`
- `packages/client/src/react/shell/ambientStatus.ts`
- `packages/client/src/react/shell/contextMenu.ts`
- `packages/client/src/react/shell/frameBatch.ts`
- `packages/client/src/react/shell/launcherModel.test.ts`
- `packages/client/src/react/shell/opsBar.ts`
- `packages/client/src/react/shell/prompt.ts`
- `packages/client/src/react/shell/queryCache.test.ts`
- `packages/client/src/react/shell/routes/ApprovalsRoute.tsx`
- `packages/client/src/react/shell/routes/AssistantConversations.test.tsx`
- `packages/client/src/react/shell/routes/AssistantConversations.tsx`
- `packages/client/src/react/shell/routes/AssistantRoute.tsx`
- `packages/client/src/react/shell/routes/AutomationViewRoute.tsx`
- `packages/client/src/react/shell/routes/ConnectFlow.test.tsx`
- `packages/client/src/react/shell/routes/ConnectFlowModal.test.tsx`
- `packages/client/src/react/shell/routes/ConnectFlowModal.tsx`
- `packages/client/src/react/shell/routes/ConnectFlowVaultStep.tsx`
- `packages/client/src/react/shell/routes/ConnectTicketPanel.tsx`
- `packages/client/src/react/shell/routes/GatewayRoute.tsx`
- `packages/client/src/react/shell/routes/HomeRoute.test.tsx`
- `packages/client/src/react/shell/routes/HouseholdRoute.tsx`
- `packages/client/src/react/shell/routes/InlineAppRoute.test.tsx`
- `packages/client/src/react/shell/routes/InlineAppRoute.tsx`
- `packages/client/src/react/shell/routes/PairDeviceModal.tsx`
- `packages/client/src/react/shell/routes/SettingsRoute.test.ts`
- `packages/client/src/react/shell/routes/SettingsRoute.tsx`
- `packages/client/src/react/shell/routes/VaultRoute.tsx`
- `packages/client/src/react/shell/routes/appSettingsData.ts`
- `packages/client/src/react/shell/routes/approvalsPhrasing.ts`
- `packages/client/src/react/shell/routes/automationThreadData.ts`
- `packages/client/src/react/shell/routes/automationTurnWatch.ts`
- `packages/client/src/react/shell/routes/automationsData.ts`
- `packages/client/src/react/shell/routes/automationsOverviewLoad.test.ts`
- `packages/client/src/react/shell/routes/connectFlow-core.ts`
- `packages/client/src/react/shell/routes/connectFlowIO.test.ts`
- `packages/client/src/react/shell/routes/connectFlowIO.ts`
- `packages/client/src/react/shell/routes/gatewayModals.ts`
- `packages/client/src/react/shell/routes/gatewayStorageData.ts`
- `packages/client/src/react/shell/routes/homeSample.ts`
- `packages/client/src/react/shell/routes/homeTileContent.ts`
- `packages/client/src/react/shell/routes/homeTiles.ts`
- `packages/client/src/react/shell/routes/paletteData.test.ts`
- `packages/client/src/react/shell/routes/profileData.ts`
- `packages/client/src/react/shell/routes/settingsAccountData.test.ts`
- `packages/client/src/react/shell/routes/settingsHarnessesData.ts`
- `packages/client/src/react/shell/statusChannel.ts`
- `packages/client/src/react/shell/useAppearance.ts`
- `packages/client/src/react/shell/useAssistantConversations.ts`
- `packages/client/src/react/shell/useShellApps.test.tsx`
- `packages/client/src/react/shell/useShellApps.ts`
- `packages/client/src/react/ui/BarsBlock.tsx`
- `packages/client/src/react/ui/Button.tsx`
- `packages/client/src/react/ui/Logo.tsx`
- `packages/client/src/react/ui/blockParity.test.tsx`
- `packages/client/src/replica/addressed-vault.test.ts`
- `packages/client/src/replica/index.ts`
- `packages/client/src/replica/live-query.ts`
- `packages/client/src/replica/native.ts`
- `packages/client/src/replica/search.ts`
- `packages/client/src/replica/worker-client.ts`
- `packages/client/src/storage-metrics.ts`
- `packages/client/src/surface-copy.ts`
- `packages/client/src/types.d.ts`
- `packages/core/src/blob/index.ts`
- `packages/core/src/protocol/handshake.ts`
- `packages/core/src/protocol/routes.ts`
- `packages/core/src/time/recurrence.ts`
- `packages/design/src/blocks/bars.ts`
- `packages/design/src/blocks/blocks.test.ts`
- `packages/design/src/blocks/contracts.ts`
- `packages/design/src/blocks/distribution.ts`
- `packages/design/src/blueprint.ts`
- `packages/design/src/color.ts`
- `packages/design/src/contrast.test.ts`
- `packages/design/src/density.ts`
- `packages/design/src/design-md.test.ts`
- `packages/design/src/elements/dom.ts`
- `packages/design/src/elements/elements.test.ts`
- `packages/design/src/elements/feedback.test.ts`
- `packages/design/src/elements/feedback.ts`
- `packages/design/src/elements/index.ts`
- `packages/design/src/icons.ts`
- `packages/design/src/kit-css.test.ts`
- `packages/design/src/moment-matrix.test.ts`
- `packages/design/src/native.ts`
- `packages/design/src/roles.test.ts`
- `packages/design/src/roles.ts`
- `packages/design/src/themes/centraid.ts`
- `packages/design/src/themes/shared.ts`
- `packages/design/src/themes/themes.test.ts`
- `packages/design/src/type-role-parity.test.ts`
- `packages/model-runtime/ort-types.d.ts`
- `packages/model-runtime/src/onnx.test.ts`
- `packages/model-runtime/src/onnx.ts`
- `packages/server/src/acp/automation/run-automation-dispatch.test.ts`
- `packages/server/src/acp/automation/run-automation-live-dispatch.ts`
- `packages/server/src/acp/backends/acp/backend.model-usage.test.ts`
- `packages/server/src/acp/backends/acp/backend.test.ts`
- `packages/server/src/acp/backends/acp/backend.ts`
- `packages/server/src/acp/backends/acp/enumerate-models.test.ts`
- `packages/server/src/acp/backends/acp/harness-errors.test.ts`
- `packages/server/src/acp/backends/acp/harness-errors.ts`
- `packages/server/src/acp/backends/acp/session-warm.ts`
- `packages/server/src/acp/backends/acp/stop-reason.ts`
- `packages/server/src/acp/backends/acp/stream-events.test.ts`
- `packages/server/src/acp/backends/acp/vault-mcp-server.ts`
- `packages/server/src/acp/models/catalog.test.ts`
- `packages/server/src/acp/multimodal.ts`
- `packages/server/src/acp/preflight.test.ts`
- `packages/server/src/acp/registry.test.ts`
- `packages/server/src/acp/registry.ts`
- `packages/server/src/automation/fire/condition.ts`
- `packages/server/src/automation/fire/cron-cursor.ts`
- `packages/server/src/automation/fire/enrich-engine-selection.test.ts`
- `packages/server/src/automation/fire/enrich-gate.ts`
- `packages/server/src/automation/fire/enrich-resolve.ts`
- `packages/server/src/automation/fire/fire.ts`
- `packages/server/src/automation/fire/scheduler-ledger.ts`
- `packages/server/src/automation/handler/lint.ts`
- `packages/server/src/automation/handler/runner.ts`
- `packages/server/src/automation/manifest/manifest.test.ts`
- `packages/server/src/automation/manifest/manifest.ts`
- `packages/server/src/automation/worker/runner.ts`
- `packages/server/src/backup/backup-cas-reconciliation.test.ts`
- `packages/server/src/backup/backup-service-restore.test.ts`
- `packages/server/src/backup/backup-service.ts`
- `packages/server/src/backup/storage-connections.ts`
- `packages/server/src/backup/wal.integration.test.ts`
- `packages/server/src/cli/admin.test.ts`
- `packages/server/src/cli/backup-admin.test.ts`
- `packages/server/src/cli/cli.test.ts`
- `packages/server/src/cli/cli.ts`
- `packages/server/src/cli/device-admin.ts`
- `packages/server/src/cli/endpoint-host.ts`
- `packages/server/src/cli/service-admin.ts`
- `packages/server/src/engine/conversation/history.ts`
- `packages/server/src/engine/conversation/runner-core.failover.test.ts`
- `packages/server/src/engine/conversation/runner-core.ts`
- `packages/server/src/engine/conversation/store-items.test.ts`
- `packages/server/src/engine/conversation/store-sql.ts`
- `packages/server/src/engine/conversation/store.ts`
- `packages/server/src/engine/conversation/turn.ts`
- `packages/server/src/engine/handlers/dispatcher.ts`
- `packages/server/src/engine/handlers/handler-runner.contract.test.ts`
- `packages/server/src/engine/handlers/handler-runner.ts`
- `packages/server/src/engine/handlers/worker-admission.ts`
- `packages/server/src/engine/handlers/worker-pool.ts`
- `packages/server/src/engine/http/changes-sse.ts`
- `packages/server/src/engine/http/compression.ts`
- `packages/server/src/engine/http/router.test.ts`
- `packages/server/src/engine/http/router.ts`
- `packages/server/src/engine/http/sse-stream.ts`
- `packages/server/src/engine/http/turn-routes.test.ts`
- `packages/server/src/engine/insights/analytics-store.ts`
- `packages/server/src/engine/model-pricing.test.ts`
- `packages/server/src/engine/registry/manifest.ts`
- `packages/server/src/engine/registry/registry.ts`
- `packages/server/src/engine/registry/token-purity.ts`
- `packages/server/src/engine/runtime.ts`
- `packages/server/src/engine/sandbox/boot.test.ts`
- `packages/server/src/engine/sandbox/boot.ts`
- `packages/server/src/engine/settings/settings-merge.ts`
- `packages/server/src/engine/stores/gateway-db.ts`
- `packages/server/src/engine/worker/ts-loader-hooks.ts`
- `packages/server/src/lifecycle/automation-lifecycle-over-http.test.ts`
- `packages/server/src/lifecycle/install-over-http.test.ts`
- `packages/server/src/lifecycle/lifecycle-over-http.test.ts`
- `packages/server/src/lifecycle/lifecycle-shared.ts`
- `packages/server/src/routes/apps-store-routes.ts`
- `packages/server/src/routes/assistant-routes.ts`
- `packages/server/src/routes/automations-routes-lanes.test.ts`
- `packages/server/src/routes/automations-routes.ts`
- `packages/server/src/routes/edges-reconcile.ts`
- `packages/server/src/routes/edges-routes.test.ts`
- `packages/server/src/routes/edges-routes.ts`
- `packages/server/src/routes/grant-routes.ts`
- `packages/server/src/routes/harnesses-routes.ts`
- `packages/server/src/routes/lifecycle-automation-routes.test.ts`
- `packages/server/src/routes/lifecycle-automation-routes.ts`
- `packages/server/src/routes/lifecycle-routes.ts`
- `packages/server/src/routes/peer-commons-route.ts`
- `packages/server/src/routes/peer-plane.test.ts`
- `packages/server/src/routes/replica-access.ts`
- `packages/server/src/routes/replica-routes.ts`
- `packages/server/src/routes/templates-routes.ts`
- `packages/server/src/routes/vault-routes.test.ts`
- `packages/server/src/routes/vault-routes.ts`
- `packages/server/src/runs/unified-conversation-runner.ts`
- `packages/server/src/serve/automation-event-sources-github.test.ts`
- `packages/server/src/serve/build-gateway.ts`
- `packages/server/src/serve/diagnostics-redaction.ts`
- `packages/server/src/serve/gateway-db.test.ts`
- `packages/server/src/serve/gateway-db.ts`
- `packages/server/src/serve/gateway-schema.ts`
- `packages/server/src/serve/hardware-profile.ts`
- `packages/server/src/serve/pairing-ticket-host-custody.test.ts`
- `packages/server/src/serve/peer-commons-client.ts`
- `packages/server/src/serve/peer-commons-sweep.test.ts`
- `packages/server/src/serve/peer-give.test-fixtures.ts`
- `packages/server/src/serve/peer-link-client.ts`
- `packages/server/src/serve/peer-transport-remote.test.ts`
- `packages/server/src/serve/share-coordinator.test.ts`
- `packages/server/src/serve/share-coordinator.ts`
- `packages/server/src/serve/share-effect-executor.ts`
- `packages/server/src/serve/share-outbox-obligation.contract.test.ts`
- `packages/server/src/serve/share-scope.ts`
- `packages/server/src/serve/storage-limits.ts`
- `packages/server/src/serve/support-bundle.ts`
- `packages/server/src/serve/vault-links-store.test.ts`
- `packages/server/src/serve/vault-links-store.ts`
- `packages/server/src/serve/vault-picker.ts`
- `packages/server/src/serve/vault-plane-blob-sweep.test.ts`
- `packages/server/src/serve/vault-plane.ts`
- `packages/server/src/serve/vault-registry-footprint.test.ts`
- `packages/server/src/serve/vault-registry.test.ts`
- `packages/server/src/serve/vault-registry.ts`
- `packages/server/src/serve/web-control-sessions.ts`
- `packages/server/src/skills/authoring-prompt.test.ts`
- `packages/server/src/skills/authoring-prompt.ts`
- `packages/server/src/skills/compose.test.ts`
- `packages/server/src/skills/index.ts`
- `packages/server/src/validate-manifest.ts`
- `packages/server/src/worktree-store/worktree-store.ts`
- `packages/tunnel/src/alpn-parity.test.ts`
- `packages/tunnel/src/desktop-tunnel.ts`
- `packages/tunnel/src/gateway-endpoint.ts`
- `packages/tunnel/src/peer-target-differential.test.ts`
- `packages/vault/src/blob/blob.test.ts`
- `packages/vault/src/blob/cache.test.ts`
- `packages/vault/src/blob/cache.ts`
- `packages/vault/src/blob/direct-cold-doors.test.ts`
- `packages/vault/src/blob/local.ts`
- `packages/vault/src/blob/orphan-grace.test.ts`
- `packages/vault/src/blob/outbox-runner.test.ts`
- `packages/vault/src/blob/pipeline.ts`
- `packages/vault/src/blob/replica-index.ts`
- `packages/vault/src/blob/s3-pipeline.ts`
- `packages/vault/src/blob/s3.test.ts`
- `packages/vault/src/blob/seal-frames.ts`
- `packages/vault/src/blob/store-routing.test.ts`
- `packages/vault/src/commands/enrich.ts`
- `packages/vault/src/commands/judgment.ts`
- `packages/vault/src/commands/links.test.ts`
- `packages/vault/src/commands/people.ts`
- `packages/vault/src/errors.ts`
- `packages/vault/src/gateway/duties.test.ts`
- `packages/vault/src/gateway/ext.ts`
- `packages/vault/src/gateway/gateway.ts`
- `packages/vault/src/ingest/enrich-publishers.ts`
- `packages/vault/src/ingest/payload-schemas.test.ts`
- `packages/vault/src/recurrence/rrule.test.ts`
- `packages/vault/src/schema/atlas-browse-refs.ts`
- `packages/vault/src/schema/atlas-browse.ts`
- `packages/vault/src/schema/atlas-census.ts`
- `packages/vault/src/schema/atlas-graph.ts`
- `packages/vault/src/schema/domains-tally.ts`
- `packages/vault/src/schema/key-store.ts`
- `packages/vault/src/share/commons-bootstrap.ts`
- `packages/vault/src/share/commons-routing.test.ts`
- `packages/vault/src/share/commons-routing.ts`
- `packages/vault/src/share/commons-sim-grant-world.test-fixtures.ts`
- `packages/vault/src/share/commons-sim-grant.test-fixtures.ts`
- `packages/vault/src/share/placement-lifecycle.test.ts`
- `packages/vault/src/share/placement.test.ts`
- `packages/vault/src/wal-shipper-clone.test.ts`
- `packages/vault/src/wal-shipper-detectors.test.ts`
- `packages/vault/src/wal-shipper.test.ts`
- `packages/vault/src/wal-shipper.ts`
- `receipts/issue-861-comment-current-state.md`
- `scripts/lint-comment-file-refs.mjs`
- `scripts/lint-comment-narration.mjs`
- `scripts/perf/README.md`

## User impact

None visible. The diff is comment-only across every UI package — no rendered
pixel, string, or behavior changes anywhere. The evidence for "unchanged" is
the first-run surface the desktop harness already captures:
`artifacts/e2e/ui-impact/issue-679-first-run-home.png`, emitted by
`apps/desktop/tests/e2e/onboarding-home.spec.ts` (in this diff with comment
edits only), re-captures the same Home because nothing user-facing moved.

First-run: onboarding and the fresh Home are unchanged; this change series
touches only comments.

## Out of scope

- Markdown docs narration (done under #767); the evidence layer (receipts,
  CHANGELOG, Evolution Log, QUALITY `## Resolved`) untouched.
- Behavior, code, type, or test changes beyond comment lines and the
  sanctioned `perf-budgets.ts`/`scripts/perf/README.md` relocation.
- Lint/oxlint rule or budget changes; the two new checks are warn-only lanes,
  not gates.
- `COMPAT(…)` stamp mechanics and duplication (settled Q3).
- JSDoc tag adoption (settled Q7); module splits of banner-heavy files
  (settled Q4).
- Promotion of the dangling-ref check to a blocking directive (future ruling).

## Decisions

- The issue's seven "settled recommendations" are executed as ruled: delete
  narration by default with present-tense conversion only for binding
  constraints (Q1); both checks warn-only (Q2); COMPAT stamps untouched (Q3);
  banner-heavy modules recorded in QUALITY.md, not reshaped (Q4); density
  unregulated (Q5); box-drawing banners win despite ASCII being the numeric
  majority (Q6); no JSDoc tags (Q7).
- The check scripts follow the existing `scripts/lint-*.mjs` convention
  rather than a `.governance` directive: the governance pack tree is
  digest-managed kit territory and the checks are warn-only lanes, not gates.
  No `package.json` wiring, so no toolchain-config waiver is needed.
- Check regexes carry the `u` flag and named/non-capturing groups to satisfy
  the repo's own oxlint rules (`require-unicode-regexp`,
  `prefer-named-capture-group`).
- `perf-budgets.ts`'s `approvedDeviation` string is treated as append-only
  ratchet evidence and left byte-identical.
- Two byte-level fingerprint ratchets tripped on comment-only edits and are
  re-pinned per their own protocols. Schema/export:
  `tests/schema-export-fingerprint.json` re-pinned with the deviation note
  prepended and the export owner touched
  (`packages/vault/src/gateway/portable-export.ts`, audit note #861 — the
  same comment-only precedent as its #721 note). Classification
  (`tests/quality/classification-ratchet.json`), deviation note verbatim:
  #861 comment sweep re-pin: packages/server/src/acp/backends/acp/vault-mcp-server.ts and packages/server/src/automation/manifest/manifest.ts changed in comment lines only (historical narration converted to present tense; no code, classification, refusal, or gate changed), so their governed fingerprints are re-pinned to the same logic at new bytes. No quality lost a gate, no gate lost its evidence, and every other governed fingerprint is unmoved.
- Three local `check:push` failures are environmental, not this diff's, and
  are left to CI where those lanes run with their real toolchains:
  `@centraid/desktop` `ipc-core.test.ts` cannot load the Electron binary in
  this sandbox ("Electron failed to install correctly"; the suite's 308/308
  tests pass); `design:gallery` wants a Playwright chromium revision this
  container does not have; and the iOS `@expo/fingerprint` identity mismatch
  is iOS-only while Android matches — a comment-only TS diff feeds neither,
  so the committed fingerprint is left alone rather than re-written from a
  container whose prebuild state differs from CI. The push therefore uses the
  pre-push gate's own documented escape (`SKIP_CHECK_PR=1`, "CI still
  enforces") after every non-environmental gate was run and fixed locally.

## Verification

Both warn-only checks, before the sweep (evidence baseline) and re-run on the
final tree:

```
bun scripts/lint-comment-file-refs.mjs   # baseline: 52 dangling reference(s)
bun scripts/lint-comment-narration.mjs   # baseline: 772 line(s) to review
```

Scoped lint over every root-edited file is clean:

```
bunx oxlint -c oxlint.config.ts --disable-nested-config --deny-warnings \
  packages/design/src/blocks/contracts.ts packages/design/src/density.ts \
  packages/design/src/themes/shared.ts packages/client/src/home-copy.ts \
  apps/mobile/src/apps/photos/photos-band.ts \
  packages/blueprints/apps/photos/enrichment-consent.ts \
  packages/blueprints/src/types.ts apps/web/tests/e2e/perf-budgets.ts \
  scripts/lint-comment-file-refs.mjs scripts/lint-comment-narration.mjs
```

Final-tree evidence, re-run after all waves landed:

```
bun scripts/lint-comment-file-refs.mjs
#  → "clean — every comment file reference is live"  (baseline was 52;
#    the dangling-file-ref check reports zero findings on the final tree)
bun scripts/lint-comment-narration.mjs
#  → 71 line(s), the exact union of the six slices' justified survivor
#    lists (17 server + 12 client + 10 mobile + 16 blueprints + 17 misc
#    + 3 shells minus overlaps, plus the root-owned enrichment-consent
#    line). Narration tripwire output on the final tree is reviewed
#    line-by-line; every residual match is a present-tense constraint
#    (idiomatic "used to <verb>" = employed-to, present passives like
#    "is replaced", quoted definitions, and one deliberately recorded
#    rejected-experiment block in apps/web/vite.config.ts).
git grep -n 'eslint-disable' -- 'packages/**/*.ts*' 'apps/**/*.ts*'
#  → empty (tracked sources only; the sole non-tracked hit is the gitignored
#    generated apps/oauth-worker/worker-configuration.d.ts, which the checks
#    also exclude by enumerating via `git ls-files`). Zero `eslint-disable`
#    strings remain in `.ts`/`.tsx` comments; every suppression verified
#    still effective under its oxlint name (slices probed by deleting a
#    directive, watching the rule fire, restoring it — with
#    reportUnusedDisableDirectives=deny catching dead directives).
git grep -nE '^\s*// *-{6,}' -- 'packages/**/*.ts*' 'apps/**/*.ts*'
#  → zero ASCII banners; one banner style repo-wide (box-drawing).
bun run lint       # oxlint over 4,664 files → clean
bun run format     # oxfmt → no changes needed
bun run typecheck  # turbo, 25/25 tasks successful (every touched package)
```

Every sweep change touches comment lines only (plus the sanctioned Wave-3
relocations); no test, type, or behavior changes — each slice verified its
diff by filtering for non-comment `+`/`-` lines (empty in all six), and the
scoped typechecks plus the final repo-wide typecheck hold. Every Wave 1 site
in the issue appendix is fixed with the current truth verified by grep — no
guessed successor filenames; where no successor exists the claim was deleted
(`apps-store-client.ts`, `band-owner.ts`, `host-platform.ts`).

The dangling-ref promotion decision (settled Q2) is recorded as a comment on
issue #861. See
[issuecomment-5396382447](https://github.com/srikanth235/centraid/issues/861#issuecomment-5396382447):
warn-only for now; promotion to a blocking directive is a future ruling taken
once the zero baseline has held through normal PR cycles.

Acceptance criteria, restated verbatim over the evidence above:

- `docs/coding-standards.md` carries the "Comments describe now" section: tense test, rewrite table, live-file-ref/prefer-symbol rule, blessed heading idiom, blessed banner style, and the explicit non-goals (density unregulated, no JSDoc tags).
- Both warn-only checks exist and run; the dangling-file-ref check reports zero findings on the final tree.
- Every Wave 1 site in the issue appendix is fixed with the current truth verified by grep — no guessed successor filenames.
- Narration tripwire output on the final tree is reviewed line-by-line; every residual match is a present-tense constraint.
- Zero `eslint-disable` strings remain in `.ts`/`.tsx` comments; every suppression verified still effective under its oxlint name.
- One banner style repo-wide.
- Every sweep change touches comment lines only (plus the sanctioned Wave-3 relocations); no test, type, or behavior changes.
- Wave 3 verdict (keep / compress / relocate) recorded per ratio-offender file; `perf-budgets.ts` runbook relocated.
- QUALITY.md carries the module-size observation (settled Q4).

## Audit

Fresh-context sub-agent, adversarial, over the staged diff, this receipt, and
the acceptance criteria. Four rounds; each REFUTED round was remediated and
re-audited rather than argued with:

1. **REFUTED** (root-wave partial): the "What changed" table listed two
   no-edit verdict files as changes → table corrected to an explicit
   "Keep, no edit — appear in no diff" note.
2. **REFUTED** (full umbrella): both check scripts scanned the gitignored
   generated `apps/oauth-worker/worker-configuration.d.ts`, so the recorded
   narration count (71) and eslint-disable evidence did not reproduce →
   both scripts now enumerate tracked files via `git ls-files`; evidence
   commands restated as tracked-tree `git grep`s.
3. **REFUTED**: the bonus `ext.ts` banner fix was missing from the change
   surface list and banner counts → list and counts corrected (617 files,
   38 lines / seven files).
4. Final round:

**Verdict: PASS**

- Change surface is set-identical at 617: `git diff --cached --name-only` against the receipt's list is empty in both `comm` directions, no duplicates; the heading's promise — "every file in this umbrella's diff" — holds literally.
- The follow-ups paragraph is corrected and accurate: 38 leftover ASCII banner lines across seven files, `ext.ts` named with a correct parenthetical on its NUL-byte grep behavior (816 NUL bytes, past git's 8 KB text heuristic).
- Working tree equals the index; every audit command ran against the tree the receipt describes.
- Both prior refutations remain remediated: narration reproduces at 71 findings, file-refs at "clean"; tracked-tree `git grep` for `eslint-disable` and ASCII banners both return empty.
- Comment-only holds across all 617 files: `git diff --cached -U0 -- packages apps` filtered for non-comment `+`/`-` lines returns 0, `ext.ts` included.
- Wave 0's section with all six promised parts, the Wave 3 verdict table with byte-identical `approvedDeviation`, the `scripts/perf/README.md` relocation, the QUALITY.md Q4 observation, and six spot-checked slice claims all re-confirm.
- Internal consistency holds: the 9 checked checklist items are diff-identical to the acceptance criteria restated in Verification; the single unchecked item (the Q2 promotion ruling as an issue comment) is process follow-up, correctly left open.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-24 | claude-code | 9988c109-6474-5924-b263-ee0ff5fa132d |
