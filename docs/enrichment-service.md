# The enrichment service (issue #724)

Settled **2026-08-07** (issue #724). The one seam between the gateway and every model that derives something from a member's bytes, and the reference implementation that speaks it.

## One seam, not four

Before this issue the gateway reached models through a different mechanism per capability — a spawned embedder program (`CENTRAID_EMBEDDER_PATH`), a spawned Tesseract OCR process (`CENTRAID_TESSERACT_PATH`), and a desktop-only on-device ASR adapter (`CENTRAID_DEVICE_ASR_URL`) reachable only from Electron's main process. Each had its own configuration, its own timeout, its own failure vocabulary, and its own answer to "is this switched on here?". All three are gone. Every model-derived capability now goes through one client, [`packages/gateway/src/enrich/service-client.ts`](../packages/gateway/src/enrich/service-client.ts), talking to one HTTP service the owner points at with `CENTRAID_ENRICH_URL`.

Apps never call the service directly. An app's job is to enqueue an `enrich_request` row (consent-scoped, per [docs/photos-derived-ledger.md](photos-derived-ledger.md)) or read the vault tables a sweep already populated — the same "queue is the database" posture issue #721 E2 shipped, now shared by every capability.

## The wire contract

Frozen; verify any change against [`service-client.ts`](../packages/gateway/src/enrich/service-client.ts) directly rather than this doc, which only mirrors it.

```
GET /capabilities
  -> 200 {"capabilities": {"<cap>": {"model": "<name>@<version>"}}}

POST /enrich/<cap>   {"items": [ … ]}
  -> 200 {"model": "<name>@<version>", "results": [ … ]}
  -> 404 {"error": "unavailable"}   (capability not advertised)
```

`results` are in **request order**, one per item, each either the capability's success payload or `{"id", "error"}` — one item the model cannot read costs one result, never the batch. A model id that does not parse as `"<name>@<version>"` ([`packages/vault/src/enrich/model-id.ts`](../packages/vault/src/enrich/model-id.ts)) is treated as if the capability were not advertised at all: a row keyed under an unparseable model can never be found again by a backfill query.

| Capability | Item | Result |
| --- | --- | --- |
| `embed-image` | `{id, mediaType, bytes(base64)}` | `{id, vector[]}` |
| `embed-text` | `{id, text}` | `{id, vector[]}` |
| `ocr` | `{id, mediaType, bytes, originalWidth?, originalHeight?}` | `{id, regions[{text, confidence, box}]}` |
| `faces` | same shape as `ocr` | `{id, faces[{box, confidence, embedding[]}]}` |
| `transcript` | `{id, mediaType, bytes}` | `{id, text, confidence?}` |

Boxes are `[x, y, w, h]` integers, origin top-left, expressed in the **original** image's pixels when the item declared `originalWidth`/`originalHeight` — the service downscales for its own model and the caller never has to know by how much. `service-client.ts` validates every returned box against the declared dimensions and refuses one that runs past them.

## Config

| Variable | Purpose |
| --- | --- |
| `CENTRAID_ENRICH_URL` | Base URL of the enrichment service. Must resolve to loopback (`localhost`, `::1`, `127.x.x.x`) over `http:`/`https:`; a non-loopback host, credentials embedded in the URL, or an unparseable URL are all read as "not configured" rather than an error — there is no code path where a member's bytes leave the host. |
| `CENTRAID_ENRICH_TOKEN` | Optional. Sent as `Authorization: Bearer`, never folded into the URL (a URL ends up in logs; a header doesn't). |

Client-enforced ceilings, regardless of what the service would allow: 16 items per batch (`MAX_ENRICH_BATCH`), 60s batch timeout, 15s capabilities-probe timeout, 32MB response cap, and a 4096-dimension vector ceiling (matches `enrich.upsert_embedding`'s own limit).

## Honest unavailability

Nothing in `service-client.ts` throws because a service is absent, asleep, out of date, or missing the capability asked for — those are the ordinary states of a gateway whose owner has not switched enrichment on. Every such case comes back as `{status: "unavailable", reason}`, never an exception, so a background sweep or a search route can say "not available here" without rendering a failure. Only a caller bug (an empty or oversized batch) throws.

## Provenance and backfill

Every derived row gets a stamp in `enrich_derivation` ([`packages/vault/src/schema/enrich.ts`](../packages/vault/src/schema/enrich.ts)), `UNIQUE(target_type, target_id, variant)`, recording the capability, the `"<name>@<version>"` model that produced it, and an optional small JSON payload. [`packages/vault/src/enrich/derivation.ts`](../packages/vault/src/enrich/derivation.ts) owns two operations: `stampDerivation` (upsert the stamp — re-running the same derivation replaces it, since a target has one producer at a time) and `supersededTargets` (the backfill selector: targets stamped under an older version of the model running now, decided by `isSupersededBy` in JS because a lexicographic string comparison would put `clip@10` before `clip@2`). A stamp from a different model family, or one that fails to parse, is deliberately **not** superseded — it belongs to an index this model does not own.

OCR stamps carry the normalized region payload (`{regions: [{text, confidence, box}]}`) exactly as the service answered, so a later region-level feature (drawing a box, re-ordering text) needs no re-inference — the stamp already has it.

## The generic sweep

[`packages/gateway/src/enrich/capability-sweep.ts`](../packages/gateway/src/enrich/capability-sweep.ts) is the one bounded pass shared by every capability. A `CapabilitySweepSpec` supplies the three things that differ per capability — which rows are behind (`selectBacklog`), what bytes to send (`buildItem`), and where the answer lands (`apply`) — and the sweep owns everything that is hard and must not drift: the consent gate (checked **before** the service is even probed, so an `off`/`device` domain tier produces no request and no traffic), the batch cap, per-item failure isolation, and the stamp+drain transaction. The derivation stamp and the `enrich_request.drained_at` mark commit together with the derived value in one transaction — a stamp without its value would tell the next sweep the work is done when nothing was produced; a drain without its value would silently answer a member's ask with nothing, invisible to any later repair pass.

| Capability | Spec | Policy domain | Consent posture | Where results land | Model id (reference service) |
| --- | --- | --- | --- | --- | --- |
| `embed-image` | [`embedding-sweep.ts`](../packages/gateway/src/enrich/embedding-sweep.ts) | photos | ambient backfill at the domain's `gateway` tier | `enrich_embedding` | `clip-vit-b-32@1` |
| `ocr` | [`ocr-sweep.ts`](../packages/gateway/src/enrich/ocr-sweep.ts) | photos | ambient backfill at the domain's `gateway` tier | `core_content_derivative` (`variant='text'`) via `core.set_extracted_text` | `pp-ocrv4@1` |
| `faces` | [`faces-sweep.ts`](../packages/gateway/src/enrich/faces-sweep.ts) | photos | consent-gated: only drains `enrich_request` rows tagged `capability='faces'` (per-asset or a standing vault-wide ask); a stamp from an older model is the one exception, since it is proof of past consent for that photograph | `media_face_region` (`review_state='proposed'`) + `enrich_embedding` | `yunet-sface@1` |
| `transcript` | [`transcript-sweep.ts`](../packages/gateway/src/enrich/transcript-sweep.ts) | docs | ambient backfill at the domain's `gateway` tier | `core_content_derivative` (`variant='transcript'`) via `core.set_extracted_text` | `whisper-proxy@1` (proxy; see below) |

OCR and transcript both land through the `core.set_extracted_text` command rather than a raw insert, so FTS refresh triggers, receipts, and the write postcondition all apply the same way every other content-derivative writer gets them. Both specs write **honest empty**: a photograph with no legible text, or a recording the service could not transcribe, still gets its derivation stamp (so the backfill does not loop over it forever) but no text derivative — an empty string is refused by `core.set_extracted_text`'s own schema, and a placeholder would make "nothing found" indistinguishable from "derivation failed".

Faces is the one capability with its own consent tag, separate from the domain-tier gate every other capability answers to alone — a face asserts an identity, which the pixels-only capabilities (OCR, embeddings) do not. See [Faces](#faces) below.

## Lane split: device lease vs. the enrichment service

The on-device lease lane (a phone or other device volunteering idle compute) is narrowed to **non-ML, device-codec work only**: `poster` and `pdfText` (`WORK_CAPABILITIES` in [`packages/client/src/device-enrichment-worker.ts`](../packages/client/src/device-enrichment-worker.ts)). Every ML capability — embeddings, OCR, faces, transcripts — runs on the gateway's enrichment service exclusively; no device advertises or leases them any more.

## Derivatives, never originals (with one exception)

Every photo-domain spec reads a target's `preview` or `thumb` derivative, never the member's full-resolution original — a preview already carries the detail a vision model needs. `transcript-sweep.ts` is the one deliberate exception: a recording's "preview" would be missing words, not just fewer pixels, so it reads `core_content_item`'s **original** bytes, bounded by a 200MB skip ceiling (a recording over that size is skipped rather than read whole into memory and posted to a local service).

## Faces

Detection and recognition (YuNet + SFace) run through the service; regions land in the [#712 review queue](photos-derived-ledger.md) as `review_state='proposed'`. Grouping ([`packages/vault/src/enrich/face-clusters.ts`](../packages/vault/src/enrich/face-clusters.ts)) is party-anchored: centroids computed from **confirmed** regions propose "is this X?" against unmatched proposed faces (cosine distance ≤ 0.30); strangers left over are grouped by centroid-linkage agglomerative clustering (≤ 0.22, minimum group size 2) rather than single-link chaining, because a chain of pairwise-similar faces can walk from one person to another through people who resemble both. Both thresholds sit inside the published operating point deliberately — a false merge costs a member trust in a way a false split never does. Rebuilds are byte-stable (deterministic region ids from `(asset, model, box)`) and never cross a model boundary: comparisons only happen within one embedding model at a time. Grouping projects into `media_face_cluster`, a derived, rebuildable table.

`media.forget_person` (risk `high`, requires confirmation) is the delete path: its postcondition proves zero rows remain across face regions (by either the `party_id` or `confirmed_by_party_id` column), face embeddings, derivation stamps, and cluster rows for that party. It does **not** delete the `core_party` itself — forgetting who is in your photographs and deleting a person from your address book are different acts. Replica propagation is proven by test via the change-log triggers, and a recovery export/import test covers the same guarantee across a restore.

On mobile, [`apps/mobile/src/apps/photos/people-model.ts`](../apps/mobile/src/apps/photos/people-model.ts) unifies confirmed parties, proposed candidates, and unnamed clusters into one roster; the "Detect faces" menu row navigates to the consent gate (`EnrichmentConsent`) rather than starting a scan silently.

## Running the reference service

[`tools/enrichment-service`](../tools/enrichment-service) is a workspace package (TypeScript on Bun, no Python anywhere). Its native/ML dependencies (`onnxruntime-node`, `sharp`) live only in `tools/enrichment-service/runtime/`, which is **not** a workspace package — a root `bun install` never pulls them in.

```sh
bun run --cwd tools/enrichment-service setup   # installs runtime deps + downloads model weights
bun run --cwd tools/enrichment-service serve   # binds 127.0.0.1:8787 by default
```

The repo ships no model weights; `setup` downloads them. Point the gateway at the running service with:

```sh
CENTRAID_ENRICH_URL=http://127.0.0.1:8787
```

Model choices and their licences are recorded in [`tools/enrichment-service/LICENSES.md`](../tools/enrichment-service/LICENSES.md): CLIP ViT-B/32 (MIT — MobileCLIP was the issue's first choice but was rejected, since Apple's weights carry the non-permissive Apple Sample Code License), PP-OCRv4 (Apache-2.0), YuNet and SFace (MIT / Apache-2.0). `transcript` ships no bundled model at all — the service proxies to an OpenAI-compatible `/v1/audio/transcriptions` endpoint named by `ENRICH_SERVICE_TRANSCRIPT_URL`, and only advertises `transcript` in `/capabilities` once that endpoint answers a liveness probe.

**Real-weight evidence.** Issue #725 closes the former tensor-layout gap with a scheduled/manual live lane. `models.lock.json` pins the runtime inputs; committed OCR, embedding, and face fixtures pass through the actual ONNX exports; the suite checks capability/model handshake, OCR text and geometry tolerance, embedding cosine tolerance, face count/geometry, and licence pins. The default suite still proves the pure TypeScript math without native dependencies or weights. Run `bun run --cwd tools/enrichment-service setup` followed by `bun run test:enrich:live` after any model/preprocessing change and before releases; the health report treats evidence as stale after eight days and absent evidence as grey.

## Deletions and migrations

All three deleted mechanisms had zero released users (this repo carries no release tags), so each is a plain deletion, not a deprecation:

- **`CENTRAID_EMBEDDER_PATH` / `CENTRAID_EMBEDDER_MODEL`** (spawned embedder process) — replaced by the enrichment service's `embed-image` capability. Point `CENTRAID_ENRICH_URL` at a running service.
- **`CENTRAID_TESSERACT_PATH`** (spawned Tesseract OCR) — replaced by the service's `ocr` capability. The capture route's live single-shot OCR ask ([`packages/gateway/src/capture/capture-ocr.ts`](../packages/gateway/src/capture/capture-ocr.ts)) now calls the service; its 503-when-unconfigured contract is unchanged, only its source.
- **`CENTRAID_DEVICE_ASR_URL` / `_TOKEN` / `_MODEL`** (desktop on-device ASR adapter) — desktop now advertises `transcript: false` permanently. If you were running whisper.cpp against the old adapter, point the enrichment service's `ENRICH_SERVICE_TRANSCRIPT_URL` at your whisper-compatible endpoint instead; the service proxies to it.

## Related

- [`packages/gateway/src/enrich/service-client.ts`](../packages/gateway/src/enrich/service-client.ts) — the wire client, config, and caps.
- [`packages/gateway/src/enrich/capability-sweep.ts`](../packages/gateway/src/enrich/capability-sweep.ts) — the generic sweep every capability rides.
- [`packages/vault/src/enrich/derivation.ts`](../packages/vault/src/enrich/derivation.ts) — the provenance stamp and supersession query.
- [`packages/vault/src/enrich/face-clusters.ts`](../packages/vault/src/enrich/face-clusters.ts) — party-anchored matching and stranger grouping.
- [`packages/vault/src/commands/media.ts`](../packages/vault/src/commands/media.ts) — `media.forget_person`.
- [`tools/enrichment-service`](../tools/enrichment-service) — the reference implementation, its README, and `LICENSES.md`.
- [docs/photos-derived-ledger.md](photos-derived-ledger.md) — the vault-side derived-data foundation this seam feeds.
- [docs/mobile-offline.md](mobile-offline.md) — the device-lease lane's remaining non-ML capabilities.
