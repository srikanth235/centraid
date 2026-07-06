# issue-299 — enrichment spine: model-derived data as first-class ontology

GitHub issue: [#299](https://github.com/srikanth235/centraid/issues/299)

First principle: **derived data is ontology data, and it never outranks the
owner.** Enrichment invents no tables — captions land as
knowledge.annotation, machine tags as core.tag (confidence set, no party),
faces as media.face_region proposals, albums as core.collection drafts,
filing as core.content_item updates — and it rides the SAME staging spine
imports use, so idempotency, review, provenance and receipts come from
machinery that already exists. Egress is structural, not policy: agents can
only ever spell `thumb`, `preview` and `text` — originals have no spelling
on the agent surface.

## Checklist

- [x] Commit 1 — vault enrichment core + agent content surfaces (v10 schema, publishers, commands, auto-publish trust, `content` op, ctx.agent attachments, assistant vault_content)
- [x] Commit 2 — phase 1 enrichers: photo captions + doc text (blueprint automation templates)
- [x] Commit 3 — phase 2: screenshot/receipt cross-domain extraction + doc filing proposals; Photos client phash
- [ ] Commit 4 — phase 3: face proposal/confirm loop in Photos, near-duplicates, trip albums
- [ ] Commit 5 — phase 4: doc entity links w/ anchors, obligations → schedule, anchored-citation Q&A
- [ ] Commit 6 — phase 5: search-miss/on-view prioritization wiring + receipts polish

## What changed

Commit 1 — vault enrichment core + agent content surfaces:

- `packages/vault/src/schema/enrich.ts` (new, v10) — `media_asset_phash`
  sidecar (the issue sketched a column; ADD COLUMN cannot be written
  re-runnably and a v8-style rebuild would cross media_face_region's live
  FK — a sidecar keyed by asset_id is the same queries with one JOIN),
  `enrich_embedding` (float32 BLOB vectors, UNIQUE per entity+model),
  `enrich_request` (search-miss / on-view queue), and the `vision` /
  `doctype` machine-tag schemes (bootstrap seeds fresh vaults; the guarded
  v10 inserts backfill only vaults that already have an owner, so
  bootstrap and `importVaultExport` never collide).
- `packages/vault/src/enrich/content.ts` (new) — the agent content
  primitive resolving the #296 §7 seam: variant ∈ {thumb, preview, text}
  ONLY (derivatives egress, never originals), size-bounded (1 MiB default,
  4 MiB hard, 256k text chars), riding the same `resolveServableBlob`
  reachability rule as the blob routes.
- `packages/vault/src/enrich/similarity.ts` (new) — `vault_hamming`
  app-defined SQL function (hex hamming, NULL-safe), float32 vector
  encode/decode, cosine, and the brute-force `scanEmbeddings` (exact scan;
  the index stays additive by design).
- `packages/vault/src/ingest/enrich-publishers.ts` (new) — publishers for
  knowledge.annotation (one caption per author+target, replaces only its
  OWN prior output), core.tag (creates concepts under the machine schemes;
  an owner-asserted tag is terminal — skip, never overwrite),
  media.face_region (create unconfirmed; a confirmed region is immune),
  core.collection (probe by name; top-up only, never removes), and
  core.content_item filing (update-only — a proposal for a missing
  document fails per-row; folder matches by label, else a new concept).
- `packages/vault/src/commands/enrich.ts` (new) — `core.set_extracted_text`
  (upserts the text derivative; the #296 derivative-aware FTS triggers
  index the PARENT document in-transaction), `media.confirm_face` /
  `media.reject_face` (the owner half of the proposal loop), 
  `sync.set_connection_trust` (risk HIGH: an agent proposing to widen its
  own trust parks, structurally), `enrich.request_enrichment`,
  `enrich.upsert_embedding`.
- `packages/vault/src/commands/sync.ts` — `sync.stage_rows` now (a)
  injects `author_party_id` into knowledge.annotation payloads from the
  CALLER's identity — attribution is server-side, masquerade is
  structurally impossible; (b) honors the connection's owner-set
  `auto-publish` trust by applying the batch in the same command (postcond
  widened to draft-or-published), returning `published` counts. `staged`
  trust keeps today's behavior exactly.
- `packages/vault/src/commands/media.ts` — `media.add_asset` accepts
  `phash` (hex, client-computed beside its canvas thumb) → sidecar upsert.
- `packages/vault/src/gateway/gateway.ts` — `contentForAgent`: consent
  (read on core.content_item) + variant gate + size bound; every fetch,
  allow AND deny, writes an `agent-content` receipt — the "multimodal
  hand-off is its own consent event" decision made code.
- `packages/vault/src/host.ts` — `enrich` settings bag
  (`photos`/`docs` ∈ off|local|model, default `local`) +
  read/updateEnrichSettings.
- `packages/vault/src/db.ts` — registers `vault_hamming` beside
  `vault_content_text`. `packages/vault/src/schema/tables.ts` — registers
  `enrich.embedding` / `enrich.request`; `media_asset_phash` stays
  unregistered plumbing like `blob_staging`.
- `packages/app-engine/src/handlers/vault-bridge.ts` — `VaultOp` gains
  `content`.
- `packages/gateway/src/serve/vault-plane.ts` — `content` op on BOTH
  bridges (app + agent plane) via an async result twin; enrich command
  registration; `contentAsOwner` (assistant text reads).
- `packages/gateway/src/routes/vault-routes.ts` — `GET/PUT /_vault/enrich`
  (owner policy surface, mirrors blob-store).
- `packages/automation/src/worker/runner.ts` — `ctx.vault.content(...)`;
  `ctx.agent({prompt, json, content})` — content refs name vault
  derivatives; the WORKER never holds bytes.
- `packages/automation/src/handler/ctx.ts` + `handler/runner.ts` — the
  parent resolves content refs through the vault bridge (fail-closed: a
  deny fails the agent call with the receipt-bearing error) into
  `AgentCall.attachments`.
- `packages/agent-runtime/src/automation/run-automation-live-dispatch.ts` —
  attachments become scratch files referenced from the prompt; the CLI's
  native multimodal Read path picks them up — one mechanism for both
  runners, no per-backend wire format.
- `packages/agent-runtime/src/vault-sql-tool.ts` + both backends'
  `host-tools.ts` — the assistant's `vault_content` tool (text-first:
  extracted text / inline body by content_id, receipted); registered on
  claude (MCP) and codex (dynamicTools) identically.
- `packages/app-engine/src/conversation/{turn,runner-core}.ts` —
  `VaultContentRunner` threaded per turn like `vaultSql`.
- `packages/gateway/src/runs/assistant-conversation-runner.ts` /
  `unified-conversation-runner.ts` / `vault-plane.ts` — the owner-side
  runner wiring; `assistant-prompt.ts` teaches the register when to reach
  for vault_content and to cite `ref:core.content_item/<id>`.

Commit 2 — phase 1 enrichers (blueprint automation templates):

- `packages/blueprints/automations/photo-captioner/` (new) — the vision
  enricher: data trigger on media.media_asset (5-min gate), UUIDv7 cursor
  in ctx.state (id order IS time order — no wall clock), preview-else-thumb
  variant pick (a photo with neither is an honest skip), one bounded
  `ctx.agent` vision turn per photo with a JSON schema, captions + tags
  staged via `sync.stage_rows` on the `enrichment.vision` connection.
  Ships `enabled: false` — enabling IS the owner's opt-in; the vault block
  requests media/core read + sync read+act.
- `packages/blueprints/automations/doc-text-extractor/` (new) — the doc
  enricher: scans (no text variant, preview exists) OCR through
  `core.set_extracted_text` so the #296 FTS triggers index the PARENT
  document in-transaction; documents WITH text get a one-paragraph summary
  staged as a machine annotation on `enrichment.doctext`; a binary with
  neither derivative is "not enrichable yet", logged, never guessed.
- `packages/blueprints/index.json` + regenerated `manifest.json` — both
  templates in the gallery under a new "Enrichment" category with
  data-trigger labels; neither declares `connector` (connectors forbid
  ctx.agent — enrichers are the OTHER kind of automation, by design).
- `packages/blueprints/src/enricher-automations.test.ts` (new) — manifests
  parse under the runtime validator (vault block + data trigger cohere,
  ships disabled, no connector block), handlers pass the determinism lint,
  and stub-ctx behavior tests pin the contract: preview-over-thumb content
  refs, staged-not-written output, external ids derived from asset ids,
  cursor advance, agent-turn-free skips.

Commit 3 — phase 2: cross-domain extraction + filing; Photos client phash:

- `packages/blueprints/automations/screenshot-extractor/` (new) — the
  thesis demo: EXIF-less photos (screenshots and photographed documents —
  camera shots carry spool EXIF, so the camera roll is never taxed) take
  one vision turn; receipts stage `core.transaction` rows (existing
  publisher, minor units, "Receipts (screenshots)" account), bookings
  stage tentative `core.event` rows. A dateless extraction is DROPPED,
  never defaulted — posted_at/dtstart are NOT NULL in the model and an
  invented date is a guess. Cross-domain rows ALWAYS stage; the review
  click is the domain boundary.
- `packages/blueprints/automations/doc-filer/` (new) — scan-dump triage:
  watches `core.content_derivative` (a document becomes filable the moment
  it has text), reads the owner's existing folder labels into the prompt
  so proposals reuse them, and stages a `core.content_item` filing update
  (title + folder) plus a doctype tag under the machine scheme per
  document. Filing never applies itself.
- Photos client phash (Tier 0): `apps/photos/app.js` computes a 64-bit
  dHash from the SAME image decode the thumb already pays for (9×8
  grayscale, adjacent-brightness bits) and passes it through
  `actions/upload.js` → `media.add_asset` → the sidecar. `app.json`'s
  upload input schema gains `phash`.
- Gallery entries (`index.json` + regenerated `manifest.json`, 22
  templates) and 3 new behavior tests (receipt extraction shape + currency
  normalization, dateless-booking drop, filing proposal shape + folder
  reuse + cursor).

## Decisions of record

- **Enrichment rides the sync spine, not a new pipeline** — an enricher is
  a connection; `sync_external_entity`'s content-hash diffing is the
  idempotency contract (`h(payload)` changes when the enricher's output
  changes; enrichers put their version in the external-id space when they
  need forced re-runs).
- **Attribution is injected, never declared**: `sync.stage_rows` stamps
  the caller's party onto annotation payloads server-side.
- **Owner assertions are terminal** at the publisher layer (owner tag,
  confirmed face, foreign-author annotation) — invariant 3 enforced where
  writes happen, not in enricher code.
- **Derivatives egress, never originals** — `contentForAgent` has no
  `original` spelling; scanned-PDF OCR therefore requires a preview/thumb
  derivative to exist (server codecs stay the #296 plug-in seam), and a
  doc with neither text nor preview is honestly "not enrichable yet".
- **auto-publish is the owner's standing consent**, set per connection via
  a risk-HIGH command; agents proposing it park.
- The assistant's `vault_content` is **text-first**: binary variants stay
  on the enricher plane (the conversation wire has no image tool-results).

## Out of scope

- Enricher automation templates (commits 2–5).
- Search-miss auto-recording in `gateway.search` (commit 6) — the
  `enrich_request` queue + command land here, the write-on-miss wiring
  follows with the drain loop.
- A real embedding provider — `enrich.upsert_embedding` + `scanEmbeddings`
  are the seam; wiring a provider is a later, provider-agnostic decision.
- Desktop Settings UI for the enrich policy (the routes are the surface).
- `media_asset_phash` rows do not ride `importVaultExport` (re-derivable).

## Verification

- `packages/vault`: 326 tests green (`npx vitest run`) — includes new
  suite `src/enrich/enrich.test.ts` (v10 schema + schemes, vault_hamming
  near-dup SQL, caption staging → owner trust flip → auto-publish → FTS
  hit → idempotent re-stage → model-upgrade update, agent-park on trust
  widening, machine tags vs terminal owner tags, face propose/confirm/
  immune/reject, album staged review + top-up dedup, filing update +
  refused create, set_extracted_text → parent FTS, contentForAgent
  variant gate/caps/receipts, embeddings upsert + cosine scan, request
  queue, settings).
- `packages/gateway`: 163 green + 1 skipped; `packages/automation`: 144
  green; `packages/agent-runtime`: 68 green; app-engine, vault, gateway,
  automation, agent-runtime typecheck (tsc) clean.
- `packages/blueprints`: 119 green (`npx vitest run`) — the
  `src/enricher-automations.test.ts` suite now covers all four enrichers
  (manifest validity incl. no-connector-block, determinism lint, stub-ctx
  behavior: derivative-only content refs, staged-not-written output,
  dateless-extraction drops, folder reuse, cursors); the manifest sweep
  accepts the four template dirs; `build:manifest` regenerated cleanly
  (22 templates).
