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
- [x] A6 — Tally ledger-root audit, second posture
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
- [~] D4 — Docs OCR corrections join as the third consumer — **STRUCK**, see
  Decisions 6

Search

- [x] S1 — one grouping scaffold, per-app entity lists as config
- [x] S2 — "things" search stays deferred (honest omission stands)

Conformance

- [x] E1 — per-engine conformance gates, sabotage-verified
- [x] E2 — engine contracts in blueprint-seats.md with structural exclusions
- [x] E3 — the band can be handed back; verified in two apps

Photos remainder

- [x] P5 — backup policy switches, "Back up now", failure verdict on the frame screen
- [x] P6 — per-copy provenance + cross-person face grouping
- [x] P7 — Sharing's grant roster (folded into Engine A; see Decisions)
- [x] P8 — the five pushed destinations vs the receipt's band claim (see Decisions)
- [x] P9 — PlacesView ground colour measured
- [~] P10 — browser verification of the web surfaces — **STRUCK**, see Decisions 7
- [x] P11 — `enforceRetention` fix-or-disable for `media_media_asset`
- [x] P12 — sweep operator log carries the lineage-blocked lists
- [x] P13 — mobile Permission as a timeline takeover
- [x] P14 — `packages/blueprints/manifest.json` final regeneration
- [x] P15 — mechanical gates green (`bun run check:push`)
- [x] P16 — portable-export ruling recorded before the fingerprint moves
- [x] P17 — mobile native-state fingerprints after L1–L3 review
- [x] P18 — six files under 625 lines by extraction, no limit bump
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

6. **D4 — struck, with the finding.** The issue conditions D4 on "when C3
   produces output". C3 shipped the *consent* for Docs OCR, not a review
   surface, and OCR extraction produces a derived text column, not proposal
   rows: there is no per-correction row for a member to confirm, reject or
   dismiss. The nearest existing table, `agent_correction`
   (`packages/vault/src/schema/agent.ts`), records a correction that already
   happened — it is an audit row, not a queue. Joining D4 would therefore
   mean inventing a proposal shape for text spans, which is a feature, not a
   consumer of the engine this pass built. The triage engine is proven by two
   consumers (face review's durable answers, duplicate review's ephemeral
   decisions) sharing one session model; the third joins when a doc-text
   proposal row exists to answer.

7. **P10 — struck, with a finding that refutes the existing evidence.** Both
   real-browser harnesses were run (`bun run --cwd apps/desktop test:e2e`,
   58 passed; `bun run --cwd apps/web e2e` against a real gateway). Photos
   never mounts in either: the harness session holds no replica-plane grant
   (`403 /centraid/_web/control?path=/centraid/_vault/replica/bootstrap`),
   so `InlineAppRoute` sits on "Loading Photos…" forever. Consequently the
   `artifacts/e2e/ui-impact/issue-711-photos-v4.png` and
   `issue-712-shared-engines.png` frames the ui-receipt gate accepts are
   pictures of that spinner — any receipt citing them as Photos-surface
   evidence over-claims, including #711's and the first draft of this one
   (amended under User impact). Per-surface browser verification is
   unobtainable without granting the harness session the replica plane,
   which is harness work outside this pass. The honest substitute on record
   is the jsdom/unit suite (80 files / 2031 tests) — reported as what it is,
   not as browser evidence.

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
- A6 — Tally ledger-root audit, second posture — placement-registry.test.ts ledger-root audit block; zero engine edits
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
- E1 — per-engine conformance gates, sabotage-verified — scripts/lint-engine-conformance.mjs, sabotage-verified per engine
- E2 — engine contracts in blueprint-seats.md with structural exclusions — blueprint-seats.md Engine contracts section
- E3 — the band can be handed back; verified in two apps — inlineAppFrame frame action + kit/band/band-owner + BandSection
- P5 — backup policy switches, "Back up now", failure verdict on the frame screen — backup-verdict.ts + switches on the frame screen
- P6 — per-copy provenance + cross-person face grouping — viewer.ts custody policy table + people confirmed_by
- P7 — Sharing's grant roster (folded into Engine A; see Decisions) — InlineScope.audience end to end
- P8 — the five pushed destinations vs the receipt's band claim (see Decisions) — PlacesView/PlaceDetail wrapped in PhotosScreen; claim rewritten in Decisions 3
- P9 — PlacesView ground colour measured — PlacesView --bg-sunken + radii.lg; static token comparison
- P11 — `enforceRetention` fix-or-disable for `media_media_asset` — RETENTION_REFUSALS in duties.ts
- P12 — sweep operator log carries the lineage-blocked lists — runSweep log carries the lineage lists
- P13 — mobile Permission as a timeline takeover — PhotoAccessPanel takeover; access row deleted
- P14 — `packages/blueprints/manifest.json` final regeneration — manifest regenerated; version drift recorded
- P15 — mechanical gates green (`bun run check:push`) — 39/39 gates green (see Verification)
- P16 — portable-export ruling recorded before the fingerprint moves — Decisions 4, recorded before the fingerprint moved
- P17 — mobile native-state fingerprints after L1–L3 review — no native change; fingerprints agree, --write correctly not run
- P18 — six files under 625 lines by extraction, no limit bump — six files extracted under 625; seams named above
- P19 — independent fresh-context audit of the #711 receipt — independent audit summarized in Verification

Struck items (both restated here so the crosswalk is complete): D4 — Docs OCR corrections join as the third consumer — struck, Decisions 6. P10 — browser verification of the web surfaces — struck, Decisions 7.

### Conformance (E1–E3, A6)

- `scripts/lint-engine-conformance.mjs` + `scripts/lib/disabled-controls.mjs`
  (+ `scripts/lint-engine-conformance.test.mjs`), wired into `check:push` as
  `lint:engine-conformance` (`package.json`) — one sabotage-verified gate per
  engine: placement outside the registry fails; `locker.item` as an itemType
  fails (A7); mobile apps reaching past `kit/transfer`/`kit/storage` to the
  upload internals or custody projections fail (2-entry shrink-only ratchet,
  reasons stated); a consent gate for a non-ENRICH_DOMAIN fails; the retired
  `media.confirm_face`/`media.reject_face` verbs fail; a reasonless disabled
  control on the named engine surfaces fails. Scope limits stated in the
  file's header. Real defect found by the gate and fixed:
  `TransferPolicySwitch.inertReason` is now required and rendered
  (`apps/mobile/src/kit/transfer/transfer-policy.ts` + test,
  `apps/mobile/src/screens/BackupHealth.tsx`). Known refusal gaps in the two
  FaceReview clients ratcheted with reasons (`TRIAGE_REFUSAL_GAPS`).
- `docs/blueprint-seats.md` — new "Engine contracts" section: verbs,
  reason-string grammar, structural exclusions per engine; search scaffold
  reconciled as the fifth shared thing (no contract: no verbs, no refusals).
- E3 — web: `packages/client/src/react/shell/routes/inlineAppFrame.tsx`
  (+ `inlineFrame.test.tsx`) — a frame action in the app bar hands the band
  back and re-claims it from the same place; second-app (docs) verification
  at the hook level, persistence asserted against raw storage after remount.
  Mobile: new `apps/mobile/src/kit/band/band-owner.ts` (+ test) — the latch
  moves out of `photos-band.ts` onto web's `shell.bandOwner.<appId>` key
  (stored `photos.bandOwner.*` answers reset; safe — no writer existed), and
  `apps/mobile/src/screens/settings/BandSection.tsx` (+ `Settings.tsx`) is
  the per-app hand-back list. Latent bug fixed: mobile `PhotosBand.tsx`
  returned null for `owner === "host"`, stranding the member; the capsule
  now stays (`PhotosHome.tsx`, `PhotosScreen.tsx`, `photos-band.ts`,
  `PhotosLibrary.tsx` touched by the move). Photos is the only claiming app
  today — recorded; `BAND_CLAIMING_APPS` is a tripwired roster.
- A6 — `packages/blueprints/src/placement-registry.test.ts` gained the
  ledger-root audit block: `tally.group` is an ordinary registry row, no
  engine module branches on an app id or item type, Tally's call sites pass
  nothing the engine had to learn. Verdict: zero engine edits needed.

### Photos finals (P6, P9, P14, P18)

- P6(a) — `packages/blueprints/apps/photos/viewer.ts` (+ `viewer.test.ts`):
  `originParagraph` is a per-custody-state policy table with an explicit
  "has not been checked yet" branch (it previously asserted "on this device"
  with no custody row at all); `format.ts` gains the missing
  `pending-offsite` row. Recorded limit: `blob_replica` is not a registered
  entity, so per-copy *locations* beyond the five-state vocabulary would be
  invented — not shipped.
- P6(b) — `packages/blueprints/apps/photos/queries/people.ts`, `people.ts`,
  `view-copy.ts`, `components/People.tsx` (+ `.module.css`, test): each
  person carries `confirmed_by`; a group spanning two answerers renders
  "Confirmed by X and Y — separately, and they stay separate." Read-side
  only, no schema.
- P9 — `apps/mobile/src/apps/photos/PlacesView.tsx`: the card ground pinned
  `--skel` (the loading absence) forever and 7px radius; now
  `--bg-sunken` / `radii.lg` per the handoff. Method: static token
  comparison against `tokens.generated.ts` and the design roles — no pixel
  scan run, stated as such. Hairline deliberately not added (no Photos shelf
  card carries one) — flagged, not fixed unilaterally.
- P18 — six files under 625 by extraction, every `#711` waiver removed, no
  limit bump. Named seams: `apps/mobile/src/screens/home/
  springboard-policy.ts` (Home layout law; desktop twin is
  `homeTiles.ts` — unifying is now a file move),
  `packages/client/src/gateway-client-vault-imports.ts` (staged-import
  workflow split from owner acts; the `gateway-client-atlas.ts` seam),
  `apps/mobile/src/apps/photos/PhotoLightboxChrome.tsx` (the two pure
  stage strips; the `--on-stage` token rule stated once),
  `AlbumDetail.styles.ts` + `PhotosHome.styles.ts` (the directory's
  `.styles.ts` convention). Incidental: `tile-model.ts` (+ test),
  `catalog.ts` (+ test), `Home.tsx`, `home/LauncherGrid.tsx`,
  `home/TileBody.tsx`, `gateway-client.ts`,
  `gateway-client-contract-fixtures.ts`,
  `gateway-client-vault.contract.test.ts`.
- P14 — `packages/blueprints/manifest.json` regenerated from a settled tree
  (one-line diff: photos 0.2.0 → 0.4.0 via `packages/blueprints/index.json`,
  which is the version source); three other templates' version drift
  (agenda, notes, docs) recorded, not fixed (other apps' issues).
  `docs/traps/manifest-regeneration.md` corrected per the write-back loop
  (stale ".js handlers" checklist line; version-source note).

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
- `apps/mobile/src/apps/photos/AlbumDetail.styles.ts`
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
- `apps/mobile/src/apps/photos/PhotoLightbox.tsx`
- `apps/mobile/src/apps/photos/PhotoLightboxChrome.tsx`
- `apps/mobile/src/apps/photos/PhotoPermission.tsx`
- `apps/mobile/src/apps/photos/PhotoStateView.tsx`
- `apps/mobile/src/apps/photos/PhotosBand.tsx`
- `apps/mobile/src/apps/photos/PhotosGridSkeleton.tsx`
- `apps/mobile/src/apps/photos/PhotosHome.styles.ts`
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
- `apps/mobile/src/kit/band/band-owner.test.ts`
- `apps/mobile/src/kit/band/band-owner.ts`
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
- `apps/mobile/src/screens/Home.tsx`
- `apps/mobile/src/screens/Scan.test.tsx`
- `apps/mobile/src/screens/Scan.tsx`
- `apps/mobile/src/screens/Settings.tsx`
- `apps/mobile/src/screens/home/LauncherGrid.tsx`
- `apps/mobile/src/screens/home/TileBody.tsx`
- `apps/mobile/src/screens/home/catalog.test.ts`
- `apps/mobile/src/screens/home/catalog.ts`
- `apps/mobile/src/screens/home/springboard-policy.ts`
- `apps/mobile/src/screens/home/tile-model.test.ts`
- `apps/mobile/src/screens/home/tile-model.ts`
- `apps/mobile/src/screens/scan-consent.test.ts`
- `apps/mobile/src/screens/scan-consent.ts`
- `apps/mobile/src/screens/settings/BandSection.tsx`
- `apps/mobile/src/screens/settings/ShareTargetSection.tsx`
- `docs/blueprint-seats.md`
- `docs/glossary.md`
- `docs/traps/manifest-regeneration.md`
- `package.json`
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
- `packages/blueprints/apps/photos/components/People.module.css`
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
- `packages/blueprints/apps/photos/format.ts`
- `packages/blueprints/apps/photos/icons.tsx`
- `packages/blueprints/apps/photos/people.ts`
- `packages/blueprints/apps/photos/queries/enrichment-status.ts`
- `packages/blueprints/apps/photos/queries/face-queue.ts`
- `packages/blueprints/apps/photos/queries/faces.ts`
- `packages/blueprints/apps/photos/queries/people.ts`
- `packages/blueprints/apps/photos/triage-session.test.ts`
- `packages/blueprints/apps/photos/triage-session.ts`
- `packages/blueprints/apps/photos/view-copy.ts`
- `packages/blueprints/apps/photos/viewer.test.ts`
- `packages/blueprints/apps/photos/viewer.ts`
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
- `packages/blueprints/index.json`
- `packages/blueprints/manifest.json`
- `packages/blueprints/src/handler-reachability.test.ts`
- `packages/blueprints/src/no-inference-client.test.ts`
- `packages/blueprints/src/photos-face-review.test.ts`
- `packages/blueprints/src/photos-sharing-body.test.ts`
- `packages/blueprints/src/placement-registry.test.ts`
- `packages/blueprints/types/centraid.d.ts`
- `packages/client/src/enrich-policy.ts`
- `packages/client/src/gateway-client-contract-fixtures.ts`
- `packages/client/src/gateway-client-enrich.contract.test.ts`
- `packages/client/src/gateway-client-seam-fixtures.ts`
- `packages/client/src/gateway-client-vault-imports.ts`
- `packages/client/src/gateway-client-vault.contract.test.ts`
- `packages/client/src/gateway-client-vault.ts`
- `packages/client/src/gateway-client.ts`
- `packages/client/src/react/screens/SettingsEnrichmentScreen.test.tsx`
- `packages/client/src/react/screens/SettingsEnrichmentScreen.tsx`
- `packages/client/src/react/shell/inlineFrame.test.tsx`
- `packages/client/src/react/shell/routes/inlineAppFrame.tsx`
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
- `scripts/lib/disabled-controls.mjs`
- `scripts/lint-engine-conformance.mjs`
- `scripts/lint-engine-conformance.test.mjs`
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
the Photos app view open. Honesty note (P10, Decisions 7): the harness
session lacks a replica-plane grant, so the captured frame shows the app
view in its loading state, not a mounted Photos timeline — the same is true
of #711's evidence frame. The emitter and gate wiring are real; the frame's
content is the P10 finding.

## Out of scope

- Per-app v4 parity work for the other seven apps beyond the engine consumers
  (each app's own issue).
- The scene/label entity and receipt-OCR pipelines (S2/D4 mark the joints).
- Locker's PWA seat and re-auth-per-open design (post-v0).
- Any second copy of an engine "for now" (PX3).
- Photos-local surfaces that ride no engine: slideshow transport, mobile Import,
  "Surfaces and asks" (PX7 — stay on #711).

## Simulator pass — defects found and fixed (post-merge, same issue)

Driving the engines on a seeded iPhone 17 Pro simulator surfaced seven defects.
None is a regression from this issue's engine work; six are older bugs the
seeded library was the first thing to walk into, and one is the seed itself.
They are recorded here because they were found and fixed under this issue.

| # | Defect | Fix |
| --- | --- | --- |
| 1 | `PRAGMA busy_timeout` was never set, so a favourite tapped while the grid read the same vault failed instantly with SQLITE_BUSY — surfaced as "database is locked". Two handles per vault file + `journal_mode=DELETE` guarantees the overlap. | `op-sqlite-driver.ts`: 5s busy timeout at connection open, before the store core's own PRAGMA block. |
| 2 | Four icon spellings (`map-pin`, `activity`, `dollar-sign`, `hard-drive`) had no alias, and `resolveIconName` THROWS — each one took a whole screen down with a render error. Two more (`list`, `file`) had already shipped this way. | Aliases added, plus `icon-resolver.sweep.test.ts`: greps every icon literal out of the mobile source and resolves it, so this class cannot merge again. |
| 3 | Refusing the OS camera-roll prompt blanked the ENTIRE Photos library — the vault's own replica photographs, the shelves, and the route into face review — behind a panel about a permission none of that content needs. | `photoAccessTakesOverTimeline` now counts vault-resident assets; the takeover is for when there is genuinely no grid, which is what its own doctrine already said. |
| 4 | Tiles asked for `?variant=thumb`, which 404s until the gateway's preview backstop has run, and went straight to terminal `could not decode` over bytes sitting whole in CAS. The web grid has always had a fallback ladder; mobile had none. | `use-image-fallback.ts` — one hook, the web's `originalFallback` ladder, consumed by the tile and by face review. |
| 5 | Face review's crop and source photograph were empty boxes for the same reason — the member was asked to name a face they could not see. | Same hook. |
| 6 | Settings' PAIRED branch offered "Pair another" by camera only. The paste field existed solely in the unpaired branch, so adding a second gateway from a simulator or a headless VPS meant unpairing (or reinstalling) first — throwing away a working link to add one. | `TicketPasteField` extracted; both branches now offer both roads. |
| 7 | Purging the demo scenario reported `sync.import_batch` blocked for ever, because the seed stages face proposals through the ordinary publisher road and nothing cleared the batch's own line items. | `DEPENDENT_ROWS` entry in `vault/gateway/demo.ts`. |
| 8 | The Search destination rendered TWO `ReplicaStatusBar`s — `PhotosHome` draws one for every band destination and `PhotosSearchView` drew its own — and being mounted at different times they disagreed: "Updated just now" six points above "Updated 11m ago". | Removed from the view; the standalone route keeps its own, since it has no `PhotosHome` above it. |
| 9 | "Back up to the gateway" over a selection with no DEVICE copy filtered to an empty run, transferred nothing, and fell through to the SUCCESS haptic — a confirmation buzz for work that never happened. | `nothingToBackUpMessage`, in a copy module with no imports so the sentence is assertable without a renderer. |
| 10 | Home's Photos mosaic asked for the same `?variant=thumb` and had no failure state at all, so it sat on skeleton ground for ever. | `MosaicCell` + the shared ladder; `TilePhoto` gained `originalUri`. |
| 11 | **Every screen in the app** is presented with `COVER_OPTIONS` (a native `fullScreenModal`), and `<SafeAreaView edges>` resolves to a ZERO inset under that presentation — so 26 screens drew their header through the status bar. Face review's own title, "Face review", was not merely overlapping: it was invisible. | `kit/components/TopSafeArea.tsx` — same prop shape, implemented with `useSafeAreaInsets`, which does report the real inset (and is why Photos' own cover screens always looked right). Seeding the provider with `initialWindowMetrics` was tried first and measured NOT to fix it; that is recorded in the component header so it is not retried. |

### Chrome removed on review (same pass)

Four surfaces were carrying a control or a sentence that another control or
sentence on the same screen already carried. None of these were bugs; all four
were rent charged against the member's own content.

| Surface | What was there | What it is now |
| --- | --- | --- |
| Home's title row | A filled **Search everything** and an outlined **All apps**, spanning the width directly above the first preview | Nothing. Search is the magnifier in the vault lockup one row above; All apps is the band's **More** tab one row below. Home now spends no filled ink at all — on a screen made of previews, the loudest thing should be a photograph. |
| Photos' toolbar | `18 photographs`, immediately above `AUGUST 2026  9 photographs` and `Wed, 5 Aug  2` — three mono counts in the first three rows, none counting the same thing | Gone. The timeline's own headers state every count in the place the photographs they describe are; the total was the one with no photographs under it. |
| Photos' toolbar (the rest of it) | A permanent 44pt row holding one tile-size stepper | The stepper moved into the **More** sheet as `Tile size`, and the row went with it. The grid already takes the same preference by pinch (§4.2). It is drawn as a bounded stepper rather than a meta value, and does NOT dismiss the sheet — a stepper you may press once is not a stepper. `PhotosToolbar.tsx` is deleted. |
| `ReplicaStatusBar` (≈20 screens) | A standing `Updated 10m ago` with a `Refresh` button, in the settled case | Nothing in the settled case. `Refresh` was a third way to do what pull-to-refresh does; freshness is a fact about the vault, and Home already carries it ambiently (`HomeStatusLine`). Offline, asleep, syncing, first-sync progress, diverging sources, pending changes and out-of-room all render exactly as before — and now have the row to themselves. The action label survives only for the states where pulling would not help ("Wake help", "Check network", "Sync now"). |

### The photos-domain enrichers are deleted

Asking "did you test on-device face detection?" turned up that there is no such
thing. The only face detector in the repo was the `face-proposer` automation,
whose whole method is `ctx.agent` — a gateway-lane vision turn. But the tier
that makes Photos' "Run on this device" answer available is `device`, and
`device` means *no gateway-lane work* (`packages/vault/src/enrich/policy.ts`:
the legacy `local` maps DOWN to it precisely because `local` meant "no model
turn"). So the one automation that could drain a `capability: faces` request
was refused by the very gate that offered the button — a promise the runtime
could not keep in either direction.

Removed, with their registrations, gallery rows, health-probe ids and
behaviour suites:

| Automation | What it did |
| --- | --- |
| `face-proposer` | Proposed face regions from a vision turn |
| `photo-captioner` | Captioned and tagged photographs from a vision turn |
| `screenshot-extractor` | Read photographed receipts into staged ledger rows |
| `trip-albums` | Clustered photographs into trip albums by time gap |

That work becomes the Photos app's own. The consent gate and the
`request-enrichment` action stay — the tag a member's answer writes IS the
consent record — but `actions/request-enrichment.ts` now states plainly that
nothing drains the row today, rather than naming a producer that no longer
exists. Touched: `index.json` (35 → 31 templates) + a regenerated
`manifest.json`, `ENRICHER_AUTOMATION_IDS`, both v0 gallery lists (8 → 6), and
the enricher-template fixture set. Fixtures that merely *named* a deleted
automation were renamed to a synthetic `face-finder`, so no test claims a
shipped template that isn't there.

Engines verified end to end on the seeded vault: the **triage verb** writes
`confirmed` / `rejected` / `dismissed` and Skip writes nothing (checked in SQL
after each tap); the **consent gate** offers the on-device tier and the
enrichment answer lands; **search** returns caption hits with the honest
"searched the whole replica on this device" foot; the **face crop** geometry
isolates the correct face in a two-person frame.

The enrichment tier also has a trap worth recording: `readEnrichSettings` reads
the JSON settings bag, but APPS read the mirrored `enrich_policy` table. Editing
`core_vault.settings_json` directly leaves the two disagreeing and the phone
still sees the old tier — the write must go through `updateEnrichSettings`
(`PUT /centraid/_vault/enrich`), which refreshes the mirror.

### Seed: face proposals for the triage verb

`packages/blueprints/apps/photos/seed.js` now seeds 8 portrait frames and stages
8 face regions through `sync.stage_rows` → `sync.publish_batch` — the ordinary
enrichment publisher road, not a direct table write — plus two named parties.
Every region arrives UNANSWERED: a seed that pre-confirmed them would hide the
one flow the scenario exists to exercise. Portraits are procedurally generated
into `sample/`, so no third-party image is redistributed.

## Verification

One proof per item, on device or in CI, never "looks right"; a struck item
records its reason here. The whole pass re-runs with:

```sh
bun run check:push
```

(38/38 green on the first two commits; 39/39 once E1 added the
`lint:engine-conformance` gate to the chain — the count changed because this
pass added a gate to `check:push`, not because a gate was skipped.)

The first PR CI run also exposed eight type-aware diagnostics in
`apps/mobile/src/apps/docs/docs-custody.ts`,
`packages/blueprints/apps/photos/enrichment-consent.test.ts`, and
`tests/quality/user-facing-qualities.test.ts`. The optional custody state is
now explicit, the consent tests call their intentionally `void` UI callback
without awaiting it, and the quality comparisons use an explicit string
comparator. The corrected static gate passes with:

```sh
bun run lint:types
```

Engine-specific proofs a
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
- P17 — this pass changed no native module, podspec, or native project file
  (the #711 `expo-blur` removal was remediated before #713 merged), so there
  was no fingerprint to rewrite and `ci:native-state --write` was correctly
  NOT run: `bun run check:mobile-native-state` reports "Pod lock, project
  paths, and iOS/Android fingerprints agree" (L1–L3 coherent, L4 matching)
  and has been green in every `check:push` on this branch.
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
re-attesting the receipt at its **final state**: three waves of work now land
on this branch — two committed (`b357e3ab`, `f2f65036`) and a third still
uncommitted in the worktree. `git diff origin/main --stat` (which compares the
working tree, not just `HEAD`, against `origin/main`) already covers all three
waves in one pass — 210 files, +12074/-3714 — so both committed and
uncommitted work were audited together, not separately. Verified against that
diff, `git status`, spot-read source files with running code, `gh issue view
712 --repo srikanth235/centraid`, the two `## Decisions` findings' underlying
evidence, and a live re-run of `lint:engine-conformance` plus several of the
`## Verification` section's own proof commands.

- **(1) `## What changed` faithfully describes the full diff (committed +
  uncommitted) — PASS.** Every path named under Engines A–E, the search
  scaffold, and the Photos-defects/finals bullets exists in `git diff
  origin/main --stat` with the described shape; every path in `git status`'s
  "Changes not staged" and "Untracked files" lists (e.g.
  `apps/mobile/src/kit/band/`, `scripts/lint-engine-conformance.mjs`,
  `apps/mobile/src/screens/home/springboard-policy.ts`,
  `packages/client/src/gateway-client-vault-imports.ts`,
  `apps/mobile/src/apps/photos/PhotoLightboxChrome.tsx`) appears in "Every
  file this pass touched" and is attributed to a named item. No untracked or
  modified file rides along unnamed.
- **(2) Each `- [x]` checklist item is realized in the tree — PASS, with the
  newest claims spot-checked against running code, not prose:**
  - `E1` — `scripts/lint-engine-conformance.mjs`,
    `scripts/lib/disabled-controls.mjs` and
    `scripts/lint-engine-conformance.test.mjs` all exist; `package.json`
    wires `"lint:engine-conformance": "node
    scripts/lint-engine-conformance.mjs"` into the `check:push` gate list
    (confirmed by grep against the script line itself, not the receipt's
    claim about it). Re-ran it live: `ok   engine conformance — placement,
    custody, consent and triage each have exactly one door, and the engine
    surfaces explain every refusal`.
  - `E2` — `docs/blueprint-seats.md` carries a `## Engine contracts` heading
    (line 74).
  - `E3` — `apps/mobile/src/kit/band/band-owner.ts` (+ `.test.ts`) and
    `apps/mobile/src/screens/settings/BandSection.tsx` both exist;
    `BandSection.tsx` calls `useBandOwner(app.id)` and wires `onChange={
    setBandOwner}` — a real writer, not a stub. `inlineAppFrame.tsx` also
    reads/writes `bandOwner`/`setBandOwner`, matching the web-side "frame
    action hands the band back" claim.
  - `P6` — `packages/blueprints/apps/photos/viewer.ts` defines
    `originParagraph(asset, gatewayName)` as a per-custody-state table
    including a `pending-offsite` branch (lines 315–336), matching the claim.
    `packages/blueprints/apps/photos/queries/people.ts` carries
    `confirmed_by_party_id` on the region read and assembles a `confirmed_by`
    array per person group (lines 58–264), matching the P6(b) claim.
  - `P9` — `apps/mobile/src/apps/photos/PlacesView.tsx` reads
    `colors.bgSunken` for the card ground and sets `borderRadius: radii.lg`,
    matching the claim exactly.
  - `P18` — the six named seams (`PhotosHome.tsx` 588, `AlbumDetail.tsx` 590,
    `packages/client/src/gateway-client-vault.ts` 564, `home/tile-model.ts`
    483, `PhotoLightbox.tsx` 623, `screens/BackupHealth.tsx` 521 lines) are
    all under the 625-line `repo-hygiene` cap. A repo-wide `grep -rn
    "allow-repo-hygiene"` finds waivers only in files this pass never
    touched (`centraid-city/`, `packages/app-engine/`,
    `tests/quality/user-facing-qualities.test.ts`, etc.) — none in any
    Photos/#712 file, confirming the #711 waivers were genuinely removed by
    extraction rather than left in place beside a raised limit.
  - `P14` — `packages/blueprints/index.json` shows exactly the claimed
    one-line diff (`"version": "0.2.0"` → `"0.4.0"` for photos);
    `packages/blueprints/manifest.json`'s own diff is 16 lines (the
    regenerated derived artifact), consistent with "one-line diff" referring
    to the version *source*, not the generated manifest.
  - No falsely-checked item was found among the items spot-checked. Every
    struck item (`D4`, `P10`) was left struck, not silently checked.
- **(3) `## Checklist` mirrors the issue's checklist — PASS.** `gh issue view
  712 --repo srikanth235/centraid` lists A1–A7, B1–B4, C1–C5, D1–D4, S1–S2,
  E1–E3, P5–P19 (P1–P4 explicitly retired/moved per the issue body's own
  note) — the receipt's `## Checklist` carries the identical set, same order,
  same identifiers, nothing renumbered or invented.
- **(4) The two struck items' findings — PASS on both, evidence read
  directly, not trusted from prose:**
  - **Decisions 6 (D4, no OCR proposal row exists).** `grep`-ed
    `packages/vault/src/schema/` for `ocr_proposal`, `doc_text_proposal`,
    `text_span_proposal` — zero matches. `agent_correction`
    (`packages/vault/src/schema/agent.ts` line 45) exists and is exactly
    what the receipt describes: a row that records a correction that already
    happened, with no `review_state`/proposal-queue shape to answer against.
    The finding holds.
  - **Decisions 7 (P10, evidence frames show a loading state).**
    `artifacts/e2e/ui-impact/issue-712-shared-engines.png` was opened and
    read as an image: it shows the Photos app shell with the centre pane
    reading **"Loading Photos…"** — a spinner state, not a mounted Photos
    timeline. The finding is accurate as stated, not an over-claim walked
    back to a milder one.
- **Discrepancy found and reconciled during this attestation:** the
  crosswalk row for `P15` said "39/39 gates green" while `## Verification`
  said "38/38". Both were true of different moments — 38 gates existed
  until E1 added `lint:engine-conformance` to `check:push`, making 39.
  The Verification prose now says so explicitly rather than carrying two
  numbers for one claim.
- **Not independently re-verified (scope limit, not a finding):** a full
  `bun run check:push` run was not re-executed by this audit (multi-minute,
  outside a fresh-context attestation's budget). `lint:engine-conformance`
  was re-run live and passed; the P19 independent-audit claim (48
  PASS/3 REFUTED) was checked in the prior attestation pass against the
  actual task-notification transcript and is not re-litigated here since
  nothing in this pass's diff touches it.

**Verdict: PASS.** No checked box overstates what the tree (committed or
uncommitted) contains, both struck items' findings hold up against direct
evidence, and the checklist mirrors the issue. One internal numeric
inconsistency (39/39 vs. 38/38 gates) is named above as a discrepancy the
author should reconcile before merge — it does not itself falsify any
checklist claim.

## Steering

Re-scanned the session transcript
(`8eaf2fc5-4c26-4cea-a89d-c8f1f7ba124d.jsonl`, 809 lines) for events *since*
the prior fresh-context attestation (which found zero events over the
session's first ~469 lines). Walked every `type: "user"` entry plus every
`type: "attachment"`/`"queue-operation"` entry carrying a human-authored
`prompt` (the prior pass's method missed these because a queued slash-style
message is not a plain `type: "user"` entry — corrected here), again
excluding `isSidechain: true` entries and tool-result-only payloads.

Three candidate events surfaced after line 469, evaluated individually
against the directive's rubric (`.governance/packs/governance-kit/audit/
directives/agent-steering-accounting/README.md`: an **interrupt** is a
runtime-emitted `[Request interrupted by user...]` sentinel; a **correction**
is a message that redirects or corrects the agent's work mid-task; "tool
denials and ordinary task messages are not steering"):

1. **Line 645 (attachment, `2026-08-06T06:56:06.931Z`): "what percentage of
   work is done?"** — a status query, not a redirect. It asks for
   information about progress; it does not change scope, correct a mistake,
   or redirect the agent's next action. **Not steering** under the rubric's
   own "ordinary task messages are not steering" carve-out — classified the
   same way a "keep going" message would be.
2. **Line 709 (user, `2026-08-06T07:11:39.766Z`): "just logged in...continue."**
   and **line 716 (user, `2026-08-06T07:12:18.520Z`): "just lggoed in
   .continue...act as orcehstrator and span opus/sonnet/haiku..."** — both
   follow a `401 OAuth access token has expired` failure at line 700 (an
   *auth outage*, a runtime/infra event, not a human decision) and a `/model`
   switch to `claude-fable-5` at line 714. Both messages restate "continue"
   (the second re-pastes the session's original scope verbatim rather than
   introducing new scope) to resume the interrupted run. **Not steering** —
   resumption after an outage, not a correction of agent behavior; no scope,
   plan, or approach changed.
3. **Line 711 (user, `2026-08-06T07:11:47.175Z`): "[Request interrupted by
   user]"** — this is the literal runtime sentinel the directive names as
   the structural-interrupt case. **Steering event, type `interrupt`, tier
   `structural`.** Recorded as `steer-8eaf2fc5-1786000307-1` under
   `### Steering` below: session `8eaf2fc5-4c26-4cea-a89d-c8f1f7ba124d`,
   issue `#712`, ordinal `711` (1-based line position in the transcript
   file), timestamp `2026-08-06T07:11:47.175Z`, commit `PENDING` (the wave
   that followed this interrupt has not been committed yet as of this
   attestation). `user-reason` left empty per the row schema (interrupts
   carry no reason field; the `/model` switch immediately after is a
   plausible cause but is not asserted as fact here).

No other candidate events were found: `grep -c "Request interrupted"` returns
exactly `1` over the full 809-line transcript (the event just recorded), and
no other `type: "attachment"` entry with `origin.kind: "human"` exists besides
the percentage-status query already classified above as non-steering.

Checks, per the directive's rubric:
1. **Every steering event recorded — PASS.** The one qualifying interrupt is
   appended as a row with a valid `(session, ordinal)` identity, confirmed
   unique via `existing-ordinals` (empty before this append) and validated
   below.
2. **No non-steering message recorded as a steering event — PASS.** The
   status query and the two outage-resumption messages were evaluated and
   correctly excluded rather than logged as corrections; none redirects the
   agent's work.

**Ledger validation:**

```
$ python3 .governance/packs/governance-kit/audit/directives/agent-steering-accounting/lib/ledger.py validate-dir receipts
```

ran clean (no violations reported) after the row was appended and the table
header/separator were added to `### Steering` below (the ledger tool's
`append_row` only inserts a bare row when a `### Steering` sub-table with a
header does not yet exist under an existing heading — the header/separator
were added by hand to match the schema the tool expects on the next append).

**Verdict: PASS.** One structural interrupt recorded for this session,
correctly distinguished from two non-steering resumption messages and one
non-steering status query; the ledger validates clean across `receipts/`.

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
| claude-code-8eaf2fc5-4c2-1786003430-1 | claude-code | 8eaf2fc5-4c26-4cea-a89d-c8f1f7ba124d | #712 | claude-opus-5 | 157 | 4564558 | 24868872 | 53448 | 4618163 | 42.2999 | 34189 | 7070837 | 122489110 | 501938 | feat(engines): close the pass — conformance gates, band hand-back, Photos finals |
| codex-019fd642-e7c-1786007909-1 | codex | 019fd642-e7c5-7c51-983a-10ddd72c2c1c | #712 | gpt-5.6-luna | 338318 | 0 | 8062720 | 27455 | 365773 | 3.2733 | 338318 | 0 | 8062720 | 27455 | fix(ci): clear PR type-aware lint failures (#712) |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-8eaf2fc5-1786000307-1 | 8eaf2fc5-4c26-4cea-a89d-c8f1f7ba124d | #712 | interrupt | structural |  | PENDING | 711 | 2026-08-06T07:11:47.175Z |

One structural interrupt recorded for session `8eaf2fc5-4c26-4cea-a89d-c8f1f7ba124d`
(see the `## Steering` attestation above for the full method and evidence). The
`what percentage of work is done?` status query and the two `just logged
in...continue` resumption messages that followed the mid-session auth outage
are not steering events under the directive's rubric — none redirects or
corrects the agent's work — and are recorded in prose only, not as rows.
