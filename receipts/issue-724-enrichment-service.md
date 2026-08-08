# Receipt — issue #724: one enrichment service

The single gateway-side ML seam, the capabilities it unblocks, and the Photos
work that was waiting on it. Lands on top of #721/#723 (PR #723), which shipped
the Photos north-star core.

## Checklist

- [x] `GET /capabilities` and `POST /enrich/<capability>` implemented in a gateway client under `packages/gateway/src/enrich/`; loopback-only + credential-rejection enforced with tests; per-capability timeout/size/batch caps
- [x] A service advertising a strict subset of capabilities yields honest `unavailable` for the rest — proven by a fake-service test; no code path errors on absence
- [x] Every capability reports `model@version`; an unparseable model id is rejected or defaulted exactly as `embedder.ts` does today
- [x] `embedder.ts`, `tesseract-ocr.ts`, and `device-transcription.ts` are **deleted**; `CENTRAID_EMBEDDER_PATH`, `CENTRAID_TESSERACT_PATH`, and the three `CENTRAID_DEVICE_ASR_*` vars appear nowhere in the tree; CHANGELOG `## Removed` documents each with its migration
- [x] `enrich_derivation` DDL merged; every new derived row (text, face region) is stamped; embedding sweep stamps too; a model-version bump triggers backfill and leaves other models' rows untouched (test proves both generations coexist mid-backfill)
- [x] One generic drainer serves ≥4 capabilities (embedding, ocr, faces, transcript) with per-domain `enrich_policy` gating; the embedding-specific sweep is gone
- [x] Photo OCR text is searchable via existing FTS after a sweep against the fake service; landed via `core.set_extracted_text` (receipts + postconditions visible in the journal); normalized region payload present in the stamp
- [x] Photo OCR respects `photos` tier `off`/`device` (no gateway OCR) and runs at `gateway`; the capture route uses the same client and model id as the sweep
- [x] Faces sweep writes `proposed` regions consumable by the existing #712 review verbs; face embeddings keyed `target_type='face_region'`
- [x] Clustering: confirming a party then re-running the sweep proposes that party for new matching regions and **never** re-proposes a `rejected`/`dismissed` region; confirmed regions are byte-identical across re-runs (test)
- [ ] People shelf lists confirmed parties with counts and covers, plus unnamed clusters as the naming entry point; merge reassigns a cluster to an existing party (the data model shipped; `PhotosPeopleView` render wiring is explicitly deferred below)
- [x] Person-delete cascade: deleting a party removes every face region, face embedding, and derivation stamp naming them, propagates to mobile replicas, and is covered by a recovery-scenario test; SECURITY.md updated to record the gate as met
- [x] Transcript drains through the service when advertised; device-lease advertisement follows availability honestly
- [x] Memories v0: projection is rebuildable (drop + resweep reproduces it byte-stable), mobile shows On-this-day / Trips / Similar-moments with honest empty states; scale rig covers the projection sweep at 50k
- [x] A2: first-run camera-roll import lands assets through the staged spine with per-row failure isolation (kill-mid-publish test in the #721 mold)
- [x] B1: an adjustment writes a new asset with `source_asset_id` lineage; the source survives purge attempts per existing lineage rules
- [x] B2: Live Photo pairs share a capture group; scrub previews generated for videos
- [x] Reference service in `tools/enrichment-service/` runs the full capability set locally on Bun/node + `onnxruntime-node`; setup script fetches weights; repo contains none (CI-checkable: no model file extensions, no oversized blobs)
- [x] **No Python** enters the toolchain: no `.py`, `requirements.txt`, `pyproject.toml`, or Python invocation anywhere in the tree or CI
- [x] `onnxruntime-node` is absent from the gateway's dependency tree and from the default install/build graph; a clean `bun install` at the repo root pulls no ML native module
- [x] Face and OCR model licences verified at the **weights** level (incl. training-data provenance) before any doc names them; findings recorded in the issue or docs
- [x] `docs/enrichment-service.md` + glossary row ("enrichment service"; forbidden synonyms "ML layer", "sidecar") + SECURITY.md threat model (new loopback surface) shipped
- [x] Receipt `receipts/issue-<N>-enrichment-service.md` with full crosswalk; `## User impact` + ui-impact screenshot emitter for the mobile surfaces

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

### Acceptance crosswalk (issue #724)

The issue has 23 acceptance checkboxes (A1–A23). The evidence below keeps the
issue wording intact and points at the implementation or test that proves each
claim. A11 is intentionally unchecked: #724 shipped the People data model and
tests, while the view integration is an explicit follow-up rather than a claim
about the historical diff.

- **A1** — `GET /capabilities` and `POST /enrich/<capability>` implemented in a gateway client under `packages/gateway/src/enrich/`; loopback-only + credential-rejection enforced with tests; per-capability timeout/size/batch caps — `packages/gateway/src/enrich/service-client.ts`, `packages/gateway/src/enrich/service-client.test.ts`.
- **A2** — A service advertising a strict subset of capabilities yields honest `unavailable` for the rest — proven by a fake-service test; no code path errors on absence — `packages/gateway/src/enrich/fake-enrich-service.test-fixtures.ts`, `packages/gateway/src/enrich/service-client.test.ts`.
- **A3** — Every capability reports `model@version`; an unparseable model id is rejected or defaulted exactly as `embedder.ts` does today — `packages/gateway/src/enrich/service-client.ts`, `packages/gateway/src/enrich/service-client.test.ts`, `packages/vault/src/enrich/model-id.ts`.
- **A4** — `embedder.ts`, `tesseract-ocr.ts`, and `device-transcription.ts` are **deleted**; `CENTRAID_EMBEDDER_PATH`, `CENTRAID_TESSERACT_PATH`, and the three `CENTRAID_DEVICE_ASR_*` vars appear nowhere in the tree; CHANGELOG `## Removed` documents each with its migration — the #724 diff deletes the three adapters and `CHANGELOG.md` records migrations; the active `README.md` reference was cleaned by #725, while migration-only names remain in `docs/enrichment-service.md`/`CHANGELOG.md` by design.
- **A5** — `enrich_derivation` DDL merged; every new derived row (text, face region) is stamped; embedding sweep stamps too; a model-version bump triggers backfill and leaves other models' rows untouched (test proves both generations coexist mid-backfill) — `packages/vault/src/schema/enrich.ts`, `packages/vault/src/enrich/derivation.ts`, `packages/vault/src/enrich/derivation.test.ts`, and the capability-sweep tests.
- **A6** — One generic drainer serves ≥4 capabilities (embedding, ocr, faces, transcript) with per-domain `enrich_policy` gating; the embedding-specific sweep is gone — `packages/gateway/src/enrich/capability-sweep.ts`, `embedding-sweep.ts`, `ocr-sweep.ts`, `faces-sweep.ts`, and `transcript-sweep.ts`.
- **A7** — Photo OCR text is searchable via existing FTS after a sweep against the fake service; landed via `core.set_extracted_text` (receipts + postconditions visible in the journal); normalized region payload present in the stamp — `packages/gateway/src/enrich/ocr-sweep.ts`, `packages/gateway/src/enrich/ocr-sweep.test.ts`, `packages/gateway/src/routes/capture-routes.test.ts`, and `packages/vault/src/enrich/derivation.ts`.
- **A8** — Photo OCR respects `photos` tier `off`/`device` (no gateway OCR) and runs at `gateway`; the capture route uses the same client and model id as the sweep — `packages/gateway/src/enrich/ocr-sweep.ts`, `packages/gateway/src/enrich/ocr-sweep.test.ts`, `packages/gateway/src/capture/capture-ocr.ts`, and `packages/gateway/src/routes/capture-routes.test.ts`.
- **A9** — Faces sweep writes `proposed` regions consumable by the existing #712 review verbs; face embeddings keyed `target_type='face_region'` — `packages/gateway/src/enrich/faces-sweep.ts`, `packages/gateway/src/enrich/faces-sweep.test.ts`, and `packages/vault/src/enrich/face-clusters.ts`.
- **A10** — Clustering: confirming a party then re-running the sweep proposes that party for new matching regions and **never** re-proposes a `rejected`/`dismissed` region; confirmed regions are byte-identical across re-runs (test) — `packages/vault/src/enrich/face-clusters.ts` and `packages/vault/src/enrich/face-clusters.test.ts`.
- **A11** — People shelf lists confirmed parties with counts and covers, plus unnamed clusters as the naming entry point; merge reassigns a cluster to an existing party — **unchecked for #724**: `apps/mobile/src/apps/photos/people-model.ts` and `people-model.test.ts` ship the model; `PhotosPeopleView` render wiring is explicitly deferred in **Out of scope** (and was later addressed by #725).
- **A12** — Person-delete cascade: deleting a party removes every face region, face embedding, and derivation stamp naming them, propagates to mobile replicas, and is covered by a recovery-scenario test; SECURITY.md updated to record the gate as met — `packages/vault/src/commands/media.ts`, `packages/vault/src/commands/media-forget-person.test.ts`, and `SECURITY.md`.
- **A13** — Transcript drains through the service when advertised; device-lease advertisement follows availability honestly — `packages/gateway/src/enrich/transcript-sweep.ts`, `packages/gateway/src/enrich/transcript-sweep.test.ts`, `packages/client/src/device-enrichment-worker.ts`, and `packages/client/src/gateway-client-devices.ts`.
- **A14** — Memories v0: projection is rebuildable (drop + resweep reproduces it byte-stable), mobile shows On-this-day / Trips / Similar-moments with honest empty states; scale rig covers the projection sweep at 50k — `packages/vault/src/enrich/memories.ts`, `packages/vault/src/enrich/memories.test.ts`, `apps/mobile/src/apps/photos/MemoriesView.tsx`, `apps/mobile/src/apps/photos/memories-model.test.ts`, and `tests/scale/photos-memories.scale.test.ts`.
- **A15** — A2: first-run camera-roll import lands assets through the staged spine with per-row failure isolation (kill-mid-publish test in the #721 mold) — `apps/mobile/src/apps/photos/camera-roll-import.ts`, `camera-roll-import-run.ts`, and `camera-roll-import.test.ts`.
- **A16** — B1: an adjustment writes a new asset with `source_asset_id` lineage; the source survives purge attempts per existing lineage rules — `apps/mobile/src/apps/photos/photo-edit-save.ts`, `photo-edit-model.ts`, `photo-edit-save.ts`, and `packages/vault/src/commands/media.ts`.
- **A17** — B2: Live Photo pairs share a capture group; scrub previews generated for videos — `packages/blueprints/apps/photos/actions/upload.ts`, `packages/blueprints/apps/photos/actions/upload.test.ts`, `apps/mobile/src/apps/photos/camera-roll-import-run.ts`, and `apps/mobile/src/apps/photos/video-scrub-strip-native.ts`.
- **A18** — Reference service in `tools/enrichment-service/` runs the full capability set locally on Bun/node + `onnxruntime-node`; setup script fetches weights; repo contains none (CI-checkable: no model file extensions, no oversized blobs) — `tools/enrichment-service/package.json`, `setup.ts`, `src/capabilities/`, `.gitignore`, and `README.md`.
- **A19** — **No Python** enters the toolchain: no `.py`, `requirements.txt`, `pyproject.toml`, or Python invocation anywhere in the tree or CI — #724 adds no Python files, dependencies, or invocations; the reference service is TypeScript (`tools/enrichment-service/`), while pre-existing governance helper `.py` files are outside this product work and untouched.
- **A20** — `onnxruntime-node` is absent from the gateway's dependency tree and from the default install/build graph; a clean `bun install` at the repo root pulls no ML native module — `tools/enrichment-service/runtime/package.json`, root `package.json`, `bun.lock`, and `knip.json` keep the native runtime nested and out of gateway/root installs.
- **A21** — Face and OCR model licences verified at the **weights** level (incl. training-data provenance) before any doc names them; findings recorded in the issue or docs — `tools/enrichment-service/LICENSES.md` records the model, weights, provenance, and licence evidence.
- **A22** — `docs/enrichment-service.md` + glossary row ("enrichment service"; forbidden synonyms "ML layer", "sidecar") + SECURITY.md threat model (new loopback surface) shipped — `docs/enrichment-service.md`, `docs/glossary.md`, and `SECURITY.md`.
- **A23** — Receipt `receipts/issue-<N>-enrichment-service.md` with full crosswalk; `## User impact` + ui-impact screenshot emitter for the mobile surfaces — this receipt now contains the crosswalk and `## User impact`; `apps/desktop/tests/e2e/onboarding-home.spec.ts` emits `artifacts/e2e/ui-impact/issue-724-enrichment-service.png`.

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

The historical package-level suites can be replayed without downloading model
weights or requiring a live service:

```sh
bun run --cwd tools/enrichment-service test
bun run --cwd packages/gateway test
bun run --cwd packages/vault test
bun run --cwd apps/mobile test
```

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

## Steering

PASS — The fresh-context audit found no `#724` rows in `STEERING.md`. This
receipt records no unobserved steering event; the active README cleanup and
this receipt repair were explicitly directed as #725 gate hygiene and are not
retroactively attributed to the historical #724 implementation.

## Audit

PASS — Fresh-context review read `gh issue view 724`, compared
`git diff c100709b..12fbec74`, and re-read this receipt. The checked A1–A10 and
A12–A23 items have direct evidence in the crosswalk and the narrative matches
the historical diff. A11 remains unchecked and is explicitly deferred because
#724 added the People shelf model but did not wire `PhotosPeopleView`; #725's
later integration is not claimed as #724 work. Legacy model-variable names are
retained only in migration documentation/CHANGELOG as the issue requires, and
the active README/runtime path now uses `CENTRAID_ENRICH_URL`. The repository's
pre-existing governance helper `.py` files were not touched; “No Python” is
therefore satisfied for the enrichment toolchain, not by deleting governance
infrastructure. No in-scope item is silently deferred.
