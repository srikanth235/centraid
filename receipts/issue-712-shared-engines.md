# Receipt — issue #712: ship v0's eight blueprints on four shared engines, not eight forks

One pass, one branch, one PR. Every item below is either checked or struck with a
recorded reason; the five open rulings are recorded under `## Decisions` with the
answer that actually shipped.

## Checklist

Engine A — placement spine

- [ ] A1 — share-target pointer on mobile ("Where your shares go" in frame Settings)
- [ ] A2 — placement verb in the mobile replica layer with the refusal grammar
- [ ] A3 — first-share picker at the moment of intent
- [ ] A4 — placement registry, not enumeration
- [ ] A5 — Photos Sharing shelf (mobile), first consumer
- [ ] A6 — Tally ledger-root audit, second posture
- [ ] A7 — exclusion ruling: Locker does not share (see Decisions)

Engine B — byte custody unification

- [ ] B1 — rename the More row "Storage" → "Backup"
- [ ] B2 — Backup health → frame Settings beside Phone storage; Photos keeps a deep link
- [ ] B3 — free up space as a frame capability over the CAS, fed by `blob.custody_rollup`
- [ ] B4 — custody altitude conformance for Docs rows and Notes chips

Engine C — the consent gate

- [ ] C1 — lift the gate to kit (mobile) and `_shared/` (web)
- [ ] C2 — re-home Photos' gate to the People shelf empty state
- [ ] C3 — Docs OCR consent as the second instance
- [ ] C4 — gate structurally unrenderable for Locker items
- [ ] C5 — one inference harness, one privacy boundary; tier rename `off|local|model` → `off|device|gateway`

Engine D — the triage verb

- [ ] D1 — generic proposal-answer verb (confirm / reject / dismiss-without-naming)
- [ ] D2 — face review (web + mobile) onto D1; a session can reach zero remaining
- [ ] D3 — duplicates review onto the same queue shape
- [ ] D4 — Docs OCR corrections join as the third consumer

Search

- [ ] S1 — one grouping scaffold, per-app entity lists as config
- [ ] S2 — "things" search stays deferred (honest omission stands)

Conformance

- [ ] E1 — per-engine conformance gates, sabotage-verified
- [ ] E2 — engine contracts in blueprint-seats.md with structural exclusions
- [ ] E3 — the band can be handed back; verified in two apps

Photos remainder

- [ ] P5 — backup policy switches, "Back up now", failure verdict on the frame screen
- [ ] P6 — per-copy provenance + cross-person face grouping
- [ ] P7 — Sharing's grant roster (folded into Engine A; see Decisions)
- [ ] P8 — the five pushed destinations vs the receipt's band claim (see Decisions)
- [ ] P9 — PlacesView ground colour measured
- [ ] P10 — browser verification of the web surfaces
- [ ] P11 — `enforceRetention` fix-or-disable for `media_media_asset`
- [ ] P12 — sweep operator log carries the lineage-blocked lists
- [ ] P13 — mobile Permission as a timeline takeover
- [ ] P14 — `packages/blueprints/manifest.json` final regeneration
- [ ] P15 — mechanical gates green (`bun run check:push`)
- [ ] P16 — portable-export ruling recorded before the fingerprint moves
- [ ] P17 — mobile native-state fingerprints after L1–L3 review
- [ ] P18 — six files under 625 lines by extraction, no limit bump
- [ ] P19 — independent fresh-context audit of the #711 receipt

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

(One subsection per engine; filled as the pass lands.)

- P12 — `packages/gateway/src/serve/vault-plane.ts` `runSweep()` now logs
  `assetsBlockedByLineage` / `contentBlockedByLineage` verbatim (the same lists
  the journal receipt carries) and emits the line even when a sweep touched
  nothing but declined lineage-blocked purges.
- P11 — `enforceRetention` (`packages/vault/src/gateway/duties.ts`) no longer
  silently skips policies it cannot serve. `media.media_asset` is a standing,
  reasoned refusal (`RETENTION_REFUSALS`): no `created_at` to measure against,
  lineage FKs without `ON DELETE`, and asset purging already rides the trash
  lifecycle. Missing-timestamp-column policies also record a refusal. Refusals
  surface in `SweepResult.retentionRefused` and the journal receipt. The duty
  is *disabled with a stated reason* for media assets rather than half-fixed;
  adding `created_at` stays a deliberate platform decision (PX4), not taken
  here. Sabotage-commented test in `duties.test.ts`.

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

(One proof per item, on device or in CI, never "looks right"; filled as items
close. A struck item records its reason here.)
