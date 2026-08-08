# issue-721 — Photos toward its north star: the structural core

Issue: [#721](https://github.com/srikanth235/centraid/issues/721)

This receipt supersedes the earlier CI-repair receipt for the same issue (the
branch consolidation that kept PR #722's reviewed diff evaluable); its
accounting rows are preserved below. The work recorded here is the umbrella's
structural core, cut along the issue's own "Suggested sequencing".

## Checklist

- [x] Takeout photo importer on the existing staging spine
- [x] Adversarial fixture library and 50k scale rig
- [x] Derived-intelligence foundation: model-versioned ledger, gateway indexer, semantic search
- [x] Mobile surfaces: semantic hit group, key photo, Videos shelf, sqliteVec build flag
- [x] Docs: derived ledger, dogfood ritual, switcher walkthrough
- [ ] A2 first-run camera-roll import
- [ ] B1 light/colour editing and auto-enhance
- [ ] B2 video and Live Photo playback depth
- [ ] B4 OCR sweep (consent rails exist; the gateway sweep does not)
- [ ] B6 structural Memories
- [ ] C3–C6 blindspot passes (offloaded-at-scale, limited access, two-device conflict, undated volume)
- [ ] E4 faces (blocked on permissively-licensed detector/embedder weights)
- [ ] E6 device-side indexing (explicitly next-version)

## What changed

### Takeout photo importer on the existing staging spine

Workstream A1. The zip walker in [packages/vault/src/ingest/stage-file.ts](../packages/vault/src/ingest/stage-file.ts)
gained a binary media route: media entries bypass the UTF-8 decode, land in the
content-addressed blob store via the same staging band the mbox attachment path
uses, and become `media.media_asset` candidates. Content sniffing settles the
extension's claim, so ten bytes of text named `photo.heic` stays honestly
unrouted. [packages/vault/src/ingest/takeout-sidecar.ts](../packages/vault/src/ingest/takeout-sidecar.ts)
(with [takeout-sidecar.test.ts](../packages/vault/src/ingest/takeout-sidecar.test.ts))
pairs Google's four sidecar naming conventions, parses capture time
(epoch-zero and missing stay `NULL`, never 1970), treats Takeout's zero-filled
`(0,0)` geo as absence, reconstructs albums from folder structure (year-folders
excluded), and derives Live Photo capture groups. Publishing goes through a new
publisher in [packages/vault/src/ingest/publishers.ts](../packages/vault/src/ingest/publishers.ts)
that reuses `media.add_asset`'s own primitives — extracted, not duplicated,
from [packages/vault/src/commands/media.ts](../packages/vault/src/commands/media.ts)
and [packages/vault/src/commands/flags.ts](../packages/vault/src/commands/flags.ts) —
with payload validation in [packages/vault/src/ingest/payload-schemas.ts](../packages/vault/src/ingest/payload-schemas.ts)
and end-to-end coverage in [packages/vault/src/ingest/takeout-photos.test.ts](../packages/vault/src/ingest/takeout-photos.test.ts).
Dedupe rides `core_content_item.sha256`; resumability is structural and tested
(re-import skips; a mid-publish failure re-imports as exactly the missing rows).
[packages/gateway/src/routes/import-routes.ts](../packages/gateway/src/routes/import-routes.ts)
lets base64 media bodies through without forcing the UTF-8 text decode and
labels the new entity type for review.

### Derived-intelligence foundation: model-versioned ledger, gateway indexer, semantic search

Workstreams E1/E2/E3, building on the enrichment schema that already existed.
[packages/vault/src/enrich/model-id.ts](../packages/vault/src/enrich/model-id.ts)
(+ [model-id.test.ts](../packages/vault/src/enrich/model-id.test.ts)) pins the
`"<name>@<version>"` model-identity convention so an upgrade is a backfill,
never a migration; [packages/vault/src/schema/enrich.ts](../packages/vault/src/schema/enrich.ts)'s
header now argues why there is no separate version or content-hash column.
[packages/gateway/src/enrich/photo-embeddings.ts](../packages/gateway/src/enrich/photo-embeddings.ts)
(+ [photo-embeddings.test.ts](../packages/gateway/src/enrich/photo-embeddings.test.ts),
which proves claiming, versioned rows, request draining, crash resume, and
policy gating against a stub embedder command)
is the indexing sweep — the queue is the database (`enrich_request` plus a
LEFT-JOIN backfill), batches of 16 on the hourly sweep clock in
[packages/gateway/src/serve/vault-plane.ts](../packages/gateway/src/serve/vault-plane.ts),
gated on the owner's `enrich_policy` gateway tier, embedding from
thumbnail/preview derivatives, never originals.
[packages/gateway/src/enrich/embedder.ts](../packages/gateway/src/enrich/embedder.ts)
is the opt-in external embedder command (`CENTRAID_EMBEDDER_PATH`, Tesseract
posture: shell-free spawn, timeouts, output caps), with
[embedder.test.ts](../packages/gateway/src/enrich/embedder.test.ts) and
[embedder.test-fixtures.ts](../packages/gateway/src/enrich/embedder.test-fixtures.ts).
sqlite-vec loads through a new `loadExtensions` hook in
[packages/vault/src/db.ts](../packages/vault/src/db.ts) (previewCodec injection
precedent), implemented in [packages/gateway/src/enrich/sqlite-vec.ts](../packages/gateway/src/enrich/sqlite-vec.ts):
per-connection load with `enableLoadExtension(false)` re-closed in a `finally`,
feature-detected, never failing the vault open.
[packages/gateway/src/enrich/semantic-search.ts](../packages/gateway/src/enrich/semantic-search.ts)
ranks with `vec_distance_cosine` over the existing BLOB column (no `vec0`
table) and falls back to the brute-force scan;
[semantic-search.test.ts](../packages/gateway/src/enrich/semantic-search.test.ts)
proves ranker parity, [sqlite-vec.test.ts](../packages/gateway/src/enrich/sqlite-vec.test.ts)
the load lifecycle. The owner-only route
[packages/gateway/src/routes/enrich-search-routes.ts](../packages/gateway/src/routes/enrich-search-routes.ts)
(+ [enrich-search-routes.test.ts](../packages/gateway/src/routes/enrich-search-routes.test.ts))
answers `{status: "unavailable"}` honestly when no embedder is configured; it is
mounted in [packages/gateway/src/serve/build-gateway.ts](../packages/gateway/src/serve/build-gateway.ts)
and classified in [packages/gateway/src/routes/route-security.ts](../packages/gateway/src/routes/route-security.ts).
`sqlite-vec` is a [packages/gateway/package.json](../packages/gateway/package.json)
dependency (lockfile: [bun.lock](../bun.lock)); the vault barrel
[packages/vault/src/index.ts](../packages/vault/src/index.ts) exports the new
model-id helpers.

### Mobile surfaces: semantic hit group, key photo, Videos shelf, sqliteVec build flag

Workstreams B4 (surface), B5, B3.
[apps/mobile/src/apps/photos/search-hits.ts](../apps/mobile/src/apps/photos/search-hits.ts)
(+ [search-hits.test.ts](../apps/mobile/src/apps/photos/search-hits.test.ts))
gained the `"semantic"` hit kind — one aggregate "Photos that look like…" row,
resolved against the loaded timeline;
[apps/mobile/src/apps/photos/PhotosSearch.tsx](../apps/mobile/src/apps/photos/PhotosSearch.tsx)
fires the debounced semantic fetch in its own effect so an unavailable or
unreachable gateway never touches the rest of search. Key photo:
[apps/mobile/src/apps/photos/photos-collections.ts](../apps/mobile/src/apps/photos/photos-collections.ts)
(+ [photos-collections.test.ts](../apps/mobile/src/apps/photos/photos-collections.test.ts))
now honors a member-chosen `cover_content_id` on the Collections rails,
[apps/mobile/src/apps/photos/PhotosCollectionsView.tsx](../apps/mobile/src/apps/photos/PhotosCollectionsView.tsx)
(+ [PhotosCollectionsView.test.tsx](../apps/mobile/src/apps/photos/PhotosCollectionsView.test.tsx))
passes it through, and a "Make key photo" row in
[apps/mobile/src/apps/photos/viewer-menu.ts](../apps/mobile/src/apps/photos/viewer-menu.ts)
(+ [viewer-menu.test.ts](../apps/mobile/src/apps/photos/viewer-menu.test.ts)),
wired in [apps/mobile/src/apps/photos/PhotoLightbox.tsx](../apps/mobile/src/apps/photos/PhotoLightbox.tsx),
fires the existing `set-album-cover` write. The Videos shelf reuses the
filtered-shelf door via [apps/mobile/src/apps/photos/PhotoStateView.tsx](../apps/mobile/src/apps/photos/PhotoStateView.tsx)
and [apps/mobile/src/navigation.ts](../apps/mobile/src/navigation.ts);
Screenshots/Panoramas/Selfies are deferred with the concrete reason recorded in
[apps/mobile/src/apps/photos/photos-library-menu.ts](../apps/mobile/src/apps/photos/photos-library-menu.ts)
and the collections model. The op-sqlite `sqliteVec` flag is declared in BOTH
[package.json](../package.json) and [apps/mobile/package.json](../apps/mobile/package.json)
(the iOS-podspec-vs-Android-gradle split), pinned by
[apps/mobile/src/lib/replica/op-sqlite-build-config.test.ts](../apps/mobile/src/lib/replica/op-sqlite-build-config.test.ts),
with [apps/mobile/src/lib/replica/replica-sqlite-vec-error.ts](../apps/mobile/src/lib/replica/replica-sqlite-vec-error.ts)
and an exported-but-not-yet-called probe in
[apps/mobile/src/lib/replica/op-sqlite-driver.ts](../apps/mobile/src/lib/replica/op-sqlite-driver.ts).

### Adversarial fixture library and 50k scale rig

Workstreams D1/C1/C2.
[apps/mobile/src/apps/photos/photos-fixtures.ts](../apps/mobile/src/apps/photos/photos-fixtures.ts)
gained deterministic named fixtures: all-undated, ten-k-one-day, date-line,
wrong-camera-clock, mostly-offloaded.
[apps/mobile/src/apps/photos/timeline-model.test.ts](../apps/mobile/src/apps/photos/timeline-model.test.ts)
now crosses the international date line, exercises the device-local fallback
branch, and files a wiped-clock 2003 capture honestly;
[apps/mobile/src/apps/photos/timeline-10k-one-day.test.ts](../apps/mobile/src/apps/photos/timeline-10k-one-day.test.ts)
budgets the degenerate one-day distribution in the PR lane.
[packages/vault/src/blob/exif-fixtures.ts](../packages/vault/src/blob/exif-fixtures.ts)
builds corrupt EXIF (truncated APP1, bad byte order, IFD offset past EOF, entry
overflow, epoch-zero timestamps) and
[packages/vault/src/blob/exif-adversarial.test.ts](../packages/vault/src/blob/exif-adversarial.test.ts)
proves extraction never throws and never fabricates.
[tests/scale/photos-timeline.scale.test.ts](../tests/scale/photos-timeline.scale.test.ts)
seeds 50k assets plus a 10k-one-day corpus and records drift-tracked
measurements, registered in [tests/quality-rig-budgets.json](../tests/quality-rig-budgets.json)
and as flow `photos.scale-50k` in [tests/matrix.json](../tests/matrix.json).

### Docs: derived ledger, dogfood ritual, switcher walkthrough

Workstreams D2/D3 plus the E-foundation's write-back.
[docs/photos-derived-ledger.md](../docs/photos-derived-ledger.md) (the E1/E2/E3
data model and its two sqlite-vec rules),
[docs/photos-dogfood.md](../docs/photos-dogfood.md) (the real-library ritual and
its known stuck-state regression classes),
[docs/photos-switcher-walkthrough.md](../docs/photos-switcher-walkthrough.md)
(the day-one script with honest shipped/partial/gap status per step), three new
index rows in [AGENTS.md](../AGENTS.md), a derived-data / face-data paragraph in
[SECURITY.md](../SECURITY.md)'s threat model, and the release note in
[CHANGELOG.md](../CHANGELOG.md).

### Gate ratchets moved by this change

The schema fingerprint moved on the comment-only enrich.ts header edit;
[tests/schema-export-fingerprint.json](../tests/schema-export-fingerprint.json)
is re-pinned and the export owner
[packages/vault/src/gateway/portable-export.ts](../packages/vault/src/gateway/portable-export.ts)
carries the #721 audit note (no table, column, or CHECK changed; export
completeness unaffected). The governed-classification ratchet
[tests/quality/classification-ratchet.json](../tests/quality/classification-ratchet.json)
is re-pinned for the route-security classification and the new matrix flow,
with an approvedDeviation naming this receipt.
[scripts/validate-ui-receipt.mjs](../scripts/validate-ui-receipt.mjs) and
[scripts/check-quality-knobs.mjs](../scripts/check-quality-knobs.mjs) no longer
crash on a receipt renamed away under a doc-integrity waiver (they read only
files present in the worktree), and
[apps/desktop/tests/e2e/onboarding-home.spec.ts](../apps/desktop/tests/e2e/onboarding-home.spec.ts)
gains test 2.6d emitting this change's visual evidence.

## User impact

A switching member can finally get their library in: a Google Takeout archive
drops onto the import surface, stages as a reviewable draft, and publishes
with real capture times, albums, Live Photo pairs, and byte-level dedupe.
Search grows a semantic hit group ("Photos that look like…") when the owner
configures an embedder on their gateway; a member-chosen album cover now shows
on the Collections rails instead of silently reverting to newest; a Videos
shelf joins Collections; and the viewer's overflow menu gains "Make key
photo".

**First-run:** on a fresh vault nothing new runs unasked — the embedding sweep
is triple-gated (an embedder must be configured by the owner, the enrichment
tier must be `gateway`, and the sweep touches only thumbnails, never
originals), and with no embedder configured semantic search answers honestly
`unavailable` while every other search plane works. Import stages as a draft;
nothing lands in the vault until the member publishes the review.

Visual evidence: `artifacts/e2e/ui-impact/issue-721-photos-north-star.png`,
emitted by `apps/desktop/tests/e2e/onboarding-home.spec.ts` (test 2.6d) with
Photos open in the app view.

## Out of scope

Everything unchecked above, deliberately: A2's first-run camera-roll flow; B1
light/colour editing; B2 video depth; the B4 OCR sweep (skipped because an OCR
derivative must land through the command pipeline for FTS/receipts, the `ocr`
capability is currently the device-lease lane, and the photos-vs-docs policy
domain is an unmade product decision — it needs its own issue); B6 structural
Memories; the C3–C6 blindspot passes; E4 faces (weights licensing is the
scheduling gate, and SECURITY.md now records the delete-cascade bar); E6
device-side indexing (next-version by the issue's own decision — the ledger's
first-writer-wins shape keeps it open). Screenshots/Panoramas/Selfies shelves
are deferred inside B3 because the bulk metadata path exposes no honest
subtype signal.

## Verification

```sh
bun run lint
bun run knip
bun run typecheck:affected
bun run test:affected
bun run test:matrix
bun run test:ratchet
node node_modules/vitest/vitest.mjs run --config vitest.scale.config.ts tests/scale/photos-timeline.scale.test.ts
```

The scale rig runs the single-file way CI's dedicated lane does; the full
`bun run test:scale` serially executes every rig in the repo and was not
re-run for this change. Package suites during development:
`bun run --filter=@centraid/vault test` (1154 passed),
`bun run --filter=@centraid/gateway test` (1347 passed),
`bun run --filter=@centraid/mobile test` (1058+ passed, including the new
fixture and search suites).

## Decisions

- **Scope cut along the issue's "Suggested sequencing".** The umbrella is a
  multi-release roadmap; this change ships its structural core (A1, D1+C1+C2,
  E1+E2+E3, B5, B3-honest-subset, B4-surface, D2+D3 docs) and records every
  deferral above rather than pretending breadth.
- **The embedder is an external command, not a bundled model.** Following the
  Tesseract precedent: no 100MB weights in the repo or install, no third-party
  upload, honest `unavailable` when unconfigured. Bundled CLIP is a follow-up.
- **No `vec0` virtual table.** Vectors stay in `enrich_embedding.vector`;
  sqlite-vec accelerates ranking as a pure function and brute-force cosine is
  the always-available fallback, so the extension is strictly additive.
- **`media.media_asset`, not a new entity name**, for imported photos — a
  second name would have split provenance from the vocabulary the vault
  already uses.
- **Screenshots/Panoramas shelves deferred** despite the issue listing them:
  the expo-media-library bulk path this app's 50k walk uses has no subtype
  field, and per-asset async lookups are the forbidden round-trip pattern. An
  honest Videos shelf shipped; the rest waits for an honest signal.
- **B4's OCR sweep skipped** for the three structural reasons in Out of scope.
- **Approved gate deviation** — #721 photos north-star core: route-security gains the owner-only /centraid/_vault/enrich/semantic-search classification and tests/matrix.json gains the photos.scale-50k scale flow; both reviewed with the umbrella receipt.
- **One receipt per issue**: the prior CI-repair receipt for #721 was renamed
  to this one (the directive forbids two receipts sharing an issue number);
  its accounting rows are preserved verbatim below.

## Audit

**Verdict: PASS.** A fresh-context sub-agent, handed only the diff, this
receipt, and `gh issue view 721`, spot-checked the vault open path
(`packages/vault/src/db.ts`), the semantic-search route and its mount, the
op-sqlite build-config pin in both manifests, the Takeout sidecar module, and
the AGENTS/SECURITY/CHANGELOG edits against the prose; re-ran the three
package suites and matched the claimed counts exactly (vault 1154, gateway
1347, mobile 1058); and confirmed the deferred items (OCR sweep, faces,
enhance) are genuinely absent from the diff. The checklist honestly maps the
umbrella issue's prose workstreams, checked = shipped, unchecked = deferred.

## Steering

**Verdict: PASS.** The session consisted of one initiating instruction
("work on the entire scope of #721 and create a PR, orchestrating
subagents") and zero subsequent user messages — no interrupts, no
corrections — so an empty steering ledger is the correct record.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019fdbbe-44e-1786098231-1 | codex | 019fdbbe-44eb-7a20-a8c6-da96d2b3badd | #721 | gpt-5.6-luna | 76396 | 0 | 750080 | 3443 | 79839 | 0.4302 | 76396 | 0 | 750080 | 3443 | fix(ci): make PR 722 governance and format compliant (#721) |
| codex-019fdbbe-44e-1786098278-1 | codex | 019fdbbe-44eb-7a20-a8c6-da96d2b3badd | #721 | gpt-5.6-luna | 5684 | 0 | 314368 | 663 | 6347 | 0.1027 | 82080 | 0 | 1064448 | 4106 | fix(ci): make PR 722 governance and format compliant (#721) |
| codex-019fdbbe-44e-1786098426-1 | codex | 019fdbbe-44eb-7a20-a8c6-da96d2b3badd | #721 | gpt-5.6-luna | 17882 | 0 | 774912 | 1016 | 18898 | 0.2537 | 99962 | 0 | 1839360 | 5122 | fix(ci): make PR 722 governance and format compliant (#721) |
| codex-019fdbbe-44e-1786098942-1 | codex | 019fdbbe-44eb-7a20-a8c6-da96d2b3badd | #721 | gpt-5.6-luna | 77970 | 0 | 5221888 | 6124 | 84094 | 1.5923 | 177932 | 0 | 7061248 | 11246 | fix(mobile): make replica status switch exhaustive (#721) |
| claude-code-aa5dc1b0-17a-1786105031-1 | claude-code | aa5dc1b0-17a0-4aa5-b626-38e8fb7bf8da | #721 | claude-fable-5 | 295 | 710717 | 23231625 | 315140 | 1026152 | 47.8755 | 295 | 710717 | 23231625 | 315140 | feat(photos): ship the north-star structural core — Takeout import, derived inte |
| claude-code-aa5dc1b0-17a-1786105088-1 | claude-code | aa5dc1b0-17a0-4aa5-b626-38e8fb7bf8da | #721 | claude-fable-5 | 6 | 12594 | 710607 | 780 | 13380 | 0.9071 | 301 | 723311 | 23942232 | 315920 | feat(photos): ship the north-star structural core — Takeout import, derived inte |
| claude-code-aa5dc1b0-17a-1786105153-1 | claude-code | aa5dc1b0-17a0-4aa5-b626-38e8fb7bf8da | #721 | claude-fable-5 | 8 | 6772 | 966111 | 2326 | 9106 | 1.1671 | 309 | 730083 | 24908343 | 318246 | feat(photos): ship the north-star structural core — Takeout import, derived inte |
| claude-code-aa5dc1b0-17a-1786105241-1 | claude-code | aa5dc1b0-17a0-4aa5-b626-38e8fb7bf8da | #721 | claude-fable-5 | 6 | 13965 | 732459 | 7110 | 21081 | 1.2626 | 315 | 744048 | 25640802 | 325356 | feat(photos): ship the north-star structural core — Takeout import, derived inte |
| claude-code-aa5dc1b0-17a-1786105302-1 | claude-code | aa5dc1b0-17a0-4aa5-b626-38e8fb7bf8da | #721 | claude-fable-5 | 2 | 2566 | 248808 | 281 | 2849 | 0.2950 | 317 | 746614 | 25889610 | 325637 | feat(photos): ship the north-star core — import, intelligence, fixtures (#721) - |
| claude-code-aa5dc1b0-17a-1786106013-1 | claude-code | aa5dc1b0-17a0-4aa5-b626-38e8fb7bf8da | #721 | claude-fable-5 | 158 | 104125 | 21523439 | 55403 | 159686 | 25.5967 | 475 | 850739 | 47413049 | 381040 |  |
