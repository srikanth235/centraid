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

## Phase 2 — comments face forward (deletion-first sweep)

Ruled on the issue (comment 5397080529, extending the Decision section):
Phase 1 cured lying comments; this phase cures worthless-but-true ones under
the governing definition — a comment is a forward-facing obligation, a message
to the next editor stating something the code cannot state, alive only as long
as its deletion would mislead someone. Same umbrella, same receipt.

### Checklist (phase 2)

- [x] `docs/coding-standards.md` carries the "Comments face forward" doctrine
      (four species, deletion test, deletion-first, encoding ladder, trust
      budget, directive register, no tenure) with Phase 1's mechanical rules
      demoted to a "Mechanical surrogates" subsection (finders, never
      verdicts). Both warn-only lint headers renamed to match.
- [x] Deletion-first sweep executed across all six ownership slices; every
      survivor classifiable to a species; per-slice counts below.
- [x] The Phase 2 diff is comment-only across `packages/**`/`apps/**`
      (proof below; one sanctioned JSX-container deletion).
- [x] Receipt appended with a fresh-context audit verdict (below).

### What changed (phase 2)

**Wave 0 (root).** `docs/coding-standards.md`: "Comments describe now" became
**"Comments face forward"** — the doctrine, then the surrogates. Issue #861
retitled to cover both phases; the Phase 2 ruling posted as issue comment
5397080529 with workstreams A2 (rulebook), B2 (no new mechanical checks — the
deletion test cannot be regexed; settled), C2 (the sweep), and five settled
questions (delete-first; signature-restating JSDoc dies; orientation headers
are maps; machine-facing/protocol comments untouchable; density still
unregulated).

**Waves 1–2 (six parallel slice agents, disjoint by ownership).** Worker
self-reported counts at hand-off:

| Slice | Files touched | Deleted sites | Rewritten to directive register | Notable |
| --- | --- | --- | --- | --- |
| packages/server | 218 | 44 blocks (+84 blocks shrunk) | 193 | zero `@param`/`@returns` noise found in 799 files; JSDoc re-attached to its declaration in 2 files (code order unchanged) |
| packages/client + packages/design | 127 | 12 (+65 blocks shrunk) | 147 | ~45 comments narrated the retired vanilla shell as live (`App.tsx` claimed the shell "NOT yet wired to `#root`"); multi-agent lane narration removed from production source; design confirmed as house model (11 of 79 files needed edits) |
| apps/mobile | 309 | ~48 | ~130 (+393 citation normalizations) | changelog headers recast as present prohibitions (`FaceReview.tsx` "WHAT THIS SCREEN MAY NOT DO"); platform footguns and measured cost bounds kept |
| packages/blueprints | 108 | 31 (115 lines) | 123 | one rotted comment (`apps/people/app-inline.tsx` claimed a rebuild had not happened that has); package suite 4,803 tests green at hand-off |
| packages/vault + backup/cli/core/model-runtime/test-kit/tunnel | 87 | 25 | ~45 (+46 citation normalizations) | 20 copy-pasted zero-information `/** Register the X commands */` JSDocs deleted (two had drifted onto the wrong declaration); `recovery-kit.ts` header repointed from nonexistent `writeRecoveryKit` to `wrapRecoveryKit`; barred from `schema/` by the brief |
| apps/web + desktop + extension + oauth-worker | 45 | 17 | ~82 | the Phase 2 trigger files fixed: `gateway-monitor.ts` / `gateway-monitor-core.ts` headers now state obligations, not the #351 wave story |

**Wave 3 (root integration).**

- **Citation-form ruling:** bare `(#N)` is the citation form; wave/phase/part
  qualifiers are process vocabulary and die inside parenthetical citations.
  Applied mechanically to comment lines only (untouchables excluded): 1,328
  files, 2,552 parenthetical citations normalized, 885 bare `issue #N`
  collapsed to `#N`. Trailing comments after code deliberately not matched
  (strings could masquerade); compound citations and multi-line parentheticals
  left as-is. Known residue (audit advisory): ~21 single-citation
  parentheticals with hyphen/lowercase qualifier forms (`W2-1`, `d11`) or
  inside JSX comment containers were outside the pattern and survive; they are
  candidates for the same treatment whenever their files are next touched (no
  tenure).
- **Schema directory (root-owned):** five hand conversions
  (`time-organize.ts`, `blob.ts`, `journal.ts`, `atlas-browse-refs.ts`,
  `domains-people.ts`) plus one narration trim in `blob.ts`; the worker's
  proposed keeps (`sealed.ts` erase invariants, `poly-refs.ts`, `fts.ts`,
  `notifications.ts` "formerly Inbox" rename-back guard) stand.
- **Suppression hygiene:** both `ErrorBoundary.tsx` twins (mobile, client
  shell) carried `/* eslint-enable ... */` closers under `oxlint-disable`
  openers — the `enable` form Phase 1's rename missed; renamed to
  `oxlint-enable`. Zero `eslint-` markers remain in tracked `.ts`/`.tsx`.
- **Residual narration fixes:** `settingsAccountData.ts` ("Import pane's
  callbacks lived here until #807" became "There is no Import pane (#807)")
  and `packages/vault/src/commands/people.ts` ("named circles until #441"
  became the same prohibition its schema twin states).
- **`packages/backup/README.md`:** dangling `writeRecoveryKit` mention fixed
  to `wrapRecoveryKit`.
- **QUALITY.md:** four new Open entries — dead exports (`CodeLang`,
  `DiffRow`/`diffRows`), "chat" vocabulary in ledger comments, blueprint
  handler contracts wanting to climb from inert `@type` JSDoc to
  `satisfies ActionHandler`, and sub-wave stamps in test-name string
  literals.
- **Kept by ruling:** the ~20 `@type` `ActionHandler`/`QueryHandler` JSDoc
  tags — the handlers are dynamically loaded default exports with no static
  check, so the tag is the only statement of the contract (species: contract)
  until the exports are typed.

### Change surface (phase 2) — every file in this phase's diff

1881 files, enumerated from `git diff HEAD --name-only` at commit
time (comment-only in `packages/**`/`apps/**` per the proof below; the
non-TS files are the standard, the two lint scripts, the two ratchet JSONs,
QUALITY.md, `packages/backup/README.md`, and this receipt):

- `QUALITY.md`
- `apps/desktop/src/main.ts`
- `apps/desktop/src/main/app-chrome.ts`
- `apps/desktop/src/main/app-sessions.ts`
- `apps/desktop/src/main/apps-store-client.ts`
- `apps/desktop/src/main/auth-injector.ts`
- `apps/desktop/src/main/crash-log-core.ts`
- `apps/desktop/src/main/crash-log.ts`
- `apps/desktop/src/main/detached-gateway-core.ts`
- `apps/desktop/src/main/detached-gateway.ts`
- `apps/desktop/src/main/embedded-gateway-layout.test.ts`
- `apps/desktop/src/main/embedded-gateway.ts`
- `apps/desktop/src/main/gateway-connectivity-core.ts`
- `apps/desktop/src/main/gateway-connectivity.ts`
- `apps/desktop/src/main/gateway-monitor-core.ts`
- `apps/desktop/src/main/gateway-monitor-notifications.test.ts`
- `apps/desktop/src/main/gateway-monitor.ts`
- `apps/desktop/src/main/gateway-ops-core.ts`
- `apps/desktop/src/main/gateway-ops.ts`
- `apps/desktop/src/main/gateway-outage-log-core.ts`
- `apps/desktop/src/main/gateway-outage-log.ts`
- `apps/desktop/src/main/gateway-pairing-core.ts`
- `apps/desktop/src/main/gateway-pairing.ts`
- `apps/desktop/src/main/gateway-paths.ts`
- `apps/desktop/src/main/gateway-secrets.ts`
- `apps/desktop/src/main/gateway-store-core.ts`
- `apps/desktop/src/main/gateway-store.ts`
- `apps/desktop/src/main/gateway-supervisor-core.ts`
- `apps/desktop/src/main/gateway-vaults-core.ts`
- `apps/desktop/src/main/gateway-vaults.ts`
- `apps/desktop/src/main/ipc-core.ts`
- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/src/main/iroh-dialer.ts`
- `apps/desktop/src/main/local-gateway.test.ts`
- `apps/desktop/src/main/local-gateway.ts`
- `apps/desktop/src/main/login-item.ts`
- `apps/desktop/src/main/phone-link.ts`
- `apps/desktop/src/main/preload-core.test.ts`
- `apps/desktop/src/main/preload-core.ts`
- `apps/desktop/src/main/settings-merge.ts`
- `apps/desktop/src/main/settings.ts`
- `apps/desktop/src/main/update-check.ts`
- `apps/desktop/src/main/update-rollout-core.ts`
- `apps/desktop/src/main/update-rollout.ts`
- `apps/desktop/src/main/update-signature-gate.ts`
- `apps/desktop/src/main/update-watcher.ts`
- `apps/desktop/src/main/version-handshake.ts`
- `apps/desktop/src/main/window-state.ts`
- `apps/desktop/src/preload.ts`
- `apps/desktop/tests/e2e/automations.spec.ts`
- `apps/desktop/tests/e2e/fixtures.ts`
- `apps/desktop/tests/e2e/household.spec.ts`
- `apps/desktop/tests/e2e/launch-time.spec.ts`
- `apps/desktop/tests/e2e/onboarding-home.spec.ts`
- `apps/desktop/tests/e2e/pending-overlay.spec.ts`
- `apps/desktop/tests/e2e/playwright.config.ts`
- `apps/desktop/tests/e2e/settings-enrichment.spec.ts`
- `apps/desktop/tests/e2e/settings-gateways.spec.ts`
- `apps/desktop/vite.config.ts`
- `apps/extension/src/content-core.ts`
- `apps/extension/src/popup-core.ts`
- `apps/extension/src/transport-core.ts`
- `apps/extension/src/worker-core.ts`
- `apps/mobile/App.tsx`
- `apps/mobile/app.config.ts`
- `apps/mobile/index.ts`
- `apps/mobile/lazy-screens.tsx`
- `apps/mobile/modules/centraid-tunnel/index.ts`
- `apps/mobile/navigators.tsx`
- `apps/mobile/src/ErrorBoundary.tsx`
- `apps/mobile/src/apps/agenda/AgendaBand.tsx`
- `apps/mobile/src/apps/agenda/AgendaEvent.tsx`
- `apps/mobile/src/apps/agenda/AgendaEventEditor.tsx`
- `apps/mobile/src/apps/agenda/AgendaHome.tsx`
- `apps/mobile/src/apps/assistant/Assistant.tsx`
- `apps/mobile/src/apps/automations/automations-model.ts`
- `apps/mobile/src/apps/docs/AddToDocs.tsx`
- `apps/mobile/src/apps/docs/BulkUpload.tsx`
- `apps/mobile/src/apps/docs/DocRow.tsx`
- `apps/mobile/src/apps/docs/DocsBand.tsx`
- `apps/mobile/src/apps/docs/DocsCapabilities.tsx`
- `apps/mobile/src/apps/docs/DocsDueView.tsx`
- `apps/mobile/src/apps/docs/DocsFoldersView.tsx`
- `apps/mobile/src/apps/docs/DocsHome.tsx`
- `apps/mobile/src/apps/docs/DocsScan.tsx`
- `apps/mobile/src/apps/docs/DocsScreen.tsx`
- `apps/mobile/src/apps/docs/DocsSearchView.tsx`
- `apps/mobile/src/apps/docs/DocsStarred.tsx`
- `apps/mobile/src/apps/docs/DocsStorage.tsx`
- `apps/mobile/src/apps/docs/DocumentEditor.tsx`
- `apps/mobile/src/apps/docs/DocumentNames.tsx`
- `apps/mobile/src/apps/docs/DocumentProperties.tsx`
- `apps/mobile/src/apps/docs/DocumentRead.tsx`
- `apps/mobile/src/apps/docs/DocumentVersions.tsx`
- `apps/mobile/src/apps/docs/DocumentViewer.tsx`
- `apps/mobile/src/apps/docs/DriveList.tsx`
- `apps/mobile/src/apps/docs/FolderView.tsx`
- `apps/mobile/src/apps/docs/ProposedFiling.tsx`
- `apps/mobile/src/apps/docs/doc-menu.test.ts`
- `apps/mobile/src/apps/docs/doc-menu.ts`
- `apps/mobile/src/apps/docs/docs-band.test.ts`
- `apps/mobile/src/apps/docs/docs-band.ts`
- `apps/mobile/src/apps/docs/docs-copy.ts`
- `apps/mobile/src/apps/docs/docs-export.ts`
- `apps/mobile/src/apps/docs/docs-projection.test.ts`
- `apps/mobile/src/apps/docs/docs-projection.ts`
- `apps/mobile/src/apps/docs/docs-versions.ts`
- `apps/mobile/src/apps/docs/docs-view-prefs.test.ts`
- `apps/mobile/src/apps/docs/document-read-model.ts`
- `apps/mobile/src/apps/docs/editor-outcome.ts`
- `apps/mobile/src/apps/docs/useDocs.ts`
- `apps/mobile/src/apps/docs/useDocsGrantAudiences.ts`
- `apps/mobile/src/apps/docs/useDocumentText.ts`
- `apps/mobile/src/apps/docs/useVersionChain.ts`
- `apps/mobile/src/apps/insights/Insights.styles.ts`
- `apps/mobile/src/apps/insights/Insights.tsx`
- `apps/mobile/src/apps/locker/LockerItemRow.tsx`
- `apps/mobile/src/apps/people/PeopleBand.tsx`
- `apps/mobile/src/apps/people/PeopleHome.tsx`
- `apps/mobile/src/apps/people/PeopleScreen.tsx`
- `apps/mobile/src/apps/people/PersonView.tsx`
- `apps/mobile/src/apps/people/people-band.ts`
- `apps/mobile/src/apps/photos/AlbumDetail.styles.ts`
- `apps/mobile/src/apps/photos/CameraRollImportOffer.tsx`
- `apps/mobile/src/apps/photos/DuplicatesShelf.tsx`
- `apps/mobile/src/apps/photos/EnrichmentConsent.styles.ts`
- `apps/mobile/src/apps/photos/EnrichmentConsent.test.tsx`
- `apps/mobile/src/apps/photos/EnrichmentConsent.tsx`
- `apps/mobile/src/apps/photos/FaceReview.test.tsx`
- `apps/mobile/src/apps/photos/FaceReview.tsx`
- `apps/mobile/src/apps/photos/MediaPage.tsx`
- `apps/mobile/src/apps/photos/MemoriesView.test.tsx`
- `apps/mobile/src/apps/photos/MemoriesView.tsx`
- `apps/mobile/src/apps/photos/PhotoAccessPanel.tsx`
- `apps/mobile/src/apps/photos/PhotoEditor.test.tsx`
- `apps/mobile/src/apps/photos/PhotoGrainView.tsx`
- `apps/mobile/src/apps/photos/PhotoLightbox.styles.ts`
- `apps/mobile/src/apps/photos/PhotoLightbox.tsx`
- `apps/mobile/src/apps/photos/PhotoLightboxChrome.tsx`
- `apps/mobile/src/apps/photos/PhotoStateView.tsx`
- `apps/mobile/src/apps/photos/PhotosBand.tsx`
- `apps/mobile/src/apps/photos/PhotosCollectionsView.test.tsx`
- `apps/mobile/src/apps/photos/PhotosCollectionsView.tsx`
- `apps/mobile/src/apps/photos/PhotosGridSkeleton.tsx`
- `apps/mobile/src/apps/photos/PhotosHome.styles.ts`
- `apps/mobile/src/apps/photos/PhotosHome.tsx`
- `apps/mobile/src/apps/photos/PhotosLibrary.tsx`
- `apps/mobile/src/apps/photos/PhotosMoreSheet.test.tsx`
- `apps/mobile/src/apps/photos/PhotosMoreSheet.tsx`
- `apps/mobile/src/apps/photos/PhotosPeopleView.test.tsx`
- `apps/mobile/src/apps/photos/PhotosPeopleView.tsx`
- `apps/mobile/src/apps/photos/PhotosScreen.test.tsx`
- `apps/mobile/src/apps/photos/PhotosScreen.tsx`
- `apps/mobile/src/apps/photos/PhotosSearch.tsx`
- `apps/mobile/src/apps/photos/PlaceDetail.test.tsx`
- `apps/mobile/src/apps/photos/PlaceDetail.tsx`
- `apps/mobile/src/apps/photos/PlacesMap.test.tsx`
- `apps/mobile/src/apps/photos/PlacesMap.tsx`
- `apps/mobile/src/apps/photos/PlacesSketchMap.tsx`
- `apps/mobile/src/apps/photos/PlacesView.test.tsx`
- `apps/mobile/src/apps/photos/PlacesView.tsx`
- `apps/mobile/src/apps/photos/TimelineGrainControl.tsx`
- `apps/mobile/src/apps/photos/camera-roll-import-run.ts`
- `apps/mobile/src/apps/photos/camera-roll-import.test.ts`
- `apps/mobile/src/apps/photos/camera-roll-import.ts`
- `apps/mobile/src/apps/photos/exif-location-strip.ts`
- `apps/mobile/src/apps/photos/face-review-queue.ts`
- `apps/mobile/src/apps/photos/image-cache.ts`
- `apps/mobile/src/apps/photos/memories-model.test.ts`
- `apps/mobile/src/apps/photos/memories-model.ts`
- `apps/mobile/src/apps/photos/people-model.test.ts`
- `apps/mobile/src/apps/photos/people-model.ts`
- `apps/mobile/src/apps/photos/photo-access.ts`
- `apps/mobile/src/apps/photos/photo-edit-model.ts`
- `apps/mobile/src/apps/photos/photo-edit-save.ts`
- `apps/mobile/src/apps/photos/photo-grants.ts`
- `apps/mobile/src/apps/photos/photo-share.test.ts`
- `apps/mobile/src/apps/photos/photos-backup-copy.ts`
- `apps/mobile/src/apps/photos/photos-backup-messages.test.ts`
- `apps/mobile/src/apps/photos/photos-backup.ts`
- `apps/mobile/src/apps/photos/photos-band.test.ts`
- `apps/mobile/src/apps/photos/photos-band.ts`
- `apps/mobile/src/apps/photos/photos-collections-menu.ts`
- `apps/mobile/src/apps/photos/photos-collections.test.ts`
- `apps/mobile/src/apps/photos/photos-collections.ts`
- `apps/mobile/src/apps/photos/photos-fixtures.ts`
- `apps/mobile/src/apps/photos/photos-library-menu.ts`
- `apps/mobile/src/apps/photos/photos-more-router.test.ts`
- `apps/mobile/src/apps/photos/photos-trash.ts`
- `apps/mobile/src/apps/photos/places-map-apple.tsx`
- `apps/mobile/src/apps/photos/places-map-libre.tsx`
- `apps/mobile/src/apps/photos/places-map-mode.ts`
- `apps/mobile/src/apps/photos/places-model.test.ts`
- `apps/mobile/src/apps/photos/places-model.ts`
- `apps/mobile/src/apps/photos/places-pin.tsx`
- `apps/mobile/src/apps/photos/search-hits.test.ts`
- `apps/mobile/src/apps/photos/search-hits.ts`
- `apps/mobile/src/apps/photos/search-place-vocabulary.ts`
- `apps/mobile/src/apps/photos/share-place-call-sites.test.ts`
- `apps/mobile/src/apps/photos/tile-overlays.ts`
- `apps/mobile/src/apps/photos/timeline-10k-one-day.test.ts`
- `apps/mobile/src/apps/photos/timeline-50k.test.ts`
- `apps/mobile/src/apps/photos/timeline-grains.ts`
- `apps/mobile/src/apps/photos/timeline-model.test.ts`
- `apps/mobile/src/apps/photos/timeline-model.ts`
- `apps/mobile/src/apps/photos/timeline-rows.test.ts`
- `apps/mobile/src/apps/photos/use-photo-selection-share.ts`
- `apps/mobile/src/apps/photos/video-scrub-strip-native.ts`
- `apps/mobile/src/apps/photos/video-scrub-strip.ts`
- `apps/mobile/src/apps/photos/viewer-menu.test.ts`
- `apps/mobile/src/apps/photos/viewer-menu.ts`
- `apps/mobile/src/apps/photos/viewer-model.test.ts`
- `apps/mobile/src/apps/photos/viewer-model.ts`
- `apps/mobile/src/apps/photos/viewer-read-only-reason.test.ts`
- `apps/mobile/src/apps/tally/TallyHome.tsx`
- `apps/mobile/src/apps/tasks/TasksBand.tsx`
- `apps/mobile/src/apps/tasks/TasksHome.styles.ts`
- `apps/mobile/src/apps/tasks/TasksHome.tsx`
- `apps/mobile/src/apps/tasks/TasksScreen.tsx`
- `apps/mobile/src/apps/tasks/tasks-band.test.ts`
- `apps/mobile/src/apps/tasks/tasks-band.ts`
- `apps/mobile/src/apps/tasks/useTasks.ts`
- `apps/mobile/src/kit/band-surface.ts`
- `apps/mobile/src/kit/band/band-owner.test.ts`
- `apps/mobile/src/kit/band/band-owner.ts`
- `apps/mobile/src/kit/components/AnchoredMenu.test.tsx`
- `apps/mobile/src/kit/components/AnchoredMenu.tsx`
- `apps/mobile/src/kit/components/BarsBlock.tsx`
- `apps/mobile/src/kit/components/ConsentGate.styles.ts`
- `apps/mobile/src/kit/components/ConsentGate.tsx`
- `apps/mobile/src/kit/components/HomeKey.tsx`
- `apps/mobile/src/kit/components/OptionSheet.tsx`
- `apps/mobile/src/kit/components/OutOfRoom.tsx`
- `apps/mobile/src/kit/components/SectionBlock.tsx`
- `apps/mobile/src/kit/components/TopSafeArea.tsx`
- `apps/mobile/src/kit/components/icon-resolver.sweep.test.ts`
- `apps/mobile/src/kit/components/status-line.ts`
- `apps/mobile/src/kit/fetch-gate/FetchChoice.tsx`
- `apps/mobile/src/kit/hooks/ShareIntentIngest.tsx`
- `apps/mobile/src/kit/hooks/share-ingest.test.ts`
- `apps/mobile/src/kit/hooks/share-ingest.ts`
- `apps/mobile/src/kit/media/use-image-fallback.ts`
- `apps/mobile/src/kit/replica/ReplicaStateCard.test.tsx`
- `apps/mobile/src/kit/replica/ReplicaStateCard.tsx`
- `apps/mobile/src/kit/replica/ReplicaStatusBar.test.tsx`
- `apps/mobile/src/kit/replica/mount-plan.test.ts`
- `apps/mobile/src/kit/replica/mount-plan.ts`
- `apps/mobile/src/kit/replica/replica-mount.test.ts`
- `apps/mobile/src/kit/replica/replica-mount.ts`
- `apps/mobile/src/kit/schedule/recurrence.test.ts`
- `apps/mobile/src/kit/share/GrantSheet.tsx`
- `apps/mobile/src/kit/share/ShareSheet.test.tsx`
- `apps/mobile/src/kit/share/grants-transport.ts`
- `apps/mobile/src/kit/storage/custody-status.test.ts`
- `apps/mobile/src/kit/storage/custody-status.ts`
- `apps/mobile/src/kit/storage/free-up-space.test.ts`
- `apps/mobile/src/kit/storage/free-up-space.ts`
- `apps/mobile/src/kit/theme/appearance.ts`
- `apps/mobile/src/kit/transfer/backup-verdict.test.ts`
- `apps/mobile/src/kit/transfer/backup-verdict.ts`
- `apps/mobile/src/kit/transfer/transfer-consent.test.ts`
- `apps/mobile/src/kit/transfer/transfer-consent.ts`
- `apps/mobile/src/kit/transfer/transfer-policy.test.ts`
- `apps/mobile/src/kit/transfer/transfer-policy.ts`
- `apps/mobile/src/kit/transfer/transfer-queue.ts`
- `apps/mobile/src/kit/transfer/transfer-run.test.ts`
- `apps/mobile/src/kit/transfer/transfer-run.ts`
- `apps/mobile/src/lib/atlas.test.ts`
- `apps/mobile/src/lib/atlas.ts`
- `apps/mobile/src/lib/automations.ts`
- `apps/mobile/src/lib/backoff.ts`
- `apps/mobile/src/lib/coalesce.ts`
- `apps/mobile/src/lib/conditional-fetch.ts`
- `apps/mobile/src/lib/connection-reauth.ts`
- `apps/mobile/src/lib/connections.test.ts`
- `apps/mobile/src/lib/decision-detail.ts`
- `apps/mobile/src/lib/devices.test.ts`
- `apps/mobile/src/lib/enrichment.ts`
- `apps/mobile/src/lib/gateway.ts`
- `apps/mobile/src/lib/insights.test.ts`
- `apps/mobile/src/lib/notifications-navigation.test.ts`
- `apps/mobile/src/lib/notifications-navigation.ts`
- `apps/mobile/src/lib/notifications-plan.ts`
- `apps/mobile/src/lib/phone-link-parse.ts`
- `apps/mobile/src/lib/phone-link.ts`
- `apps/mobile/src/lib/profile.test.ts`
- `apps/mobile/src/lib/profile.ts`
- `apps/mobile/src/lib/replica/edges-transport.ts`
- `apps/mobile/src/lib/replica/links-transport.ts`
- `apps/mobile/src/lib/replica/multi-vault-reader.ts`
- `apps/mobile/src/lib/replica/node-sqlite-driver.jsdom.test.ts`
- `apps/mobile/src/lib/replica/op-sqlite-build-config.test.ts`
- `apps/mobile/src/lib/replica/op-sqlite-driver.ts`
- `apps/mobile/src/lib/replica/placement-transport.ts`
- `apps/mobile/src/lib/replica/replica-read-pushdown.ts`
- `apps/mobile/src/lib/replica/replica-sqlite-vec-error.ts`
- `apps/mobile/src/lib/secure-storage.ts`
- `apps/mobile/src/lib/upload/boot.ts`
- `apps/mobile/src/lib/upload/bytes.ts`
- `apps/mobile/src/lib/upload/cbsf.ts`
- `apps/mobile/src/lib/upload/crypto.ts`
- `apps/mobile/src/lib/upload/drain-lock.ts`
- `apps/mobile/src/lib/upload/expo-native.ts`
- `apps/mobile/src/lib/upload/file-source.ts`
- `apps/mobile/src/lib/upload/incremental-sha256.ts`
- `apps/mobile/src/lib/upload/media-producer.test.ts`
- `apps/mobile/src/lib/upload/media-producer.ts`
- `apps/mobile/src/lib/upload/native-policy.ts`
- `apps/mobile/src/lib/upload/native-queue.ts`
- `apps/mobile/src/lib/upload/reconcile-gate.ts`
- `apps/mobile/src/lib/upload/store-migrations.ts`
- `apps/mobile/src/lib/upload/store-rows.ts`
- `apps/mobile/src/lib/upload/store.ts`
- `apps/mobile/src/lib/upload/uploader.ts`
- `apps/mobile/src/lib/vault-links.test.ts`
- `apps/mobile/src/navigation.ts`
- `apps/mobile/src/screens/Approvals.tsx`
- `apps/mobile/src/screens/BackupHealth.custody.tsx`
- `apps/mobile/src/screens/BackupHealth.styles.ts`
- `apps/mobile/src/screens/BackupHealth.tsx`
- `apps/mobile/src/screens/Home.tsx`
- `apps/mobile/src/screens/Onboarding.tsx`
- `apps/mobile/src/screens/Scan.test.tsx`
- `apps/mobile/src/screens/Scan.tsx`
- `apps/mobile/src/screens/Settings.tsx`
- `apps/mobile/src/screens/SharingLinkRow.tsx`
- `apps/mobile/src/screens/approvals/StagedWrite.tsx`
- `apps/mobile/src/screens/approvals/approvals-model.ts`
- `apps/mobile/src/screens/approvals/useApprovals.ts`
- `apps/mobile/src/screens/devices/DeviceActions.tsx`
- `apps/mobile/src/screens/devices/Devices.styles.ts`
- `apps/mobile/src/screens/devices/Devices.tsx`
- `apps/mobile/src/screens/devices/devices-model.test.ts`
- `apps/mobile/src/screens/devices/devices-model.ts`
- `apps/mobile/src/screens/devices/useDevices.ts`
- `apps/mobile/src/screens/home/AllAppsSheet.tsx`
- `apps/mobile/src/screens/home/FirstMoves.tsx`
- `apps/mobile/src/screens/home/HomeBand.tsx`
- `apps/mobile/src/screens/home/HomeStatusLine.tsx`
- `apps/mobile/src/screens/home/HomeTitleRow.tsx`
- `apps/mobile/src/screens/home/LauncherGrid.tsx`
- `apps/mobile/src/screens/home/SearchOverlay.test.tsx`
- `apps/mobile/src/screens/home/SearchOverlay.tsx`
- `apps/mobile/src/screens/home/TileBody.tsx`
- `apps/mobile/src/screens/home/VaultHeader.tsx`
- `apps/mobile/src/screens/home/band.test.ts`
- `apps/mobile/src/screens/home/band.ts`
- `apps/mobile/src/screens/home/blueprint-search.ts`
- `apps/mobile/src/screens/home/catalog.test.ts`
- `apps/mobile/src/screens/home/catalog.ts`
- `apps/mobile/src/screens/home/grid-packing.test.ts`
- `apps/mobile/src/screens/home/grid-packing.ts`
- `apps/mobile/src/screens/home/home-pins.ts`
- `apps/mobile/src/screens/home/search-model.test.ts`
- `apps/mobile/src/screens/home/search-model.ts`
- `apps/mobile/src/screens/home/springboard-policy.ts`
- `apps/mobile/src/screens/home/tile-model.test.ts`
- `apps/mobile/src/screens/home/tile-model.ts`
- `apps/mobile/src/screens/home/useSearchRecents.ts`
- `apps/mobile/src/screens/home/useSpringboardTiles.ts`
- `apps/mobile/src/screens/scan-consent.test.ts`
- `apps/mobile/src/screens/scan-consent.ts`
- `apps/mobile/src/screens/settings/AppearanceSection.tsx`
- `apps/mobile/src/screens/settings/BandSection.tsx`
- `apps/mobile/src/screens/settings/ColorSwatchRow.tsx`
- `apps/mobile/src/screens/settings/EnrichmentSection.test.tsx`
- `apps/mobile/src/screens/settings/EnrichmentSection.tsx`
- `apps/mobile/src/screens/settings/SettingsSection.tsx`
- `apps/mobile/src/screens/settings/VaultSection.tsx`
- `apps/mobile/src/screens/settings/YouSection.tsx`
- `apps/mobile/src/version-core.test.ts`
- `apps/oauth-worker/src/worker-guards.test.ts`
- `apps/oauth-worker/src/worker.ts`
- `apps/web/src/client-globals.d.ts`
- `apps/web/src/iroh-transport.ts`
- `apps/web/src/main.ts`
- `apps/web/src/sw-notifications-wake.test.ts`
- `apps/web/src/sw-runtime.test.ts`
- `apps/web/src/sw-version.ts`
- `apps/web/src/web-chrome.ts`
- `apps/web/src/web-state.ts`
- `apps/web/tests/e2e/accessibility.spec.ts`
- `apps/web/tests/e2e/app-card-logical-insets.spec.ts`
- `apps/web/tests/e2e/docs-grant.spec.ts`
- `apps/web/tests/e2e/grant-sheet.spec.ts`
- `apps/web/tests/e2e/leak-budgets.ts`
- `apps/web/tests/e2e/leak-probe.ts`
- `apps/web/tests/e2e/offline-reconnect.spec.ts`
- `apps/web/tests/e2e/offline-search.spec.ts`
- `apps/web/tests/e2e/people-grants.spec.ts`
- `apps/web/tests/e2e/perf-budgets.ts`
- `apps/web/tests/e2e/perf-waterfall.spec.ts`
- `apps/web/tests/e2e/photos-grants.spec.ts`
- `apps/web/tests/e2e/playwright.config.ts`
- `apps/web/tests/e2e/rebuilt-apps.spec.ts`
- `apps/web/tests/e2e/renderer-leak.spec.ts`
- `apps/web/tests/e2e/server.ts`
- `apps/web/vite.config.ts`
- `docs/coding-standards.md`
- `packages/backup/README.md`
- `packages/backup/src/cas-grant.ts`
- `packages/backup/src/compress.test.ts`
- `packages/backup/src/compress.ts`
- `packages/backup/src/conformance-derived.test.ts`
- `packages/backup/src/conformance-derived.ts`
- `packages/backup/src/conformance-observability.test.ts`
- `packages/backup/src/conformance.ts`
- `packages/backup/src/crypto.ts`
- `packages/backup/src/engine.test.ts`
- `packages/backup/src/engine.ts`
- `packages/backup/src/index.ts`
- `packages/backup/src/interop-clawgnition.test.ts`
- `packages/backup/src/local-provider.test.ts`
- `packages/backup/src/manifest.ts`
- `packages/backup/src/materialize.test.ts`
- `packages/backup/src/materialize.ts`
- `packages/backup/src/parts.ts`
- `packages/backup/src/provider.ts`
- `packages/backup/src/recovery-kit.test.ts`
- `packages/backup/src/recovery-kit.ts`
- `packages/backup/src/remote-provider.test.ts`
- `packages/backup/src/s3-store.ts`
- `packages/backup/src/testing/s3-test-server.ts`
- `packages/backup/src/wal-address.test-fixtures.ts`
- `packages/backup/src/wal-format.test.ts`
- `packages/backup/src/wal-format.ts`
- `packages/backup/src/wal-prefix-properties.test.ts`
- `packages/backup/src/wal-restore.test.ts`
- `packages/backup/src/wal-restore.ts`
- `packages/backup/src/wire-client.ts`
- `packages/blueprints/apps/_shared/ConsentGate.tsx`
- `packages/blueprints/apps/_shared/GrantSheet.tsx`
- `packages/blueprints/apps/_shared/LoadingSkeleton.tsx`
- `packages/blueprints/apps/_shared/NavRail.tsx`
- `packages/blueprints/apps/_shared/ScopeChips.tsx`
- `packages/blueprints/apps/_shared/SearchScaffold.test.tsx`
- `packages/blueprints/apps/_shared/SearchScaffold.tsx`
- `packages/blueprints/apps/_shared/ShareSheet.tsx`
- `packages/blueprints/apps/_shared/VaultAccessButton.tsx`
- `packages/blueprints/apps/_shared/capture-consent.test.ts`
- `packages/blueprints/apps/_shared/capture-consent.ts`
- `packages/blueprints/apps/_shared/consent-gate.test.ts`
- `packages/blueprints/apps/_shared/consent-gate.ts`
- `packages/blueprints/apps/_shared/download-on-demand.ts`
- `packages/blueprints/apps/_shared/face-crop.ts`
- `packages/blueprints/apps/_shared/grant-audiences.ts`
- `packages/blueprints/apps/_shared/grant-copy.ts`
- `packages/blueprints/apps/_shared/grant-door.ts`
- `packages/blueprints/apps/_shared/grant-gateway.ts`
- `packages/blueprints/apps/_shared/grant-plane.ts`
- `packages/blueprints/apps/_shared/journal-scheme.ts`
- `packages/blueprints/apps/_shared/nav-seat.ts`
- `packages/blueprints/apps/_shared/pending-overlay.ts`
- `packages/blueprints/apps/_shared/placement-registry.ts`
- `packages/blueprints/apps/_shared/scope-kit.ts`
- `packages/blueprints/apps/_shared/scope-merge.ts`
- `packages/blueprints/apps/_shared/search-scaffold.test.ts`
- `packages/blueprints/apps/_shared/search-scaffold.ts`
- `packages/blueprints/apps/_shared/selection-engine.ts`
- `packages/blueprints/apps/_shared/shared-copy.ts`
- `packages/blueprints/apps/_shared/triage-session.test.ts`
- `packages/blueprints/apps/_shared/triage-session.ts`
- `packages/blueprints/apps/_shared/video-frame.ts`
- `packages/blueprints/apps/_shared/write-target.ts`
- `packages/blueprints/apps/agenda/Chrome.tsx`
- `packages/blueprints/apps/agenda/actions/attach.ts`
- `packages/blueprints/apps/agenda/app-inline.tsx`
- `packages/blueprints/apps/agenda/components/Grid.tsx`
- `packages/blueprints/apps/agenda/format-locale.test.ts`
- `packages/blueprints/apps/agenda/format.ts`
- `packages/blueprints/apps/agenda/queries/search.ts`
- `packages/blueprints/apps/agenda/queries/upcoming.ts`
- `packages/blueprints/apps/docs/Chrome.tsx`
- `packages/blueprints/apps/docs/actions/replace.ts`
- `packages/blueprints/apps/docs/actions/star.ts`
- `packages/blueprints/apps/docs/actions/tag.ts`
- `packages/blueprints/apps/docs/actions/unstar.ts`
- `packages/blueprints/apps/docs/actions/upload.ts`
- `packages/blueprints/apps/docs/app-inline.tsx`
- `packages/blueprints/apps/docs/app-root.tsx`
- `packages/blueprints/apps/docs/components/Activity.tsx`
- `packages/blueprints/apps/docs/components/Breadcrumb.tsx`
- `packages/blueprints/apps/docs/components/Details.tsx`
- `packages/blueprints/apps/docs/components/DriveRoute.tsx`
- `packages/blueprints/apps/docs/components/EmptyState.tsx`
- `packages/blueprints/apps/docs/components/History.tsx`
- `packages/blueprints/apps/docs/components/InfoToggle.tsx`
- `packages/blueprints/apps/docs/components/QuickLookStage.tsx`
- `packages/blueprints/apps/docs/components/Shared.tsx`
- `packages/blueprints/apps/docs/components/ShelfStrip.tsx`
- `packages/blueprints/apps/docs/components/Sidebar.tsx`
- `packages/blueprints/apps/docs/components/Tags.tsx`
- `packages/blueprints/apps/docs/components/UploadQueue.tsx`
- `packages/blueprints/apps/docs/custody-row-mark.test.ts`
- `packages/blueprints/apps/docs/document-copy.ts`
- `packages/blueprints/apps/docs/drive-copy.ts`
- `packages/blueprints/apps/docs/filters.ts`
- `packages/blueprints/apps/docs/format.ts`
- `packages/blueprints/apps/docs/grant-audiences.ts`
- `packages/blueprints/apps/docs/icons.ts`
- `packages/blueprints/apps/docs/logic.ts`
- `packages/blueprints/apps/docs/metadata.ts`
- `packages/blueprints/apps/docs/nav.ts`
- `packages/blueprints/apps/docs/pdf-text.ts`
- `packages/blueprints/apps/docs/popovers.ts`
- `packages/blueprints/apps/docs/queries/_shared.ts`
- `packages/blueprints/apps/docs/queries/activity.ts`
- `packages/blueprints/apps/docs/queries/drive.ts`
- `packages/blueprints/apps/docs/queries/history.ts`
- `packages/blueprints/apps/docs/queries/search.ts`
- `packages/blueprints/apps/docs/queries/shares.test.ts`
- `packages/blueprints/apps/docs/types.ts`
- `packages/blueprints/apps/docs/upload.ts`
- `packages/blueprints/apps/docs/uploads.ts`
- `packages/blueprints/apps/docs/versions.ts`
- `packages/blueprints/apps/docs/view-copy.ts`
- `packages/blueprints/apps/inline-types.ts`
- `packages/blueprints/apps/locker/Chrome.tsx`
- `packages/blueprints/apps/locker/app-inline.tsx`
- `packages/blueprints/apps/locker/app-root.tsx`
- `packages/blueprints/apps/locker/components/Detail.tsx`
- `packages/blueprints/apps/locker/components/EditModal.tsx`
- `packages/blueprints/apps/locker/components/ItemFields.tsx`
- `packages/blueprints/apps/locker/components/List.tsx`
- `packages/blueprints/apps/locker/components/Sidebar.tsx`
- `packages/blueprints/apps/locker/locker-item-type.test.ts`
- `packages/blueprints/apps/locker/logic.ts`
- `packages/blueprints/apps/locker/queries/item.ts`
- `packages/blueprints/apps/locker/queries/items.ts`
- `packages/blueprints/apps/locker/queries/watchtower.ts`
- `packages/blueprints/apps/locker/totp.ts`
- `packages/blueprints/apps/locker/types.ts`
- `packages/blueprints/apps/notes/actions/attach.ts`
- `packages/blueprints/apps/notes/app-inline.tsx`
- `packages/blueprints/apps/notes/app-root.tsx`
- `packages/blueprints/apps/notes/logic.ts`
- `packages/blueprints/apps/notes/queries/library.ts`
- `packages/blueprints/apps/notes/queries/note.ts`
- `packages/blueprints/apps/notes/queries/search.ts`
- `packages/blueprints/apps/people/Chrome.tsx`
- `packages/blueprints/apps/people/actions/merge-people.ts`
- `packages/blueprints/apps/people/app-inline.tsx`
- `packages/blueprints/apps/people/app-root.tsx`
- `packages/blueprints/apps/people/components/PersonGrants.test.tsx`
- `packages/blueprints/apps/people/components/PersonGrants.tsx`
- `packages/blueprints/apps/people/components/PersonRoute.tsx`
- `packages/blueprints/apps/people/grant-dashboard.ts`
- `packages/blueprints/apps/people/people-copy.ts`
- `packages/blueprints/apps/people/queries/_shared.ts`
- `packages/blueprints/apps/people/queries/dashboard.ts`
- `packages/blueprints/apps/people/queries/journal.ts`
- `packages/blueprints/apps/people/queries/people.ts`
- `packages/blueprints/apps/people/queries/person.ts`
- `packages/blueprints/apps/people/queries/search.ts`
- `packages/blueprints/apps/people/queries/share-links.test.ts`
- `packages/blueprints/apps/people/types.ts`
- `packages/blueprints/apps/photos/actions/answer-face.ts`
- `packages/blueprints/apps/photos/actions/name-place.ts`
- `packages/blueprints/apps/photos/actions/purge-asset.ts`
- `packages/blueprints/apps/photos/actions/tag-asset.ts`
- `packages/blueprints/apps/photos/actions/update-asset.ts`
- `packages/blueprints/apps/photos/actions/upload.test.ts`
- `packages/blueprints/apps/photos/actions/upload.ts`
- `packages/blueprints/apps/photos/albums-actions.ts`
- `packages/blueprints/apps/photos/app-inline.tsx`
- `packages/blueprints/apps/photos/app-root.tsx`
- `packages/blueprints/apps/photos/asset-key.ts`
- `packages/blueprints/apps/photos/assets-actions.ts`
- `packages/blueprints/apps/photos/components/AlbumGrant.test.tsx`
- `packages/blueprints/apps/photos/components/DuplicateReview.tsx`
- `packages/blueprints/apps/photos/components/Duplicates.tsx`
- `packages/blueprints/apps/photos/components/Editor.tsx`
- `packages/blueprints/apps/photos/components/EnrichmentConsent.tsx`
- `packages/blueprints/apps/photos/components/FaceReview.tsx`
- `packages/blueprints/apps/photos/components/Import.tsx`
- `packages/blueprints/apps/photos/components/Lightbox.tsx`
- `packages/blueprints/apps/photos/components/LightboxInfo.tsx`
- `packages/blueprints/apps/photos/components/LightboxLocation.tsx`
- `packages/blueprints/apps/photos/components/OfflineBanner.tsx`
- `packages/blueprints/apps/photos/components/People.test.tsx`
- `packages/blueprints/apps/photos/components/People.tsx`
- `packages/blueprints/apps/photos/components/Permission.tsx`
- `packages/blueprints/apps/photos/components/Picker.tsx`
- `packages/blueprints/apps/photos/components/PlaceNaming.test.tsx`
- `packages/blueprints/apps/photos/components/PlaceNaming.tsx`
- `packages/blueprints/apps/photos/components/Places.test.tsx`
- `packages/blueprints/apps/photos/components/Places.tsx`
- `packages/blueprints/apps/photos/components/SearchShelf.tsx`
- `packages/blueprints/apps/photos/components/SelectionBar.tsx`
- `packages/blueprints/apps/photos/components/Storage.tsx`
- `packages/blueprints/apps/photos/components/Timeline.tsx`
- `packages/blueprints/apps/photos/components/Toolbar.tsx`
- `packages/blueprints/apps/photos/components/ViewerStage.tsx`
- `packages/blueprints/apps/photos/constants.ts`
- `packages/blueprints/apps/photos/custody-store.ts`
- `packages/blueprints/apps/photos/duplicates.tsx`
- `packages/blueprints/apps/photos/enrichment-consent.ts`
- `packages/blueprints/apps/photos/enrichment-gate.ts`
- `packages/blueprints/apps/photos/faces.ts`
- `packages/blueprints/apps/photos/format.ts`
- `packages/blueprints/apps/photos/grant-audiences.ts`
- `packages/blueprints/apps/photos/grant-entries.test.ts`
- `packages/blueprints/apps/photos/grouping.test.ts`
- `packages/blueprints/apps/photos/grouping.ts`
- `packages/blueprints/apps/photos/library-reads.ts`
- `packages/blueprints/apps/photos/library-store.ts`
- `packages/blueprints/apps/photos/lightbox.tsx`
- `packages/blueprints/apps/photos/media.ts`
- `packages/blueprints/apps/photos/memories.test.ts`
- `packages/blueprints/apps/photos/memories.ts`
- `packages/blueprints/apps/photos/outcomes.ts`
- `packages/blueprints/apps/photos/people.ts`
- `packages/blueprints/apps/photos/picker-actions.ts`
- `packages/blueprints/apps/photos/picker.tsx`
- `packages/blueprints/apps/photos/queries/_shared.ts`
- `packages/blueprints/apps/photos/queries/duplicates.ts`
- `packages/blueprints/apps/photos/queries/enrichment-status.ts`
- `packages/blueprints/apps/photos/queries/face-queue.ts`
- `packages/blueprints/apps/photos/queries/faces.ts`
- `packages/blueprints/apps/photos/queries/library.ts`
- `packages/blueprints/apps/photos/queries/people.ts`
- `packages/blueprints/apps/photos/queries/search.ts`
- `packages/blueprints/apps/photos/queries/storage.ts`
- `packages/blueprints/apps/photos/search-entry.test.ts`
- `packages/blueprints/apps/photos/search-groups.test.ts`
- `packages/blueprints/apps/photos/search-groups.ts`
- `packages/blueprints/apps/photos/search.ts`
- `packages/blueprints/apps/photos/selection-actions.ts`
- `packages/blueprints/apps/photos/selection.tsx`
- `packages/blueprints/apps/photos/share-place.test.ts`
- `packages/blueprints/apps/photos/share-place.ts`
- `packages/blueprints/apps/photos/shared-copy.ts`
- `packages/blueprints/apps/photos/shelves.ts`
- `packages/blueprints/apps/photos/slideshow.tsx`
- `packages/blueprints/apps/photos/storage-model.test.ts`
- `packages/blueprints/apps/photos/storage-model.ts`
- `packages/blueprints/apps/photos/thumbhash.ts`
- `packages/blueprints/apps/photos/trash-actions.test.ts`
- `packages/blueprints/apps/photos/trash-actions.ts`
- `packages/blueprints/apps/photos/trips.test.ts`
- `packages/blueprints/apps/photos/trips.ts`
- `packages/blueprints/apps/photos/types.ts`
- `packages/blueprints/apps/photos/upload.ts`
- `packages/blueprints/apps/photos/view-copy.ts`
- `packages/blueprints/apps/photos/viewer.test.ts`
- `packages/blueprints/apps/photos/viewer.ts`
- `packages/blueprints/apps/photos/visibility.ts`
- `packages/blueprints/apps/tally/app-inline.tsx`
- `packages/blueprints/apps/tally/queries/dashboard.ts`
- `packages/blueprints/apps/tasks/Chrome.tsx`
- `packages/blueprints/apps/tasks/actions/attach.ts`
- `packages/blueprints/apps/tasks/app-inline.tsx`
- `packages/blueprints/apps/tasks/app-root.tsx`
- `packages/blueprints/apps/tasks/queries/board.ts`
- `packages/blueprints/apps/tasks/queries/search.ts`
- `packages/blueprints/apps/tasks/scope-declaration.ts`
- `packages/blueprints/apps/tasks/scope-fanout.ts`
- `packages/blueprints/apps/tasks/types.ts`
- `packages/blueprints/automations/pull-connectors-graph.test.ts`
- `packages/blueprints/src/app-boot-harness.ts`
- `packages/blueprints/src/app-manifests.test.ts`
- `packages/blueprints/src/app-meta.ts`
- `packages/blueprints/src/app-rewrites.ts`
- `packages/blueprints/src/app-states.test.ts`
- `packages/blueprints/src/clone.ts`
- `packages/blueprints/src/day-context-journal-queries.test.ts`
- `packages/blueprints/src/docs-drive.test.ts`
- `packages/blueprints/src/handler-crud-smoke.integration.test.ts`
- `packages/blueprints/src/handler-reachability.test.ts`
- `packages/blueprints/src/index.ts`
- `packages/blueprints/src/no-inference-client.test.ts`
- `packages/blueprints/src/photos-asset-key.test.ts`
- `packages/blueprints/src/photos-duplicates.test.ts`
- `packages/blueprints/src/photos-face-review.test.ts`
- `packages/blueprints/src/photos-faces.test.ts`
- `packages/blueprints/src/photos-library-store.test.ts`
- `packages/blueprints/src/photos-people.test.ts`
- `packages/blueprints/src/photos-search-fanout.test.ts`
- `packages/blueprints/src/photos-selection-bar.test.ts`
- `packages/blueprints/src/photos-shelves-v4.test.ts`
- `packages/blueprints/src/photos-thumbhash.test.ts`
- `packages/blueprints/src/photos-view-state.test.ts`
- `packages/blueprints/src/photos-viewer.test.ts`
- `packages/blueprints/src/photos-vocabulary.test.ts`
- `packages/blueprints/src/placement-registry.test.ts`
- `packages/blueprints/src/query-handlers.test.ts`
- `packages/blueprints/src/scope-kit.test.ts`
- `packages/blueprints/src/scope-merge.test.ts`
- `packages/blueprints/src/search-scaffold-reach.test.ts`
- `packages/blueprints/src/share-kit.test.ts`
- `packages/blueprints/src/shared-css.test.ts`
- `packages/blueprints/src/token-purity-allowlist.ts`
- `packages/blueprints/src/write-target.test.ts`
- `packages/blueprints/types/centraid.d.ts`
- `packages/cli/src/auth.precedence.test.ts`
- `packages/cli/src/auth.ts`
- `packages/cli/src/cli.branches.test.ts`
- `packages/cli/src/cli.integration.test.ts`
- `packages/cli/src/cli.ts`
- `packages/client/src/app-format.test.ts`
- `packages/client/src/app-format.ts`
- `packages/client/src/app-shell-context.ts`
- `packages/client/src/approvals-copy.ts`
- `packages/client/src/assist-oauth-handoff.ts`
- `packages/client/src/assistant-rich.test.ts`
- `packages/client/src/assistant-rich.ts`
- `packages/client/src/assistant-sanitize.test.ts`
- `packages/client/src/automation-identity.ts`
- `packages/client/src/automations-copy.ts`
- `packages/client/src/centraid-api.d.ts`
- `packages/client/src/code-highlight.test.ts`
- `packages/client/src/code-highlight.ts`
- `packages/client/src/connectors-copy.ts`
- `packages/client/src/conversation-routes.test.ts`
- `packages/client/src/conversation-routes.ts`
- `packages/client/src/cron.ts`
- `packages/client/src/data-copy.ts`
- `packages/client/src/device-blob-source.ts`
- `packages/client/src/device-enrichment-compute.ts`
- `packages/client/src/device-enrichment-worker.ts`
- `packages/client/src/device-roster.ts`
- `packages/client/src/devices-copy.ts`
- `packages/client/src/diff.ts`
- `packages/client/src/enrich-policy.ts`
- `packages/client/src/format.ts`
- `packages/client/src/gateway-auth.ts`
- `packages/client/src/gateway-client-atlas.contract.test.ts`
- `packages/client/src/gateway-client-atlas.ts`
- `packages/client/src/gateway-client-automation-editing.ts`
- `packages/client/src/gateway-client-automations.ts`
- `packages/client/src/gateway-client-backup.ts`
- `packages/client/src/gateway-client-connections.ts`
- `packages/client/src/gateway-client-conversation-history.contract.test.ts`
- `packages/client/src/gateway-client-conversation-history.ts`
- `packages/client/src/gateway-client-conversation.ts`
- `packages/client/src/gateway-client-core.ts`
- `packages/client/src/gateway-client-devices.contract.test.ts`
- `packages/client/src/gateway-client-devices.ts`
- `packages/client/src/gateway-client-editing.ts`
- `packages/client/src/gateway-client-enrich.contract.test.ts`
- `packages/client/src/gateway-client-local-storage.ts`
- `packages/client/src/gateway-client-outbox.ts`
- `packages/client/src/gateway-client-owners.ts`
- `packages/client/src/gateway-client-seam-fixtures.ts`
- `packages/client/src/gateway-client-storage.ts`
- `packages/client/src/gateway-client-vault-enrich.ts`
- `packages/client/src/gateway-client-vault-imports.ts`
- `packages/client/src/gateway-client-vault.ts`
- `packages/client/src/gateway-client.ts`
- `packages/client/src/gfm.ts`
- `packages/client/src/home-copy.ts`
- `packages/client/src/insights-copy.ts`
- `packages/client/src/notifications-copy.ts`
- `packages/client/src/react/blueprints/blob-auth.ts`
- `packages/client/src/react/blueprints/blob-staging.ts`
- `packages/client/src/react/blueprints/centraid-inline-scopes.test.ts`
- `packages/client/src/react/blueprints/centraid-inline.ts`
- `packages/client/src/react/blueprints/grant-wire.ts`
- `packages/client/src/react/blueprints/inline-blob-images.test.ts`
- `packages/client/src/react/blueprints/inline-blob-images.ts`
- `packages/client/src/react/blueprints/inline-query-stub.d.ts`
- `packages/client/src/react/blueprints/inlineQueryCtx.ts`
- `packages/client/src/react/blueprints/placement-wire.ts`
- `packages/client/src/react/boot.tsx`
- `packages/client/src/react/css-modules.d.ts`
- `packages/client/src/react/format.test.ts`
- `packages/client/src/react/format.ts`
- `packages/client/src/react/host-platform.ts`
- `packages/client/src/react/screen-contracts.ts`
- `packages/client/src/react/screens/AppEnrichmentSurface.test.tsx`
- `packages/client/src/react/screens/AppEnrichmentSurface.tsx`
- `packages/client/src/react/screens/AppSettingsPanel.tsx`
- `packages/client/src/react/screens/ApprovalsScreen.test.tsx`
- `packages/client/src/react/screens/ApprovalsScreen.tsx`
- `packages/client/src/react/screens/AssistantMessage.tsx`
- `packages/client/src/react/screens/AssistantScreen.test.tsx`
- `packages/client/src/react/screens/AssistantScreen.tsx`
- `packages/client/src/react/screens/AtlasBrowseDeleteDialog.tsx`
- `packages/client/src/react/screens/AtlasBrowseRowEditor.tsx`
- `packages/client/src/react/screens/AtlasKindsSection.tsx`
- `packages/client/src/react/screens/AtlasOrreryChart.tsx`
- `packages/client/src/react/screens/AtlasOrreryCore.tsx`
- `packages/client/src/react/screens/AtlasOrreryPanel.tsx`
- `packages/client/src/react/screens/AtlasRecordsSection.tsx`
- `packages/client/src/react/screens/AtlasRelationsSection.tsx`
- `packages/client/src/react/screens/AtlasRelationsTab.test.tsx`
- `packages/client/src/react/screens/AtlasRelationsTab.tsx`
- `packages/client/src/react/screens/AtlasScreen.tsx`
- `packages/client/src/react/screens/AutomationCompilePane.tsx`
- `packages/client/src/react/screens/AutomationEditorScreen.tsx`
- `packages/client/src/react/screens/AutomationTemplatesScreen.tsx`
- `packages/client/src/react/screens/AutomationThreadScreen.tsx`
- `packages/client/src/react/screens/AutomationsOverviewScreen.tsx`
- `packages/client/src/react/screens/BackupCard.tsx`
- `packages/client/src/react/screens/BackupCopyCards.tsx`
- `packages/client/src/react/screens/BackupDeviceList.tsx`
- `packages/client/src/react/screens/BackupHealthMetrics.tsx`
- `packages/client/src/react/screens/BackupLossSummary.tsx`
- `packages/client/src/react/screens/ComposerAutocomplete.tsx`
- `packages/client/src/react/screens/DevicePairPanel.test.tsx`
- `packages/client/src/react/screens/DevicesCard.tsx`
- `packages/client/src/react/screens/FirstRunGate.tsx`
- `packages/client/src/react/screens/GatewayAlertsTab.tsx`
- `packages/client/src/react/screens/GatewayScreen.tsx`
- `packages/client/src/react/screens/HomeSpringboard.tsx`
- `packages/client/src/react/screens/HouseholdScreen.tsx`
- `packages/client/src/react/screens/LibraryCards.test.tsx`
- `packages/client/src/react/screens/LibraryCards.tsx`
- `packages/client/src/react/screens/LocalFootprintCard.test.tsx`
- `packages/client/src/react/screens/LocalFootprintCard.tsx`
- `packages/client/src/react/screens/LogsScreen.tsx`
- `packages/client/src/react/screens/OnboardingErrorNote.tsx`
- `packages/client/src/react/screens/PaletteScreen.tsx`
- `packages/client/src/react/screens/PhoneScreen.tsx`
- `packages/client/src/react/screens/PowerPostureNote.test.tsx`
- `packages/client/src/react/screens/PowerPostureNote.tsx`
- `packages/client/src/react/screens/ResourceAdvancedKnobs.tsx`
- `packages/client/src/react/screens/ResourceCardDetails.tsx`
- `packages/client/src/react/screens/ResourceCompareDialog.tsx`
- `packages/client/src/react/screens/ResourceDetailsDialog.tsx`
- `packages/client/src/react/screens/ResourceModeCard.test.tsx`
- `packages/client/src/react/screens/ResourceModeCard.tsx`
- `packages/client/src/react/screens/RestartGatewayScreen.tsx`
- `packages/client/src/react/screens/RunViewScreen.tsx`
- `packages/client/src/react/screens/SettingsAppearanceScreen.tsx`
- `packages/client/src/react/screens/SettingsConnectionsScreen.tsx`
- `packages/client/src/react/screens/SettingsDiagnosticsScreen.test.tsx`
- `packages/client/src/react/screens/SettingsDiagnosticsScreen.tsx`
- `packages/client/src/react/screens/SettingsEnrichmentCapabilities.tsx`
- `packages/client/src/react/screens/SettingsEnrichmentRules.tsx`
- `packages/client/src/react/screens/SettingsEnrichmentScreen.test.tsx`
- `packages/client/src/react/screens/SettingsEnrichmentScreen.tsx`
- `packages/client/src/react/screens/SettingsVaultScreen.test.tsx`
- `packages/client/src/react/screens/SettingsVaultScreen.tsx`
- `packages/client/src/react/screens/SharingRecoveryRows.tsx`
- `packages/client/src/react/screens/StorageLimitsPanel.tsx`
- `packages/client/src/react/screens/StorageScreen.tsx`
- `packages/client/src/react/screens/VaultFootprintRows.tsx`
- `packages/client/src/react/screens/VaultScreen.tsx`
- `packages/client/src/react/screens/assistantDrafts.ts`
- `packages/client/src/react/screens/assistantUsage.ts`
- `packages/client/src/react/screens/atlasBrowseData.ts`
- `packages/client/src/react/screens/atlasOrreryCamera.test.ts`
- `packages/client/src/react/screens/atlasOrreryCamera.ts`
- `packages/client/src/react/screens/atlasOrreryGeometry.ts`
- `packages/client/src/react/screens/atlasOrreryMotion.ts`
- `packages/client/src/react/screens/atlasRelationsTestKit.tsx`
- `packages/client/src/react/screens/atlasSampleRows.ts`
- `packages/client/src/react/screens/atlasScreenModel.test.ts`
- `packages/client/src/react/screens/atlasScreenModel.ts`
- `packages/client/src/react/screens/automationsOverviewGrouping.ts`
- `packages/client/src/react/screens/backupMetrics.test.ts`
- `packages/client/src/react/screens/backupMetrics.ts`
- `packages/client/src/react/screens/composerMentions.ts`
- `packages/client/src/react/screens/device-errors.ts`
- `packages/client/src/react/screens/device-groups.ts`
- `packages/client/src/react/screens/domTestKit.ts`
- `packages/client/src/react/screens/gatewayHeartbeat.ts`
- `packages/client/src/react/screens/localUsageView.test.ts`
- `packages/client/src/react/screens/localUsageView.ts`
- `packages/client/src/react/screens/networkCalls.ts`
- `packages/client/src/react/screens/privacyStores.ts`
- `packages/client/src/react/screens/resource-presets.ts`
- `packages/client/src/react/screens/resource-summary.ts`
- `packages/client/src/react/screens/settings-controls.tsx`
- `packages/client/src/react/screens/transcriptWindow.ts`
- `packages/client/src/react/screens/useAssistantScroll.ts`
- `packages/client/src/react/screens/useKeychainPrompt.ts`
- `packages/client/src/react/shell/AllAppsSheet.tsx`
- `packages/client/src/react/shell/App.inline-branch.test.tsx`
- `packages/client/src/react/shell/App.test.tsx`
- `packages/client/src/react/shell/App.tsx`
- `packages/client/src/react/shell/ErrorBoundary.tsx`
- `packages/client/src/react/shell/PageScroll.tsx`
- `packages/client/src/react/shell/ShellApp.tsx`
- `packages/client/src/react/shell/ShellFrame.tsx`
- `packages/client/src/react/shell/StatusLine.tsx`
- `packages/client/src/react/shell/Stem.tsx`
- `packages/client/src/react/shell/actions.tsx`
- `packages/client/src/react/shell/ambientStatus.ts`
- `packages/client/src/react/shell/appearance.ts`
- `packages/client/src/react/shell/automationTemplatePreview.ts`
- `packages/client/src/react/shell/boundedMemo.ts`
- `packages/client/src/react/shell/commitAvailability.tsx`
- `packages/client/src/react/shell/contextMenu.ts`
- `packages/client/src/react/shell/frameBatch.ts`
- `packages/client/src/react/shell/gatewayRegistry.ts`
- `packages/client/src/react/shell/gatewaySwitcher.ts`
- `packages/client/src/react/shell/glyphs.tsx`
- `packages/client/src/react/shell/iconSvg.ts`
- `packages/client/src/react/shell/launcherModel.ts`
- `packages/client/src/react/shell/opsBar.ts`
- `packages/client/src/react/shell/optimisticUpdate.ts`
- `packages/client/src/react/shell/ownerScope.ts`
- `packages/client/src/react/shell/queryCache.ts`
- `packages/client/src/react/shell/routeVitals.ts`
- `packages/client/src/react/shell/router.ts`
- `packages/client/src/react/shell/routes/AppSettingsController.tsx`
- `packages/client/src/react/shell/routes/ApprovalsRoute.test.tsx`
- `packages/client/src/react/shell/routes/ApprovalsRoute.tsx`
- `packages/client/src/react/shell/routes/AssistantConversations.test.tsx`
- `packages/client/src/react/shell/routes/AssistantConversations.tsx`
- `packages/client/src/react/shell/routes/AssistantRoute.tsx`
- `packages/client/src/react/shell/routes/AtlasRoute.tsx`
- `packages/client/src/react/shell/routes/AutomationEditorRoute.tsx`
- `packages/client/src/react/shell/routes/AutomationViewRoute.tsx`
- `packages/client/src/react/shell/routes/AutomationsRoute.tsx`
- `packages/client/src/react/shell/routes/ConnectFlow.test.tsx`
- `packages/client/src/react/shell/routes/ConnectFlow.tsx`
- `packages/client/src/react/shell/routes/ConnectFlowDetailsStep.tsx`
- `packages/client/src/react/shell/routes/ConnectFlowModal.tsx`
- `packages/client/src/react/shell/routes/ConnectFlowVaultStep.tsx`
- `packages/client/src/react/shell/routes/GatewayRoute.tsx`
- `packages/client/src/react/shell/routes/HandshakeLadder.tsx`
- `packages/client/src/react/shell/routes/HomeRoute.test.tsx`
- `packages/client/src/react/shell/routes/HomeRoute.tsx`
- `packages/client/src/react/shell/routes/HouseholdRoute.tsx`
- `packages/client/src/react/shell/routes/InlineAppRoute.test.tsx`
- `packages/client/src/react/shell/routes/InlineAppRoute.tsx`
- `packages/client/src/react/shell/routes/InsightsRoute.tsx`
- `packages/client/src/react/shell/routes/RenameGatewayModal.tsx`
- `packages/client/src/react/shell/routes/RunViewRoute.tsx`
- `packages/client/src/react/shell/routes/RunsPane.tsx`
- `packages/client/src/react/shell/routes/ScopePicker.tsx`
- `packages/client/src/react/shell/routes/SettingsRoute.tsx`
- `packages/client/src/react/shell/routes/TemplatesRoute.tsx`
- `packages/client/src/react/shell/routes/TestConnectionModal.tsx`
- `packages/client/src/react/shell/routes/VaultModal.tsx`
- `packages/client/src/react/shell/routes/appSettingsData.ts`
- `packages/client/src/react/shell/routes/approvalsData.test.ts`
- `packages/client/src/react/shell/routes/approvalsData.ts`
- `packages/client/src/react/shell/routes/approvalsPhrasing.ts`
- `packages/client/src/react/shell/routes/assistantCatchUp.ts`
- `packages/client/src/react/shell/routes/assistantProjection.test.ts`
- `packages/client/src/react/shell/routes/assistantProjection.ts`
- `packages/client/src/react/shell/routes/assistantRich.ts`
- `packages/client/src/react/shell/routes/assistantStarters.ts`
- `packages/client/src/react/shell/routes/assistantTranscript.ts`
- `packages/client/src/react/shell/routes/automationEditorData.ts`
- `packages/client/src/react/shell/routes/automationThreadData.ts`
- `packages/client/src/react/shell/routes/automationsData.ts`
- `packages/client/src/react/shell/routes/connectFlow-core.ts`
- `packages/client/src/react/shell/routes/connectFlowIO.test.ts`
- `packages/client/src/react/shell/routes/connectFlowIO.ts`
- `packages/client/src/react/shell/routes/connectorPlatform.ts`
- `packages/client/src/react/shell/routes/conversationExport.ts`
- `packages/client/src/react/shell/routes/conversationScopes.ts`
- `packages/client/src/react/shell/routes/gatewayData.ts`
- `packages/client/src/react/shell/routes/gatewayModals.ts`
- `packages/client/src/react/shell/routes/gatewayStorageData.ts`
- `packages/client/src/react/shell/routes/homeConditions.ts`
- `packages/client/src/react/shell/routes/homeData.ts`
- `packages/client/src/react/shell/routes/homeSample.ts`
- `packages/client/src/react/shell/routes/homeTileContent.ts`
- `packages/client/src/react/shell/routes/homeTiles.ts`
- `packages/client/src/react/shell/routes/inlineAppFlows.ts`
- `packages/client/src/react/shell/routes/inlineApps.ts`
- `packages/client/src/react/shell/routes/paletteConversationSearch.ts`
- `packages/client/src/react/shell/routes/paletteData.ts`
- `packages/client/src/react/shell/routes/paletteEntitySearch.ts`
- `packages/client/src/react/shell/routes/paletteRecents.ts`
- `packages/client/src/react/shell/routes/runViewData.ts`
- `packages/client/src/react/shell/routes/settingsAccountData.test.ts`
- `packages/client/src/react/shell/routes/settingsAccountData.ts`
- `packages/client/src/react/shell/routes/settingsConnectionsData.ts`
- `packages/client/src/react/shell/routes/settingsCronTimezoneData.ts`
- `packages/client/src/react/shell/routes/settingsDiagnosticsData.ts`
- `packages/client/src/react/shell/routes/settingsEnrichmentData.test.ts`
- `packages/client/src/react/shell/routes/settingsEnrichmentData.ts`
- `packages/client/src/react/shell/routes/templatesData.test.ts`
- `packages/client/src/react/shell/routes/templatesData.ts`
- `packages/client/src/react/shell/routes/useAppScopes.test.ts`
- `packages/client/src/react/shell/routes/useAppScopes.ts`
- `packages/client/src/react/shell/routes/vaultModals.test.ts`
- `packages/client/src/react/shell/routes/vaultModals.ts`
- `packages/client/src/react/shell/routes/visibility-ticker.test.ts`
- `packages/client/src/react/shell/routes/visibility-ticker.ts`
- `packages/client/src/react/shell/status.tsx`
- `packages/client/src/react/shell/statusChannel.ts`
- `packages/client/src/react/shell/structuralEqual.ts`
- `packages/client/src/react/shell/useAppearance.ts`
- `packages/client/src/react/shell/useAssistantConversations.ts`
- `packages/client/src/react/shell/useAsyncData.ts`
- `packages/client/src/react/shell/useBlockingCount.ts`
- `packages/client/src/react/shell/useGatewayHealth.ts`
- `packages/client/src/react/shell/useGatewayRuntime.ts`
- `packages/client/src/react/shell/useOwnerScopes.ts`
- `packages/client/src/react/shell/useShellApps.ts`
- `packages/client/src/react/shell/useStarred.ts`
- `packages/client/src/react/ui/BarsBlock.tsx`
- `packages/client/src/react/ui/Button.test.tsx`
- `packages/client/src/react/ui/Button.tsx`
- `packages/client/src/react/ui/ChipsBlock.tsx`
- `packages/client/src/react/ui/DecideBlock.tsx`
- `packages/client/src/react/ui/DocTable.tsx`
- `packages/client/src/react/ui/EmptyBlock.tsx`
- `packages/client/src/react/ui/Gallery.tsx`
- `packages/client/src/react/ui/Icon.tsx`
- `packages/client/src/react/ui/MeterRows.tsx`
- `packages/client/src/react/ui/NoteBlock.tsx`
- `packages/client/src/react/ui/PanelBlock.tsx`
- `packages/client/src/react/ui/RowsBlock.tsx`
- `packages/client/src/react/ui/SectionBlock.tsx`
- `packages/client/src/react/ui/index.ts`
- `packages/client/src/react/ui/states.tsx`
- `packages/client/src/replica/identity-inventory.test.ts`
- `packages/client/src/replica/purge-selector.test.ts`
- `packages/client/src/replica/shell-session-scopes.test.ts`
- `packages/client/src/replica/shell-session.ts`
- `packages/client/src/replica/sqlite-worker.test.ts`
- `packages/client/src/sharing-copy.ts`
- `packages/client/src/storage-metrics.ts`
- `packages/client/src/surface-copy.ts`
- `packages/client/src/theme-vars.ts`
- `packages/client/src/turn-stream.test.ts`
- `packages/client/src/turn-stream.ts`
- `packages/client/src/types.d.ts`
- `packages/client/src/vault-change-feed.ts`
- `packages/client/src/version-handshake.ts`
- `packages/core/src/blob/index.ts`
- `packages/core/src/protocol/capabilities.test.ts`
- `packages/core/src/protocol/capabilities.ts`
- `packages/core/src/protocol/handshake-direct.test.ts`
- `packages/core/src/protocol/handshake.test.ts`
- `packages/core/src/protocol/handshake.ts`
- `packages/core/src/protocol/peer.test.ts`
- `packages/core/src/protocol/peer.ts`
- `packages/core/src/protocol/routes.test.ts`
- `packages/core/src/protocol/routes.ts`
- `packages/core/src/protocol/version.ts`
- `packages/core/src/time/time-zoo-recurrence.test.ts`
- `packages/core/src/time/time-zoo-zone-crossing.test.ts`
- `packages/core/src/time/timezone-properties.test.ts`
- `packages/design/src/blocks/contracts.ts`
- `packages/design/src/color.ts`
- `packages/design/src/contrast-shell-palette.test.ts`
- `packages/design/src/contrast.test.ts`
- `packages/design/src/css-properties.test.ts`
- `packages/design/src/css-vars.ts`
- `packages/design/src/css.test.ts`
- `packages/design/src/css.ts`
- `packages/design/src/elements/attachments.ts`
- `packages/design/src/elements/feedback.ts`
- `packages/design/src/eleven-px-floor.test.ts`
- `packages/design/src/focus-ring-contrast.test.ts`
- `packages/design/src/font-faces.ts`
- `packages/design/src/fonts.test.ts`
- `packages/design/src/fonts.ts`
- `packages/design/src/icons.ts`
- `packages/design/src/identity.test.ts`
- `packages/design/src/kit-css.test.ts`
- `packages/design/src/themes/index.ts`
- `packages/design/src/themes/themes.test.ts`
- `packages/design/src/tokens.test.ts`
- `packages/design/src/type-role-parity.test.ts`
- `packages/design/src/typography.ts`
- `packages/model-runtime/automation-handlers/bundle-drift.test.ts`
- `packages/model-runtime/automation-handlers/photo-ocr.test.ts`
- `packages/model-runtime/setup.ts`
- `packages/model-runtime/src/capabilities/embed.ts`
- `packages/model-runtime/src/config.ts`
- `packages/model-runtime/src/nms.ts`
- `packages/model-runtime/src/onnx.test.ts`
- `packages/model-runtime/src/onnx.ts`
- `packages/server/scripts/live-harness-smoke.ts`
- `packages/server/src/acp/automation/live-automation-failover.test.ts`
- `packages/server/src/acp/automation/run-automation-dispatch.test.ts`
- `packages/server/src/acp/automation/run-automation-live-dispatch.ts`
- `packages/server/src/acp/automation/run-automation.test.ts`
- `packages/server/src/acp/automation/run-automation.ts`
- `packages/server/src/acp/backends/acp/backend.ts`
- `packages/server/src/acp/backends/acp/capabilities-cache.ts`
- `packages/server/src/acp/backends/acp/content.ts`
- `packages/server/src/acp/backends/acp/enumerate-models.test.ts`
- `packages/server/src/acp/backends/acp/enumerate-models.ts`
- `packages/server/src/acp/backends/acp/harness-errors.test.ts`
- `packages/server/src/acp/backends/acp/harness-errors.ts`
- `packages/server/src/acp/backends/acp/journey.integration.test.ts`
- `packages/server/src/acp/backends/acp/probe-capabilities.ts`
- `packages/server/src/acp/backends/acp/session-warm.ts`
- `packages/server/src/acp/backends/acp/stream-events.ts`
- `packages/server/src/acp/backends/acp/turn-vault-tools.test.ts`
- `packages/server/src/acp/backends/acp/types.ts`
- `packages/server/src/acp/backends/acp/vault-mcp-server.ts`
- `packages/server/src/acp/cli/centraid-cli.test.ts`
- `packages/server/src/acp/cli/centraid-cli.ts`
- `packages/server/src/acp/conversation-driver.ts`
- `packages/server/src/acp/index.ts`
- `packages/server/src/acp/low-priority-properties.test.ts`
- `packages/server/src/acp/matrix-concurrency.test.ts`
- `packages/server/src/acp/matrix-contracts.test.ts`
- `packages/server/src/acp/matrix-durability.test.ts`
- `packages/server/src/acp/models/catalog-warmer.ts`
- `packages/server/src/acp/models/catalog.ts`
- `packages/server/src/acp/models/enumerators.ts`
- `packages/server/src/acp/multimodal.ts`
- `packages/server/src/acp/registry.ts`
- `packages/server/src/acp/runtime.ts`
- `packages/server/src/acp/types.ts`
- `packages/server/src/acp/vault-sql-tool.ts`
- `packages/server/src/automation/cron-timezone.ts`
- `packages/server/src/automation/fire/calendar-boundary-cron.test.ts`
- `packages/server/src/automation/fire/clock-adversity-cron.test.ts`
- `packages/server/src/automation/fire/connector.test.ts`
- `packages/server/src/automation/fire/cron-cursor.ts`
- `packages/server/src/automation/fire/cron-match.ts`
- `packages/server/src/automation/fire/cursor-engine-support.ts`
- `packages/server/src/automation/fire/cursor-engine.ts`
- `packages/server/src/automation/fire/cursor-invariants.test.ts`
- `packages/server/src/automation/fire/enrich-engine-selection.test.ts`
- `packages/server/src/automation/fire/enrich-gate.test.ts`
- `packages/server/src/automation/fire/enrich-gate.ts`
- `packages/server/src/automation/fire/enrich-refusal-outcome.test.ts`
- `packages/server/src/automation/fire/enrich-resolve.property.test.ts`
- `packages/server/src/automation/fire/enrich-resolve.test.ts`
- `packages/server/src/automation/fire/enrich-resolve.ts`
- `packages/server/src/automation/fire/fire.test.ts`
- `packages/server/src/automation/fire/fire.ts`
- `packages/server/src/automation/fire/host.ts`
- `packages/server/src/automation/fire/in-process-scheduler.ts`
- `packages/server/src/automation/fire/scheduler-ledger.ts`
- `packages/server/src/automation/fire/time-zoo-calendar.test.ts`
- `packages/server/src/automation/fire/time-zoo-cron.test.ts`
- `packages/server/src/automation/handler/audit.test.ts`
- `packages/server/src/automation/handler/audit.ts`
- `packages/server/src/automation/handler/ctx.test.ts`
- `packages/server/src/automation/handler/ctx.ts`
- `packages/server/src/automation/handler/lint.test.ts`
- `packages/server/src/automation/handler/lint.ts`
- `packages/server/src/automation/handler/runner.ts`
- `packages/server/src/automation/index.ts`
- `packages/server/src/automation/manifest/enricher-templates.test.ts`
- `packages/server/src/automation/manifest/manifest-output.ts`
- `packages/server/src/automation/manifest/manifest.ts`
- `packages/server/src/automation/manifest/ref.ts`
- `packages/server/src/automation/scaffold/app.ts`
- `packages/server/src/automation/scaffold/scaffold-files.test.ts`
- `packages/server/src/automation/scaffold/scaffold.test.ts`
- `packages/server/src/automation/scaffold/scaffold.ts`
- `packages/server/src/automation/scaffold/webhook.ts`
- `packages/server/src/automation/worker/runner.test.ts`
- `packages/server/src/automation/worker/runner.ts`
- `packages/server/src/backup/backup-backend.ts`
- `packages/server/src/backup/backup-cas-diff.test.ts`
- `packages/server/src/backup/backup-cas-diff.ts`
- `packages/server/src/backup/backup-cas-inventory.test.ts`
- `packages/server/src/backup/backup-cas-inventory.ts`
- `packages/server/src/backup/backup-cas-reconciliation.ts`
- `packages/server/src/backup/backup-derived-inventory.ts`
- `packages/server/src/backup/backup-health.test.ts`
- `packages/server/src/backup/backup-provider-observability.ts`
- `packages/server/src/backup/backup-reconciliation-state.test.ts`
- `packages/server/src/backup/backup-reconciliation.ts`
- `packages/server/src/backup/backup-recovery-kit.ts`
- `packages/server/src/backup/backup-service-restore.test.ts`
- `packages/server/src/backup/backup-service.ts`
- `packages/server/src/backup/backup-sources.test.ts`
- `packages/server/src/backup/backup-sources.ts`
- `packages/server/src/backup/backup-state.ts`
- `packages/server/src/backup/backup.integration.test.ts`
- `packages/server/src/backup/recover-identity.test.ts`
- `packages/server/src/backup/recover-internals.test.ts`
- `packages/server/src/backup/recover-internals.ts`
- `packages/server/src/backup/recover-reconcile.test.ts`
- `packages/server/src/backup/recover-reconcile.ts`
- `packages/server/src/backup/recover.integration.test.ts`
- `packages/server/src/backup/recover.test-fixtures.ts`
- `packages/server/src/backup/recover.ts`
- `packages/server/src/backup/recovery-kit-state.ts`
- `packages/server/src/backup/restore-drill.integration.test.ts`
- `packages/server/src/backup/restore-drill.ts`
- `packages/server/src/backup/restore-lazy.integration.test.ts`
- `packages/server/src/backup/restore-verify-sealkey.test.ts`
- `packages/server/src/backup/restore-warm.ts`
- `packages/server/src/backup/snapshot-blob-roots.ts`
- `packages/server/src/backup/storage-credentials.test.ts`
- `packages/server/src/backup/storage-credentials.ts`
- `packages/server/src/backup/storage-usage.test.ts`
- `packages/server/src/backup/storage-usage.ts`
- `packages/server/src/backup/storage.integration.test.ts`
- `packages/server/src/backup/wal-uploader.test.ts`
- `packages/server/src/backup/wal-uploader.ts`
- `packages/server/src/backup/wal.integration.test.ts`
- `packages/server/src/cli/admin-custody.test.ts`
- `packages/server/src/cli/admin.test.ts`
- `packages/server/src/cli/allowed-hosts-properties.test.ts`
- `packages/server/src/cli/allowed-hosts.ts`
- `packages/server/src/cli/backup-admin.test.ts`
- `packages/server/src/cli/backup-admin.ts`
- `packages/server/src/cli/cli-serve-args.ts`
- `packages/server/src/cli/cli.test.ts`
- `packages/server/src/cli/cli.ts`
- `packages/server/src/cli/config.ts`
- `packages/server/src/cli/data-dir.ts`
- `packages/server/src/cli/device-admin.ts`
- `packages/server/src/cli/doctor.test.ts`
- `packages/server/src/cli/doctor.ts`
- `packages/server/src/cli/endpoint-host-peer.test.ts`
- `packages/server/src/cli/endpoint-host.ts`
- `packages/server/src/cli/json-cli.ts`
- `packages/server/src/cli/key-store.ts`
- `packages/server/src/cli/landlord-auth.ts`
- `packages/server/src/cli/lock-admin.test.ts`
- `packages/server/src/cli/lock-admin.ts`
- `packages/server/src/cli/owner-admin.ts`
- `packages/server/src/cli/paths.ts`
- `packages/server/src/cli/recover-admin.test.ts`
- `packages/server/src/cli/recover-admin.ts`
- `packages/server/src/cli/resolve-config.ts`
- `packages/server/src/cli/service-admin.ts`
- `packages/server/src/cli/service-credential.ts`
- `packages/server/src/cli/service-install.integration.test.ts`
- `packages/server/src/cli/service-unit.ts`
- `packages/server/src/cli/status-admin.test.ts`
- `packages/server/src/cli/status-admin.ts`
- `packages/server/src/cli/vault-admin.ts`
- `packages/server/src/doctor/index.ts`
- `packages/server/src/doctor/integrity-checks.test.ts`
- `packages/server/src/doctor/integrity-checks.ts`
- `packages/server/src/engine/conversation/archive/archive.contract.test.ts`
- `packages/server/src/engine/conversation/archive/digest-parity.test.ts`
- `packages/server/src/engine/conversation/archive/engine.ts`
- `packages/server/src/engine/conversation/archive/index.ts`
- `packages/server/src/engine/conversation/archive/prune.ts`
- `packages/server/src/engine/conversation/archive/segment.test.ts`
- `packages/server/src/engine/conversation/archive/segment.ts`
- `packages/server/src/engine/conversation/archive/selector.test.ts`
- `packages/server/src/engine/conversation/archive/selector.ts`
- `packages/server/src/engine/conversation/archive/types.ts`
- `packages/server/src/engine/conversation/auto-title.ts`
- `packages/server/src/engine/conversation/automation-turn-stream-event.ts`
- `packages/server/src/engine/conversation/history.test.ts`
- `packages/server/src/engine/conversation/history.ts`
- `packages/server/src/engine/conversation/rehydrate.test.ts`
- `packages/server/src/engine/conversation/rehydrate.ts`
- `packages/server/src/engine/conversation/reprice.ts`
- `packages/server/src/engine/conversation/run-summary-sink.ts`
- `packages/server/src/engine/conversation/runner-core-types.ts`
- `packages/server/src/engine/conversation/runner-core.failover.test.ts`
- `packages/server/src/engine/conversation/runner-core.ts`
- `packages/server/src/engine/conversation/runner.ts`
- `packages/server/src/engine/conversation/schema.ts`
- `packages/server/src/engine/conversation/store-items.test.ts`
- `packages/server/src/engine/conversation/store-sql.test.ts`
- `packages/server/src/engine/conversation/store-sql.ts`
- `packages/server/src/engine/conversation/store.ts`
- `packages/server/src/engine/conversation/transcript.ts`
- `packages/server/src/engine/conversation/turn.ts`
- `packages/server/src/engine/data/blob-store.ts`
- `packages/server/src/engine/handlers/build-extra-prompt.ts`
- `packages/server/src/engine/handlers/dispatcher.test.ts`
- `packages/server/src/engine/handlers/dispatcher.ts`
- `packages/server/src/engine/handlers/handler-pool.test.ts`
- `packages/server/src/engine/handlers/handler-runner.contract.test.ts`
- `packages/server/src/engine/handlers/handler-runner.ts`
- `packages/server/src/engine/handlers/vault-bridge.test.ts`
- `packages/server/src/engine/handlers/vault-bridge.ts`
- `packages/server/src/engine/handlers/worker-admission.ts`
- `packages/server/src/engine/handlers/worker-pool.ts`
- `packages/server/src/engine/http/changes-sse.ts`
- `packages/server/src/engine/http/cloud-routes.ts`
- `packages/server/src/engine/http/compression.ts`
- `packages/server/src/engine/http/conversation-routes.ts`
- `packages/server/src/engine/http/http-server.ts`
- `packages/server/src/engine/http/internal-headers.ts`
- `packages/server/src/engine/http/request-boundary.ts`
- `packages/server/src/engine/http/router.ts`
- `packages/server/src/engine/http/server-tuning.ts`
- `packages/server/src/engine/http/sse-stream.test.ts`
- `packages/server/src/engine/http/sse-stream.ts`
- `packages/server/src/engine/http/turn-limiter.ts`
- `packages/server/src/engine/http/turn-replay.ts`
- `packages/server/src/engine/http/turn-routes.test.ts`
- `packages/server/src/engine/http/turn-routes.ts`
- `packages/server/src/engine/http/turn-sse-support.ts`
- `packages/server/src/engine/http/turn-sse.test.ts`
- `packages/server/src/engine/http/turn-sse.ts`
- `packages/server/src/engine/index.ts`
- `packages/server/src/engine/insights/analytics-store.ts`
- `packages/server/src/engine/insights/insights-store.ts`
- `packages/server/src/engine/insights/insights-types.ts`
- `packages/server/src/engine/model-pricing.ts`
- `packages/server/src/engine/pricing/catalog.ts`
- `packages/server/src/engine/pricing/cost.ts`
- `packages/server/src/engine/pricing/filter.ts`
- `packages/server/src/engine/pricing/match.ts`
- `packages/server/src/engine/pricing/types.ts`
- `packages/server/src/engine/registry/app-paths.test.ts`
- `packages/server/src/engine/registry/app-paths.ts`
- `packages/server/src/engine/registry/manifest.test.ts`
- `packages/server/src/engine/registry/manifest.ts`
- `packages/server/src/engine/registry/registry.ts`
- `packages/server/src/engine/registry/token-purity.test.ts`
- `packages/server/src/engine/registry/token-purity.ts`
- `packages/server/src/engine/runtime.ts`
- `packages/server/src/engine/sandbox/boot.test.ts`
- `packages/server/src/engine/sandbox/boot.ts`
- `packages/server/src/engine/sandbox/bundle-lane-conformance.test.ts`
- `packages/server/src/engine/sandbox/confined-fs.test.ts`
- `packages/server/src/engine/sandbox/install.test.ts`
- `packages/server/src/engine/sandbox/policy.test.ts`
- `packages/server/src/engine/sandbox/policy.ts`
- `packages/server/src/engine/sandbox/sandbox-escape.test.ts`
- `packages/server/src/engine/settings/app-settings.ts`
- `packages/server/src/engine/settings/settings-merge.test.ts`
- `packages/server/src/engine/stores/gateway-db.ts`
- `packages/server/src/engine/stores/prefs-store.ts`
- `packages/server/src/engine/stores/vault-workspace.ts`
- `packages/server/src/engine/types.ts`
- `packages/server/src/engine/worker/runner.test.ts`
- `packages/server/src/engine/worker/runner.ts`
- `packages/server/src/engine/worker/ts-loader-hooks.test.ts`
- `packages/server/src/enrich/capability-registry.test.ts`
- `packages/server/src/enrich/capability-registry.ts`
- `packages/server/src/enrich/egress-consent-lookup.test.ts`
- `packages/server/src/enrich/egress-consent-lookup.ts`
- `packages/server/src/enrich/engine-profiles.test.ts`
- `packages/server/src/enrich/engine-profiles.ts`
- `packages/server/src/enrich/semantic-search.test.ts`
- `packages/server/src/enrich/semantic-search.ts`
- `packages/server/src/enrich/sqlite-vec.test.ts`
- `packages/server/src/enrich/sqlite-vec.ts`
- `packages/server/src/enrich/system-recognition.test.ts`
- `packages/server/src/enrich/system-recognition.ts`
- `packages/server/src/index.ts`
- `packages/server/src/journal-stores.test.ts`
- `packages/server/src/journal-stores.ts`
- `packages/server/src/lifecycle/automation-anchor-scopes.test.ts`
- `packages/server/src/lifecycle/automation-anchor-scopes.ts`
- `packages/server/src/lifecycle/automation-lifecycle-over-http.test.ts`
- `packages/server/src/lifecycle/automation-revision.test.ts`
- `packages/server/src/lifecycle/automation-revision.ts`
- `packages/server/src/lifecycle/automation-turn-context.test.ts`
- `packages/server/src/lifecycle/automation-turn-context.ts`
- `packages/server/src/lifecycle/clone-over-http.test.ts`
- `packages/server/src/lifecycle/draft-preview-over-http.test.ts`
- `packages/server/src/lifecycle/ext-band-over-http.test.ts`
- `packages/server/src/lifecycle/ext-band.ts`
- `packages/server/src/lifecycle/headless-automation-compile.test.ts`
- `packages/server/src/lifecycle/headless-automation-compile.ts`
- `packages/server/src/lifecycle/install-over-http.test.ts`
- `packages/server/src/lifecycle/interactive-automation-turn.ts`
- `packages/server/src/lifecycle/lifecycle-over-http.test.ts`
- `packages/server/src/lifecycle/lifecycle-shared.test.ts`
- `packages/server/src/lifecycle/lifecycle-shared.ts`
- `packages/server/src/lifecycle/rewrite-automation-instructions.ts`
- `packages/server/src/lifecycle/webhook-route-over-http.test.ts`
- `packages/server/src/paths.ts`
- `packages/server/src/preview/codec.test.ts`
- `packages/server/src/preview/codec.ts`
- `packages/server/src/preview/native-codec.test.ts`
- `packages/server/src/preview/thumbhash.test.ts`
- `packages/server/src/preview/thumbhash.ts`
- `packages/server/src/preview/wasm-codec.test.ts`
- `packages/server/src/provider-egress-dispatch.test.ts`
- `packages/server/src/reminders/due-reminders.ts`
- `packages/server/src/routes/apps-store-draft-files.ts`
- `packages/server/src/routes/apps-store-routes.test.ts`
- `packages/server/src/routes/apps-store-routes.ts`
- `packages/server/src/routes/assistant-routes.ts`
- `packages/server/src/routes/automations-routes-lanes.test.ts`
- `packages/server/src/routes/automations-routes.test.ts`
- `packages/server/src/routes/automations-routes.ts`
- `packages/server/src/routes/backup-owner-scope.ts`
- `packages/server/src/routes/backup-routes.ts`
- `packages/server/src/routes/blob-routes.test.ts`
- `packages/server/src/routes/blob-routes.ts`
- `packages/server/src/routes/commons-recovery-routes.ts`
- `packages/server/src/routes/commons-routes-intents.test.ts`
- `packages/server/src/routes/commons-routes.ts`
- `packages/server/src/routes/commons-steward-loss-drill.test.ts`
- `packages/server/src/routes/connection-providers.ts`
- `packages/server/src/routes/connections-routes.ts`
- `packages/server/src/routes/data-plane-control.ts`
- `packages/server/src/routes/demo-routes.ts`
- `packages/server/src/routes/device-invitations.ts`
- `packages/server/src/routes/device-ticket-mint.ts`
- `packages/server/src/routes/device-work-routes.test.ts`
- `packages/server/src/routes/devices-routes-mint.test.ts`
- `packages/server/src/routes/devices-routes.test-fixtures.ts`
- `packages/server/src/routes/devices-routes.test.ts`
- `packages/server/src/routes/devices-routes.ts`
- `packages/server/src/routes/diagnostics-routes.ts`
- `packages/server/src/routes/edges-routes.ts`
- `packages/server/src/routes/enrich-profiles-routes.test.ts`
- `packages/server/src/routes/enrich-profiles-routes.ts`
- `packages/server/src/routes/enrich-search-routes.test.ts`
- `packages/server/src/routes/enrich-search-routes.ts`
- `packages/server/src/routes/gateway-info-routes.ts`
- `packages/server/src/routes/grant-routes.ts`
- `packages/server/src/routes/harnesses-routes.test.ts`
- `packages/server/src/routes/harnesses-routes.ts`
- `packages/server/src/routes/import-routes.test.ts`
- `packages/server/src/routes/import-routes.ts`
- `packages/server/src/routes/lifecycle-automation-routes.test.ts`
- `packages/server/src/routes/lifecycle-automation-routes.ts`
- `packages/server/src/routes/lifecycle-routes.ts`
- `packages/server/src/routes/logs-routes.ts`
- `packages/server/src/routes/multiplex-replica-routes.test.ts`
- `packages/server/src/routes/owners-routes.ts`
- `packages/server/src/routes/p1-owner-only-refusals.test.ts`
- `packages/server/src/routes/peer-commons-route.ts`
- `packages/server/src/routes/peer-plane.test.ts`
- `packages/server/src/routes/peer-plane.ts`
- `packages/server/src/routes/replica-access.ts`
- `packages/server/src/routes/replica-grantees.ts`
- `packages/server/src/routes/replica-intent-attribution.test.ts`
- `packages/server/src/routes/replica-intent-shape.ts`
- `packages/server/src/routes/replica-routes.ts`
- `packages/server/src/routes/replica-shape.test.ts`
- `packages/server/src/routes/replica-shape.ts`
- `packages/server/src/routes/resource-routes.ts`
- `packages/server/src/routes/route-helpers.test.ts`
- `packages/server/src/routes/route-helpers.ts`
- `packages/server/src/routes/scopes-routes.ts`
- `packages/server/src/routes/sql-statement-cache.ts`
- `packages/server/src/routes/sse-cap.ts`
- `packages/server/src/routes/storage-local-routes.ts`
- `packages/server/src/routes/storage-routes.test.ts`
- `packages/server/src/routes/storage-routes.ts`
- `packages/server/src/routes/templates-routes.test.ts`
- `packages/server/src/routes/templates-routes.ts`
- `packages/server/src/routes/vault-enrich-rules-routes.test.ts`
- `packages/server/src/routes/vault-enrich-rules-routes.ts`
- `packages/server/src/routes/vault-erase.test.ts`
- `packages/server/src/routes/vault-links-routes.ts`
- `packages/server/src/routes/vault-links-ticket-routes.test.ts`
- `packages/server/src/routes/vault-routes.atlas.test.ts`
- `packages/server/src/routes/vault-routes.browse.test.ts`
- `packages/server/src/routes/vault-routes.test.ts`
- `packages/server/src/routes/vault-routes.ts`
- `packages/server/src/runs/assistant-conversation-runner.ts`
- `packages/server/src/runs/assistant-prompt.test.ts`
- `packages/server/src/runs/assistant-prompt.ts`
- `packages/server/src/runs/run-event-bus.ts`
- `packages/server/src/runs/run-events-sse.test.ts`
- `packages/server/src/runs/unified-conversation-runner.test.ts`
- `packages/server/src/runs/unified-conversation-runner.ts`
- `packages/server/src/serve/agent-owner-cap.test.ts`
- `packages/server/src/serve/anomaly-ledger.ts`
- `packages/server/src/serve/assist-oauth.ts`
- `packages/server/src/serve/authz-matrix.smoke.test.ts`
- `packages/server/src/serve/automation-event-sources-github.test.ts`
- `packages/server/src/serve/blob-sweep-health.ts`
- `packages/server/src/serve/broker-health.ts`
- `packages/server/src/serve/build-gateway-peer.test.ts`
- `packages/server/src/serve/build-gateway.test.ts`
- `packages/server/src/serve/build-gateway.ts`
- `packages/server/src/serve/commons-notices.test.ts`
- `packages/server/src/serve/commons-notices.ts`
- `packages/server/src/serve/commons-recovery-invites.ts`
- `packages/server/src/serve/companion-access.ts`
- `packages/server/src/serve/connection-broker.test.ts`
- `packages/server/src/serve/connection-broker.ts`
- `packages/server/src/serve/connection-limiter.ts`
- `packages/server/src/serve/demo-seed.test.ts`
- `packages/server/src/serve/device-plane.test.ts`
- `packages/server/src/serve/diagnostics-redaction.ts`
- `packages/server/src/serve/disk-health.test.ts`
- `packages/server/src/serve/disk-health.ts`
- `packages/server/src/serve/enrich-tier-control.test.ts`
- `packages/server/src/serve/enrichment-health.ts`
- `packages/server/src/serve/erase-recovery.ts`
- `packages/server/src/serve/fetch-timeout.ts`
- `packages/server/src/serve/gateway-db.ts`
- `packages/server/src/serve/gateway-log-store.test.ts`
- `packages/server/src/serve/gateway-log-store.ts`
- `packages/server/src/serve/gateway-performance.ts`
- `packages/server/src/serve/gateway-schema.ts`
- `packages/server/src/serve/grant-fulfillment.ts`
- `packages/server/src/serve/group-commit-queue.ts`
- `packages/server/src/serve/hardware-profile.ts`
- `packages/server/src/serve/health-registry.ts`
- `packages/server/src/serve/host-identity.ts`
- `packages/server/src/serve/host-limits.ts`
- `packages/server/src/serve/hostile-peer.integration.test.ts`
- `packages/server/src/serve/journal-limit.test.ts`
- `packages/server/src/serve/journal-limit.ts`
- `packages/server/src/serve/link-crossing.test.ts`
- `packages/server/src/serve/link-crossing.ts`
- `packages/server/src/serve/link-party-bindings.test.ts`
- `packages/server/src/serve/link-party-bindings.ts`
- `packages/server/src/serve/local-usage.test.ts`
- `packages/server/src/serve/local-usage.ts`
- `packages/server/src/serve/manifest-scope-denial.closed-grammar.test.ts`
- `packages/server/src/serve/manifest-scope-denial.fuzz.test.ts`
- `packages/server/src/serve/manifest-scope-denial.sweep.test-fixtures.ts`
- `packages/server/src/serve/manifest-scope-denial.sweep.test.ts`
- `packages/server/src/serve/notices.ts`
- `packages/server/src/serve/outbox-edit.test.ts`
- `packages/server/src/serve/outbox-edit.ts`
- `packages/server/src/serve/outbox-executor.test.ts`
- `packages/server/src/serve/outbox-executor.ts`
- `packages/server/src/serve/owner-removal-error.ts`
- `packages/server/src/serve/owner-store.ts`
- `packages/server/src/serve/peer-commons-client.ts`
- `packages/server/src/serve/peer-commons-sweep.test.ts`
- `packages/server/src/serve/peer-commons-sweep.ts`
- `packages/server/src/serve/peer-dial.ts`
- `packages/server/src/serve/peer-give.test-fixtures.ts`
- `packages/server/src/serve/peer-link-ceremony.test.ts`
- `packages/server/src/serve/peer-link-client.ts`
- `packages/server/src/serve/peer-link-tickets.ts`
- `packages/server/src/serve/peer-plane-sweep.ts`
- `packages/server/src/serve/peer-route-announce.test.ts`
- `packages/server/src/serve/peer-route-announce.ts`
- `packages/server/src/serve/peer-route-assertion.ts`
- `packages/server/src/serve/power-context.ts`
- `packages/server/src/serve/pricing-warmer.ts`
- `packages/server/src/serve/protocol-join-lane.test.ts`
- `packages/server/src/serve/replica-intent-context.ts`
- `packages/server/src/serve/resource-accounting.ts`
- `packages/server/src/serve/resource-evidence.ts`
- `packages/server/src/serve/resource-mode.ts`
- `packages/server/src/serve/route-latency.test.ts`
- `packages/server/src/serve/route-latency.ts`
- `packages/server/src/serve/scheduler-health.ts`
- `packages/server/src/serve/secret-log.smoke.test.ts`
- `packages/server/src/serve/serve-git-store.test.ts`
- `packages/server/src/serve/serve-multiclient.test.ts`
- `packages/server/src/serve/serve-scheduler-reconcile.test.ts`
- `packages/server/src/serve/serve-vault-addressing.test.ts`
- `packages/server/src/serve/serve.test.ts`
- `packages/server/src/serve/serve.ts`
- `packages/server/src/serve/share-access-receipts.ts`
- `packages/server/src/serve/share-coordinator.test.ts`
- `packages/server/src/serve/share-coordinator.ts`
- `packages/server/src/serve/share-edge-row.ts`
- `packages/server/src/serve/share-edge-store.ts`
- `packages/server/src/serve/share-effect-executor.ts`
- `packages/server/src/serve/share-effects-retire.ts`
- `packages/server/src/serve/share-effects.ts`
- `packages/server/src/serve/share-outbox-obligation.contract.test.ts`
- `packages/server/src/serve/share-scope.test.ts`
- `packages/server/src/serve/share-scope.ts`
- `packages/server/src/serve/storage-latency.ts`
- `packages/server/src/serve/storage-limits.test.ts`
- `packages/server/src/serve/storage-limits.ts`
- `packages/server/src/serve/storage-quota-health.ts`
- `packages/server/src/serve/support-bundle-source.ts`
- `packages/server/src/serve/support-bundle.ts`
- `packages/server/src/serve/trigger-ingress-cursor.test.ts`
- `packages/server/src/serve/trigger-ingress-cursor.ts`
- `packages/server/src/serve/vault-context.ts`
- `packages/server/src/serve/vault-integrity-health.ts`
- `packages/server/src/serve/vault-link-row.ts`
- `packages/server/src/serve/vault-links-store.test.ts`
- `packages/server/src/serve/vault-links-store.ts`
- `packages/server/src/serve/vault-owned-error.ts`
- `packages/server/src/serve/vault-picker.ts`
- `packages/server/src/serve/vault-plane-app-bridge.test.ts`
- `packages/server/src/serve/vault-plane-assistant.test.ts`
- `packages/server/src/serve/vault-plane-blob-sweep.test.ts`
- `packages/server/src/serve/vault-plane-consent.test.ts`
- `packages/server/src/serve/vault-plane-conversation-archival.test.ts`
- `packages/server/src/serve/vault-plane-links.test.ts`
- `packages/server/src/serve/vault-plane-maintenance.test.ts`
- `packages/server/src/serve/vault-plane-scopes.test.ts`
- `packages/server/src/serve/vault-plane.ts`
- `packages/server/src/serve/vault-registry-footprint.test.ts`
- `packages/server/src/serve/vault-registry.test.ts`
- `packages/server/src/serve/vault-registry.ts`
- `packages/server/src/serve/web-control-sessions.ts`
- `packages/server/src/serve/web-session-store.ts`
- `packages/server/src/skills/authoring-prompt.test.ts`
- `packages/server/src/skills/authoring-prompt.ts`
- `packages/server/src/skills/compose.ts`
- `packages/server/src/skills/index.ts`
- `packages/server/src/validate-manifest.test.ts`
- `packages/server/src/validate-manifest.ts`
- `packages/server/src/version.ts`
- `packages/server/src/worktree-store/git.ts`
- `packages/server/src/worktree-store/remote.ts`
- `packages/server/src/worktree-store/types.ts`
- `packages/server/src/worktree-store/worktree-store.test.ts`
- `packages/server/src/worktree-store/worktree-store.ts`
- `packages/test-kit/src/flush.ts`
- `packages/test-kit/src/quality-signal.test.ts`
- `packages/test-kit/src/vault.ts`
- `packages/tunnel/src/alpn-parity.test.ts`
- `packages/tunnel/src/client.ts`
- `packages/tunnel/src/desktop-tunnel.ts`
- `packages/tunnel/src/device-store.ts`
- `packages/tunnel/src/endpoint-secret.ts`
- `packages/tunnel/src/gateway-endpoint.test.ts`
- `packages/tunnel/src/gateway-endpoint.ts`
- `packages/tunnel/src/native-relay.ts`
- `packages/tunnel/src/peer-budget.ts`
- `packages/tunnel/src/peer-connection.ts`
- `packages/tunnel/src/peer-plane.test.ts`
- `packages/tunnel/src/peer-target-differential.test.ts`
- `packages/tunnel/src/protocol.ts`
- `packages/tunnel/src/response-frames.ts`
- `packages/tunnel/src/tunnel.integration.test.ts`
- `packages/tunnel/src/wire-conformance.contract.test.ts`
- `packages/vault/src/backup-policy.ts`
- `packages/vault/src/blob/blob.test.ts`
- `packages/vault/src/blob/cache.ts`
- `packages/vault/src/blob/custody-export.ts`
- `packages/vault/src/blob/custody-proven.contract.test.ts`
- `packages/vault/src/blob/custody-proven.ts`
- `packages/vault/src/blob/custody-read.ts`
- `packages/vault/src/blob/custody-reconcile.ts`
- `packages/vault/src/blob/custody-rollup.test.ts`
- `packages/vault/src/blob/custody-rollup.ts`
- `packages/vault/src/blob/custody-state.ts`
- `packages/vault/src/blob/custody-types.ts`
- `packages/vault/src/blob/custody.ts`
- `packages/vault/src/blob/derivatives.ts`
- `packages/vault/src/blob/direct-cold-doors.test.ts`
- `packages/vault/src/blob/direct-transfers.test.ts`
- `packages/vault/src/blob/direct-transfers.ts`
- `packages/vault/src/blob/disk-full.integration.test.ts`
- `packages/vault/src/blob/evict.ts`
- `packages/vault/src/blob/exif-adversarial.test.ts`
- `packages/vault/src/blob/exif-fixtures.ts`
- `packages/vault/src/blob/flow.test.ts`
- `packages/vault/src/blob/incremental-sha256.ts`
- `packages/vault/src/blob/local-orphan-sweep.test.ts`
- `packages/vault/src/blob/local-orphan-sweep.ts`
- `packages/vault/src/blob/local.ts`
- `packages/vault/src/blob/media-metadata.ts`
- `packages/vault/src/blob/mint.ts`
- `packages/vault/src/blob/one-shot-stream.ts`
- `packages/vault/src/blob/orphan-grace.test.ts`
- `packages/vault/src/blob/orphan-tombstone.ts`
- `packages/vault/src/blob/outbox-drain.ts`
- `packages/vault/src/blob/outbox-runner.ts`
- `packages/vault/src/blob/pdf-text.test.ts`
- `packages/vault/src/blob/pipeline.ts`
- `packages/vault/src/blob/preview.test.ts`
- `packages/vault/src/blob/preview.ts`
- `packages/vault/src/blob/promote.ts`
- `packages/vault/src/blob/read.test.ts`
- `packages/vault/src/blob/read.ts`
- `packages/vault/src/blob/remote-transfer.ts`
- `packages/vault/src/blob/replica-index.ts`
- `packages/vault/src/blob/replicate-driver.ts`
- `packages/vault/src/blob/s3-transfer.ts`
- `packages/vault/src/blob/s3.test.ts`
- `packages/vault/src/blob/s3.ts`
- `packages/vault/src/blob/seal-frames.ts`
- `packages/vault/src/blob/seal.test.ts`
- `packages/vault/src/blob/seal.ts`
- `packages/vault/src/blob/sigv4.test.ts`
- `packages/vault/src/blob/sigv4.ts`
- `packages/vault/src/blob/staging.ts`
- `packages/vault/src/blob/store-routing.test.ts`
- `packages/vault/src/blob/store-routing.ts`
- `packages/vault/src/blob/store.ts`
- `packages/vault/src/blob/stream-ingress.ts`
- `packages/vault/src/blob/unknown-hash-stream.ts`
- `packages/vault/src/bootstrap.ts`
- `packages/vault/src/commands/annotations.ts`
- `packages/vault/src/commands/atlas.test.ts`
- `packages/vault/src/commands/atlas.ts`
- `packages/vault/src/commands/attachments.test.ts`
- `packages/vault/src/commands/attachments.ts`
- `packages/vault/src/commands/business.test.ts`
- `packages/vault/src/commands/business.ts`
- `packages/vault/src/commands/documents.test.ts`
- `packages/vault/src/commands/documents.ts`
- `packages/vault/src/commands/enrich.ts`
- `packages/vault/src/commands/entity-revisions.test.ts`
- `packages/vault/src/commands/entity-revisions.ts`
- `packages/vault/src/commands/finance.ts`
- `packages/vault/src/commands/flags.ts`
- `packages/vault/src/commands/health.ts`
- `packages/vault/src/commands/home.ts`
- `packages/vault/src/commands/inline-body-guard.ts`
- `packages/vault/src/commands/judgment.test.ts`
- `packages/vault/src/commands/judgment.ts`
- `packages/vault/src/commands/knowledge.ts`
- `packages/vault/src/commands/links.test.ts`
- `packages/vault/src/commands/links.ts`
- `packages/vault/src/commands/locker.test.ts`
- `packages/vault/src/commands/locker.ts`
- `packages/vault/src/commands/media-forget-person.test.ts`
- `packages/vault/src/commands/media-gazetteer.ts`
- `packages/vault/src/commands/media-places.test.ts`
- `packages/vault/src/commands/media-purge.test.ts`
- `packages/vault/src/commands/media.ts`
- `packages/vault/src/commands/merge.test.ts`
- `packages/vault/src/commands/merge.ts`
- `packages/vault/src/commands/outbox.ts`
- `packages/vault/src/commands/parties.ts`
- `packages/vault/src/commands/people-organize.ts`
- `packages/vault/src/commands/people.ts`
- `packages/vault/src/commands/provider-writeback.ts`
- `packages/vault/src/commands/revisions.ts`
- `packages/vault/src/commands/schedule.ts`
- `packages/vault/src/commands/social.test.ts`
- `packages/vault/src/commands/social.ts`
- `packages/vault/src/commands/sync.test.ts`
- `packages/vault/src/commands/sync.ts`
- `packages/vault/src/commands/tags.ts`
- `packages/vault/src/commands/tally.test.ts`
- `packages/vault/src/commands/tally.ts`
- `packages/vault/src/commands/tasks.ts`
- `packages/vault/src/conversation-archive-roots.test.ts`
- `packages/vault/src/conversation-archive-roots.ts`
- `packages/vault/src/db.ts`
- `packages/vault/src/enrich/clusters.test.ts`
- `packages/vault/src/enrich/clusters.ts`
- `packages/vault/src/enrich/content.ts`
- `packages/vault/src/enrich/derivation.test.ts`
- `packages/vault/src/enrich/derivation.ts`
- `packages/vault/src/enrich/egress-consent.test.ts`
- `packages/vault/src/enrich/egress-consent.ts`
- `packages/vault/src/enrich/enrich.test.ts`
- `packages/vault/src/enrich/face-clusters.test.ts`
- `packages/vault/src/enrich/face-clusters.ts`
- `packages/vault/src/enrich/leases.test.ts`
- `packages/vault/src/enrich/leases.ts`
- `packages/vault/src/enrich/memories.test.ts`
- `packages/vault/src/enrich/memories.ts`
- `packages/vault/src/enrich/model-id.test.ts`
- `packages/vault/src/enrich/model-id.ts`
- `packages/vault/src/enrich/policy-rules.test.ts`
- `packages/vault/src/enrich/policy-rules.ts`
- `packages/vault/src/enrich/policy.ts`
- `packages/vault/src/enrich/similarity.ts`
- `packages/vault/src/errors.test.ts`
- `packages/vault/src/errors.ts`
- `packages/vault/src/gateway/acting-owner.test.ts`
- `packages/vault/src/gateway/activity-read.test.ts`
- `packages/vault/src/gateway/assistant-context.ts`
- `packages/vault/src/gateway/cards.test.ts`
- `packages/vault/src/gateway/cards.ts`
- `packages/vault/src/gateway/consent.ts`
- `packages/vault/src/gateway/custody.test.ts`
- `packages/vault/src/gateway/custody.ts`
- `packages/vault/src/gateway/demo.test.ts`
- `packages/vault/src/gateway/demo.ts`
- `packages/vault/src/gateway/duties-helpers.test.ts`
- `packages/vault/src/gateway/duties.test.ts`
- `packages/vault/src/gateway/duties.ts`
- `packages/vault/src/gateway/evidence.ts`
- `packages/vault/src/gateway/execution-clamp.test.ts`
- `packages/vault/src/gateway/execution.test.ts`
- `packages/vault/src/gateway/execution.ts`
- `packages/vault/src/gateway/ext-sealed.test.ts`
- `packages/vault/src/gateway/ext.test.ts`
- `packages/vault/src/gateway/ext.ts`
- `packages/vault/src/gateway/gateway.contract.test.ts`
- `packages/vault/src/gateway/gateway.ts`
- `packages/vault/src/gateway/locker-auth.ts`
- `packages/vault/src/gateway/portability.ts`
- `packages/vault/src/gateway/portable-adapters.ts`
- `packages/vault/src/gateway/portable-export.ts`
- `packages/vault/src/gateway/read-order.test.ts`
- `packages/vault/src/gateway/reseal.ts`
- `packages/vault/src/gateway/seal-custody.test.ts`
- `packages/vault/src/gateway/share-grant-seam.test.ts`
- `packages/vault/src/gateway/types.ts`
- `packages/vault/src/grant/channel.ts`
- `packages/vault/src/grant/fulfillment-edit.ts`
- `packages/vault/src/grant/fulfillment-invite.ts`
- `packages/vault/src/grant/fulfillment.ts`
- `packages/vault/src/grant/grant-store.test.ts`
- `packages/vault/src/grant/grant-store.ts`
- `packages/vault/src/host.ts`
- `packages/vault/src/index.ts`
- `packages/vault/src/ingest/csv.test.ts`
- `packages/vault/src/ingest/csv.ts`
- `packages/vault/src/ingest/enrich-publishers.test.ts`
- `packages/vault/src/ingest/enrich-publishers.ts`
- `packages/vault/src/ingest/ics.test.ts`
- `packages/vault/src/ingest/import.ts`
- `packages/vault/src/ingest/markdown.ts`
- `packages/vault/src/ingest/mbox-attachments.test.ts`
- `packages/vault/src/ingest/mbox.ts`
- `packages/vault/src/ingest/passwords-csv.test.ts`
- `packages/vault/src/ingest/passwords-csv.ts`
- `packages/vault/src/ingest/payload-schemas.test.ts`
- `packages/vault/src/ingest/payload-schemas.ts`
- `packages/vault/src/ingest/publishers.ts`
- `packages/vault/src/ingest/stage-file.ts`
- `packages/vault/src/ingest/staging.test.ts`
- `packages/vault/src/ingest/staging.ts`
- `packages/vault/src/ingest/takeout-photos.test.ts`
- `packages/vault/src/ingest/takeout-sidecar.test.ts`
- `packages/vault/src/ingest/takeout-sidecar.ts`
- `packages/vault/src/ingest/vcard.test.ts`
- `packages/vault/src/ingest/zip.test.ts`
- `packages/vault/src/ingest/zip.ts`
- `packages/vault/src/install-memory.test.ts`
- `packages/vault/src/install-memory.ts`
- `packages/vault/src/journal-archive.ts`
- `packages/vault/src/replica/invocation-commits.ts`
- `packages/vault/src/restore-check.ts`
- `packages/vault/src/retention.test.ts`
- `packages/vault/src/retention.ts`
- `packages/vault/src/schema/atlas-browse-refs.ts`
- `packages/vault/src/schema/atlas-browse.ts`
- `packages/vault/src/schema/atlas-census.test.ts`
- `packages/vault/src/schema/atlas-census.ts`
- `packages/vault/src/schema/atlas-graph.ts`
- `packages/vault/src/schema/atlas.ts`
- `packages/vault/src/schema/blob-transfer.ts`
- `packages/vault/src/schema/blob.ts`
- `packages/vault/src/schema/commons-resilience.ts`
- `packages/vault/src/schema/consent.ts`
- `packages/vault/src/schema/core.ts`
- `packages/vault/src/schema/domains-locker.ts`
- `packages/vault/src/schema/domains-people.ts`
- `packages/vault/src/schema/domains-tally.ts`
- `packages/vault/src/schema/enrich.ts`
- `packages/vault/src/schema/entity-revisions.ts`
- `packages/vault/src/schema/ext.ts`
- `packages/vault/src/schema/fk-index.test.ts`
- `packages/vault/src/schema/fts-index-budget.test.ts`
- `packages/vault/src/schema/fts.ts`
- `packages/vault/src/schema/journal.ts`
- `packages/vault/src/schema/key-store.ts`
- `packages/vault/src/schema/migrate-batched.test.ts`
- `packages/vault/src/schema/migrate.test.ts`
- `packages/vault/src/schema/migrate.ts`
- `packages/vault/src/schema/outbox.ts`
- `packages/vault/src/schema/poly-refs.test.ts`
- `packages/vault/src/schema/poly-refs.ts`
- `packages/vault/src/schema/replica.ts`
- `packages/vault/src/schema/sealed.ts`
- `packages/vault/src/schema/seed.ts`
- `packages/vault/src/schema/share-commons.ts`
- `packages/vault/src/schema/share-grant.ts`
- `packages/vault/src/schema/sync.ts`
- `packages/vault/src/schema/table-stats.ts`
- `packages/vault/src/schema/tables.ts`
- `packages/vault/src/schema/time-organize.ts`
- `packages/vault/src/schema/vault-identity.test.ts`
- `packages/vault/src/schema/vault-identity.ts`
- `packages/vault/src/scope-extent.test.ts`
- `packages/vault/src/scope-extent.ts`
- `packages/vault/src/share/blobs.ts`
- `packages/vault/src/share/closure-location-policy.test.ts`
- `packages/vault/src/share/closure-split.test.ts`
- `packages/vault/src/share/closure.ts`
- `packages/vault/src/share/commons-blobs.test-fixtures.ts`
- `packages/vault/src/share/commons-bootstrap.ts`
- `packages/vault/src/share/commons-chain.test.ts`
- `packages/vault/src/share/commons-chain.ts`
- `packages/vault/src/share/commons-hardening.test.ts`
- `packages/vault/src/share/commons-increment.test.ts`
- `packages/vault/src/share/commons-intent.test-fixtures.ts`
- `packages/vault/src/share/commons-lifecycle.ts`
- `packages/vault/src/share/commons-recovery.ts`
- `packages/vault/src/share/commons-replay.test-fixtures.ts`
- `packages/vault/src/share/commons-replay.test.ts`
- `packages/vault/src/share/commons-replay.ts`
- `packages/vault/src/share/commons-routing.test.ts`
- `packages/vault/src/share/commons-routing.ts`
- `packages/vault/src/share/commons-sim-grant.test-fixtures.ts`
- `packages/vault/src/share/commons-sim-world.test-fixtures.ts`
- `packages/vault/src/share/commons-sim.test-fixtures.ts`
- `packages/vault/src/share/commons-sim.test.ts`
- `packages/vault/src/share/commons-size.test.ts`
- `packages/vault/src/share/commons.ts`
- `packages/vault/src/share/party-vault-binding.ts`
- `packages/vault/src/share/placement-fixture.ts`
- `packages/vault/src/share/placement-lifecycle.test.ts`
- `packages/vault/src/share/placement.test.ts`
- `packages/vault/src/share/placement.ts`
- `packages/vault/src/share/project-closure.ts`
- `packages/vault/src/share/projection-ingest.ts`
- `packages/vault/src/share/read-closure.ts`
- `packages/vault/src/share/read-tally.ts`
- `packages/vault/src/share/removal.ts`
- `packages/vault/src/share/sql.ts`
- `packages/vault/src/vault-footprint.ts`
- `packages/vault/src/vault-limit.test.ts`
- `packages/vault/src/vault-limit.ts`
- `packages/vault/src/wal-shipper-clone.test.ts`
- `packages/vault/src/wal-shipper-detectors.test.ts`
- `packages/vault/src/wal-shipper.test.ts`
- `packages/vault/src/wal-shipper.ts`
- `receipts/issue-861-comment-current-state.md`
- `scripts/lint-comment-file-refs.mjs`
- `scripts/lint-comment-narration.mjs`
- `tests/quality/classification-ratchet.json`
- `tests/schema-export-fingerprint.json`

### Sanctioned diff exceptions (phase 2)

1. `packages/blueprints/apps/docs/Chrome.tsx` — one whole JSX comment
   container deleted (plus its blank line). The expression container renders
   nothing and whitespace-only JSX text is elided, so the rendered tree is
   identical; this is the sanctioned deletion form for JSX comments.
2. `packages/server/src/acp/backends/acp/harness-errors.ts` and
   `packages/server/src/serve/group-commit-queue.ts` — an orphaned JSDoc
   block re-attached to the declaration it documents; the code statement is
   byte-identical and its order among code statements unchanged (the
   parser-based proof treats both files as comment-only).

### Integration defect caught and fixed (recorded, not hidden)

The citation normalizer's comment-line heuristic matched `*`-led lines inside
DDL **template literals** in `packages/server/src/engine/stores/gateway-db.ts`
and `packages/server/src/serve/gateway-schema.ts` — string contents, stored in
`sqlite_master`, not comments. The TypeScript-parser proof caught it; every
template-literal span in both files was restored to its HEAD bytes (code
inside interpolations was unchanged, so the restoration reverted exactly the
string-internal edits). The naive line-regex verifier that missed this
distinction was replaced by the parser-based proof below for the whole tree.

### Decisions (phase 2)

- Classification ratchet re-pinned; the deviation note in
  `tests/quality/classification-ratchet.json` is mirrored here verbatim:

#861 Phase 2 (comments face forward) re-pin: packages/server/src/acp/backends/acp/vault-mcp-server.ts, packages/server/src/automation/manifest/manifest.ts, packages/server/src/serve/health-registry.ts, and packages/vault/src/schema/sealed.ts changed in comment lines only (deletion-first sweep: zero-information and process-narration comments deleted, survivors rewritten to the directive register, citations normalized to bare #N), so their governed fingerprints are re-pinned to the same logic at new bytes. Verified by a TypeScript-parser comment-stripped comparison: the printed code of every re-pinned file is byte-identical to origin/main's branch head. No quality lost a gate, no gate lost its evidence, and every other governed fingerprint is unmoved.

- Schema/export ratchet re-pinned to
  `eedb4d6eb36f965610adb9034236b67428b94de92dcafc0c19d5c2211dfcabe5`; the
  Phase 2 deviation note prepended in `tests/schema-export-fingerprint.json`
  (chained with " Prior: " onto the Phase 1 note) is mirrored here verbatim:

#861 Phase 2 (comments face forward): comment-only edits across 39 files under packages/vault/src/schema — five hand conversions of surviving narration to forward-facing obligations (time-organize.ts, blob.ts, journal.ts, atlas-browse-refs.ts, domains-people.ts) plus the repo-wide bare-#N citation normalization — with no table, column, index, trigger, or CHECK added, dropped, or altered. Every schema file's printed code (TypeScript parser, comments removed) is byte-identical to the branch head, so no DDL template literal changed. Export completeness re-audited in packages/vault/src/gateway/portable-export.ts (Phase 2 audit note in its header): the canonical table walk carries exactly what it carried.

- The Phase 2 audit note extends the `Schema/export audit #861` block in
  `packages/vault/src/gateway/portable-export.ts` to cover both phases.
- Environmental gate lanes: unchanged from Phase 1's disposition — the local
  sandbox cannot run the Electron binary or the pinned Playwright chromium,
  and `check-mobile-native-state` reports an iOS-only `@expo/fingerprint`
  mismatch (Android matches) that a TS-comment diff cannot cause. CI enforces
  these lanes on push; every non-environmental gate ran and passed locally.

### User impact (phase 2)

None visible. The Phase 2 diff is comment-only in `packages/**`/`apps/**`
(one render-identical JSX-container deletion aside); no string, style, or
behavior change reaches any surface. First-run: unchanged — the Phase 1
first-run evidence stands, and no e2e harness output could differ from a
comment-only diff.

### Verification (phase 2)

- Comment-only proof: `verify-comment-only-ts.mjs` (session scratchpad; its
  method is recorded here) — parses HEAD and worktree versions of every
  modified tracked `.ts`/`.tsx` under `packages/`/`apps/` with the repo's
  TypeScript 5.9.3, prints both with comments removed, requires identical
  output. Result: all modified files identical except the one sanctioned
  JSX-container deletion in `Chrome.tsx`.
- `bun run format` — clean (oxfmt over 4,664 files); `bun run lint`
  (oxlint `--deny-warnings`) — clean; `bun run typecheck` — 25/25 tasks green.
- `bun scripts/lint-comment-file-refs.mjs` — clean, zero dangling references.
- `bun scripts/lint-comment-narration.mjs` — 71 lines, reviewed line-by-line
  at integration: present-tense "is replaced by"/"used to <verb>" mechanics,
  runtime-state "previously", quoted spec text, and deliberate keeps (the
  `vite.config.ts` measured waiver; design tests asserting retirements). The
  two genuine stragglers found in that review are fixed (Wave 3 above).
- `bun scripts/check-quality-knobs.mjs` — green with the re-pin above;
  `bun scripts/check-schema-export-ratchet.mjs` — green, prints the pinned
  fingerprint; `bun scripts/validate-ui-receipt.mjs` — "evidence verified".
- `bun scripts/check-mobile-native-state.mjs` — iOS fingerprint mismatch,
  dispositioned environmental (Decisions above).

### Audit (phase 2)

Fresh-context adversarial sub-agent over the uncommitted Phase 2 diff, this
receipt's Phase 2 section, and the issue's Phase 2 acceptance criteria.

**Verdict: PASS** (one round; one advisory adopted as the residue amendment
above).

- All five Verification commands re-run and reproduce (file-refs clean;
  narration exactly 71; quality-knobs, schema-export, ui-receipt green;
  mobile-native-state fails iOS-only, matching the environmental disposition).
- Comment-only re-proved by the auditor's own independently written
  TypeScript-parser strip over **all 1,873** modified `.ts`/`.tsx` — one
  code-differing file, `Chrome.tsx`, whose printed outputs are identical once
  whitespace-only lines are dropped; the two JSDoc re-attachment files print
  byte-identical with statement order unchanged.
- Both deviation notes verified byte-verbatim in this receipt; all four
  re-pinned classification hashes equal current file sha256s; the pinned
  schema fingerprint matches the ratchet's own output; 39 schema files
  confirmed.
- Template-literal restoration verified: both DDL files' templates
  byte-identical to HEAD, comment edits retained.
- Doctrine section, lint headers, zero `eslint-` markers, four QUALITY.md
  entries, `wrapRecoveryKit`, settled schema keeps, issue retitle and comment
  5397080529 all confirmed; six per-slice notable claims spot-checked true
  (20 `Register the` JSDocs gone; gateway-monitor headers; `App.tsx`;
  `FaceReview.tsx`; `app-inline.tsx`; the two Wave 3 straggler fixes).
- Advisories recorded: the citation residue (amended above); one surviving
  `@param` in `packages/server/src/cli/pair-qr.ts` that states semantics
  beyond the type (not noise, kept); the `portable-export.ts` audit-note edit
  is the ratchet's own required bookkeeping, disclosed in Decisions, not a
  sweep disposition.


## Phase 3 — density budget (Wave 0 + compression sweep)

Ruled in the issue body (supersedes the density non-goal): doctrine governs
what a comment may say; the budget governs how much. Wave 0 lands the
character-based per-file ratchet, the block-length bound, and the CI global
figure; compression waves follow. Evidence appended per wave below.

### Wave 0 — enforcement infrastructure (2026-08-25)

Landed, per the issue's enforcement design:

- `scripts/check-comment-density-ratchet.mjs` — the blocking gate (`bun run
  test:comment-density`, wired into `check:push` in `package.json` after
  `test:hygiene-ratchet`). Metric: character share — non-whitespace comment
  characters / non-whitespace file characters, comment ranges from the
  TypeScript parser (leaf-token leading-trivia walk, deduped by position), so
  neither line-fusing nor whitespace games the number. Per-file pins live in
  `tests/comment-density-ratchet.json`: any rise fails (integer
  cross-multiplication, no float drift); unpinned files ≥40 non-blank lines
  fail above the 15% cap; `--write` adds/prunes/lowers and refuses to raise.
  Global character share AND line density print on every run — the CI trend
  figure. Allowlist seeded with `packages/design/src/blocks/contracts.ts`
  (prose contracts registry — the prose is the payload); allowlist exempts
  the cap only, never the pin.
- `scripts/lint-comment-blocks.mjs` — warn-only block bound: >10 lines
  (>15 for a file-top orientation header), allowlist skipped. 1,546 blocks
  over bound at seed time.
- `scripts/comment-only-diff.mjs` — sweep evidence tool: reprints both sides
  of a diff through the TypeScript printer with comments removed; exit 0 iff
  no code changed. Not a gate.
- `scripts/check-comment-density-ratchet.test.mjs` — 10 tests in the
  `scripts:test` lane, including the demonstrated-red case ("RED: a pinned
  file whose comment share rises fails verification"), --write
  never-raises, new-file cap, allowlist pass, block-length limits, and
  comment-only-diff verdicts.
- `docs/coding-standards.md` — "The density budget" subsection replaces the
  former "density is not regulated" non-goal (the no-JSDoc-tag-vocabulary
  non-goal survives); "Mechanical surrogates" now names the block lint and
  the proof tool and points at the ratchet as the one blocking gate.

Seed measurement (pre-sweep tree, doctrine sweep merged): **global character
share 24.31%**, line density 14.83% (the issue table's 14.9% metric), 3,638
files pinned, **1,975 files over the 15% cap**. The issue's ~1,648-file
estimate was modeled on line density; the character metric the enforcement
design mandates yields the larger worklist, recorded here as the deviation
between estimate and measurement — the budget's normative metric is
character share.

Allowlist additions after seeding, per the issue's named-allowlist ruling:
`apps/web/tests/e2e/leak-budgets.ts` and `apps/web/tests/e2e/perf-budgets.ts`
(e2e budget registries — the prose is the payload). Cap-exempt only; their
pins still forbid growth.

Verification (Wave 0):

```sh
bun run test:comment-density        # verify mode, prints the global figure
node --test scripts/check-comment-density-ratchet.test.mjs
node scripts/lint-comment-blocks.mjs
node scripts/comment-only-diff.mjs HEAD
bun run format:check && bun run lint && bun run knip
```

All green at hand-off (10/10 tests; formatter clean over 4,670 files; knip
finding-free vs baseline).

### Wave 1 — compression sweep, the 158 heaviest files (2026-08-25)

Eight parallel worker sub-agents, ownership-disjoint file batches, root
integration per [docs/multi-agent.md](../docs/multi-agent.md). Tree movement:

| Figure | Wave 0 seed | after Wave 1 |
| --- | --- | --- |
| Global character share | 24.31% | **21.17%** |
| Global line density | 14.83% | **12.65%** |
| Comment lines | 113,106 | ~94,100 |
| Files over the 15% cap | 1,975 | 1,906 |

Batch aggregates (comment characters cut): desktop+photos −64%, mobile −53%,
backup+blueprints −49.5%, blueprints+client (all 20 under cap, 11.1–14.9%),
client+design+server (14 of 20 under 13%), server slice (all 20 under cap,
9.6–14.6%), server+vault (16 of 20 under 13%; `build-gateway.ts` 69k → 16.8k
chars), vault −40%.

**Allowlist ruling (root).** 27 entries added by name, each with its reason in
`tests/comment-density-ratchet.json`: declaration-leaf contract surfaces
(`custody-types.ts`, `gateway/types.ts`, `share/closure.ts`, `acp/types.ts`,
`docs/types.ts`, `inline-types.ts`), protocol/format specs
(`backup/provider.ts`, `wal-format.ts`, `tunnel/protocol.ts`), security-rule
batteries and proofs (`diagnostics-redaction.ts`, `sandbox/policy.ts`,
`wal-shipper.ts`, `peer-target-differential.test.ts`), copy/consent registries
(`drive-copy.ts`, `view-copy.ts`, `enrichment-consent.ts`, `home` launcher and
design registries), and the mobile declarative policy tables. Allowlisting
exempts the cap only — every pin still forbids growth. Rejected nominations:
files whose payload is string literals (their comments compressed normally) and
every ordinary code file.

**Proof-tool defect found and fixed by this wave** (`scripts/comment-only-diff.mjs`):
the printed-code comparison false-positived on formatter fallout — a block
emptied of its comment collapses (`catch { }` → `catch {}`) and the TS
printer preserves original block formatting; separately a leaf-token
comparison false-positives on dropped syntax sugar (a union type's leading
`|`) and on JSDoc, which the parser gives AST nodes. The tool now runs both
comparisons and either passing proves the diff comment-only — each alone is
strict against a real code change. Test expectation updated in
`scripts/check-comment-density-ratchet.test.mjs`; 10/10 green.

**Known metric limitation (recorded, not fixed mid-sweep):** JSX
`{/* … */}` comment text is not counted as comment characters by the
scanner (the ranges sit inside JSX expression containers), so `.tsx` shares
understate true comment mass; compressing a JSX comment can slightly raise
the measured share. The doctrine, not the metric, governs JSX comments; the
baseline stays self-consistent because seed and verify use the same scanner.
Also ruled: deleting a `{/* … */}` container is a CODE change (it removes a
JSX expression child) — sweep agents rewrite the text in place, never delete
the container.

**Residue.** Non-allowlisted Wave 1 files still above 15% (e.g. desktop
`ipc.ts` 27%, `settings.ts` 28.8%, mobile `camera-roll-import.ts` 45.5%,
client `queryCache.ts` 25.5%, vault `db.ts` 40.6%) stay on the worklist for a
re-pass wave at the severity the server batches proved honest (73.3% → 12.7%
on `conversation/turn.ts`; 38% → 13% on `build-gateway.ts`). One worker
disclosed a contract deviation: a single `git checkout --` of its own
mis-edited assigned file to recover from a broken scripted rewrite, then
redone correctly; no sibling file touched.

**Deviation — five pins hand-raised after the lint gate spoke.** The sweep
emptied blocks whose comments were load-bearing for oxlint's `no-empty`
(`catch {}` sites in `vault-plane.ts`, `vault-registry.ts`, `gateway.ts`,
`inline-blob-images.ts`; an intentional empty then-branch in `custody.ts`).
One-line directive comments were restored, and the five pins were hand-raised
to the measured values (each a few tenths above the refused re-pin, far below
the Wave 0 seed), with the note mirrored in the baseline's
`approvedDeviation`. Also fixed in passing: `comment-only-diff.mjs`'s JSX
whitespace regex gains the lint-required `u` flag.

Verification (Wave 1):

```sh
node scripts/comment-only-diff.mjs HEAD   # 158 changed files — all comment-only
bun run test:comment-density              # ok — no pin rose; global figure printed
node --test scripts/check-comment-density-ratchet.test.mjs   # 10/10
bun run format:check                      # clean over 4,670 files
```

Files swept in Wave 1 (plus `scripts/comment-only-diff.mjs`,
`scripts/check-comment-density-ratchet.test.mjs`,
`tests/comment-density-ratchet.json`, and this receipt):

- `apps/desktop/src/main.ts`
- `apps/desktop/src/main/detached-gateway.ts`
- `apps/desktop/src/main/gateway-monitor-core.ts`
- `apps/desktop/src/main/gateway-monitor.ts`
- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/src/main/local-gateway.ts`
- `apps/desktop/src/main/preload-core.ts`
- `apps/desktop/src/main/settings.ts`
- `apps/desktop/tests/e2e/fixtures.ts`
- `apps/mobile/src/apps/insights/insights-model.ts`
- `apps/mobile/src/apps/photos/PhotoLightbox.tsx`
- `apps/mobile/src/apps/photos/PhotoLightboxChrome.tsx`
- `apps/mobile/src/apps/photos/PhotosHome.tsx`
- `apps/mobile/src/apps/photos/PhotosSearch.tsx`
- `apps/mobile/src/apps/photos/camera-roll-import.ts`
- `apps/mobile/src/apps/photos/memories-model.ts`
- `apps/mobile/src/apps/photos/people-model.ts`
- `apps/mobile/src/apps/photos/photo-access.ts`
- `apps/mobile/src/apps/photos/photo-edit-model.ts`
- `apps/mobile/src/apps/photos/photos-backup.ts`
- `apps/mobile/src/apps/photos/photos-band.ts`
- `apps/mobile/src/apps/photos/photos-collections.ts`
- `apps/mobile/src/apps/photos/photos-library-menu.ts`
- `apps/mobile/src/apps/photos/places-model.ts`
- `apps/mobile/src/apps/photos/search-hits.ts`
- `apps/mobile/src/apps/photos/tile-overlays.ts`
- `apps/mobile/src/apps/photos/timeline-grains.ts`
- `apps/mobile/src/apps/photos/viewer-menu.ts`
- `apps/mobile/src/apps/photos/viewer-model.ts`
- `apps/mobile/src/kit/components/AnchoredMenu.tsx`
- `apps/mobile/src/lib/gateway.ts`
- `apps/mobile/src/lib/vault-links.ts`
- `apps/mobile/src/navigation.ts`
- `apps/mobile/src/screens/Home.tsx`
- `apps/mobile/src/screens/home/HomeBand.tsx`
- `apps/mobile/src/screens/home/TileBody.tsx`
- `apps/mobile/src/screens/home/springboard-policy.ts`
- `apps/mobile/src/screens/home/tile-model.ts`
- `apps/web/tests/e2e/perf-waterfall.spec.ts`
- `packages/backup/src/engine.ts`
- `packages/backup/src/interop-clawgnition.test.ts`
- `packages/backup/src/provider.ts`
- `packages/backup/src/wal-format.ts`
- `packages/backup/src/wal-restore.ts`
- `packages/blueprints/apps/_shared/NavRail.tsx`
- `packages/blueprints/apps/_shared/scope-merge.ts`
- `packages/blueprints/apps/_shared/search-scaffold.ts`
- `packages/blueprints/apps/agenda/queries/upcoming.ts`
- `packages/blueprints/apps/docs/app-root.tsx`
- `packages/blueprints/apps/docs/drive-copy.ts`
- `packages/blueprints/apps/docs/format.ts`
- `packages/blueprints/apps/docs/queries/_shared.ts`
- `packages/blueprints/apps/docs/types.ts`
- `packages/blueprints/apps/docs/view-copy.ts`
- `packages/blueprints/apps/inline-types.ts`
- `packages/blueprints/apps/photos/app-root.tsx`
- `packages/blueprints/apps/photos/enrichment-consent.ts`
- `packages/blueprints/apps/photos/media.ts`
- `packages/blueprints/apps/photos/place-map.ts`
- `packages/blueprints/apps/photos/place-phrase.ts`
- `packages/blueprints/apps/photos/share-place.ts`
- `packages/blueprints/apps/photos/trips.ts`
- `packages/blueprints/apps/photos/upload.ts`
- `packages/blueprints/apps/photos/view-copy.ts`
- `packages/blueprints/apps/photos/viewer.ts`
- `packages/blueprints/src/app-boot-harness.ts`
- `packages/blueprints/src/clone.ts`
- `packages/client/src/enrich-policy.ts`
- `packages/client/src/gateway-client-conversation.ts`
- `packages/client/src/gateway-client.ts`
- `packages/client/src/home-copy.ts`
- `packages/client/src/react/blueprints/centraid-inline.ts`
- `packages/client/src/react/blueprints/inline-blob-images.ts`
- `packages/client/src/react/boot.tsx`
- `packages/client/src/react/screen-contracts.ts`
- `packages/client/src/react/screens/ApprovalsScreen.tsx`
- `packages/client/src/react/screens/atlasOrreryGeometry.ts`
- `packages/client/src/react/screens/atlasScreenModel.ts`
- `packages/client/src/react/shell/App.tsx`
- `packages/client/src/react/shell/Stem.tsx`
- `packages/client/src/react/shell/launcherModel.ts`
- `packages/client/src/react/shell/queryCache.ts`
- `packages/client/src/react/shell/routes/HomeRoute.tsx`
- `packages/client/src/react/shell/routes/automationThreadData.ts`
- `packages/client/src/react/shell/routes/homeTileContent.ts`
- `packages/client/src/react/shell/routes/homeTiles.ts`
- `packages/client/src/react/shell/useShellApps.ts`
- `packages/design/src/contrast.test.ts`
- `packages/design/src/density.ts`
- `packages/design/src/themes/shared.ts`
- `packages/design/src/typography.ts`
- `packages/server/src/acp/backends/acp/types.ts`
- `packages/server/src/acp/registry.ts`
- `packages/server/src/automation/fire/clock-adversity-cron.test.ts`
- `packages/server/src/automation/fire/enrich-gate.ts`
- `packages/server/src/automation/fire/enrich-resolve.ts`
- `packages/server/src/automation/fire/fire.ts`
- `packages/server/src/automation/handler/runner.ts`
- `packages/server/src/backup/backup-service.ts`
- `packages/server/src/backup/backup-sources.ts`
- `packages/server/src/backup/recover.ts`
- `packages/server/src/backup/restore-drill.ts`
- `packages/server/src/backup/wal.integration.test.ts`
- `packages/server/src/cli/endpoint-host.ts`
- `packages/server/src/engine/conversation/history.ts`
- `packages/server/src/engine/conversation/runner.ts`
- `packages/server/src/engine/conversation/schema.ts`
- `packages/server/src/engine/conversation/store.ts`
- `packages/server/src/engine/conversation/turn.ts`
- `packages/server/src/engine/http/http-server.ts`
- `packages/server/src/engine/http/turn-routes.ts`
- `packages/server/src/engine/index.ts`
- `packages/server/src/engine/registry/manifest.ts`
- `packages/server/src/engine/runtime.ts`
- `packages/server/src/engine/sandbox/policy.ts`
- `packages/server/src/engine/stores/gateway-db.ts`
- `packages/server/src/engine/worker/runner.ts`
- `packages/server/src/enrich/engine-profiles.ts`
- `packages/server/src/lifecycle/lifecycle-shared.ts`
- `packages/server/src/routes/harnesses-routes.ts`
- `packages/server/src/routes/vault-routes.ts`
- `packages/server/src/runs/unified-conversation-runner.ts`
- `packages/server/src/serve/build-gateway.ts`
- `packages/server/src/serve/diagnostics-redaction.ts`
- `packages/server/src/serve/gateway-log-store.ts`
- `packages/server/src/serve/hostile-peer.integration.test.ts`
- `packages/server/src/serve/vault-links-store.ts`
- `packages/server/src/serve/vault-plane.ts`
- `packages/server/src/serve/vault-registry.ts`
- `packages/server/src/worktree-store/worktree-store.ts`
- `packages/tunnel/src/peer-target-differential.test.ts`
- `packages/tunnel/src/protocol.ts`
- `packages/vault/src/blob/cache.ts`
- `packages/vault/src/blob/custody-rollup.ts`
- `packages/vault/src/blob/custody-types.ts`
- `packages/vault/src/blob/custody.ts`
- `packages/vault/src/blob/seal-frames.ts`
- `packages/vault/src/blob/store-routing.ts`
- `packages/vault/src/commands/enrich.ts`
- `packages/vault/src/commands/media.ts`
- `packages/vault/src/commands/sync.ts`
- `packages/vault/src/db.ts`
- `packages/vault/src/enrich/clusters.ts`
- `packages/vault/src/enrich/face-clusters.ts`
- `packages/vault/src/enrich/memories.ts`
- `packages/vault/src/gateway/duties.ts`
- `packages/vault/src/gateway/gateway.ts`
- `packages/vault/src/gateway/portable-export.ts`
- `packages/vault/src/gateway/types.ts`
- `packages/vault/src/grant/fulfillment.ts`
- `packages/vault/src/host.ts`
- `packages/vault/src/ingest/takeout-sidecar.ts`
- `packages/vault/src/journal-archive.ts`
- `packages/vault/src/share/closure.ts`
- `packages/vault/src/share/commons.ts`
- `packages/vault/src/share/placement.ts`
- `packages/vault/src/wal-shipper-detectors.test.ts`
- `packages/vault/src/wal-shipper.ts`

### Wave 2 — compression sweep, worklist ranks 161-320 (2026-08-25)

Eight worker sub-agents under the amended contract (JSX containers kept,
no block left empty, severity calibrated to the Wave 1 server batches).
Tree movement:

| Figure | after Wave 1 | after Wave 2 |
| --- | --- | --- |
| Global character share | 21.17% | **19.26%** |
| Global line density | 12.66% | **11.35%** |
| Files over the 15% cap | 1,906 | 1,791 |

Most files landed 11.9-13.0%. Residues above the cap are declaration/policy
leaves reported with their honest floors; nine graduated to the allowlist
(root ruling, reasons in the baseline): `consent-gate.ts`, `scope-kit.ts`,
`docs/document-copy.ts`, `opsBar.ts`, `homeSample.ts`, `design/palette.ts`,
`design/blocks/grid.ts`, `backup/backup-state.ts`, and `server/paths.ts`
(90.9% after honest compression — a path-slot registry whose omit-semantics
prose is the file's entire information content). Remaining non-allowlisted
residues stay on the re-pass worklist.

Proof-tool hardening continued: oxfmt's collapse of a one-line array dropped
a trailing comma, a third cosmetic false-positive class — the token
comparison now drops a `,` that immediately precedes a closing bracket, and
its join separator is an escaped NUL (a literal NUL byte had made the script
read as binary to grep). One stale-doc repair: `design/src/elements/attachments.ts`
is cited by docs/coding-standards.md as a model of the capitalized invariant
heading but carried none; its compressed header now leads with one.

Verification (Wave 2):

```sh
node scripts/comment-only-diff.mjs HEAD   # 160 changed files — all comment-only
bun run test:comment-density              # ok — no pin rose
node --test scripts/check-comment-density-ratchet.test.mjs   # 10/10
bun run lint && bun run format:check      # clean
```

Files swept in Wave 2 (plus `scripts/comment-only-diff.mjs`,
`tests/comment-density-ratchet.json`, and this receipt):

- `apps/desktop/src/main/app-sessions.ts`
- `apps/desktop/src/main/detached-gateway-core.ts`
- `apps/desktop/src/main/gateway-outage-log-core.ts`
- `apps/desktop/src/main/gateway-supervisor-core.ts`
- `apps/desktop/tests/e2e/onboarding-home.spec.ts`
- `apps/mobile/src/apps/automations/automations-model.ts`
- `apps/mobile/src/apps/docs/docs-copy.ts`
- `apps/mobile/src/apps/photos/MediaPage.tsx`
- `apps/mobile/src/apps/photos/PhotoLightbox.styles.ts`
- `apps/mobile/src/apps/photos/PhotoTimeline.tsx`
- `apps/mobile/src/apps/photos/PhotosBand.tsx`
- `apps/mobile/src/apps/photos/PhotosCollectionsView.tsx`
- `apps/mobile/src/apps/photos/PhotosScreen.tsx`
- `apps/mobile/src/apps/photos/PlacesMap.test.tsx`
- `apps/mobile/src/apps/photos/exif-location-strip.ts`
- `apps/mobile/src/apps/photos/photo-edit-save.ts`
- `apps/mobile/src/apps/photos/photo-share.ts`
- `apps/mobile/src/apps/photos/search-place-vocabulary.ts`
- `apps/mobile/src/kit/band-surface.ts`
- `apps/mobile/src/kit/replica/mount-plan.ts`
- `apps/mobile/src/kit/storage/free-up-space.ts`
- `apps/mobile/src/kit/transfer/transfer-policy.ts`
- `apps/mobile/src/kit/transfer/transfer-run.ts`
- `apps/mobile/src/lib/connection-reauth.ts`
- `apps/mobile/src/lib/devices.ts`
- `apps/mobile/src/screens/approvals/approvals-model.ts`
- `apps/mobile/src/screens/data/data-model.ts`
- `apps/mobile/src/screens/devices/devices-model.ts`
- `apps/mobile/src/screens/home/VaultHeader.tsx`
- `apps/mobile/src/screens/home/places.ts`
- `apps/web/src/iroh-transport.ts`
- `apps/web/tests/e2e/offline-search.spec.ts`
- `apps/web/vite.config.ts`
- `packages/backup/src/manifest.ts`
- `packages/backup/src/wal-restore.test.ts`
- `packages/blueprints/apps/_shared/consent-gate.ts`
- `packages/blueprints/apps/_shared/download-on-demand.ts`
- `packages/blueprints/apps/_shared/grant-plane.ts`
- `packages/blueprints/apps/_shared/scope-kit.ts`
- `packages/blueprints/apps/_shared/selection-engine.ts`
- `packages/blueprints/apps/_shared/share-kit.ts`
- `packages/blueprints/apps/_shared/triage-session.ts`
- `packages/blueprints/apps/agenda/queries/day-context.ts`
- `packages/blueprints/apps/agenda/views.ts`
- `packages/blueprints/apps/docs/Chrome.tsx`
- `packages/blueprints/apps/docs/components/FoldersRoute.tsx`
- `packages/blueprints/apps/docs/components/QuickLook.tsx`
- `packages/blueprints/apps/docs/document-copy.ts`
- `packages/blueprints/apps/docs/icons.ts`
- `packages/blueprints/apps/docs/logic.ts`
- `packages/blueprints/apps/docs/shelves.ts`
- `packages/blueprints/apps/people/people-copy.ts`
- `packages/blueprints/apps/people/types.ts`
- `packages/blueprints/apps/photos/Chrome.tsx`
- `packages/blueprints/apps/photos/components/FaceReview.tsx`
- `packages/blueprints/apps/photos/components/People.tsx`
- `packages/blueprints/apps/photos/components/Places.tsx`
- `packages/blueprints/apps/photos/components/SelectionBar.tsx`
- `packages/blueprints/apps/photos/duplicates.tsx`
- `packages/blueprints/apps/photos/faces.ts`
- `packages/blueprints/apps/photos/layout.ts`
- `packages/blueprints/apps/photos/library-store.ts`
- `packages/blueprints/apps/photos/nav-rail.ts`
- `packages/blueprints/apps/photos/queries/library.ts`
- `packages/blueprints/apps/photos/queries/people.ts`
- `packages/blueprints/apps/photos/search-groups.ts`
- `packages/blueprints/apps/photos/search.ts`
- `packages/blueprints/apps/photos/selection.tsx`
- `packages/blueprints/apps/photos/shared-copy.ts`
- `packages/blueprints/apps/photos/storage-model.ts`
- `packages/blueprints/apps/photos/types.ts`
- `packages/blueprints/src/app-states.test.ts`
- `packages/blueprints/src/handler-reachability.test.ts`
- `packages/blueprints/src/index.ts`
- `packages/blueprints/src/placement-registry.test.ts`
- `packages/blueprints/src/state-honesty.test.ts`
- `packages/blueprints/src/types.ts`
- `packages/client/src/app-shell-context.ts`
- `packages/client/src/gateway-client-conversation-history.ts`
- `packages/client/src/gateway-client-devices.ts`
- `packages/client/src/react/screens/AtlasScreen.tsx`
- `packages/client/src/react/screens/GatewayScreen.tsx`
- `packages/client/src/react/screens/HomeSpringboard.tsx`
- `packages/client/src/react/screens/HouseholdScreen.tsx`
- `packages/client/src/react/screens/resource-summary.ts`
- `packages/client/src/react/shell/ShellFrame.tsx`
- `packages/client/src/react/shell/gatewayRegistry.ts`
- `packages/client/src/react/shell/opsBar.ts`
- `packages/client/src/react/shell/routeVitals.ts`
- `packages/client/src/react/shell/routes/ApprovalsRoute.tsx`
- `packages/client/src/react/shell/routes/AssistantRoute.tsx`
- `packages/client/src/react/shell/routes/InlineAppRoute.tsx`
- `packages/client/src/react/shell/routes/SettingsRoute.tsx`
- `packages/client/src/react/shell/routes/automationsData.ts`
- `packages/client/src/react/shell/routes/homeSample.ts`
- `packages/client/src/react/shell/routes/paletteData.ts`
- `packages/client/src/react/shell/statusChannel.ts`
- `packages/client/src/storage-metrics.ts`
- `packages/client/src/turn-stream.ts`
- `packages/design/src/blocks/bars.ts`
- `packages/design/src/blocks/fixtures.ts`
- `packages/design/src/blocks/grid.ts`
- `packages/design/src/color.ts`
- `packages/design/src/elements/attachments.ts`
- `packages/design/src/icons-contract.test.ts`
- `packages/design/src/icons.ts`
- `packages/design/src/palette.ts`
- `packages/model-runtime/src/gazetteer.ts`
- `packages/model-runtime/src/onnx.ts`
- `packages/server/src/acp/automation/run-automation.ts`
- `packages/server/src/acp/backends/acp/session-config.ts`
- `packages/server/src/automation/fire/calendar-boundary-cron.test.ts`
- `packages/server/src/automation/fire/scheduler-ledger.ts`
- `packages/server/src/automation/fire/time-zoo-cron.test.ts`
- `packages/server/src/automation/handler/lint.ts`
- `packages/server/src/automation/index.ts`
- `packages/server/src/automation/scaffold/webhook.ts`
- `packages/server/src/backup/backup-state.ts`
- `packages/server/src/backup/recover-internals.ts`
- `packages/server/src/backup/wal-uploader.ts`
- `packages/server/src/doctor/integrity-checks.ts`
- `packages/server/src/engine/conversation/runner-core-types.ts`
- `packages/server/src/engine/handlers/dispatcher.ts`
- `packages/server/src/engine/handlers/worker-pool.ts`
- `packages/server/src/engine/http/changes-sse.ts`
- `packages/server/src/engine/http/turn-sse.ts`
- `packages/server/src/engine/sandbox/install.ts`
- `packages/server/src/enrich/capability-registry.ts`
- `packages/server/src/enrich/semantic-search.ts`
- `packages/server/src/paths.ts`
- `packages/server/src/provider-egress-dispatch.test.ts`
- `packages/server/src/routes/apps-store-routes.ts`
- `packages/server/src/routes/automations-routes.ts`
- `packages/server/src/routes/device-ticket-mint.ts`
- `packages/server/src/routes/devices-routes.ts`
- `packages/server/src/routes/lifecycle-routes.ts`
- `packages/server/src/routes/peer-plane.ts`
- `packages/server/src/routes/scopes-routes.ts`
- `packages/server/src/routes/storage-routes.ts`
- `packages/server/src/serve/grant-fulfillment.ts`
- `packages/server/src/serve/hardware-profile.ts`
- `packages/server/src/serve/local-usage.ts`
- `packages/server/src/serve/manifest-scope-denial.sweep.test-fixtures.ts`
- `packages/server/src/serve/protocol-join-lane.test.ts`
- `packages/test-kit/src/vitest.ts`
- `packages/tunnel/src/gateway-endpoint.ts`
- `packages/vault/src/blob/exif-fixtures.ts`
- `packages/vault/src/blob/preview.ts`
- `packages/vault/src/blob/s3.ts`
- `packages/vault/src/commands/media-gazetteer.ts`
- `packages/vault/src/enrich/derivation.ts`
- `packages/vault/src/enrich/model-id.ts`
- `packages/vault/src/enrich/policy.ts`
- `packages/vault/src/errors.ts`
- `packages/vault/src/gateway/execution.ts`
- `packages/vault/src/grant/grant-store.ts`
- `packages/vault/src/share/commons-replay.ts`
- `packages/vault/src/share/commons-sim-grant.test-fixtures.ts`
- `packages/vault/src/share/commons-sim.test.ts`
- `packages/vault/src/vault-footprint.ts`

### Wave 3a — partial sweep, paused on user request (2026-08-25)

The user paused the session mid-Wave 3 ("stop...we'll resume later"). The 8
sweep agents were halted; the 30 files they had already finished are integrated
here so the work survives the ephemeral container. The remaining ~146 Wave 3
files stay on the worklist for resumption.

| figure | after Wave 2 | after Wave 3a |
| --- | --- | --- |
| global character share | 19.26% | 19.00% |
| global line density | 11.35% | 11.18% |
| files over 15% cap | 1,791 | 1,769 |

Verification (all green before commit):

```
node scripts/comment-only-diff.mjs HEAD   # 30 changed file(s) — all comment-only
bun run format:check                      # clean after bun run format
bun run lint                              # oxlint --deny-warnings clean
node scripts/check-comment-density-ratchet.mjs --write && node scripts/check-comment-density-ratchet.mjs
# ok comment-density — no pin rose, no unpinned file over cap
```

No allowlist changes and no hand-raises in this partial wave; every touched pin
moved down. Files changed (full inventory):

- `apps/desktop/src/main/update-signature-core.ts`
- `apps/desktop/src/main/update-signature-gate.ts`
- `apps/desktop/tests/e2e/pending-overlay.spec.ts`
- `apps/mobile/src/kit/replica/replica-status.ts`
- `apps/mobile/src/kit/transfer/backup-verdict.ts`
- `apps/mobile/src/kit/transfer/transfer-consent.ts`
- `apps/mobile/src/lib/atlas.ts`
- `packages/blueprints/apps/_shared/grant-door.ts`
- `packages/blueprints/apps/_shared/shelves.ts`
- `packages/blueprints/apps/_shared/view-state-kit.ts`
- `packages/blueprints/apps/agenda/app-root.tsx`
- `packages/blueprints/apps/people/shelves.ts`
- `packages/blueprints/apps/photos/components/DuplicateReview.tsx`
- `packages/blueprints/apps/photos/components/Import.tsx`
- `packages/blueprints/src/photos-media.test.ts`
- `packages/blueprints/src/token-purity-allowlist.ts`
- `packages/client/src/approvals-copy.ts`
- `packages/client/src/assistant-rich.ts`
- `packages/client/src/react/shell/ShellApp.tsx`
- `packages/client/src/react/shell/routes/settingsEnrichmentData.ts`
- `packages/client/src/react/ui/Button.tsx`
- `packages/client/src/react/ui/DecideBlock.tsx`
- `packages/server/src/engine/handlers/handler-runner.ts`
- `packages/server/src/engine/http/compression.ts`
- `packages/server/src/engine/http/conversation-routes.ts`
- `packages/server/src/engine/model-pricing.ts`
- `packages/server/src/serve/resource-accounting.ts`
- `packages/server/src/serve/serve.ts`
- `packages/server/src/serve/share-coordinator.ts`
- `packages/server/src/serve/vault-context.ts`
- `tests/comment-density-ratchet.json`



### Wave 3b — remainder of Wave 3 (2026-08-25)

The 146 Wave 3 files the paused agents never reached, swept by 7 agents and
integrated in one pass. This completes Wave 3 (with Wave 3a above). Per the
user's directive the session stops after this wave; remaining work is listed
under "Remaining worklist" below.

| figure | after Wave 3a | after Wave 3b |
| --- | --- | --- |
| global character share | 19.00% | 17.68% |
| global line density | 11.18% | 10.27% |
| files over 15% cap | 1,769 | 1,647 |

Verification (all green before commit):

```
node scripts/comment-only-diff.mjs HEAD   # 146 changed file(s) — all comment-only
bun run format:check                      # clean after bun run format
bun run lint                              # oxlint --deny-warnings clean
node scripts/check-comment-density-ratchet.mjs --write && node scripts/check-comment-density-ratchet.mjs
# ok comment-density — no pin rose, no unpinned file over cap
```

Allowlist rulings (8 accepted, allowlist now 47 entries): sqlite-vec.ts
(security-rule battery), photos-collections-menu.ts (declaration-leaf policy),
automation/fire/host.ts (contract leaf), worktree-store/types.ts (declaration
leaf), people/grant-dashboard.ts (#825 ruling register), acp/spawn-env.ts
(PATH-shadowing rationale), vault/src/blob/store.ts (driver-contract leaf),
apps/web/tests/e2e/playwright.config.ts (config policy leaf). Nominated but
declined: apps/mobile/src/kit/fetch-gate/policy.ts — now under the 40-line
threshold, so the cap no longer applies; no entry needed.

Residues staying pinned above 13% without allowlist entries (load-bearing
floors, candidates for the residue re-pass): batch 4's small-code leaves
(outcomes.ts 34.8%, first-moves.ts 29.8%, appearance.ts 30.0%,
places-map-libre.tsx 29.7%, device-media.ts 24.1%, atlasSampleRows.ts 25.8%,
Blocks.tsx 21.7%, SearchShelf.tsx 22.4%, projection-ingest.ts 26.2%,
fulfillment-edit.ts 19.3%), batch 3's declaration/policy leaves (print.ts
36.2%, restore-warm.ts 33.0%, places-map-apple.tsx 23.5%, cbsf.ts 23.6%,
codec.ts 22.0%, commons-notices.ts 20.5%, commons-sim-grant-world
.test-fixtures.ts 21.0%), and link-party-bindings.ts 21.0%, Shared.tsx
(docs) 22.2%. All were pinned downward; none rose.

Known metric limitation reconfirmed (batch 4): JSX `{/* … */}` text counts as
code, not comment chars, so shortening a JSX comment shrinks the denominator
and can raise the measured share while the diff stays comment-only. Recorded
in the Wave 1 section; unchanged this wave.

Files changed (full inventory):

- `apps/mobile/src/apps/automations/useAutomations.ts`
- `apps/mobile/src/apps/docs/docs-band.ts`
- `apps/mobile/src/apps/docs/document-read-model.ts`
- `apps/mobile/src/apps/people/people-model.ts`
- `apps/mobile/src/apps/photos/FaceReview.tsx`
- `apps/mobile/src/apps/photos/TimelineGrainControl.tsx`
- `apps/mobile/src/apps/photos/device-media.ts`
- `apps/mobile/src/apps/photos/duplicate-clusters.ts`
- `apps/mobile/src/apps/photos/lightbox-gestures.ts`
- `apps/mobile/src/apps/photos/photos-collections-menu.ts`
- `apps/mobile/src/apps/photos/photos-more-router.test.ts`
- `apps/mobile/src/apps/photos/places-map-apple.tsx`
- `apps/mobile/src/apps/photos/places-map-libre.tsx`
- `apps/mobile/src/apps/photos/places-map-mode.ts`
- `apps/mobile/src/apps/photos/timeline-rows.ts`
- `apps/mobile/src/apps/photos/viewer-read-only-reason.test.ts`
- `apps/mobile/src/kit/band/band-owner.ts`
- `apps/mobile/src/kit/fetch-gate/policy.ts`
- `apps/mobile/src/kit/replica/ReplicaProvider.tsx`
- `apps/mobile/src/kit/replica/replica-mount.ts`
- `apps/mobile/src/lib/enrichment.ts`
- `apps/mobile/src/lib/phone-link.ts`
- `apps/mobile/src/lib/replica/op-sqlite-driver.ts`
- `apps/mobile/src/lib/replica/replica-read-pushdown.ts`
- `apps/mobile/src/lib/upload/cbsf.ts`
- `apps/mobile/src/screens/home/LauncherGrid.tsx`
- `apps/mobile/src/screens/home/first-moves.ts`
- `apps/mobile/src/screens/home/home-pins.ts`
- `apps/mobile/src/screens/home/search-model.ts`
- `apps/mobile/src/screens/home/useSpringboardTiles.ts`
- `apps/web/tests/e2e/offline-reconnect.spec.ts`
- `apps/web/tests/e2e/playwright.config.ts`
- `apps/web/tests/e2e/renderer-leak.spec.ts`
- `packages/backup/src/compress.ts`
- `packages/backup/src/crypto.ts`
- `packages/backup/src/wire-client.ts`
- `packages/blueprints/apps/_shared/grant-copy.ts`
- `packages/blueprints/apps/agenda/day-context.ts`
- `packages/blueprints/apps/agenda/format-locale.test.ts`
- `packages/blueprints/apps/docs/components/Blocks.tsx`
- `packages/blueprints/apps/docs/components/QuickLookStage.tsx`
- `packages/blueprints/apps/docs/components/Shared.tsx`
- `packages/blueprints/apps/docs/filters.ts`
- `packages/blueprints/apps/docs/frame.tsx`
- `packages/blueprints/apps/docs/nav-rail.ts`
- `packages/blueprints/apps/docs/print.ts`
- `packages/blueprints/apps/docs/queries/drive.ts`
- `packages/blueprints/apps/notes/format.ts`
- `packages/blueprints/apps/notes/logic.ts`
- `packages/blueprints/apps/notes/queries/library.ts`
- `packages/blueprints/apps/notes/send-to-tasks.ts`
- `packages/blueprints/apps/notes/view-copy.ts`
- `packages/blueprints/apps/people/components/Shared.tsx`
- `packages/blueprints/apps/people/grant-dashboard.ts`
- `packages/blueprints/apps/people/logic.ts`
- `packages/blueprints/apps/photos/components/Lightbox.tsx`
- `packages/blueprints/apps/photos/components/LightboxLocation.tsx`
- `packages/blueprints/apps/photos/components/LoadingGrid.tsx`
- `packages/blueprints/apps/photos/components/Picker.tsx`
- `packages/blueprints/apps/photos/components/PlaceMap.tsx`
- `packages/blueprints/apps/photos/components/SearchShelf.tsx`
- `packages/blueprints/apps/photos/components/Storage.tsx`
- `packages/blueprints/apps/photos/components/Tile.tsx`
- `packages/blueprints/apps/photos/components/Timeline.tsx`
- `packages/blueprints/apps/photos/components/Toolbar.tsx`
- `packages/blueprints/apps/photos/format.ts`
- `packages/blueprints/apps/photos/lightbox.tsx`
- `packages/blueprints/apps/photos/outcomes.ts`
- `packages/blueprints/apps/photos/people.ts`
- `packages/blueprints/apps/photos/queries/_shared.ts`
- `packages/blueprints/apps/photos/shelves.ts`
- `packages/blueprints/apps/photos/tile-state.ts`
- `packages/blueprints/apps/tasks/types.ts`
- `packages/blueprints/apps/tasks/view-copy.ts`
- `packages/client/src/gateway-client-connections.ts`
- `packages/client/src/gateway-client-editing.ts`
- `packages/client/src/gateway-client-links.ts`
- `packages/client/src/gateway-client-outbox.ts`
- `packages/client/src/gateway-client-vault-enrich.ts`
- `packages/client/src/gateway-client-vault.ts`
- `packages/client/src/react/screens/AtlasRelationsTab.tsx`
- `packages/client/src/react/screens/AutomationsOverviewScreen.tsx`
- `packages/client/src/react/screens/SettingsDiagnosticsScreen.tsx`
- `packages/client/src/react/screens/SettingsEnrichmentCapabilities.tsx`
- `packages/client/src/react/screens/atlasSampleRows.ts`
- `packages/client/src/react/screens/insights-model.ts`
- `packages/client/src/react/screens/localUsageView.ts`
- `packages/client/src/react/screens/privacyStores.ts`
- `packages/client/src/react/shell/appearance.ts`
- `packages/client/src/react/shell/capabilities.ts`
- `packages/client/src/react/shell/routes/approvalsPhrasing.ts`
- `packages/client/src/react/shell/routes/connectFlow-core.ts`
- `packages/client/src/replica/search.ts`
- `packages/core/src/time/time-zoo-zone-crossing.test.ts`
- `packages/design/src/css.ts`
- `packages/design/src/elements/feedback.ts`
- `packages/design/src/identity.ts`
- `packages/design/src/oklab.ts`
- `packages/server/src/acp/automation/run-automation-live-dispatch.ts`
- `packages/server/src/acp/backends/acp/enumerate-models.ts`
- `packages/server/src/acp/index.ts`
- `packages/server/src/acp/registry.test.ts`
- `packages/server/src/acp/spawn-env.ts`
- `packages/server/src/automation/fire/cron-cursor.ts`
- `packages/server/src/automation/fire/host.ts`
- `packages/server/src/automation/scaffold/scaffold.ts`
- `packages/server/src/automation/worker/runner.ts`
- `packages/server/src/backup/recover-reconcile.ts`
- `packages/server/src/backup/restore-warm.ts`
- `packages/server/src/cli/cli.ts`
- `packages/server/src/engine/sandbox/bundle-lane-conformance.test.ts`
- `packages/server/src/engine/sandbox/install.test.ts`
- `packages/server/src/engine/settings/settings-merge.ts`
- `packages/server/src/engine/stores/prefs-store.ts`
- `packages/server/src/enrich/sqlite-vec.ts`
- `packages/server/src/preview/codec.ts`
- `packages/server/src/routes/device-invitations.ts`
- `packages/server/src/routes/grant-routes.ts`
- `packages/server/src/routes/lifecycle-automation-routes.ts`
- `packages/server/src/routes/templates-routes.ts`
- `packages/server/src/routes/vault-links-routes.ts`
- `packages/server/src/serve/anomaly-ledger.ts`
- `packages/server/src/serve/commons-notices.ts`
- `packages/server/src/serve/disk-health.ts`
- `packages/server/src/serve/journal-limit.ts`
- `packages/server/src/serve/link-party-bindings.ts`
- `packages/server/src/serve/outbox-edit.ts`
- `packages/server/src/serve/peer-commons-sweep.ts`
- `packages/server/src/serve/vault-integrity-health.ts`
- `packages/server/src/serve/web-control-sessions.ts`
- `packages/server/src/serve/web-ui-server.ts`
- `packages/server/src/worktree-store/types.ts`
- `packages/vault/src/blob/local-orphan-sweep.ts`
- `packages/vault/src/blob/local.ts`
- `packages/vault/src/blob/read.ts`
- `packages/vault/src/blob/replica-index.ts`
- `packages/vault/src/blob/store.ts`
- `packages/vault/src/grant/fulfillment-edit.ts`
- `packages/vault/src/grant/fulfillment-invite.ts`
- `packages/vault/src/ingest/stage-file.ts`
- `packages/vault/src/ingest/staging.ts`
- `packages/vault/src/retention.ts`
- `packages/vault/src/share/commons-bootstrap.ts`
- `packages/vault/src/share/commons-sim-grant-world.test-fixtures.ts`
- `packages/vault/src/share/projection-ingest.ts`
- `packages/vault/src/vault-limit.ts`
- `tests/comment-density-ratchet.json`

### Wave 4 — compression sweep, 160 heaviest remaining files (2026-08-25)

Eight worker sub-agents, ownership-disjoint 20-file batches, worklist regenerated
from `measureTree` sorted by chars-over-cap, excluding the 47-entry allowlist
(pre-wave), `packages/vault/src/schema/**`, and classification-ratchet-pinned
files. Eligible over-cap worklist at dispatch: 1,570 files. This wave takes the
top 160 (including Wave 1-3 residues still over the cap). Root integration
restored three premature JSX closing `>` tokens (`PhotoStateView.tsx`
`<Pressable`, `PhotosHome.tsx` `<View`, `Editor.tsx` `<div`) that would have
been code; the proof is green only after that restore.

| figure | after Wave 3b | after Wave 4 |
| --- | --- | --- |
| global character share | 17.68% | **16.47%** |
| global line density | 10.27% | **9.44%** |
| files over 15% cap | 1,647 | 1,570 |

Of the 160 swept files (post-format measurement): 64 landed under 13%; 5 sit
13-15%; 83 remain cap-eligible above 15% as honest floors or leftover fat for
the residue re-pass; 8 dropped under the 40-line threshold (cap no longer
applies). Diff vs HEAD before this receipt: 2,353 insertions / 9,103 deletions.

Verification (all green before commit):

```
bun scripts/comment-only-diff.mjs HEAD   # 160 changed file(s) — all comment-only
bun run format && bun run format:check   # clean after oxfmt
bun run lint                             # oxlint --deny-warnings clean
bun scripts/check-comment-density-ratchet.mjs --write && bun scripts/check-comment-density-ratchet.mjs
# ok comment-density — no pin rose, no unpinned file over cap
```

Allowlist rulings (7 accepted, allowlist now 54 entries): grid-image.ts
(decode/cache contract leaf), image-cache.ts (platform cache-budget registry),
search-scaffold.ts (search-state combinator contract), archive/types.ts
(declaration-leaf archive contract), scope-merge.ts (k-way merge policy leaf),
capture-consent.ts (capture disclosure leaf), grant-audiences.ts (G-audience
policy leaf). Nominated but declined: navigation.ts, demo.ts,
no-inference-client.test.ts, snapshot-blob-roots.ts,
shell-var-resolution.test.ts, share-effects-retire.ts — remaining comments are
load-bearing on ordinary code, not a prose-is-the-payload registry. Nominated
but unnecessary because nbl fell under 40: nav-seat.ts, vault-workspace.ts,
fonts.ts, destinations.ts, video-scrub-strip.ts, band.ts, orphan-tombstone.ts,
grid-packing.ts.

Residues staying pinned above 13% without allowlist entries (candidates for the
residue re-pass): batch 1 leftover fat on photos/docs `app-root.tsx`,
`gateway.ts`, `sync.ts`, `wal-shipper-detectors.test.ts`, `PhotosHome.tsx`,
`commons.ts`; honest floors on `db.ts`, `duties.ts`, `media.ts`,
`navigation.ts`, `tile-model.ts`, and the batch 2-8 floors recorded in agent
reports (frame-sampler, view-state, useAppScopes, scope-fanout, people-band,
photo-edit-model, condition, blob-auth, vite.config, sql.ts, HomeKey,
status-line, HomeBand, etc.). All were pinned downward; none rose.

JSX comment containers rewritten in place, never deleted. Empty-catch one-line
directives kept where a sweep would have tripped oxlint `no-empty`.

Files changed (full inventory):

- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/src/main/update-watcher.ts`
- `apps/desktop/tests/e2e/household.spec.ts`
- `apps/desktop/tests/e2e/launch-time.spec.ts`
- `apps/desktop/vite.config.ts`
- `apps/mobile/App.tsx`
- `apps/mobile/src/apps/agenda/day-context.ts`
- `apps/mobile/src/apps/people/people-band.ts`
- `apps/mobile/src/apps/photos/PhotoEditor.tsx`
- `apps/mobile/src/apps/photos/PhotoGrainView.tsx`
- `apps/mobile/src/apps/photos/PhotoLightboxChrome.tsx`
- `apps/mobile/src/apps/photos/PhotoLightboxToolbar.tsx`
- `apps/mobile/src/apps/photos/PhotoStateView.tsx`
- `apps/mobile/src/apps/photos/PhotosHome.styles.ts`
- `apps/mobile/src/apps/photos/PhotosHome.tsx`
- `apps/mobile/src/apps/photos/PlacesRealMap.tsx`
- `apps/mobile/src/apps/photos/image-cache.ts`
- `apps/mobile/src/apps/photos/memories-model.ts`
- `apps/mobile/src/apps/photos/photo-edit-model.ts`
- `apps/mobile/src/apps/photos/photos-backup.ts`
- `apps/mobile/src/apps/photos/photos-band.test.ts`
- `apps/mobile/src/apps/photos/photos-collections.ts`
- `apps/mobile/src/apps/photos/photos-fixtures.ts`
- `apps/mobile/src/apps/photos/photos-selection-writes.ts`
- `apps/mobile/src/apps/photos/places-model.ts`
- `apps/mobile/src/apps/photos/search-hits.ts`
- `apps/mobile/src/apps/photos/video-scrub-strip.ts`
- `apps/mobile/src/kit/components/AnchoredMenu.tsx`
- `apps/mobile/src/kit/components/HomeKey.tsx`
- `apps/mobile/src/kit/components/status-line.ts`
- `apps/mobile/src/kit/fetch-gate/pin.ts`
- `apps/mobile/src/kit/media/grid-image.ts`
- `apps/mobile/src/kit/storage/custody-status.ts`
- `apps/mobile/src/lib/automations.ts`
- `apps/mobile/src/lib/connections.ts`
- `apps/mobile/src/lib/gateway.ts`
- `apps/mobile/src/lib/insights.ts`
- `apps/mobile/src/lib/perf/frame-sampler.ts`
- `apps/mobile/src/lib/upload/store.ts`
- `apps/mobile/src/lib/vault-links.ts`
- `apps/mobile/src/navigation.ts`
- `apps/mobile/src/screens/Home.tsx`
- `apps/mobile/src/screens/connectors/Connectors.tsx`
- `apps/mobile/src/screens/connectors/connectors-model.ts`
- `apps/mobile/src/screens/home/FirstMoves.tsx`
- `apps/mobile/src/screens/home/HomeBand.tsx`
- `apps/mobile/src/screens/home/TileBody.tsx`
- `apps/mobile/src/screens/home/band.ts`
- `apps/mobile/src/screens/home/grid-packing.ts`
- `apps/mobile/src/screens/home/tile-model.ts`
- `apps/web/tests/e2e/leak-probe.ts`
- `packages/backup/src/engine.test.ts`
- `packages/backup/src/local-provider.ts`
- `packages/backup/src/wal-restore.ts`
- `packages/blueprints/apps/_shared/GrantSheet.tsx`
- `packages/blueprints/apps/_shared/capture-consent.ts`
- `packages/blueprints/apps/_shared/grant-audiences.ts`
- `packages/blueprints/apps/_shared/nav-seat.ts`
- `packages/blueprints/apps/_shared/scope-merge.ts`
- `packages/blueprints/apps/_shared/search-scaffold.ts`
- `packages/blueprints/apps/agenda/view-copy.ts`
- `packages/blueprints/apps/docs/app-root.tsx`
- `packages/blueprints/apps/docs/format.ts`
- `packages/blueprints/apps/docs/queries/_shared.ts`
- `packages/blueprints/apps/docs/view-state.ts`
- `packages/blueprints/apps/notes/powerbox.ts`
- `packages/blueprints/apps/notes/shelves.ts`
- `packages/blueprints/apps/people/format.ts`
- `packages/blueprints/apps/people/queries/_shared.ts`
- `packages/blueprints/apps/photos/app-root.tsx`
- `packages/blueprints/apps/photos/components/Duplicates.tsx`
- `packages/blueprints/apps/photos/components/Editor.tsx`
- `packages/blueprints/apps/photos/components/LightboxInfo.tsx`
- `packages/blueprints/apps/photos/duplicate-decision.ts`
- `packages/blueprints/apps/photos/media.ts`
- `packages/blueprints/apps/photos/trash-actions.ts`
- `packages/blueprints/apps/photos/view-state.ts`
- `packages/blueprints/apps/tasks/Chrome.tsx`
- `packages/blueprints/apps/tasks/scope-fanout.ts`
- `packages/blueprints/src/app-rewrites.ts`
- `packages/blueprints/src/no-inference-client.test.ts`
- `packages/blueprints/src/photos-people.test.ts`
- `packages/client/src/app-format.ts`
- `packages/client/src/gateway-client-atlas.ts`
- `packages/client/src/gateway-client-automation-editing.ts`
- `packages/client/src/gateway-client-storage.ts`
- `packages/client/src/react/blueprints/blob-auth.ts`
- `packages/client/src/react/screens/AtlasKindsSection.tsx`
- `packages/client/src/react/screens/DevicesCard.tsx`
- `packages/client/src/react/screens/SettingsPickRow.tsx`
- `packages/client/src/react/screens/SettingsVaultScreen.tsx`
- `packages/client/src/react/screens/gatewayHeartbeat.ts`
- `packages/client/src/react/screens/vault-custody.ts`
- `packages/client/src/react/shell/StatusLine.tsx`
- `packages/client/src/react/shell/routes/settingsHarnessesData.ts`
- `packages/client/src/react/shell/routes/useAppScopes.ts`
- `packages/client/src/react/shell/useGatewayRuntime.ts`
- `packages/client/src/react/ui/BarsBlock.tsx`
- `packages/client/src/react/ui/states.tsx`
- `packages/client/src/replica/shell-session.ts`
- `packages/client/src/shell-var-resolution.test.ts`
- `packages/core/src/time/time-zoo-recurrence.test.ts`
- `packages/design/src/destinations.ts`
- `packages/design/src/fonts.ts`
- `packages/design/src/themes/centraid.ts`
- `packages/model-runtime/src/ocr-postprocess.ts`
- `packages/model-runtime/src/tokenizer.ts`
- `packages/server/src/acp/models/catalog-warmer.ts`
- `packages/server/src/acp/prompt-injection/harness.ts`
- `packages/server/src/acp/prompt-injection/red-team.test.ts`
- `packages/server/src/automation/fire/condition.ts`
- `packages/server/src/automation/fire/time-zoo-calendar.test.ts`
- `packages/server/src/automation/scaffold/app.ts`
- `packages/server/src/backup/backup-sources.test.ts`
- `packages/server/src/backup/backup.integration.test.ts`
- `packages/server/src/backup/restore-drill.integration.test.ts`
- `packages/server/src/backup/snapshot-blob-roots.ts`
- `packages/server/src/backup/storage-credentials.ts`
- `packages/server/src/backup/storage-usage.ts`
- `packages/server/src/engine/changes/change-bus.ts`
- `packages/server/src/engine/conversation/archive/types.ts`
- `packages/server/src/engine/conversation/rehydrate.ts`
- `packages/server/src/engine/conversation/runner-core.ts`
- `packages/server/src/engine/handlers/worker-admission.ts`
- `packages/server/src/engine/insights/analytics-store.ts`
- `packages/server/src/engine/stores/vault-workspace.ts`
- `packages/server/src/lifecycle/ext-band.ts`
- `packages/server/src/routes/route-helpers.ts`
- `packages/server/src/routes/vault-enrich-rules-routes.ts`
- `packages/server/src/serve/commons-observability.ts`
- `packages/server/src/serve/connection-broker.ts`
- `packages/server/src/serve/enrichment-health.ts`
- `packages/server/src/serve/outbox-executor.ts`
- `packages/server/src/serve/share-effects-retire.ts`
- `packages/server/src/serve/storage-limits.ts`
- `packages/server/src/serve/support-bundle.ts`
- `packages/server/src/serve/vault-link-row.ts`
- `packages/server/src/validate-manifest.ts`
- `packages/server/src/worktree-store/git.ts`
- `packages/vault/src/blob/custody-reconcile.ts`
- `packages/vault/src/blob/orphan-tombstone.ts`
- `packages/vault/src/commands/atlas.ts`
- `packages/vault/src/commands/enrich.ts`
- `packages/vault/src/commands/locker.ts`
- `packages/vault/src/commands/media.ts`
- `packages/vault/src/commands/sync.ts`
- `packages/vault/src/db.ts`
- `packages/vault/src/enrich/enrich.test.ts`
- `packages/vault/src/gateway/demo.ts`
- `packages/vault/src/gateway/duties.ts`
- `packages/vault/src/gateway/gateway.ts`
- `packages/vault/src/gateway/sql.ts`
- `packages/vault/src/grant/fulfillment.ts`
- `packages/vault/src/host.ts`
- `packages/vault/src/ingest/enrich-publishers.ts`
- `packages/vault/src/journal-archive.ts`
- `packages/vault/src/share/commons-routing.ts`
- `packages/vault/src/share/commons.ts`
- `packages/vault/src/share/party-vault-binding.ts`
- `packages/vault/src/wal-shipper-detectors.test.ts`
- `receipts/issue-861-comment-current-state.md`
- `tests/comment-density-ratchet.json`

### Remaining worklist

Eligible over-cap files after Wave 4 (allowlist / schema / classification
excluded): regenerate from `measureTree` sorted by chars-over-cap. Then:

1. Further sweep waves (~150 files x 8 agents) until the remaining worklist is
   small enough for a residue re-pass.
2. Residue re-pass: files that stopped at honest floors >13% — allowlist vs
   deeper cuts.
3. Schema wave (root-owned): over-cap files under `packages/vault/src/schema/`
   plus classification-ratchet-pinned files; re-pin fingerprints with an
   `approvedDeviation` note.
4. Final verification: `bun run check:pr` green, closing totals in this
   receipt, push.


### Wave 5 — compression sweep, 160 unswept files (2026-08-25)

Eight worker sub-agents, ownership-disjoint 20-file batches. Worklist regenerated
from `measureTree` sorted by chars-over-cap, preferring files never touched in
waves 1-4 (so already-swept honest floors are not re-chewed). Eligible unswept
at dispatch: 1,320. Root restored two premature JSX closing `>` tokens
(`frame.tsx` `<button`, `PersonGrants.tsx` `<Caption`) before the proof.

| figure | after Wave 4 | after Wave 5 |
| --- | --- | --- |
| global character share | 16.47% | **15.34%** |
| global line density | 9.44% | **8.70%** |
| files over 15% cap | 1,570 | 1,425 |

Verification (all green before commit):

```
bun scripts/comment-only-diff.mjs HEAD   # 160 changed file(s) — all comment-only
bun run format && bun run format:check
bun run lint
bun scripts/check-comment-density-ratchet.mjs --write && bun scripts/check-comment-density-ratchet.mjs
# ok comment-density — no pin rose, no unpinned file over cap
```

Allowlist rulings (1 accepted, allowlist now 55): `packages/core/src/protocol/capabilities.ts`
(protocol capability map; optional/absent-tolerant experimental-flag semantics
are the wire contract). Nominated but declined/unnecessary: placement-registry.ts
and several nbl<40 leaves (cap no longer applies); fake-clock.ts (warnings on
ordinary helpers, not a registry).

Residues above 13% that stay cap-eligible without allowlist (honest floors):
photos filters/media-observer/PlaceNaming, agenda Chrome/edits, egress-consent,
birthday-notifications, token-purity, docs capabilities, PhotoEditor.styles,
app-frame, fake-clock, skeleton-rows, focus-ring-contrast.test, crypto.ts
(required oxlint-disable). All pins moved down; none rose.

Files changed (full inventory):

- `apps/desktop/src/main/changelog-core.ts`
- `apps/desktop/src/main/gateway-monitor-notifications.test.ts`
- `apps/desktop/src/main/gateway-pairing-core.ts`
- `apps/desktop/src/main/ipc-core.ts`
- `apps/desktop/src/main/update-check.ts`
- `apps/desktop/src/preload.ts`
- `apps/mobile/src/apps/automations/Automations.tsx`
- `apps/mobile/src/apps/docs/docs-versions.ts`
- `apps/mobile/src/apps/docs/editor-outcome.ts`
- `apps/mobile/src/apps/insights/useInsights.ts`
- `apps/mobile/src/apps/photos/MemoriesView.tsx`
- `apps/mobile/src/apps/photos/PhotoEditor.styles.ts`
- `apps/mobile/src/apps/photos/PhotoPicker.tsx`
- `apps/mobile/src/apps/photos/PhotosPeopleView.tsx`
- `apps/mobile/src/apps/photos/PhotosScreen.test.tsx`
- `apps/mobile/src/apps/photos/photos-backup-copy.ts`
- `apps/mobile/src/apps/photos/photos-trash.ts`
- `apps/mobile/src/apps/photos/places-model.test.ts`
- `apps/mobile/src/apps/photos/share-place-call-sites.test.ts`
- `apps/mobile/src/apps/photos/skeleton-rows.ts`
- `apps/mobile/src/apps/photos/timeline-model.ts`
- `apps/mobile/src/apps/photos/video-scrub-strip-native.ts`
- `apps/mobile/src/kit/components/RowsBlock.tsx`
- `apps/mobile/src/kit/media/use-image-fallback.ts`
- `apps/mobile/src/kit/share/GrantSheet.tsx`
- `apps/mobile/src/lib/birthday-notifications.ts`
- `apps/mobile/src/lib/replica/mobile-gateway-compatibility.ts`
- `apps/mobile/src/lib/replica/op-sqlite-build-config.test.ts`
- `apps/mobile/src/lib/upload/boot.ts`
- `apps/mobile/src/lib/upload/crypto.ts`
- `apps/mobile/src/screens/BackupHealth.custody.tsx`
- `apps/mobile/src/screens/data/useData.ts`
- `apps/mobile/src/screens/home/SearchOverlay.tsx`
- `apps/mobile/src/screens/home/catalog.ts`
- `apps/mobile/src/screens/home/home-status.ts`
- `apps/web/tests/e2e/app-card-logical-insets.spec.ts`
- `packages/backup/src/testing/s3-test-server.ts`
- `packages/blueprints/apps/_shared/SearchScaffold.tsx`
- `packages/blueprints/apps/_shared/app-frame.tsx`
- `packages/blueprints/apps/_shared/placement-registry.ts`
- `packages/blueprints/apps/_shared/write-target.ts`
- `packages/blueprints/apps/agenda/Chrome.tsx`
- `packages/blueprints/apps/agenda/edits.ts`
- `packages/blueprints/apps/agenda/format.ts`
- `packages/blueprints/apps/agenda/logic.ts`
- `packages/blueprints/apps/docs/capabilities.ts`
- `packages/blueprints/apps/docs/components/Breadcrumb.tsx`
- `packages/blueprints/apps/locker/logic.ts`
- `packages/blueprints/apps/notes/Chrome.tsx`
- `packages/blueprints/apps/notes/logic.test-fixtures.ts`
- `packages/blueprints/apps/people/app-root.tsx`
- `packages/blueprints/apps/people/components/PersonGrants.tsx`
- `packages/blueprints/apps/people/writes.ts`
- `packages/blueprints/apps/photos/asset-key.ts`
- `packages/blueprints/apps/photos/components/AlbumBar.tsx`
- `packages/blueprints/apps/photos/components/Memories.tsx`
- `packages/blueprints/apps/photos/components/PlaceMap.test.tsx`
- `packages/blueprints/apps/photos/components/PlaceNaming.tsx`
- `packages/blueprints/apps/photos/components/ViewerActions.tsx`
- `packages/blueprints/apps/photos/components/ViewerStage.tsx`
- `packages/blueprints/apps/photos/filters.ts`
- `packages/blueprints/apps/photos/frame.tsx`
- `packages/blueprints/apps/photos/grouping.ts`
- `packages/blueprints/apps/photos/media-observer.ts`
- `packages/blueprints/apps/photos/member-prefs.ts`
- `packages/blueprints/apps/photos/queries/face-queue.ts`
- `packages/blueprints/apps/photos/queries/storage.ts`
- `packages/blueprints/apps/photos/selection-actions.ts`
- `packages/blueprints/apps/photos/visibility.ts`
- `packages/blueprints/apps/tasks/shelves.ts`
- `packages/blueprints/apps/tasks/when.ts`
- `packages/blueprints/src/photos-editor-guard.test.ts`
- `packages/blueprints/src/photos-face-review.test.ts`
- `packages/blueprints/src/photos-view-state.test.ts`
- `packages/client/src/gateway-client-backup.ts`
- `packages/client/src/gateway-client-core.ts`
- `packages/client/src/gfm.ts`
- `packages/client/src/react/blueprints/inlineQueryCtx.ts`
- `packages/client/src/react/screens/AutomationCompilePane.tsx`
- `packages/client/src/react/screens/GatewayServiceTip.tsx`
- `packages/client/src/react/screens/LogsScreen.tsx`
- `packages/client/src/react/screens/SettingsEnrichmentScreen.tsx`
- `packages/client/src/react/screens/StorageLimitsPanel.tsx`
- `packages/client/src/react/screens/VaultFootprintRows.tsx`
- `packages/client/src/react/screens/atlasOrreryMotion.ts`
- `packages/client/src/react/screens/backupMetrics.ts`
- `packages/client/src/react/screens/composerMentions.ts`
- `packages/client/src/react/screens/transcriptWindow.ts`
- `packages/client/src/react/shell/App.test.tsx`
- `packages/client/src/react/shell/commitAvailability.tsx`
- `packages/client/src/react/shell/inlineFrame.ts`
- `packages/client/src/react/shell/routes/VaultRoute.tsx`
- `packages/client/src/react/shell/routes/appSettingsData.ts`
- `packages/client/src/react/shell/routes/assistantProjection.ts`
- `packages/client/src/react/shell/routes/automationEditorData.ts`
- `packages/client/src/react/shell/routes/connectFlowIO.ts`
- `packages/client/src/react/shell/routes/homeConditions.ts`
- `packages/client/src/react/shell/routes/inlineAppFrame.tsx`
- `packages/client/src/react/shell/routes/settingsAccountData.ts`
- `packages/client/src/react/shell/routes/templatesData.ts`
- `packages/client/src/react/shell/useCapabilities.tsx`
- `packages/client/src/react/shell/useOwnerScopes.ts`
- `packages/client/src/react/ui/GridBlock.tsx`
- `packages/client/src/react/ui/MeterRows.tsx`
- `packages/client/src/react/ui/RowsBlock.tsx`
- `packages/client/src/surface-copy.ts`
- `packages/core/src/protocol/capabilities.ts`
- `packages/core/src/protocol/routes.ts`
- `packages/core/src/protocol/version.ts`
- `packages/design/src/contrast-shell-palette.test.ts`
- `packages/design/src/css-vars.ts`
- `packages/design/src/elements/host.ts`
- `packages/design/src/elements/refresh.ts`
- `packages/design/src/focus-ring-contrast.test.ts`
- `packages/model-runtime/src/face-geometry.ts`
- `packages/server/src/acp/conversation-driver.ts`
- `packages/server/src/acp/multimodal.ts`
- `packages/server/src/acp/preflight.ts`
- `packages/server/src/cli/backup-admin.ts`
- `packages/server/src/cli/landlord-auth.ts`
- `packages/server/src/cli/service-unit.ts`
- `packages/server/src/engine/conversation/auto-title.ts`
- `packages/server/src/engine/conversation/reprice.ts`
- `packages/server/src/engine/conversation/store-sql.ts`
- `packages/server/src/engine/data/blob-store.ts`
- `packages/server/src/engine/handlers/handler-runner.contract.test.ts`
- `packages/server/src/engine/handlers/vault-bridge.ts`
- `packages/server/src/engine/http/request-boundary.ts`
- `packages/server/src/engine/http/router.ts`
- `packages/server/src/engine/http/sse-stream.ts`
- `packages/server/src/engine/registry/token-purity.ts`
- `packages/server/src/engine/sandbox/confined-fs.test.ts`
- `packages/server/src/enrich/egress-consent-lookup.ts`
- `packages/server/src/lifecycle/automation-turn-context.ts`
- `packages/server/src/lifecycle/lifecycle-over-http.test.ts`
- `packages/server/src/routes/demo-routes.ts`
- `packages/server/src/routes/enrich-search-routes.ts`
- `packages/server/src/runs/assistant-conversation-runner.ts`
- `packages/server/src/serve/commons-recovery-invites.ts`
- `packages/server/src/serve/enrich-tier-control.test.ts`
- `packages/server/src/serve/gateway-db.ts`
- `packages/server/src/serve/peer-commons-client.ts`
- `packages/server/src/serve/peer-dial.ts`
- `packages/server/src/serve/peer-route-announce.ts`
- `packages/server/src/serve/power-context.ts`
- `packages/server/src/serve/route-latency.ts`
- `packages/test-kit/src/fake-clock.ts`
- `packages/vault/src/backup-policy.ts`
- `packages/vault/src/blob/custody-state.ts`
- `packages/vault/src/commands/attachments.ts`
- `packages/vault/src/enrich/egress-consent.ts`
- `packages/vault/src/enrich/policy-rules.ts`
- `packages/vault/src/gateway/consent.ts`
- `packages/vault/src/gateway/custody.ts`
- `packages/vault/src/gateway/share-grant-seam.test.ts`
- `packages/vault/src/ingest/publishers.ts`
- `packages/vault/src/share/blobs.ts`
- `packages/vault/src/share/commons-recovery.ts`
- `packages/vault/src/share/commons-sim-world.test-fixtures.ts`
- `packages/vault/src/share/project-closure.ts`
- `receipts/issue-861-comment-current-state.md`
- `tests/comment-density-ratchet.json`



### Wave 6 — compression sweep, 160 heaviest remaining files (2026-08-25)

Eight worker sub-agents, ownership-disjoint 20-file batches (one batch
re-dispatched after a provider failure; one batch split after a mid-flight
connection loss — its 11 already-edited files kept, the remaining 9 re-swept).
Worklist regenerated from `measureTree` sorted by chars-over-cap: 1,340
eligible at dispatch. Root restored four code changes the proof caught before
formatting: a deleted `rebuildMemories(this.db.vault)` call (`gateway.ts`), a
deleted JSX `{/* */}` container (`places-pin.tsx`), a deleted
`delete?: string;` interface member (`doc-table.ts`), and three lines inside a
template literal that only look like comments but are harness-script content
(`app-navigation-rail.spec.ts`) — all restored verbatim; lint also forced back
the required `@yields` tag on `parts.ts`.

A residue re-pass (three workers, 12 files) then cut every file a first agent
had nominated for the allowlist below 15% instead — no allowlist entries were
added this wave (allowlist stays 55).

| figure | after Wave 5 | after Wave 6 |
| --- | --- | --- |
| global character share | 15.34% | **14.59%** |
| global line density | 8.70% | **8.20%** |
| files over 15% cap | 1,425 | 1,359 |

Verification (all green before commit):

```
node scripts/comment-only-diff.mjs HEAD   # 159 changed file(s) — all comment-only
bun run format && bun run format:check    # proof re-run green after formatting
bun run lint                              # clean (after @yields restore)
node scripts/check-comment-density-ratchet.mjs --write
node scripts/check-comment-density-ratchet.mjs
# ok comment-density — no pin rose, no unpinned file over cap
```

Allowlist rulings (0 accepted): twelve nominations arrived
(app-paths.ts, skeleton.ts, replicate-driver.ts, doc-table.ts,
power-context-push.ts, member-prefs.ts, enumerators.ts, json-cli.ts,
permissions.ts, distribution.ts, SectionBlock.tsx, gateway-auth.ts,
atlasBrowseData.ts, wal-address.test-fixtures.ts, db.ts, scan-consent.ts,
fetch-gate/index.ts, wal-shipper-clone.test.ts, ops-state.ts, replica/store.ts,
gateway-client-owners.ts, parts.ts) — ten of them are under 40 non-blank lines
(cap-ineligible, nothing to exempt); the other twelve went through the residue
re-pass and landed 11.6–14.4%, so no exemption was needed.

Residues above 13% that stay cap-eligible (honest floors, 129 files): the
largest are justify.ts (41%), conditional-fetch.ts (38%), notes/people
frame.tsx (~36%), face-review-queue.ts (32%), journal-stores.ts (31%),
edges-reconcile.ts (30%), evict.ts (28%), support-bundle-source.ts /
icons.tsx / EnrichmentConsent.tsx / BarsBlock.styles.ts (~28%) — per-agent
adjudication: each survivor names a prohibition or issue-referenced constraint;
deeper cuts delete real guardrails.

Files changed (full inventory):

- `apps/desktop/src/main/changelog.ts`
- `apps/desktop/src/main/gateway-connectivity-core.ts`
- `apps/desktop/src/main/gateway-monitor.ts`
- `apps/desktop/src/main/local-gateway.test.ts`
- `apps/desktop/src/main/local-gateway.ts`
- `apps/desktop/src/main/power-context-push.ts`
- `apps/desktop/src/main/settings.ts`
- `apps/mobile/modules/centraid-tunnel/index.ts`
- `apps/mobile/src/apps/docs/useDocsGrantAudiences.ts`
- `apps/mobile/src/apps/photos/EnrichmentConsent.tsx`
- `apps/mobile/src/apps/photos/PhotoInfoSheet.tsx`
- `apps/mobile/src/apps/photos/PhotosCollectionsView.test.tsx`
- `apps/mobile/src/apps/photos/PlacesMap.tsx`
- `apps/mobile/src/apps/photos/camera-roll-import.ts`
- `apps/mobile/src/apps/photos/face-review-queue.ts`
- `apps/mobile/src/apps/photos/justify.ts`
- `apps/mobile/src/apps/photos/people-model.ts`
- `apps/mobile/src/apps/photos/photo-access.ts`
- `apps/mobile/src/apps/photos/photo-grants.ts`
- `apps/mobile/src/apps/photos/photos-rungs.ts`
- `apps/mobile/src/apps/photos/pinned-thumbnails.ts`
- `apps/mobile/src/apps/photos/places-pin.tsx`
- `apps/mobile/src/apps/photos/viewer-export.ts`
- `apps/mobile/src/apps/tasks/tasks-band.ts`
- `apps/mobile/src/kit/components/BarsBlock.styles.ts`
- `apps/mobile/src/kit/components/PanelBlock.tsx`
- `apps/mobile/src/kit/components/TopSafeArea.tsx`
- `apps/mobile/src/kit/fetch-gate/index.ts`
- `apps/mobile/src/lib/conditional-fetch.ts`
- `apps/mobile/src/lib/upload/store-migrations.ts`
- `apps/mobile/src/lib/upload/uploader.ts`
- `apps/mobile/src/screens/approvals/useApprovals.ts`
- `apps/mobile/src/screens/connectors/useConnectors.ts`
- `apps/mobile/src/screens/devices/Devices.tsx`
- `apps/mobile/src/screens/home/blueprint-search.ts`
- `apps/mobile/src/screens/scan-consent.ts`
- `apps/mobile/src/screens/settings/EnrichmentSection.tsx`
- `apps/web/tests/e2e/app-navigation-rail.spec.ts`
- `apps/web/tests/e2e/photos-grants.spec.ts`
- `apps/web/tests/e2e/rebuilt-apps.spec.ts`
- `packages/backup/src/parts.ts`
- `packages/backup/src/recovery-kit.ts`
- `packages/backup/src/wal-address.test-fixtures.ts`
- `packages/blueprints/apps/_shared/NavRail.tsx`
- `packages/blueprints/apps/_shared/journal-scheme.ts`
- `packages/blueprints/apps/agenda/day-context-copy.ts`
- `packages/blueprints/apps/agenda/logic.test-fixtures.ts`
- `packages/blueprints/apps/agenda/member-prefs.ts`
- `packages/blueprints/apps/agenda/queries/upcoming.ts`
- `packages/blueprints/apps/agenda/types.ts`
- `packages/blueprints/apps/docs/app-root.tsx`
- `packages/blueprints/apps/docs/components/BulkBar.tsx`
- `packages/blueprints/apps/docs/components/DriveRoute.tsx`
- `packages/blueprints/apps/docs/components/QuickLookInfo.tsx`
- `packages/blueprints/apps/docs/components/RowStateSlot.tsx`
- `packages/blueprints/apps/docs/components/SearchField.tsx`
- `packages/blueprints/apps/docs/components/SeatStates.tsx`
- `packages/blueprints/apps/docs/folder-counts.ts`
- `packages/blueprints/apps/docs/kind-colours.test.ts`
- `packages/blueprints/apps/docs/popovers.ts`
- `packages/blueprints/apps/locker/app-root.tsx`
- `packages/blueprints/apps/notes/frame.tsx`
- `packages/blueprints/apps/notes/types.ts`
- `packages/blueprints/apps/people/components/EditRoute.tsx`
- `packages/blueprints/apps/people/components/PersonRoute.tsx`
- `packages/blueprints/apps/people/components/RosterRoute.tsx`
- `packages/blueprints/apps/people/frame.tsx`
- `packages/blueprints/apps/photos/app-root.tsx`
- `packages/blueprints/apps/photos/components/AlbumGrid.tsx`
- `packages/blueprints/apps/photos/enrichment-consent.test.ts`
- `packages/blueprints/apps/photos/grant-audiences.ts`
- `packages/blueprints/apps/photos/icons.tsx`
- `packages/blueprints/apps/photos/library-reads.ts`
- `packages/blueprints/apps/photos/memories.ts`
- `packages/blueprints/apps/photos/place-map.test.ts`
- `packages/blueprints/apps/tasks/format.ts`
- `packages/blueprints/apps/tasks/logic.ts`
- `packages/blueprints/src/blueprint-seats.test.ts`
- `packages/blueprints/src/photos-faces.test.ts`
- `packages/blueprints/src/photos-shelves-v4.test.ts`
- `packages/blueprints/src/photos-vocabulary.test.ts`
- `packages/client/src/device-enrichment-compute.ts`
- `packages/client/src/format.ts`
- `packages/client/src/gateway-auth.ts`
- `packages/client/src/gateway-client-edges.ts`
- `packages/client/src/gateway-client-local-storage.ts`
- `packages/client/src/gateway-client-owners.ts`
- `packages/client/src/react/screens/AtlasOrreryChart.tsx`
- `packages/client/src/react/screens/AtlasRecordsSection.tsx`
- `packages/client/src/react/screens/SettingsHarnessLanes.tsx`
- `packages/client/src/react/screens/atlasBrowseData.ts`
- `packages/client/src/react/screens/device-groups.ts`
- `packages/client/src/react/shell/AppBand.tsx`
- `packages/client/src/react/shell/gatewaySwitcher.ts`
- `packages/client/src/react/shell/launcherModel.test.ts`
- `packages/client/src/react/shell/routes/approvalsData.ts`
- `packages/client/src/react/shell/routes/settingsConnectionsData.ts`
- `packages/client/src/react/ui/SectionBlock.tsx`
- `packages/client/src/replica/store.ts`
- `packages/design/src/blocks/distribution.ts`
- `packages/design/src/blocks/doc-table.ts`
- `packages/design/src/blocks/ops-state.ts`
- `packages/design/src/blocks/skeleton.ts`
- `packages/design/src/elements/popover.ts`
- `packages/design/src/font-faces.ts`
- `packages/design/src/native-contract.test.ts`
- `packages/design/src/tile.ts`
- `packages/model-runtime/src/image-geometry.ts`
- `packages/model-runtime/src/preprocess.ts`
- `packages/server/src/acp/backends/acp/harness-errors.ts`
- `packages/server/src/acp/backends/acp/launch.ts`
- `packages/server/src/acp/backends/acp/permissions.ts`
- `packages/server/src/acp/models/enumerators.ts`
- `packages/server/src/acp/models/tiers.ts`
- `packages/server/src/automation/fire/enrich-gate.ts`
- `packages/server/src/automation/fire/enrich-resolve.ts`
- `packages/server/src/backup/storage.integration.test.ts`
- `packages/server/src/cli/json-cli.ts`
- `packages/server/src/engine/conversation/archive/selector.ts`
- `packages/server/src/engine/registry/app-paths.ts`
- `packages/server/src/engine/settings/app-settings.ts`
- `packages/server/src/index.ts`
- `packages/server/src/journal-stores.ts`
- `packages/server/src/routes/edges-reconcile.ts`
- `packages/server/src/routes/edges-routes.ts`
- `packages/server/src/routes/gateway-info-routes.ts`
- `packages/server/src/serve/build-gateway.test.ts`
- `packages/server/src/serve/host-limits.ts`
- `packages/server/src/serve/peer-route-assertion.ts`
- `packages/server/src/serve/resource-evidence.ts`
- `packages/server/src/serve/resource-mode.ts`
- `packages/server/src/serve/scheduler-health.ts`
- `packages/server/src/serve/support-bundle-source.ts`
- `packages/server/src/serve/trigger-ingress-cursor.ts`
- `packages/server/src/serve/vault-quarantine.ts`
- `packages/server/src/serve/vault-registry.test.ts`
- `packages/server/src/worktree-store/remote.ts`
- `packages/test-kit/src/vault.ts`
- `packages/vault/src/blob/evict.ts`
- `packages/vault/src/blob/pipeline.ts`
- `packages/vault/src/blob/replicate-driver.ts`
- `packages/vault/src/blob/staging.ts`
- `packages/vault/src/commands/flags.ts`
- `packages/vault/src/commands/inline-body-guard.ts`
- `packages/vault/src/commands/links.ts`
- `packages/vault/src/commands/sync.ts`
- `packages/vault/src/db.ts`
- `packages/vault/src/enrich/clusters.ts`
- `packages/vault/src/enrich/face-clusters.ts`
- `packages/vault/src/enrich/leases.ts`
- `packages/vault/src/gateway/duties.ts`
- `packages/vault/src/gateway/gateway.ts`
- `packages/vault/src/gateway/reseal.ts`
- `packages/vault/src/ingest/takeout-sidecar.ts`
- `packages/vault/src/restore-check.ts`
- `packages/vault/src/scope-extent.ts`
- `packages/vault/src/share/commons.ts`
- `packages/vault/src/wal-shipper-clone.test.ts`
- `packages/vault/src/wal-shipper-detectors.test.ts`
- `tests/comment-density-ratchet.json`


### Wave 7 — compression sweep, 160 untouched over-cap files (2026-08-26)

Eight worker sub-agents on ownership-disjoint 20-file batches (worklist: the
1,274 eligible over-cap files, 160 heaviest never touched by waves 1–6). The
provider connection dropped mid-wave repeatedly; re-dispatched remainders
completed the sweep, and a six-worker completion pass re-cut every file still
above cap (85 at pass start) below 15%. Two files the proof caught with real
code changes — a deleted JSX `{/* */}` container and a deleted prop+button in
`Details.tsx`/`tasks/frame.tsx` — were restored byte-identical to HEAD, and
their two pins hand-restored to the HEAD values with this deviation note:
#861 wave-7 sweep revert — Details.tsx and tasks/frame.tsx were returned to
their HEAD bytes after a worker deleted JSX containers/code lines, so their
governed density pins are restored to the same logic at HEAD's exact ratio.
No other pin rose.

| figure | after Wave 6 | after Wave 7 |
| --- | --- | --- |
| global character share | 14.59% | **13.90%** |
| global line density | 8.20% | **7.75%** |
| files over 15% cap | 1,359 | 1,227 |

Verification (all green before commit):

```
node scripts/comment-only-diff.mjs HEAD   # 158 changed file(s) — all comment-only
bun run format && bun run format:check    # proof re-run green after formatting
bun run lint                              # clean
node scripts/check-comment-density-ratchet.mjs   # ok — no pin rose
```

Allowlist rulings (0 accepted). Nominated but unnecessary/declined:
update-rollout-core.ts and themes/index.ts (directive-floor tiny files, both
landed under 15% anyway).

Residues above 13% are honest floors per worker adjudication (prohibitions,
issue-referenced constraints, protected pragmas).

Files changed (full inventory):

- `apps/desktop/src/main/gateway-ops-core.ts`
- `apps/desktop/src/main/gateway-outage-log.ts`
- `apps/desktop/src/main/settings-merge.ts`
- `apps/desktop/src/main/update-rollout-core.ts`
- `apps/desktop/tests/e2e/appview-templates-insights.spec.ts`
- `apps/desktop/tests/e2e/playwright.config.ts`
- `apps/mobile/app.config.ts`
- `apps/mobile/src/apps/agenda/agenda-band.ts`
- `apps/mobile/src/apps/docs/DocsScreen.tsx`
- `apps/mobile/src/apps/docs/docs-projection.ts`
- `apps/mobile/src/apps/insights/insights-window-pref.ts`
- `apps/mobile/src/apps/people/PeopleScreen.tsx`
- `apps/mobile/src/apps/photos/PhotoAccessPanel.tsx`
- `apps/mobile/src/apps/photos/PhotosGridSkeleton.tsx`
- `apps/mobile/src/apps/photos/PhotosPeopleView.test.tsx`
- `apps/mobile/src/apps/photos/PlaceDetail.tsx`
- `apps/mobile/src/apps/photos/PlacesSketchMap.tsx`
- `apps/mobile/src/apps/photos/PlacesView.tsx`
- `apps/mobile/src/apps/photos/camera-roll-import-run.ts`
- `apps/mobile/src/apps/photos/exif-location-strip.test.ts`
- `apps/mobile/src/apps/photos/photo-edit-gestures.ts`
- `apps/mobile/src/apps/photos/timeline-10k-one-day.test.ts`
- `apps/mobile/src/apps/photos/timeline-engine.ts`
- `apps/mobile/src/apps/photos/use-photo-selection-share.ts`
- `apps/mobile/src/kit/band/band-owner.test.ts`
- `apps/mobile/src/kit/components/BarsBlock.tsx`
- `apps/mobile/src/kit/components/DocTable.tsx`
- `apps/mobile/src/kit/components/icon-resolver.sweep.test.ts`
- `apps/mobile/src/kit/fetch-gate/FetchChoice.tsx`
- `apps/mobile/src/kit/perf/FrameProbe.tsx`
- `apps/mobile/src/kit/transfer/transfer-queue.ts`
- `apps/mobile/src/lib/decision-detail.ts`
- `apps/mobile/src/lib/profile.ts`
- `apps/mobile/src/lib/replica/links-transport.ts`
- `apps/mobile/src/lib/replica/mobile-gateway-compatibility-core.ts`
- `apps/mobile/src/lib/replica/node-sqlite-driver.jsdom.test.ts`
- `apps/mobile/src/screens/Approvals.tsx`
- `apps/mobile/src/screens/connectors/Connectors.test.tsx`
- `apps/mobile/src/screens/home/AllAppsSheet.tsx`
- `apps/mobile/src/screens/home/HomeTitleRow.tsx`
- `apps/mobile/src/screens/home/band.test.ts`
- `apps/mobile/src/screens/home/useSearchRecents.ts`
- `apps/mobile/src/test/react-native-stub.tsx`
- `apps/mobile/test/fixtures/fake-direct-transfer.ts`
- `apps/web/tests/e2e/people.spec.ts`
- `packages/backup/src/materialize.ts`
- `packages/blueprints/apps/_shared/ScopeChips.tsx`
- `packages/blueprints/apps/_shared/face-crop.ts`
- `packages/blueprints/apps/agenda/components/Shared.tsx`
- `packages/blueprints/apps/agenda/frame.tsx`
- `packages/blueprints/apps/docs/components/EmptyState.tsx`
- `packages/blueprints/apps/docs/components/InfoToggle.tsx`
- `packages/blueprints/apps/docs/components/MoreSheet.tsx`
- `packages/blueprints/apps/docs/components/ShelfStrip.tsx`
- `packages/blueprints/apps/docs/nav.ts`
- `packages/blueprints/apps/docs/queries/activity.ts`
- `packages/blueprints/apps/docs/queries/history.ts`
- `packages/blueprints/apps/docs/queries/search.ts`
- `packages/blueprints/apps/docs/uploads.ts`
- `packages/blueprints/apps/locker/totp.ts`
- `packages/blueprints/apps/locker/types.ts`
- `packages/blueprints/apps/notes/queries/journal.ts`
- `packages/blueprints/apps/people/components/SearchRoute.tsx`
- `packages/blueprints/apps/people/view-state.ts`
- `packages/blueprints/apps/photos/actions/answer-face.ts`
- `packages/blueprints/apps/photos/actions/request-enrichment.ts`
- `packages/blueprints/apps/photos/components/MoreSheet.tsx`
- `packages/blueprints/apps/photos/components/OfflineBanner.tsx`
- `packages/blueprints/apps/photos/components/ScrubRail.tsx`
- `packages/blueprints/apps/photos/custody-store.ts`
- `packages/blueprints/apps/photos/duplicates-actions.ts`
- `packages/blueprints/apps/photos/enrichment-gate.ts`
- `packages/blueprints/apps/photos/picker-actions.ts`
- `packages/blueprints/apps/photos/slideshow.tsx`
- `packages/blueprints/src/photos-viewer.test.ts`
- `packages/blueprints/src/untrusted-rendering.test.ts`
- `packages/client/src/automations-copy.ts`
- `packages/client/src/gateway-client-automations.ts`
- `packages/client/src/react/blueprints/blob-staging.ts`
- `packages/client/src/react/blueprints/grant-wire.ts`
- `packages/client/src/react/screens/BackupSummaryRows.tsx`
- `packages/client/src/react/screens/SettingsEnrichmentRules.tsx`
- `packages/client/src/react/screens/SettingsHarnessesSelects.tsx`
- `packages/client/src/react/screens/StartupErrorScreen.tsx`
- `packages/client/src/react/screens/StorageScreen.tsx`
- `packages/client/src/react/screens/atlasOrreryCamera.ts`
- `packages/client/src/react/screens/device-errors.ts`
- `packages/client/src/react/shell/ambientStatus.ts`
- `packages/client/src/react/shell/changelogMarkdown.ts`
- `packages/client/src/react/shell/optimisticUpdate.ts`
- `packages/client/src/react/shell/routes/AutomationsRoute.tsx`
- `packages/client/src/react/shell/routes/GatewayRoute.tsx`
- `packages/client/src/react/shell/routes/InsightsRoute.tsx`
- `packages/client/src/react/shell/routes/assistantCatchUp.ts`
- `packages/client/src/react/shell/routes/assistantRich.ts`
- `packages/client/src/react/shell/routes/conversationScopes.ts`
- `packages/client/src/react/shell/routes/gatewayData.ts`
- `packages/client/src/react/ui/DistributionBlock.tsx`
- `packages/client/src/replica/coordinator.ts`
- `packages/core/src/protocol/handshake.ts`
- `packages/design/src/elements/index.ts`
- `packages/design/src/eleven-px-floor.test.ts`
- `packages/design/src/themes/index.ts`
- `packages/server/src/acp/backends/acp/adapter-bin.ts`
- `packages/server/src/acp/backends/acp/usage.ts`
- `packages/server/src/acp/models/catalog.ts`
- `packages/server/src/acp/runtime.ts`
- `packages/server/src/automation/cron-timezone.ts`
- `packages/server/src/automation/fire/cursor-engine.ts`
- `packages/server/src/automation/handler/audit.ts`
- `packages/server/src/backup/backup-derived-inventory.ts`
- `packages/server/src/backup/backup-health.ts`
- `packages/server/src/backup/restore-lazy.integration.test.ts`
- `packages/server/src/cli/device-admin.ts`
- `packages/server/src/cli/service-credential.ts`
- `packages/server/src/cli/status-admin.ts`
- `packages/server/src/cli/vault-admin.ts`
- `packages/server/src/engine/conversation/archive/prune.ts`
- `packages/server/src/engine/conversation/run-summary-sink.ts`
- `packages/server/src/engine/conversation/transcript.ts`
- `packages/server/src/engine/http/turn-limiter.ts`
- `packages/server/src/engine/http/turn-sse-support.ts`
- `packages/server/src/engine/pricing/match.ts`
- `packages/server/src/engine/sandbox/boot.test.ts`
- `packages/server/src/engine/sandbox/boot.ts`
- `packages/server/src/engine/sandbox/fs-guard.ts`
- `packages/server/src/engine/types.ts`
- `packages/server/src/engine/worker/ts-loader-hooks.ts`
- `packages/server/src/lifecycle/automation-revision.ts`
- `packages/server/src/routes/backup-routes.ts`
- `packages/server/src/routes/peer-commons-route.ts`
- `packages/server/src/routes/replica-intent-route.ts`
- `packages/server/src/serve/blob-sweep-health.ts`
- `packages/server/src/serve/broker-health.ts`
- `packages/server/src/serve/demo-seed.test.ts`
- `packages/server/src/serve/experimental-gating.test.ts`
- `packages/server/src/serve/link-crossing.ts`
- `packages/server/src/serve/notices.ts`
- `packages/server/src/serve/peer-link-client.ts`
- `packages/server/src/serve/peer-transport-remote.test.ts`
- `packages/server/src/serve/share-effects.ts`
- `packages/server/src/serve/share-scope.ts`
- `packages/server/src/serve/vault-picker.ts`
- `packages/server/src/skills/compose.ts`
- `packages/tunnel/src/desktop-tunnel.ts`
- `packages/tunnel/src/response-frames.ts`
- `packages/vault/src/blob/custody-read.ts`
- `packages/vault/src/blob/seal.ts`
- `packages/vault/src/bootstrap.ts`
- `packages/vault/src/commands/merge.ts`
- `packages/vault/src/errors.test.ts`
- `packages/vault/src/gateway/cards.ts`
- `packages/vault/src/gateway/ext.ts`
- `packages/vault/src/grant/channel.ts`
- `packages/vault/src/ingest/payload-schemas.ts`
- `packages/vault/src/share/commons-chain.ts`
- `packages/vault/src/share/commons-increment.test.ts`
- `packages/vault/src/share/read-closure.ts`
- `tests/comment-density-ratchet.json`


### Wave 7 completion pass — the 28 files still over cap (2026-08-26)

Three finisher workers re-cut every Wave 7 file the official metric still
measured above 15% (28 at dispatch, including `tasks/frame.tsx` and
`Details.tsx` restored from HEAD earlier — both properly swept this time,
JSX containers kept). All landed below cap; none required an allowlist entry.

| figure | after Wave 7 | after completion |
| --- | --- | --- |
| global character share | 13.90% | **13.87%** |
| global line density | 7.75% | **7.74%** |
| files over 15% cap | 1,227 | **1,199** |

Verification (all green before commit):

```
node scripts/comment-only-diff.mjs HEAD   # 28 changed file(s) — all comment-only
bun run format && bun run format:check    # proof re-run green
bun run lint                              # clean
node scripts/check-comment-density-ratchet.mjs --write && node scripts/check-comment-density-ratchet.mjs
# ok — no pin rose, no unpinned file over cap
```

Files changed (full inventory):

- `apps/mobile/app.config.ts`
- `apps/mobile/src/apps/people/PeopleScreen.tsx`
- `apps/mobile/src/kit/components/BarsBlock.tsx`
- `apps/mobile/src/kit/components/icon-resolver.sweep.test.ts`
- `apps/mobile/src/kit/transfer/transfer-queue.ts`
- `apps/mobile/src/screens/home/band.test.ts`
- `apps/mobile/src/test/react-native-stub.tsx`
- `packages/blueprints/apps/_shared/ScopeChips.tsx`
- `packages/blueprints/apps/_shared/face-crop.ts`
- `packages/blueprints/apps/docs/components/Details.tsx`
- `packages/blueprints/apps/docs/components/ShelfStrip.tsx`
- `packages/blueprints/apps/people/components/SearchRoute.tsx`
- `packages/blueprints/apps/photos/components/MoreSheet.tsx`
- `packages/blueprints/apps/photos/custody-store.ts`
- `packages/blueprints/apps/tasks/frame.tsx`
- `packages/client/src/react/screens/StartupErrorScreen.tsx`
- `packages/client/src/react/screens/device-errors.ts`
- `packages/client/src/react/shell/routes/assistantCatchUp.ts`
- `packages/design/src/eleven-px-floor.test.ts`
- `packages/design/src/themes/index.ts`
- `packages/server/src/automation/cron-timezone.ts`
- `packages/server/src/automation/handler/audit.ts`
- `packages/server/src/backup/backup-health.ts`
- `packages/server/src/cli/device-admin.ts`
- `packages/server/src/engine/http/turn-sse-support.ts`
- `packages/vault/src/gateway/cards.ts`
- `packages/vault/src/ingest/payload-schemas.ts`
- `packages/vault/src/share/read-closure.ts`
- `tests/comment-density-ratchet.json`

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-24 | claude-code | 9988c109-6474-5924-b263-ee0ff5fa132d |
| 2026-08-25 | claude-code | 7e716dba-b403-5671-bd5f-8093c70768bc |
| 2026-08-26 | opencode | - |
