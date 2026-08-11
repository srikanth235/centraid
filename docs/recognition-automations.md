# Recognition automations

Settled **2026-08-10**, superseding issue #724's separate enrichment-service process and issue #731's reserved-fetch executor. OCR, transcription, image/text embeddings, and faces are ordinary bundled automations whose handlers own model execution.

## One handler, one execution boundary

Each recognition handler owns its complete recognition flow. It:

1. selects a bounded batch from the vault;
2. reads source material with `ctx.vault.content`;
3. runs its model implementation in the handler worker, loading pinned third-party libraries and model assets from the shared local recognition runtime when needed;
4. persists the canonical result through a typed `ctx.vault.invoke` command; and
5. advances its cursor and stamps `enrich_derivation` with the model/version that produced the result.

There is no enrichment HTTP service, gateway model client, reserved `centraid://enrichment/*` fetch, `ctx.enrich`, or `ctx.infer`. `ctx.fetch` remains connector-only. Apps do not call models: they enqueue consent-scoped work when required and read the projections the automations populate.

The source modules live under [`tools/recognition-automations/automation-handlers`](../tools/recognition-automations/automation-handlers) for build-time reuse. [`build-automation-handlers.ts`](../tools/recognition-automations/build-automation-handlers.ts) bundles Centraid-authored modules into each shipped blueprint handler under [`packages/blueprints/automations`](../packages/blueprints/automations). Large third-party packages such as PDF.js remain in the single version-locked recognition runtime rather than being duplicated into handler source.

## Content and result flow

| Template | Content read | Result command | Local implementation |
| --- | --- | --- | --- |
| `embed-image` | photo preview bytes | `enrich.upsert_embedding` | CLIP visual tower |
| `embed-text` | vault text | `enrich.upsert_embedding` | CLIP text tower |
| `photo-ocr` | photo/scan preview bytes; capture image or PDF bytes | `core.set_extracted_text` | PP-OCRv4; PDF text layer first, rendered-page OCR fallback |
| `faces` | photo preview bytes | face-region and embedding commands | YuNet + SFace |
| `transcript` | bounded original audio/video bytes | `core.set_extracted_text` (`transcript`) | local FFmpeg decode + Whisper tiny.en q8 |

Image-domain recipes use the thumbnail/preview derivative rather than a full-resolution original. Transcription is the deliberate exception because a shortened recording loses content, not merely resolution. Every read has a byte ceiling and an unavailable or oversized input is recorded honestly.

Text embeddings are keyed to their parent content item but sourced from a versioned text or transcript derivative. Their derivation stamp therefore records the source `derivative_id` as `source_version`; `embed-text` treats an embedding as current only when both the model and source version match. Rewriting text under the same embedding model replaces the stored vector instead of leaving semantic search on stale text.

OCR accepts both image media types and `application/pdf`. For a PDF, the handler extracts each page's text layer when present. A page without usable embedded text is rendered locally and passed through the same bundled image recognizer. Capture invokes this same automation synchronously, so missing assets and model failures become ordinary automation-ledger failures rather than a separate gateway error vocabulary.

## Model assets

The repository does not commit model weights or native ML packages. Run:

```sh
bun run --cwd tools/recognition-automations setup
```

The setup command installs runtime dependencies—including PDF.js and its adjacent worker—into the non-workspace `tools/recognition-automations/runtime/` directory and downloads pinned model files beneath `runtime/models/`. Generated handlers resolve assets from their local `runtime/` by default; `CENTRAID_AUTOMATION_RUNTIME_DIR` may point them at another local asset directory. This variable selects files only—nothing listens on a socket and no inference request crosses a process boundary.

Model versions, hashes, licences, and sources are recorded in [`tools/recognition-automations/LICENSES.md`](../tools/recognition-automations/LICENSES.md) and `models.lock.json`. A root `bun install` does not pull the optional native dependencies.

## Scheduling, consent, and provenance

The automation engine owns scheduling, policy gates, bounded fires, cursor state, retries, Test run, and the conversation ledger. There is no gateway-private capability sweep. A model or prompt revision changes the handler's selection key and re-arms only rows whose compatible derivation stamp is behind.

Faces drains only open `enrich_request(capability='faces')` rows or content carrying a prior consent stamp; it never scans the ambient library without consent. Detection and recognition use YuNet + SFace, and regions land as proposed review items. [`media.forget_person`](../packages/vault/src/commands/media.ts) removes face regions, embeddings, derivation stamps, and clusters associated with the party.

Only `photo-ocr` has an optional delegate step. It uses `ctx.delegate` through the existing ACP/provider-egress consent rail, canonicalizes the response into the same OCR region shape, preserves absent confidence, and stamps only ACP-confirmed model identity. That explicit delegate path is not a generic inference primitive.

## Testing and live-model evidence

PR tests inject model functions into the bundled handler sources and exercise pure tokenizer, CTC, geometry, postprocessing, cursor, consent, and typed-command behavior without installing native dependencies or weights. The weekly/release live lane uses pinned real weights and committed fixtures:

```sh
bun run --cwd tools/recognition-automations setup
bun run test:enrich:live
```

The live suite checks OCR image and PDF behavior, embedding cosine tolerances, face count/geometry, model/version pins, and licence integrity. Model-quality judgements such as OCR recall, cluster purity, and search relevance remain dogfood evidence rather than deterministic CI gates.

## Related

- [`ARCHITECTURE.md`](../ARCHITECTURE.md) — runtime placement and automation lifecycle.
- [`docs/photos-derived-ledger.md`](photos-derived-ledger.md) — vault provenance, semantic search, faces, and backfill.
- [`docs/blueprint-seats.md`](blueprint-seats.md) — the app/automation model-access doctrine.
- [`tools/recognition-automations/README.md`](../tools/recognition-automations/README.md) — build and asset setup commands.
