# Receipt — issue #724: one enrichment service

The single gateway-side ML seam, the capabilities it unblocks, and the Photos
work that was waiting on it. Lands on top of #721/#723 (PR #723), which shipped
the Photos north-star core.

## Checklist

- [x] W1 — enrichment service contract + gateway client (`CENTRAID_ENRICH_URL`, loopback-only)
- [x] W1 — deletion of all three legacy ML paths and their env vars, no COMPAT shims
- [x] W2 — `enrich_derivation` provenance sidecar + model-versioned backfill for every capability
- [x] W3 — generic capability drainer; embedding sweep migrated onto it; device lane split
- [x] W4 — photo OCR end-to-end on PP-OCR, landing through `core.set_extracted_text`
- [x] W4 — capture route rewired to the service; Tesseract deleted
- [x] W5 — faces: detection, party-anchored clustering, `media.forget_person` cascade
- [x] W6 — transcript on the service; desktop ASR deleted
- [x] W7 — Memories v0 projection + mobile shelves
- [x] W8 — reference enrichment service (TypeScript, no Python), licences verified
- [x] W9 — A2 first-run camera-roll import; B1 adjustments with lineage; B2 video depth
- [x] Docs: `docs/enrichment-service.md`, glossary, decisions, CHANGELOG Removed entries
- [ ] `PhotosPeopleView` shelf render wiring (see **Out of scope**)
- [ ] Auto-enhance (see **Out of scope**)

## User impact

**First-run:** nothing changes until an owner points the gateway at an
enrichment service. With none configured, semantic search, OCR, faces and
transcript all answer honestly unavailable — the same posture #723 shipped for
semantic search — and Photos behaves exactly as before. Memories shelves and the
camera-roll import offer need no service at all and appear on first run.

With a service configured: text inside photographs becomes searchable through
the existing search field; "Detect faces" appears in the Photos library menu and
leads to the consent gate; naming one face cluster names every photograph in it;
Memories rails (On this day / Trips / Similar moments) fill in as a library
grows. Screenshot evidence: `artifacts/e2e/ui-impact/issue-724-enrichment-service.png`.

**Migrations for existing self-hosters** (no released version exists; these are
documented in CHANGELOG `## Removed`):

- `CENTRAID_EMBEDDER_PATH` → run an enrichment service, set `CENTRAID_ENRICH_URL`
- `CENTRAID_TESSERACT_PATH` → same; capture OCR now uses the service's `ocr`
- `CENTRAID_DEVICE_ASR_URL` → point the service's `ENRICH_SERVICE_TRANSCRIPT_URL`
  at the same whisper-compatible endpoint

## What changed

**The seam (W1).** `packages/gateway/src/enrich/service-client.ts` is the one
place the gateway reaches an ML runtime: `GET /capabilities` reporting a
`model@version` per capability, `POST /enrich/<cap>` batch-in/batch-out, over a
loopback-only URL with credentials-in-URL rejected — the validation design
promoted from the deleted `apps/desktop/src/main/device-transcription.ts`.
Unavailability is a status, never an exception, and it is per-capability: a
service advertising only `ocr` is legal. Client-enforced ceilings (16 items,
60s, 32 MB, dim ≤ 4096) live in the client, not the service.
`fake-enrich-service.test-fixtures.ts` is the shared loopback fake every
capability suite tests against, including its misbehaviours.

**Provenance (W2).** `enrich_derivation` (`packages/vault/src/schema/enrich.ts`,
helpers in `packages/vault/src/enrich/derivation.ts`) stamps every derived row
with the capability and `model@version` that produced it, keyed
`UNIQUE (target_type, target_id, variant)`. A model upgrade is therefore a
backfill, never a migration — `supersededTargets` selects exactly the rows an
upgrade invalidates. OCR stamps carry the normalized region payload
(`{regions:[{text,confidence,box}]}`), so region-level features later need zero
re-inference. This landed before any new text producer, deliberately: without it
an engine choice would have been a one-way door over FTS-indexed text.

**The drainer (W3).** `capability-sweep.ts` replaces the embedding-specific
sweep with one drainer parameterized by `CapabilitySweepSpec`. The sweep — not
the spec — owns the transaction, so no future capability can split the
value-write / stamp / request-drain invariant. Four specs ride it:
`embedding-sweep.ts`, `ocr-sweep.ts`, `faces-sweep.ts`, `transcript-sweep.ts`.
Apps never call the service: they enqueue consent-scoped `enrich_request` rows
and read vault tables through the consent-checked path.

**Lane split.** The device lease lane is now non-ML device-codec work only
(`previews`, `poster`, `pdfText`); everything ML is the service's. The DB CHECK
keeps accepting the legacy tokens per the edit-in-place precedent already argued
in that schema file; application code narrows.

**OCR (W4).** Text lands through `core.set_extracted_text` — the command
pipeline, for FTS triggers, receipts and postconditions — invoked from inside
the sweep's open transaction, which is safe because `beginInvocationTransaction`
uses `SAVEPOINT` when a transaction is already open. Gated on the `photos`
policy tier: an owner who set photos `off` meant the pixels, and text-in-pixels
is pixels. An empty OCR result stamps but writes no derivative, so backfill does
not loop.

**Faces (W5).** Detection is consent-gated — the sweep drains only
`enrich_request` rows tagged `capability='faces'`, never an ambient backfill.
Regions land `review_state='proposed'` into the review queue #712 built.
Clustering is party-anchored: centroids come from *confirmed* regions, so
identity lives in `core_party` and re-running never disturbs owner-authored
answers; strangers group by centroid-linkage agglomerative (0.30 propose / 0.22
group, min size 2), deliberately not the single-link union-find the phash
clusters use, because single-link chains two people together through faces
resembling both. `media.forget_person` (`risk: high`, confirm) proves the
cascade in a postcondition summing four counts to zero, with replica propagation
asserted through the change-log feed and a recovery export/import test.

**Transcript (W6).** A service capability reading original bytes — deliberately
unlike the photo sweeps, because a preview cannot be transcribed — with a 200 MB
skip ceiling.

**Memories (W7).** `media_memory` + `media_memory_member`, rebuilt wholesale in
the standing sweep in the phash-cluster mold: derived, never authored,
deterministic ids, byte-stable across rebuilds. Assets with no capture time
never appear in a date-based memory.

**Reference service (W8).** `tools/enrichment-service` is a workspace package
(so lint/typecheck/vitest/knip apply) whose native dependencies live in a nested
non-workspace `runtime/`, keeping `onnxruntime-node` and `sharp` out of the root
install graph and out of the gateway entirely. No Python. The pre/post-processing
Python would have provided is written in TypeScript and unit-tested without the
native runtime: BPE tokenizer, CTC decode, NMS, DB detection postprocess,
Umeyama alignment.

**Client work (W9).** First-run camera-roll import on the staged spine
(resumable, per-candidate isolation); editor adjustments with real
`source_asset_id` lineage; video scrub strips on iOS/Android with an honest
fallback elsewhere.

**Bugs found and fixed in passing.** `fts_core_content_item` indexed only
`variant='transcript'`, never `'text'` — photo OCR would have been silently
unsearchable. `enrich.derivation` was missing from `VAULT_TABLES`, so it had
neither export coverage nor replica triggers. Asset purge deleted face regions
without sweeping their poly-refs, which would have orphaned face vectors. The
Photos upload action validated `tz_offset_min` / `capture_group_id` /
`thumbhash` and then dropped them before `media.add_asset`, breaking Live Photo
pairing for every camera-roll upload.

## Out of scope

- **Auto-enhance (B1).** React Native gives no decoded pixel buffer without a
  new native dependency. Crop / rotate / straighten / flip ship; the limitation
  is documented in `photo-edit-model.ts` rather than faked.
- **`PhotosPeopleView` shelf render wiring.** `people-model.ts` and its tests
  ship; wiring `buildPeopleShelf` into that view's render is an integration
  leftover, and the walkthrough marks People **partial** accordingly. Two
  surfaces also count people differently (`confirmed_by_party_id` vs
  `confirmed_by_party_id ?? party_id`) — `people-model.ts` uses the strict rule.
- **Face merge/split management UI** beyond name and merge-into-existing.
- **Screenshot classifier** (open question 2 on the issue): likely derivable
  from OCR density with no new model — fast-follow.
- **Region-level OCR UI** (tap-a-word). The data is preserved by W2.
- **Bulk staged import over HTTP.** A2 stages per photo/pair because
  `sync.stage_rows` has no HTTP door for mobile yet.
- **E6 device-side inference** — dead by decision, recorded in `docs/decisions.md`.
- **C3–C6 blindspot passes** — human D2-ritual work by construction; the new
  checklist item #9 covers the enrichment surfaces.

## Decisions

- **Full deletion over COMPAT shims.** The repo has zero release tags and the
  CHANGELOG carries only `[Unreleased]`; `embedder.ts` was never on `main`, and
  `CENTRAID_TESSERACT_PATH` appeared in no doc. Shims would have protected
  nobody while taking the integration-shape count from four to three instead of
  to one — failing the issue's own goal.
- **PP-OCR only for v0.** One engine, no fallback matrix, no dual-quality
  reasoning in the sweep. W2 makes the engine reversible.
- **No Python in the toolchain.** The repo stays single-language; the cost is
  hand-written pre/post-processing, which is unit-tested.
- **MobileCLIP rejected on licence.** Apple's weights ship under the Apple
  Sample Code License, not a permissive one; CLIP ViT-B/32 (MIT) used instead,
  per the issue's documented fallback. Full table in
  `tools/enrichment-service/LICENSES.md`.
- **Faces consent is a library scan, not a subscription.** A vault-wide
  `capability='faces'` request licenses one pass and drains when exhausted;
  photographs imported afterwards need a fresh ask. Flagged on the issue in case
  the product wants standing consent instead.
- **`target_type` uses qualified logical names** (`media.face_region`), because
  `cleanupPolyRefs` / `resolveEntity` only work with the qualified form.

Approved deviation, quoted verbatim from
`tests/quality/classification-ratchet.json` so the gate can find it here:

> #724 enrichment service: quality-knob and classification fingerprints re-pinned for issue #724 — the schema gained enrich_derivation, media_face_cluster, media_memory, and media_memory_member, and tests/matrix.json gains the memories scale rig alongside #721's photos.scale-50k flow. No budget was widened and no gate was removed; reviewed with the umbrella receipt.

## Verification

- `bun run typecheck` — 35/35 tasks pass across every package
- `bun run lint` (oxlint, `--deny-warnings`) — clean
- `bun run knip` — clean (exit 0)
- `bun run format` — applied
- Package suites, run by each workstream against the integrated tree: vault
  1189, gateway 1389, client 2009, mobile 1108, blueprints 2067, desktop 280,
  `tools/enrichment-service` 100
- `apps/mobile` `src/apps/photos/` re-run after integration fixes — 42 files,
  456 tests pass
- `packages/blueprints` `apps/photos/actions/upload.test.ts` — 2 pass
- Scale rig: `rebuildMemories` at 50k assets registered in
  `tests/quality-rig-budgets.json` and `tests/matrix.json`
- `lint:schema-export` green; `tests/schema-export-fingerprint.json` re-pinned
- Not run: `bun run test` repo-wide in one turbo pass (the parallel run
  exhausted host memory, exit 137); per-package suites above cover the same
  files. Governance and push gates skipped at the maintainer's instruction —
  CI enforces.
- Not verified by construction: the reference service's three ONNX
  tensor-layout assumptions need a real forward pass after `bun run setup`
  downloads weights (documented in its README "Known gaps"). PR CI never loads
  models by design.
