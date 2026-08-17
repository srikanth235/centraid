# Recognition automations

OCR, transcription, image/text embeddings, and faces are bundled automations whose handlers own model execution.

## One handler, one execution boundary

Each recognition handler owns its complete recognition flow. It:

1. selects a bounded batch from the vault;
2. reads source material with `ctx.vault.content`;
3. runs its model implementation in the handler worker, loading pinned third-party libraries and model assets from the shared local recognition runtime when needed;
4. persists the canonical result through a typed `ctx.vault.invoke` command; and
5. advances its cursor and stamps `enrich_derivation` with the model/version that produced the result.

There is no enrichment HTTP service, gateway model client, reserved `centraid://enrichment/*` fetch, `ctx.enrich`, or `ctx.infer`. `ctx.fetch` remains connector-only. Apps do not call models: they enqueue consent-scoped work when required and read the projections the automations populate.

The source modules live under [`packages/model-runtime/automation-handlers`](../packages/model-runtime/automation-handlers) for build-time reuse. [`build-automation-handlers.ts`](../packages/model-runtime/build-automation-handlers.ts) bundles Centraid-authored modules into each shipped blueprint handler under [`packages/blueprints/automations`](../packages/blueprints/automations). Large third-party packages such as PDF.js remain in the single version-locked recognition runtime rather than being duplicated into handler source.

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
bun run --cwd packages/model-runtime setup
```

The setup command installs runtime dependencies—including PDF.js and its adjacent worker—into the non-workspace `packages/model-runtime/runtime/` directory and downloads pinned model files beneath `runtime/models/`. Generated handlers resolve assets from their local `runtime/` by default; `CENTRAID_AUTOMATION_RUNTIME_DIR` may point them at another local asset directory. This variable selects files only—nothing listens on a socket and no inference request crosses a process boundary.

Model versions, hashes, licences, and sources are recorded in [`packages/model-runtime/LICENSES.md`](../packages/model-runtime/LICENSES.md) and `models.lock.json`. A root `bun install` does not pull the optional native dependencies.

## Scheduling, consent, and provenance

The automation engine owns scheduling, policy gates, bounded fires, cursor state, retries, Test run, and the conversation ledger. There is no gateway-private capability sweep. A model or prompt revision changes the handler's selection key and re-arms only rows whose compatible derivation stamp is behind.

Faces drains only open `enrich_request(capability='faces')` rows or content carrying a prior consent stamp; it never scans the ambient library without consent. Detection and recognition use YuNet + SFace, and regions land as proposed review items. [`media.forget_person`](../packages/vault/src/commands/media.ts) removes face regions, embeddings, derivation stamps, and clusters associated with the party.

## Delegate variants and engine profiles

Two enrichers ship a delegate variant: `photo-ocr` (`ocr`) and `doc-text-extractor` (`doc-text`). A delegate variant uses `ctx.delegate` through the existing ACP/provider-egress consent rail, canonicalizes the response into the same typed command the deterministic path writes, preserves absent confidence, and stamps only ACP-confirmed model identity — never the model id that was asked for. That explicit delegation path is not a generic inference primitive, and no other capability has one. `faces` never will: face recognition is biometric identification and admits no delegate profile at all (`enrich/engine-profiles.ts`).

**Which variant runs is a policy answer, not a manifest field.** `manifest.enrich.delegateStep` DECLARES that a delegate variant exists — the prompt revision the handler ships, the honest latency, the consequence of switching. The choice is the engine profile the policy cascade resolves for the capability (`enrich/engine-profiles.ts`, `automation/fire/enrich-resolve.ts`): a profile bound to a harness selects the delegate variant and carries its model, config pins and prompt revision into the fire and onto the dispatch surface. The manifest's own `selected: "delegate"` remains honoured as the pre-existing per-recipe switch, and a vault with no rules and no profiles fires exactly what it fired before.

Consequences of that seam, each enforced on the fire path:

- A delegate variant with no pinned model anywhere is refused before any dispatch surface opens. Consent is decided once, upstream, at the one enrichment gate; engine details are read only after it allowed the run.
- A delegate profile selected for a capability whose handler has **no** delegate code path — the embedding capabilities today — is inert: the deterministic engine runs, the input is untouched, nothing reaches a provider, and the selection is logged. A future engine can be selected for `embed-*` without a policy change; this build simply ships no delegate implementation for them.
- A profile may pin a prompt revision, but the prompt text belongs to the handler: a handler refuses a revision it does not ship rather than stamping one it did not send.
- Derivation stamps carry the profile that produced them (`enrich_derivation.profile`, defaulting to `built-in`), and handlers read and re-derive per profile. Two profiles' answers for one target are two rows, never a re-derivation loop.

`doc-text` has no bundled deterministic engine — extracting text from a scan is a model turn either way, which is why it declares `lane: "gateway"` and ships disabled. Its variants are therefore "the engine this vault runs automations on" versus "the engine the member bound `doc-text` to", the latter pinned, prompt-revisioned and stamped.

## Testing and live-model evidence

PR tests inject model functions into the bundled handler sources and exercise pure tokenizer, CTC, geometry, postprocessing, cursor, consent, and typed-command behavior without installing native dependencies or weights. The weekly/release live lane uses pinned real weights and committed fixtures:

```sh
bun run --cwd packages/model-runtime setup
bun run test:enrich:live
```

The live suite checks OCR image and PDF behavior, embedding cosine tolerances, face count/geometry, model/version pins, and licence integrity. Model-quality judgements such as OCR recall, cluster purity, and search relevance remain dogfood evidence rather than deterministic CI gates.

## Related

- [`ARCHITECTURE.md`](../ARCHITECTURE.md) — runtime placement and automation lifecycle.
- [`docs/photos/derived-ledger.md`](photos/derived-ledger.md) — vault provenance, semantic search, faces, and backfill.
- [`docs/blueprint-seats.md`](blueprint-seats.md) — the app/automation model-access doctrine.
- [`packages/model-runtime/README.md`](../packages/model-runtime/README.md) — build and asset setup commands.
