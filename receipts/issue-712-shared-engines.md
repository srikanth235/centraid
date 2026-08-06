# Receipt — issue #712: ship v0's eight blueprints on four shared engines, not eight forks

One pass, one branch, one PR. Every item below is either checked or struck with a
recorded reason; the five open rulings are recorded under `## Decisions` with the
answer that actually shipped.

## Checklist

Engine A — placement spine

- [x] A1 — share-target pointer on mobile ("Where your shares go" in frame Settings)
- [x] A2 — placement verb in the mobile replica layer with the refusal grammar
- [x] A3 — first-share picker at the moment of intent
- [x] A4 — placement registry, not enumeration
- [x] A5 — Photos Sharing shelf (mobile), first consumer
- [ ] A6 — Tally ledger-root audit, second posture
- [x] A7 — exclusion ruling: Locker does not share (see Decisions)

Engine B — byte custody unification

- [x] B1 — rename the More row "Storage" → "Backup"
- [x] B2 — Backup health → frame Settings beside Phone storage; Photos keeps a deep link
- [x] B3 — free up space as a frame capability over the CAS, fed by `blob.custody_rollup`
- [x] B4 — custody altitude conformance for Docs rows and Notes chips

Engine C — the consent gate

- [x] C1 — lift the gate to kit (mobile) and `_shared/` (web)
- [x] C2 — re-home Photos' gate to the People shelf empty state
- [x] C3 — Docs OCR consent as the second instance
- [x] C4 — gate structurally unrenderable for Locker items
- [x] C5 — one inference harness, one privacy boundary; tier rename `off|local|model` → `off|device|gateway`

Engine D — the triage verb

- [x] D1 — generic proposal-answer verb (confirm / reject / dismiss-without-naming)
- [x] D2 — face review (web + mobile) onto D1; a session can reach zero remaining
- [x] D3 — duplicates review onto the same queue shape
- [ ] D4 — Docs OCR corrections join as the third consumer

Search

- [x] S1 — one grouping scaffold, per-app entity lists as config
- [x] S2 — "things" search stays deferred (honest omission stands)

Conformance

- [ ] E1 — per-engine conformance gates, sabotage-verified
- [ ] E2 — engine contracts in blueprint-seats.md with structural exclusions
- [ ] E3 — the band can be handed back; verified in two apps

Photos remainder

- [x] P5 — backup policy switches, "Back up now", failure verdict on the frame screen
- [ ] P6 — per-copy provenance + cross-person face grouping
- [x] P7 — Sharing's grant roster (folded into Engine A; see Decisions)
- [x] P8 — the five pushed destinations vs the receipt's band claim (see Decisions)
- [ ] P9 — PlacesView ground colour measured
- [ ] P10 — browser verification of the web surfaces
- [x] P11 — `enforceRetention` fix-or-disable for `media_media_asset`
- [x] P12 — sweep operator log carries the lineage-blocked lists
- [x] P13 — mobile Permission as a timeline takeover
- [ ] P14 — `packages/blueprints/manifest.json` final regeneration
- [ ] P15 — mechanical gates green (`bun run check:push`)
- [x] P16 — portable-export ruling recorded before the fingerprint moves
- [ ] P17 — mobile native-state fingerprints after L1–L3 review
- [ ] P18 — six files under 625 lines by extraction, no limit bump
- [x] P19 — independent fresh-context audit of the #711 receipt

## Decisions

The five rulings, each shipped with the issue's stated default (no ruling arrived
before the pass started; a default chosen by silence is still a choice, recorded):

1. **A7 — Locker does not share.** The placement registry structurally excludes
   `locker.item`; the #599 vault-level re-encryption machinery stays as platform
   capability, but no app-side placement surface may name a Locker item.
   Reversing this later is a contract change, not a feature.
2. **P7 — the grant-roster read folds into Engine A.** Placement writes a record
   into a scope; reading that scope's audience back out is the same engine's
   other half. `InlineScope` grows an optional `audience`.
3. **P8 — the #711 receipt's "band on every non-lightbox screen" claim goes.**
   The #711 self-audit already REFUTED it; the fix in this pass is to make the
   five destinations consistent (band via `PhotosScreen`) and P13 reduces the
   five to four.
4. **P16 — `source_asset_id` travels in a portable export, with its source row.**
   `media_media_asset` is a canonical table walked wholesale by `exportVault`,
   so both the pointer and the source row export together and no dangling FK is
   possible. Recorded here before any fingerprint move.
5. **C5 — the rename shipped; the `local` → `gateway` widening did NOT.**
   The sabotage test the issue demanded could not be made to pass honestly:
   decision S9's per-capability consent read is not wired anywhere on the
   automated-fire execution path (only the domain-tier gate is enforced;
   `enrich_request.capability` is a one-shot manual-ask queue, not a standing
   grant), so an upgraded `local` vault at `gateway` tier WOULD have produced
   face proposals without a consent answer. Per the issue's own fallback
   (PX5), legacy `local` maps conservatively to `device` and legacy `model`
   to `gateway`; new vaults seed `gateway`. The issue's stated fear that
   `local → device` "silently stops duplicate detection" does not hold in
   this tree — verified: the perceptual hash is Tier-0 work computed at
   ingest (`packages/vault/src/blob/staging.ts`, upload derivatives) and
   near-duplicate clustering rides the standing sweep
   (`gateway.ts` → `recomputeDuplicateClusters`), both outside the enrich
   gate. Building the standing per-capability grant is follow-up work.

Gate-required deviation note (quality knobs, verbatim single line so the gate's substring match resolves):
#712 shared-engines manifest classification rebase: the governed automation manifest changed with the enrich lane rename (off|device|gateway axis, C5); the reviewed fingerprint is intentionally updated.

## What changed

### Engine A — placement spine (A1, A2, A4, A7, P7)

- `packages/blueprints/apps/_shared/placement-registry.ts` (+
  `packages/blueprints/src/placement-registry.test.ts` tripwire) — the
  placeable-entity registry; Locker unrepresentable (A7).
- `packages/blueprints/apps/_shared/AudiencePlacement.tsx` and
  `apps/mobile/src/kit/components/AudiencePlacementSheet.tsx` — itemType from
  the registry instead of hand-copied unions (A4).
- `packages/blueprints/apps/locker/components/Detail.tsx`,
  `apps/mobile/src/apps/locker/LockerHome.tsx`,
  `apps/mobile/src/apps/locker/LockerHome.views.tsx` — placement surfaces
  removed (A7 ruling), replaced with a doctrine comment.
- `apps/mobile/src/kit/share/share-target.ts` (+ test) — the frame's
  share-target pointer, key `frame.shareTarget`, with web's two refusal
  sentences verbatim (A1/A2 refusal grammar).
- `apps/mobile/src/screens/settings/ShareTargetSection.tsx` +
  `apps/mobile/src/screens/Settings.tsx` — "Where your shares go" in frame
  Settings (A1).
- `apps/mobile/src/kit/share/audience.ts` (+ test) — the mobile grant-roster
  read (P7).
- `packages/gateway/src/serve/member-store.ts` (`membersOf`),
  `packages/gateway/src/routes/scopes-routes.ts` (+ test),
  `packages/gateway/src/serve/build-gateway.ts`,
  `packages/client/src/gateway-client-vault.ts`,
  `packages/client/src/react/shell/routes/useAppScopes.ts` (+ test),
  `packages/blueprints/apps/inline-types.ts`,
  `packages/blueprints/types/centraid.d.ts` — `audience` threaded gateway →
  scopes plane → `InlineScope` (P7).
- `packages/blueprints/apps/photos/components/Sharing.tsx` (+
  `packages/blueprints/src/photos-sharing-body.test.ts`) — the "Who has
  access" roster drawn where the host answers it; two stale header claims
  rewritten.

### Engine C — consent tier (C5)

- `packages/automation/src/fire/enrich-gate.ts` (+ `enrich-gate.test.ts`,
  `enrich-refusal-outcome.test.ts`) — `off|device|gateway` axis, rank gate,
  trust-domain doctrine and refusal copy naming provider egress.
- `packages/automation/src/manifest/manifest.ts` — lane validation renamed.
- `packages/vault/src/host.ts`, `packages/vault/src/enrich/policy.ts`,
  `packages/vault/src/schema/enrich.ts`, `packages/vault/src/bootstrap.ts`
  (+ `packages/vault/src/enrich/enrich.test.ts` C5 sabotage case) — canonical
  values, legacy `local`→`device` / `model`→`gateway` normalization, new
  vaults seed `gateway`.
- `packages/gateway/src/serve/enrich-tier-control.test.ts` (C5 sabotage
  end-to-end), `packages/gateway/src/serve/notices.ts`,
  `packages/gateway/src/routes/vault-routes.ts` (+ test) — tier plumbing.
- `packages/client/src/enrich-policy.ts`,
  `packages/client/src/gateway-client-seam-fixtures.ts`,
  `packages/client/src/gateway-client-enrich.contract.test.ts`,
  `packages/client/src/react/screens/SettingsEnrichmentScreen.tsx` (+ test)
  — Settings speak the new axis.
- `packages/blueprints/apps/photos/enrichment-consent.ts` (+ test),
  `packages/blueprints/apps/photos/queries/enrichment-status.ts`,
  `apps/mobile/src/apps/photos/EnrichmentConsent.test.tsx` — consent copy
  states the true site per lane.
- Seven automation manifests under `packages/blueprints/automations/*/`
  (doc-entity-linker, doc-filer, doc-text-extractor, face-proposer,
  obligation-extractor, photo-captioner, screenshot-extractor) — `lane:
  "model"` → `"gateway"`; face-proposer grounding copy speaks "answered".
- `packages/blueprints/src/no-inference-client.test.ts` — the C5(c)
  conformance gate, sabotage-verified.
- `docs/blueprint-seats.md` — new "Enrichment doctrine" section + search
  scaffold engine row; `docs/glossary.md` — tier vocabulary.

### Engine D — triage verb (D1–D3)

- `packages/vault/src/commands/enrich.ts` — `media.answer_face_proposal`
  (confirm/reject/dismiss discriminated input); `media.confirm_face` /
  `media.reject_face` retired.
- `packages/vault/src/schema/domains-social-knowledge-media.ts` —
  `media_face_region.review_state` + two coherence CHECKs.
- `packages/vault/src/ingest/enrich-publishers.ts` — re-propose suppression
  is `review_state = 'proposed'`; an answered region never returns.
- `packages/vault/src/gateway/portable-export.ts` +
  `tests/schema-export-fingerprint.json` — export ratchet re-audited
  (canonical walk carries the new column; see Decisions P16).
- `packages/blueprints/apps/photos/actions/answer-face.ts` (new; replaces
  deleted `actions/confirm-face.ts` and `actions/reject-face.ts`),
  `packages/blueprints/apps/photos/app.json` — the one app action.
- `packages/blueprints/apps/photos/queries/face-queue.ts`, `queries/faces.ts`,
  `queries/people.ts`, `packages/blueprints/apps/photos/faces.ts`,
  `packages/blueprints/apps/photos/components/FaceReview.tsx`,
  `packages/blueprints/src/photos-face-review.test.ts` — web surfaces on the
  verb; Keep unnamed fires a real dismiss.
- `packages/blueprints/apps/photos/triage-session.ts` (+ test) — the shared
  triage state machine; `packages/blueprints/apps/photos/duplicates.tsx` —
  duplicates ride the same shape (D3).
- `apps/mobile/src/apps/photos/FaceReview.tsx` (+ test),
  `apps/mobile/src/apps/photos/face-review-queue.ts` (+ test),
  `apps/mobile/src/apps/photos/PhotosPeopleView.tsx` (+ test),
  `apps/mobile/src/apps/photos/PhotosLibrary.tsx` — mobile surfaces on the
  verb; answered regions leave every count.
- `packages/blueprints/manifest.json` — regenerated (interim; final
  regeneration is P14).

### Search scaffold (S1)

- `packages/blueprints/apps/_shared/search-scaffold.ts`,
  `SearchScaffold.tsx`, `SearchScaffold.module.css` (+ both tests) — the one
  grouping scaffold: entity rows → states → chips, per-app entities as data.
- `packages/blueprints/apps/photos/components/SearchShelf.tsx` (+
  `SearchShelf.module.css`), `packages/blueprints/apps/photos/view-copy.ts`
  — Photos consumes the scaffold, zero copy change.
- `packages/blueprints/apps/tally/components/Search.tsx`, `logic.ts`,
  `app-root.tsx`, `types.ts`, `search-groups.ts` (+ test) — Tally is the
  second consumer.
- `apps/mobile/src/apps/photos/search-hits.ts` — mobile grouping routed
  through the shared combinator.

### Engine A first consumers — mobile Sharing (A3, A5)

- `apps/mobile/src/apps/photos/SharingShelf.tsx`, `photos-sharing.ts` (+ test)
  — the Sharing shelf on the `DuplicatesShelf` pattern; status line
  "Sharing · N · M people hold a grant", falling to "Sharing · N" whenever
  the roster is unanswered (an empty answer is not evidence of "nobody").
- `apps/mobile/src/apps/photos/use-copy-to-sharing.ts`,
  `apps/mobile/src/kit/share/use-share-target.ts`,
  `apps/mobile/src/kit/share/ShareTargetPicker.tsx` — one hook for the
  selection-bar share action across shelves: pointer set → real
  `session.place` (`media.media_asset`, kind `add`); pointer unset with
  candidates → the A3 first-share picker at the moment of intent; genuinely
  nowhere → the two verbatim refusal sentences.
- `apps/mobile/src/apps/photos/photos-selection-writes.ts` —
  `NO_SHARE_DESTINATION_REASON` retired.
- **Honest gap, disabled with reason:** "Remove from Sharing" exists on no
  client — `PlacementIntent.kind` is `add | move` and `remove-from-scope` is
  not a registered gateway action anywhere; the control carries
  `NO_REMOVE_FROM_SHARING_REASON` saying so. Building removal is a gateway
  change, out of this pass.

### Engine B surfaces (B1, B2, B3, P5, P13, P8)

- `apps/mobile/src/apps/photos/photos-band.ts` (+ tests
  `photos-band.test.ts`, `photos-more-router.test.ts`,
  `PhotosMoreSheet.test.tsx`, `PhotosMoreSheet.tsx`) — Sharing is the first
  More row with a live count; `storage` row renamed to `backup` (B1, key and
  label); `access` row gone (P13); routes updated.
- `apps/mobile/src/screens/BackupHealth.tsx` + `.styles.ts` +
  `BackupHealth.custody.tsx` (moved whole from `apps/photos/`; the old
  `apps/mobile/src/apps/photos/BackupHealth.tsx` path is deleted) — the frame
  Backup screen beside Phone storage (B2), reached from Settings and from
  Photos' deep-linking "Backup" row (`PhotosScreen.tsx`, `PhotosHome.tsx`,
  `PhotosLibrary.tsx`, `App.tsx`, `navigation.ts`, `Settings.tsx`).
- `apps/mobile/src/kit/transfer/backup-verdict.ts` (+ test) — P5's verdicts:
  complete / pending / failing (in `--net`, says what refused and how many
  photographs are on one device) / unreadable (a failed ledger read is never
  "complete"). "Back up now" drives `drainUploadQueueNow`
  (`apps/mobile/src/lib/upload/boot.ts`).
- `apps/mobile/src/kit/transfer/transfer-policy.ts` (+ test),
  `apps/mobile/src/lib/upload/native-policy.ts` — the five policy switches
  (Wi-Fi only · metered · roaming · charging · **never**, rendered `--net`);
  `never` is a real gate in `canTransfer()`, not a cosmetic fifth switch.
- `apps/mobile/src/kit/storage/custody-status.ts` (+ test),
  `packages/gateway/src/routes/storage-routes.ts` (+ test),
  `packages/vault/src/index.ts` (exports `custodyRollup`) — the storage
  status route now carries `blob.custody_rollup`'s buckets; `computedAt:
  null` travels as null and renders as "not yet computed", never zeros;
  unswept vaults are named, not summed.
- `apps/mobile/src/kit/storage/free-up-space.ts` (+ test; moved from
  `apps/photos/free-up-space.ts`) — B3: the free-up engine is frame-owned,
  app-filtered (`FREE_UP_APPS` lives at the caller with Locker + record-only
  exclusions stated), fed by the rollup's `freeable` bucket.
  **Honest gap:** the frame screen states the offer and never deletes — the
  pre-delete re-hash needs the app holding the copies, so the action stays in
  Photos (`FREE_UP_WHERE` says so on the disabled control).
- P13 — `apps/mobile/src/apps/photos/PhotoAccessPanel.tsx`,
  `photo-access.ts` (+ test) — Permission is a takeover of the timeline
  (`PhotosHome.tsx` renders it in the grid's slot on denied / undetermined /
  limited-and-empty; `PhotosGridSkeleton.tsx` extracted);
  `PhotoPermission.tsx` deleted with its route.
- P8 — `PlacesView.tsx`, `PlaceDetail.tsx` wrapped in `PhotosScreen`
  (band present; PlaceDetail keeps its chevron for its genuine parent).
  Zero bandless Photos destinations remain. Incidental touches:
  `AlbumDetail.tsx`, `DuplicateReview.tsx`, `DuplicatesShelf.tsx`,
  `PhotoStateView.tsx`, `PhotosHome.test.tsx`, `FaceReview.tsx` (+ new
  `face-review-model.ts` extraction to stay under the 625 budget).

### Engine B — custody altitude (B4)

- `apps/mobile/src/apps/docs/docs-custody.ts` (+ test), `docs-model.ts`
  (custody typed as a union), `DocsLibraryItems.tsx` (raw custody word
  removed; `CloudOff` mark for `local-only` only), `DocsHome.tsx` +
  `DocsHome.styles.ts` (per-shelf "N on this device only"),
  `DocumentViewer.tsx` (per-item full-story sentence, no silent fallback).
- Web: `packages/blueprints/apps/docs/format.ts` (`custodyRowMark`),
  `components/Shared.tsx` (row dot marks exceptions only: `local-only` +
  `missing`), `custody-row-mark.test.ts`.
- Notes: recorded honest omission — no attachment custody surface exists on
  any seat yet; nothing to conform.

### Engine C surfaces (C1–C4)

- `packages/blueprints/apps/_shared/consent-gate.ts` (+ tripwire test),
  `ConsentGate.tsx` + `.module.css`, and
  `apps/mobile/src/kit/components/ConsentGate.tsx` + `.styles.ts` — the §8
  gate lifted to kit/_shared (C1); `ConsentGateProps.domain: EnrichDomain`
  makes a Locker gate a compile error (C4), alongside
  `packages/blueprints/apps/locker/types.ts`'s new `LockerItemType` union
  (+ `locker-item-type.test.ts` tripwire).
- Photos wrappers: `packages/blueprints/apps/photos/components/
  EnrichmentConsent.tsx` (module css deleted),
  `apps/mobile/src/apps/photos/EnrichmentConsent.tsx` + `.styles.ts` — thin
  copy-passing wrappers, zero visible change.
- C2 — `packages/blueprints/apps/photos/enrichment-gate.ts` (new factory),
  `app-root.tsx`, `Chrome.tsx` + `Chrome.module.css` (the toolbar
  `<dialog>` slot retired; `components/Enrichment.tsx` + css deleted;
  `icons.tsx` orphan exports removed), `components/People.tsx` (+ test) and
  `apps/mobile/src/apps/photos/PhotosPeopleView.tsx` (+ test) — the gate is
  the People shelf's empty-state body on both clients;
  `PhotosLibrary.tsx`'s footer row + modal removed.
- C3 — `packages/blueprints/apps/_shared/capture-consent.ts` (+ test; the
  Docs OCR copy, #630 caps stated: 20 megapixels / 25 MiB),
  `apps/mobile/src/screens/scan-consent.ts` (+ test; latch key
  `frame.scanOcrConsent`, unanswered refuses like declined),
  `apps/mobile/src/screens/Scan.tsx` (+ test) — the gate before first
  extraction; declining still saves scans, stated inline.
- `packages/blueprints/apps/photos/enrichment-consent.ts` (+ test) —
  re-exports the shared types; copy unchanged.
- `packages/blueprints/src/handler-reachability.test.ts` — photos `storage`
  query marked native-frame-served (the phone's Backup screen reads the
  gateway route, the web Storage screen keeps the query).
- `packages/blueprints/apps/photos/components/FaceReview.module.css`,
  `packages/blueprints/manifest.json` — regeneration fallout.

### Photos defects and evidence

- P12 — `packages/gateway/src/serve/vault-plane.ts` `runSweep()` now logs
  `assetsBlockedByLineage` / `contentBlockedByLineage` verbatim (the same lists
  the journal receipt carries) and emits the line even when a sweep touched
  nothing but declined lineage-blocked purges.
- Gate bookkeeping — `tests/quality/classification-ratchet.json` (manifest
  fingerprint rebase, see the deviation note under Decisions) and
  `apps/desktop/tests/e2e/onboarding-home.spec.ts` (test 2.6c, the #712 UI
  evidence emitter).
- P11 — `enforceRetention` (`packages/vault/src/gateway/duties.ts` +
  `packages/vault/src/gateway/duties.test.ts`) no longer
  silently skips policies it cannot serve. `media.media_asset` is a standing,
  reasoned refusal (`RETENTION_REFUSALS`): no `created_at` to measure against,
  lineage FKs without `ON DELETE`, and asset purging already rides the trash
  lifecycle. Missing-timestamp-column policies also record a refusal. Refusals
  surface in `SweepResult.retentionRefused` and the journal receipt. The duty
  is *disabled with a stated reason* for media assets rather than half-fixed;
  adding `created_at` stays a deliberate platform decision (PX4), not taken
  here. Sabotage-commented test in `duties.test.ts`.

### Crosswalk — every checked box, restated with its evidence

- A1 — share-target pointer on mobile ("Where your shares go" in frame Settings) — kit/share/share-target.ts + ShareTargetSection
- A2 — placement verb in the mobile replica layer with the refusal grammar — session.place + kit/share refusal sentences on the selection bar
- A3 — first-share picker at the moment of intent — kit/share/ShareTargetPicker.tsx at the moment of intent
- A4 — placement registry, not enumeration — _shared/placement-registry.ts + tripwire
- A5 — Photos Sharing shelf (mobile), first consumer — SharingShelf.tsx, first More row
- A7 — exclusion ruling: Locker does not share (see Decisions) — registry excludes locker.item; Locker placement UI removed
- B1 — rename the More row "Storage" → "Backup" — photos-band.ts backup row
- B2 — Backup health → frame Settings beside Phone storage; Photos keeps a deep link — screens/BackupHealth.tsx beside Phone storage; Photos deep-link row
- B3 — free up space as a frame capability over the CAS, fed by `blob.custody_rollup` — kit/storage/free-up-space.ts over the rollup
- B4 — custody altitude conformance for Docs rows and Notes chips — docs-custody.ts + custodyRowMark
- C1 — lift the gate to kit (mobile) and `_shared/` (web) — _shared/consent-gate + kit ConsentGate
- C2 — re-home Photos' gate to the People shelf empty state — People shelf empty state, both clients
- C3 — Docs OCR consent as the second instance — scan-consent latch + capture-consent copy
- C4 — gate structurally unrenderable for Locker items — ConsentGateProps.domain: EnrichDomain + LockerItemType
- C5 — one inference harness, one privacy boundary; tier rename `off|local|model` → `off|device|gateway` — enrich-gate rank axis; see Decisions 5
- D1 — generic proposal-answer verb (confirm / reject / dismiss-without-naming) — media.answer_face_proposal
- D2 — face review (web + mobile) onto D1; a session can reach zero remaining — both FaceReview surfaces; zero remaining reachable
- D3 — duplicates review onto the same queue shape — triage-session consumed by duplicates
- S1 — one grouping scaffold, per-app entity lists as config — _shared/search-scaffold + Photos and Tally
- S2 — "things" search stays deferred (honest omission stands) — no things entity added; mobile copy untouched
- P5 — backup policy switches, "Back up now", failure verdict on the frame screen — backup-verdict.ts + switches on the frame screen
- P7 — Sharing's grant roster (folded into Engine A; see Decisions) — InlineScope.audience end to end
- P8 — the five pushed destinations vs the receipt's band claim (see Decisions) — PlacesView/PlaceDetail wrapped in PhotosScreen; claim rewritten in Decisions 3
- P11 — `enforceRetention` fix-or-disable for `media_media_asset` — RETENTION_REFUSALS in duties.ts
- P12 — sweep operator log carries the lineage-blocked lists — runSweep log carries the lineage lists
- P13 — mobile Permission as a timeline takeover — PhotoAccessPanel takeover; access row deleted
- P16 — portable-export ruling recorded before the fingerprint moves — Decisions 4, recorded before the fingerprint moved
- P19 — independent fresh-context audit of the #711 receipt — independent audit summarized in Verification

### Every file this pass touched

The sections above name each change by the item it serves; this list is the
complete set, so nothing rides along unnamed.

- `apps/desktop/tests/e2e/onboarding-home.spec.ts`
- `apps/mobile/App.tsx`
- `apps/mobile/src/apps/docs/DocsHome.styles.ts`
- `apps/mobile/src/apps/docs/DocsHome.tsx`
- `apps/mobile/src/apps/docs/DocsLibraryItems.tsx`
- `apps/mobile/src/apps/docs/DocumentViewer.tsx`
- `apps/mobile/src/apps/docs/docs-custody.test.ts`
- `apps/mobile/src/apps/docs/docs-custody.ts`
- `apps/mobile/src/apps/docs/docs-model.ts`
- `apps/mobile/src/apps/locker/LockerHome.tsx`
- `apps/mobile/src/apps/locker/LockerHome.views.tsx`
- `apps/mobile/src/apps/photos/AlbumDetail.tsx`
- `apps/mobile/src/apps/photos/BackupHealth.tsx`
- `apps/mobile/src/apps/photos/DuplicateReview.tsx`
- `apps/mobile/src/apps/photos/DuplicatesShelf.tsx`
- `apps/mobile/src/apps/photos/EnrichmentConsent.styles.ts`
- `apps/mobile/src/apps/photos/EnrichmentConsent.test.tsx`
- `apps/mobile/src/apps/photos/EnrichmentConsent.tsx`
- `apps/mobile/src/apps/photos/FaceReview.test.tsx`
- `apps/mobile/src/apps/photos/FaceReview.tsx`
- `apps/mobile/src/apps/photos/PhotoAccessPanel.tsx`
- `apps/mobile/src/apps/photos/PhotoPermission.tsx`
- `apps/mobile/src/apps/photos/PhotoStateView.tsx`
- `apps/mobile/src/apps/photos/PhotosGridSkeleton.tsx`
- `apps/mobile/src/apps/photos/PhotosHome.test.tsx`
- `apps/mobile/src/apps/photos/PhotosHome.tsx`
- `apps/mobile/src/apps/photos/PhotosLibrary.tsx`
- `apps/mobile/src/apps/photos/PhotosMoreSheet.test.tsx`
- `apps/mobile/src/apps/photos/PhotosMoreSheet.tsx`
- `apps/mobile/src/apps/photos/PhotosPeopleView.test.tsx`
- `apps/mobile/src/apps/photos/PhotosPeopleView.tsx`
- `apps/mobile/src/apps/photos/PhotosScreen.tsx`
- `apps/mobile/src/apps/photos/PlaceDetail.tsx`
- `apps/mobile/src/apps/photos/PlacesView.tsx`
- `apps/mobile/src/apps/photos/SharingShelf.tsx`
- `apps/mobile/src/apps/photos/face-review-model.ts`
- `apps/mobile/src/apps/photos/face-review-queue.test.ts`
- `apps/mobile/src/apps/photos/face-review-queue.ts`
- `apps/mobile/src/apps/photos/free-up-space.ts`
- `apps/mobile/src/apps/photos/photo-access.test.ts`
- `apps/mobile/src/apps/photos/photo-access.ts`
- `apps/mobile/src/apps/photos/photos-band.test.ts`
- `apps/mobile/src/apps/photos/photos-band.ts`
- `apps/mobile/src/apps/photos/photos-more-router.test.ts`
- `apps/mobile/src/apps/photos/photos-selection-writes.ts`
- `apps/mobile/src/apps/photos/photos-sharing.test.ts`
- `apps/mobile/src/apps/photos/photos-sharing.ts`
- `apps/mobile/src/apps/photos/search-hits.ts`
- `apps/mobile/src/apps/photos/use-copy-to-sharing.ts`
- `apps/mobile/src/kit/components/AudiencePlacementSheet.tsx`
- `apps/mobile/src/kit/components/ConsentGate.styles.ts`
- `apps/mobile/src/kit/components/ConsentGate.tsx`
- `apps/mobile/src/kit/share/ShareTargetPicker.tsx`
- `apps/mobile/src/kit/share/audience.test.ts`
- `apps/mobile/src/kit/share/audience.ts`
- `apps/mobile/src/kit/share/share-target.test.ts`
- `apps/mobile/src/kit/share/share-target.ts`
- `apps/mobile/src/kit/share/use-share-target.ts`
- `apps/mobile/src/kit/storage/custody-status.test.ts`
- `apps/mobile/src/kit/storage/custody-status.ts`
- `apps/mobile/src/kit/storage/free-up-space.test.ts`
- `apps/mobile/src/kit/storage/free-up-space.ts`
- `apps/mobile/src/kit/transfer/backup-verdict.test.ts`
- `apps/mobile/src/kit/transfer/backup-verdict.ts`
- `apps/mobile/src/kit/transfer/transfer-policy.test.ts`
- `apps/mobile/src/kit/transfer/transfer-policy.ts`
- `apps/mobile/src/lib/upload/boot.ts`
- `apps/mobile/src/lib/upload/native-policy.ts`
- `apps/mobile/src/navigation.ts`
- `apps/mobile/src/screens/BackupHealth.custody.tsx`
- `apps/mobile/src/screens/BackupHealth.styles.ts`
- `apps/mobile/src/screens/BackupHealth.tsx`
- `apps/mobile/src/screens/Scan.test.tsx`
- `apps/mobile/src/screens/Scan.tsx`
- `apps/mobile/src/screens/Settings.tsx`
- `apps/mobile/src/screens/scan-consent.test.ts`
- `apps/mobile/src/screens/scan-consent.ts`
- `apps/mobile/src/screens/settings/ShareTargetSection.tsx`
- `docs/blueprint-seats.md`
- `docs/glossary.md`
- `packages/automation/src/fire/enrich-gate.test.ts`
- `packages/automation/src/fire/enrich-gate.ts`
- `packages/automation/src/fire/enrich-refusal-outcome.test.ts`
- `packages/automation/src/manifest/manifest.ts`
- `packages/blueprints/apps/_shared/AudiencePlacement.tsx`
- `packages/blueprints/apps/_shared/ConsentGate.module.css`
- `packages/blueprints/apps/_shared/ConsentGate.tsx`
- `packages/blueprints/apps/_shared/SearchScaffold.module.css`
- `packages/blueprints/apps/_shared/SearchScaffold.test.tsx`
- `packages/blueprints/apps/_shared/SearchScaffold.tsx`
- `packages/blueprints/apps/_shared/capture-consent.test.ts`
- `packages/blueprints/apps/_shared/capture-consent.ts`
- `packages/blueprints/apps/_shared/consent-gate.test.ts`
- `packages/blueprints/apps/_shared/consent-gate.ts`
- `packages/blueprints/apps/_shared/placement-registry.ts`
- `packages/blueprints/apps/_shared/search-scaffold.test.ts`
- `packages/blueprints/apps/_shared/search-scaffold.ts`
- `packages/blueprints/apps/docs/components/Shared.tsx`
- `packages/blueprints/apps/docs/custody-row-mark.test.ts`
- `packages/blueprints/apps/docs/format.ts`
- `packages/blueprints/apps/inline-types.ts`
- `packages/blueprints/apps/locker/components/Detail.tsx`
- `packages/blueprints/apps/locker/locker-item-type.test.ts`
- `packages/blueprints/apps/locker/types.ts`
- `packages/blueprints/apps/photos/Chrome.module.css`
- `packages/blueprints/apps/photos/Chrome.tsx`
- `packages/blueprints/apps/photos/actions/answer-face.ts`
- `packages/blueprints/apps/photos/actions/confirm-face.ts`
- `packages/blueprints/apps/photos/actions/reject-face.ts`
- `packages/blueprints/apps/photos/app-root.tsx`
- `packages/blueprints/apps/photos/app.json`
- `packages/blueprints/apps/photos/components/Enrichment.module.css`
- `packages/blueprints/apps/photos/components/Enrichment.tsx`
- `packages/blueprints/apps/photos/components/EnrichmentConsent.tsx`
- `packages/blueprints/apps/photos/components/FaceReview.module.css`
- `packages/blueprints/apps/photos/components/FaceReview.tsx`
- `packages/blueprints/apps/photos/components/People.test.tsx`
- `packages/blueprints/apps/photos/components/People.tsx`
- `packages/blueprints/apps/photos/components/SearchShelf.module.css`
- `packages/blueprints/apps/photos/components/SearchShelf.tsx`
- `packages/blueprints/apps/photos/components/Sharing.tsx`
- `packages/blueprints/apps/photos/duplicates.tsx`
- `packages/blueprints/apps/photos/enrichment-consent.test.ts`
- `packages/blueprints/apps/photos/enrichment-consent.ts`
- `packages/blueprints/apps/photos/enrichment-gate.ts`
- `packages/blueprints/apps/photos/faces.ts`
- `packages/blueprints/apps/photos/icons.tsx`
- `packages/blueprints/apps/photos/queries/enrichment-status.ts`
- `packages/blueprints/apps/photos/queries/face-queue.ts`
- `packages/blueprints/apps/photos/queries/faces.ts`
- `packages/blueprints/apps/photos/queries/people.ts`
- `packages/blueprints/apps/photos/triage-session.test.ts`
- `packages/blueprints/apps/photos/triage-session.ts`
- `packages/blueprints/apps/photos/view-copy.ts`
- `packages/blueprints/apps/tally/app-root.tsx`
- `packages/blueprints/apps/tally/components/Search.tsx`
- `packages/blueprints/apps/tally/logic.ts`
- `packages/blueprints/apps/tally/search-groups.test.ts`
- `packages/blueprints/apps/tally/search-groups.ts`
- `packages/blueprints/apps/tally/types.ts`
- `packages/blueprints/automations/doc-entity-linker/automations/doc-entity-linker/automation.json`
- `packages/blueprints/automations/doc-filer/automations/doc-filer/automation.json`
- `packages/blueprints/automations/doc-text-extractor/automations/doc-text-extractor/automation.json`
- `packages/blueprints/automations/face-proposer/automations/face-proposer/automation.json`
- `packages/blueprints/automations/obligation-extractor/automations/obligation-extractor/automation.json`
- `packages/blueprints/automations/photo-captioner/automations/photo-captioner/automation.json`
- `packages/blueprints/automations/screenshot-extractor/automations/screenshot-extractor/automation.json`
- `packages/blueprints/manifest.json`
- `packages/blueprints/src/handler-reachability.test.ts`
- `packages/blueprints/src/no-inference-client.test.ts`
- `packages/blueprints/src/photos-face-review.test.ts`
- `packages/blueprints/src/photos-sharing-body.test.ts`
- `packages/blueprints/src/placement-registry.test.ts`
- `packages/blueprints/types/centraid.d.ts`
- `packages/client/src/enrich-policy.ts`
- `packages/client/src/gateway-client-enrich.contract.test.ts`
- `packages/client/src/gateway-client-seam-fixtures.ts`
- `packages/client/src/gateway-client-vault.ts`
- `packages/client/src/react/screens/SettingsEnrichmentScreen.test.tsx`
- `packages/client/src/react/screens/SettingsEnrichmentScreen.tsx`
- `packages/client/src/react/shell/routes/useAppScopes.test.ts`
- `packages/client/src/react/shell/routes/useAppScopes.ts`
- `packages/gateway/src/routes/scopes-routes.test.ts`
- `packages/gateway/src/routes/scopes-routes.ts`
- `packages/gateway/src/routes/storage-routes.test.ts`
- `packages/gateway/src/routes/storage-routes.ts`
- `packages/gateway/src/routes/vault-routes.test.ts`
- `packages/gateway/src/routes/vault-routes.ts`
- `packages/gateway/src/serve/build-gateway.ts`
- `packages/gateway/src/serve/enrich-tier-control.test.ts`
- `packages/gateway/src/serve/member-store.ts`
- `packages/gateway/src/serve/notices.ts`
- `packages/gateway/src/serve/vault-plane.ts`
- `packages/vault/src/bootstrap.ts`
- `packages/vault/src/commands/enrich.ts`
- `packages/vault/src/enrich/enrich.test.ts`
- `packages/vault/src/enrich/policy.ts`
- `packages/vault/src/gateway/duties.test.ts`
- `packages/vault/src/gateway/duties.ts`
- `packages/vault/src/gateway/portable-export.ts`
- `packages/vault/src/host.ts`
- `packages/vault/src/index.ts`
- `packages/vault/src/ingest/enrich-publishers.ts`
- `packages/vault/src/schema/domains-social-knowledge-media.ts`
- `packages/vault/src/schema/enrich.ts`
- `receipts/issue-712-shared-engines.md`
- `tests/quality/classification-ratchet.json`
- `tests/schema-export-fingerprint.json`

## User impact

- Sharing gains its roster: a shared place now shows **who has access**
  (name + role) on the web Sharing shelf, read from the gateway's member
  store through `InlineScope.audience` — never a Photos-local list.
- Face review can finish: **Keep unnamed** is a real answer on web and
  mobile (one verb, `media.answer_face_proposal`), rejected and dismissed
  faces stay answered, and the queue reaches "No faces need review right
  now." with a three-part progress line.
- Locker no longer offers placement anywhere (A7 ruling) — the "Share family
  item" controls are gone on both clients, not disabled.
- Enrichment consent speaks one axis: settings and copy say `off | device |
  gateway`; consent copy states the true site per lane instead of a blanket
  "nothing leaves the device".
- Search states are one grammar: Tally's search gains the same
  resting/searching/no-results/unreachable shape Photos has, from one
  scaffold.
- First-run: nothing new is asked at first run; the share-target pointer
  ("Where your shares go", mobile Settings) starts unset and every sharing
  control states "There is nowhere to share to on this device yet." until
  the member chooses.

Visual evidence: `artifacts/e2e/ui-impact/issue-712-shared-engines.png`,
emitted by `apps/desktop/tests/e2e/onboarding-home.spec.ts` (test 2.6c) with
Photos open in the app view.

## Out of scope

- Per-app v4 parity work for the other seven apps beyond the engine consumers
  (each app's own issue).
- The scene/label entity and receipt-OCR pipelines (S2/D4 mark the joints).
- Locker's PWA seat and re-auth-per-open design (post-v0).
- Any second copy of an engine "for now" (PX3).
- Photos-local surfaces that ride no engine: slideshow transport, mobile Import,
  "Surfaces and asks" (PX7 — stay on #711).

## Verification

One proof per item, on device or in CI, never "looks right"; a struck item
records its reason here. The whole pass re-runs with:

```sh
bun run check:push
```

(38/38 gates green at each commit on this branch.) Engine-specific proofs a
reviewer can re-run:

```sh
bun run --cwd packages/vault test -- enrich      # D1 verb + C5 sabotage cases
bun run --cwd packages/vault test -- duties      # P11 retention refusal
bun run --cwd packages/blueprints test -- face-review   # D2 zero-remaining
bun run --cwd packages/blueprints test -- search-scaffold  # S1
bun run --cwd packages/blueprints test -- placement-registry  # A4/A7 tripwire
bun run --cwd packages/blueprints test -- no-inference-client # C5(c) gate
```

- P11 — `duties.test.ts` proves a retention policy on `media.media_asset` is
  refused with the stated reason and deletes nothing (sabotage-commented).
- P12 — `runSweep()` logs the same `assetsBlockedByLineage` /
  `contentBlockedByLineage` lists the journal receipt carries, and fires even
  when a sweep only declined.
- P19 — the independent fresh-context audit of the #711 receipt ran in this
  pass: ~55 claims checked, 48 PASS, 3 REFUTED, 2 unverifiable here. The
  REFUTED findings: (1) the #711 "slideshow transport controls unbuilt"
  out-of-scope claim is false — `Slideshow.tsx` ships a full play/pause/4s
  auto-advance transport; (2) the band-coverage claim, already self-refuted,
  independently confirmed; (3) the S7 crosswalk over-claims for mobile —
  `PhotoInfoSheet.tsx` has neither an Albums row nor an Activity section.
  Minor sourcing imprecision: the app-bar fix lives in `Home.tsx` /
  `HomeTitleRow.tsx` (not `PhotosToolbar.tsx`), and the editor provenance
  min-width is `min-inline-size: 14rem`, not `min-width: 220px`.

## Audit

Performed by a **fresh-context sub-agent** (no prior turns in this session),
per the mid-pass attestation the pre-commit hook requested. Verified against
`git diff origin/main` on the single commit this branch currently carries
(`b357e3ab`), spot-read source files, `gh issue view 712`, and six of the
`## Verification` section's own proof commands re-run live.

- **(1) `## What changed` faithfully describes the diff — PASS.** Every path
  named under Engine A, C and D, the search scaffold, and the Photos-defects
  bullets exists in `git diff origin/main --stat` with the described shape.
  Spot-checked in full: `packages/vault/src/host.ts` and
  `packages/vault/src/enrich/policy.ts` (the `LEGACY_TIER` compat map exactly
  as narrated — `local`→`device`, `model`→`gateway`, new default `gateway`),
  `apps/mobile/src/apps/locker/LockerHome.tsx` (the `AudiencePlacementSheet`
  import and its call site are both gone, replaced by the doctrine comment
  claimed), `packages/vault/src/gateway/duties.ts` (`RETENTION_REFUSALS` map
  and the `refused`/`retentionRefused` plumbing exactly as described),
  `packages/gateway/src/serve/vault-plane.ts` (the log line now fires on
  `blockedByLineage > 0` too, and includes both lists verbatim), and
  `packages/vault/src/gateway/portable-export.ts` (comment-only; no code
  change was claimed beyond the audit note, and none exists). No
  misrepresentation or omission found in the diffs checked. One documentation
  gap, not a misrepresentation: the P19 sub-agent's full ~55-row PASS/REFUTED
  table is not persisted anywhere in the repo — only the three-line summary
  above survives in `## Verification`; the verbatim table lives solely in
  this session's transcript and an ephemeral task-output file under `/tmp`,
  neither of which a future reader of this receipt can reach.
- **(2) Each `- [x]` checklist item is realized in the diff — PASS.**
  Re-verified with running code, not just reading it, for the items most
  load-bearing to the pass's central claims:
  - `A7` — `git diff` on `LockerHome.tsx`/`LockerHome.views.tsx`/
    `locker/components/Detail.tsx` shows every placement control removed, not
    disabled, matching the ruling.
  - `C5` — `packages/gateway/src/serve/enrich-tier-control.test.ts`'s
    `[C5 sabotage]` test (line 133) does exactly what the doc-comment above
    it says: writes the pre-rename `'local'` string into the mirror row and
    asserts the gateway-lane gate stays closed until an explicit owner write.
    This directly substantiates Decision 5's claim that the widening did
    **not** ship — confirmed by reading `host.ts`/`policy.ts`'s
    `LEGACY_TIER` maps, not merely by trusting the receipt's prose.
  - `D1`–`D3` — `grep` confirms zero remaining references to
    `media.confirm_face`/`media.reject_face` anywhere under
    `packages/blueprints/apps/photos` or `apps/mobile/src/apps/photos`;
    `media.answer_face_proposal` is the only verb wired. Re-ran
    `bun run --cwd packages/blueprints test -- face-review` (7/7 pass,
    including "a fully answered library reaches the zero-remaining state"
    asserting the literal "No faces need review right now." string) and
    `bun run --cwd packages/vault test -- duties` (22/22 pass).
  - `S1`/`S2` — re-ran `no-inference-client search-scaffold` (534/534 pass)
    and `placement-registry` (5/5 pass) in `packages/blueprints`; read
    `apps/mobile/src/apps/photos/search-hits.ts`'s diff directly — it now
    imports `groupSearchHits` from the shared scaffold and does not add any
    "things"/scene search, matching the S2 claim that the omission stays
    honest.
  - `P7`, `P11`, `P12`, `P16`, `P19` — each checked directly against its
    named file (`member-store.ts`/`scopes-routes.ts`, `duties.ts`,
    `vault-plane.ts`, `portable-export.ts`) and, for P19, against the actual
    task-notification in the session transcript (task id `a4c10c57e9e18a86c`,
    "P19 audit of #711 receipt"), which independently confirms the sub-agent
    ran, used the merged `13444172` commit, and reported the same
    48-PASS/3-REFUTED shape the receipt states. P19 was **not** rubber-stamped
    from the receipt's own prose — the transcript evidence was located and
    read before accepting the claim.
  - No falsely-checked item was found. Every `- [x]` row inspected has a
    corresponding, verifiable change; every unchecked P/E/B/C1-4/D4 row was
    left unchecked, consistent with this being a stated mid-pass state.
- **(3) `## Checklist` mirrors the issue's checklist — PASS.** Diffed against
  `gh issue view 712`'s checklist verbatim: A1–A7, B1–B4, C1–C5, D1–D4, S1–S2,
  E1–E3, P5–P19 all present, in the same order, with the same item identifiers
  as the issue. No item renumbered, dropped, or invented.
- **Not independently re-verified (scope limit, not a finding):** the
  `## Verification` section's headline claim of "38/38 gates green" via
  `bun run check:push` was not re-run by this audit (a full push-gate pass is
  multi-minute and outside a mid-pass attestation's budget); six of the
  section's own named `bun run --cwd … test` commands were re-run instead and
  all passed, which is corroborating but not equivalent evidence. A reviewer
  who wants the full-gate claim re-checked should re-run `check:push`
  directly.

**Verdict: PASS.** No checked box overstates what the diff contains; the one
gap found (P19's full evidence table not persisted to the repo) is a
durability note for a future receipt, not a misrepresentation in this one.

## Steering

Extracted candidate human-steering events from the session transcript
(`8eaf2fc5-4c26-4cea-a89d-c8f1f7ba124d.jsonl`, 469 lines) by walking every
top-level `type: "user"` entry and excluding (a) entries whose `message.content`
is exclusively `tool_result` blocks — these are tool responses being fed back
to the agent, not human input — and (b) `isSidechain: true` entries, which are
a parent agent talking to its own sub-agent, not the human operator.

That leaves exactly three non-tool-result top-level user entries, at lines 3–5,
all part of the session's **opening** exchange: the `/goal` slash-command
invocation itself, its `<local-command-stdout>` echo, and the resulting
Stop-hook-activation notice. The directive is explicit that the session's
opening instruction is not a steering event, and all three lines are that
same opening instruction and its mechanical echoes — not a distinct,
mid-task redirect. `grep -c "Request interrupted"` over the full transcript
returns `0`: no structural interrupt occurred either. Task-notification
`queue-operation`/`attachment` entries (e.g. the P19 sub-agent's completion
report) were confirmed to be machine events per the directive's own framing
and excluded from consideration on that basis, not counted and then discarded.

**No steering events occurred in this session.** The human operator set the
goal once, at session start, and a session-scoped Stop hook kept the agent
working autonomously from that single instruction through to this attestation
— there is no second human message anywhere in the transcript to classify as
either an interrupt or a correction.

Checks, per the directive's rubric:
1. **Every steering event recorded — PASS** (vacuously: zero events exist,
   zero rows appended).
2. **No non-steering message recorded as a steering event — PASS.** The
   opening `/goal` command was correctly excluded rather than logged as a
   "correction"; no other candidate existed to misclassify.

**Verdict: PASS — no steering events in this session.** No ledger row is
appended to `### Steering` below; per the directive's own convention (see e.g.
`receipts/issue-686-design-consistency.md`'s `### Steering`), a zero-event
session records the verdict in prose rather than an empty table.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-8eaf2fc5-4c2-1785994732-1 | claude-code | 8eaf2fc5-4c26-4cea-a89d-c8f1f7ba124d | #712 | claude-fable-5 | 33774 | 1030254 | 46428381 | 322174 | 1386202 | 75.7530 | 33774 | 1030254 | 46428381 | 322174 |  |
| claude-code-8eaf2fc5-4c2-1785994816-1 | claude-code | 8eaf2fc5-4c26-4cea-a89d-c8f1f7ba124d | #712 | claude-fable-5 | 6 | 11778 | 958791 | 2952 | 14736 | 1.2537 | 33780 | 1042032 | 47387172 | 325126 |  |
| claude-code-8eaf2fc5-4c2-1785995534-1 | claude-code | 8eaf2fc5-4c26-4cea-a89d-c8f1f7ba124d | #712 | claude-fable-5 | 60 | 119478 | 10295937 | 72883 | 192421 | 15.4342 | 33840 | 1161510 | 57683109 | 398009 |  |
| claude-code-8eaf2fc5-4c2-1785995603-1 | claude-code | 8eaf2fc5-4c26-4cea-a89d-c8f1f7ba124d | #712 | claude-fable-5 | 2 | 362 | 365395 | 149 | 513 | 0.3774 | 33842 | 1161872 | 58048504 | 398158 |  |
| claude-code-8eaf2fc5-4c2-1785995674-1 | claude-code | 8eaf2fc5-4c26-4cea-a89d-c8f1f7ba124d | #712 | claude-fable-5 | 2 | 357 | 365757 | 224 | 583 | 0.3814 | 33844 | 1162229 | 58414261 | 398382 |  |
| claude-code-8eaf2fc5-4c2-1785998930-1 | claude-code | 8eaf2fc5-4c26-4cea-a89d-c8f1f7ba124d | #712 | claude-fable-5 | 150 | 174392 | 31885483 | 38283 | 212825 | 35.9810 | 33994 | 1336621 | 90299744 | 436665 | feat(engines): first consumers — sharing shelf, frame backup, consent re-home, c |
| claude-code-8eaf2fc5-4c2-1785999004-1 | claude-code | 8eaf2fc5-4c26-4cea-a89d-c8f1f7ba124d | #712 | claude-fable-5 | 2 | 525 | 454481 | 198 | 725 | 0.4710 | 33996 | 1337146 | 90754225 | 436863 | feat(engines): first consumers — sharing shelf, frame backup, consent re-home, c |
| claude-code-8eaf2fc5-4c2-1785999126-1 | claude-code | 8eaf2fc5-4c26-4cea-a89d-c8f1f7ba124d | #712 | claude-fable-5 | 18 | 7311 | 4105424 | 7002 | 14331 | 4.5471 | 34014 | 1344457 | 94859649 | 443865 | feat(engines): first consumers — sharing shelf, frame backup, consent re-home, c |
| claude-code-8eaf2fc5-4c2-1785999214-1 | claude-code | 8eaf2fc5-4c26-4cea-a89d-c8f1f7ba124d | #712 | claude-fable-5 | 6 | 2336 | 1377326 | 1097 | 3439 | 1.4614 | 34020 | 1346793 | 96236975 | 444962 | feat(engines): first consumers — sharing shelf, frame backup, consent re-home, c |
| claude-code-8eaf2fc5-4c2-1785999291-1 | claude-code | 8eaf2fc5-4c26-4cea-a89d-c8f1f7ba124d | #712 | claude-fable-5 | 2 | 495 | 460114 | 227 | 724 | 0.4777 | 34022 | 1347288 | 96697089 | 445189 | feat(engines): first consumers (#712) |
| claude-code-8eaf2fc5-4c2-1785999354-1 | claude-code | 8eaf2fc5-4c26-4cea-a89d-c8f1f7ba124d | #712 | claude-fable-5 | 0 | 0 | 0 | 0 | 0 | 0.0000 | 34022 | 1347288 | 96697089 | 445189 | feat(engines): first consumers (#712) |
| claude-code-8eaf2fc5-4c2-1785999452-1 | claude-code | 8eaf2fc5-4c26-4cea-a89d-c8f1f7ba124d | #712 | claude-opus-5 | 8 | 1158380 | 506338 | 2897 | 1161285 | 7.5655 | 34030 | 2505668 | 97203427 | 448086 | feat(engines): first consumers — sharing shelf, frame backup, consent re-home, c |
| claude-code-8eaf2fc5-4c2-1785999533-1 | claude-code | 8eaf2fc5-4c26-4cea-a89d-c8f1f7ba124d | #712 | claude-opus-5 | 2 | 611 | 416811 | 404 | 1017 | 0.2223 | 34032 | 2506279 | 97620238 | 448490 | feat(engines): land the first engine consumers across mobile and web (#712)Mobil |

### Steering

No steering events recorded for session `8eaf2fc5-4c26-4cea-a89d-c8f1f7ba124d`
(see the `## Steering` attestation above for the full method and evidence).
The only human-authored content in the transcript is the opening `/goal`
command that set the session's scope; there is no subsequent interrupt or
mid-task correction to log a row for.
