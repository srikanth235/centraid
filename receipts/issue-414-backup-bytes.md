# Issue #414 — Backup and bytes: remote-primary CAS

## Checklist

- [x] Primary-store seam: `primary = remote ?? localFs`; local FS demotes to cache + outbox when a remote exists. Custody states gain **`pending-offsite`** (in outbox, drain in progress) alongside `replicated` / `local-only` / `remote-only` / `missing`.
- [x] Evict-only-if-replicated unchanged; `pending-offsite` blobs are pinned un-evictable by definition.
- [x] Real free-disk watermark gating at admission (the ½-free/1 GiB-floor budget math is fiction on small disks); reserved headroom for WAL staging, snapshot assembly, journal.
- [x] Snapshot: assert (test) that a remote-primary vault's snapshot materializes only outbox contents — the mechanism exists (`backup-service.ts:1106`); make it a stated guarantee.
- [x] Replace full-buffer-only `ingestSync` ingress with a streaming pipeline; one pass over the incoming iroh stream, tee'd: **incremental sha256** (verifying the D10 client-declared sha when present) ‖ **framed AES-GCM seal** (streaming-friendly per #405's format revision) ‖ **preview generation while plaintext is in hand** (never re-fetch a 500 MB video to thumbnail it; dovetails #405 gateway codec) ‖ **outbox spool**.
- [x] Common path: blob fits the outbox ⇒ sha known before upload ⇒ direct PUT to final `sha256/<sha>` key. Oversized path (blob > available outbox): stream-through under a temp key, `CopyObject` to the sha key on completion, delete temp. Multipart-abort lifecycle rule + staging TTL sweep learns to GC the `tmp/` prefix.
- [x] Resumable upload sessions (init/append/commit) on both hops: S3 multipart parts persist server-side; sha256 midstate is serializable; a killed 500 MB transfer resumes from offset, neither hop restarts.
- [x] Dedup: **pre-upload known-sha check (D10)** short-circuits before any bytes ship; streaming path without a client sha checks at stream end (a duplicate wastes one upload — rare, acceptable), aborts the copy.
- [x] Drain respects `throttleBytesPerSec` + replication concurrency (`cache.ts:52`); interactive read-through QoS (#405 §4) preempts drain. Provider read path (single-flight, retry/backoff) is promoted from nice-to-have to **load-bearing** — in remote-primary, a flaky provider is flaky *reads*.
- [x] `casAck: 'receipt'` (default): attach returns on outbox commit; UI shows "n pending offsite". `casAck: 'replicated'` (strict): client/UI gates completion on the `pending-offsite → replicated` custody event over the existing status/SSE channel — e.g. "safe to delete from camera roll". The transport is identical in both modes (D3).
- [x] Offline (LAN-up/WAN-down): attach succeeds while the outbox has room; drain resumes on reconnect. Outbox full + remote unreachable ⇒ typed admission error with honest numbers. Strict mode with provider down: attach still claims, reports "attached locally, offsite pending" — strict failure never rolls back the claim (bytes + row are locally durable).
- [x] Invariants unchanged: evict-only-if-replicated, backpressure-never-loss, staging TTL (`staging.ts:17`).
- [ ] Single per-vault `BackupPolicy` subsuming today's scattered keys: `{ rpoSeconds, snapshotIntervalHours, verifyEveryDays, casAck: 'receipt'|'replicated', outboxBudgetBytes?, cacheBudgetBytes?, throttleBytesPerSec?, storageClass? }`. Existing keys map mechanically (pre-release, no compat machinery).
- [x] Offsite drain interval derives from `rpoSeconds` — kill the `WAL_DRAIN_MS` constant (`backup-service.ts:67`); `walTickMs` follows (capture at least as often as drain). Floor 30 s.
- [x] Health thresholds (`backup-health.ts`) derive from the policy (2× stays) — tightening the RPO tightens the alarms.
- [x] Explicit three-way destination per vault: **gateway-local only** (default) / **own S3-compatible endpoint** (reuse `S3BlobStoreOptions`) / **provider `cas` grant** (`provider.ts:91-106`).
- [x] Local-only UI states the consequence plainly: attachments have no offsite copy beyond snapshot cadence. `casAck` hidden for local-only (meaningless without a remote).
- [x] `PUT /v1/backup/vaults/{id}/policy` + echo in `GET`: `{ rpoSeconds, snapshotIntervalHours, verifyEveryDays, casAck }` + `declaredAt`. Additive per the protocol's layering rules; `provider.ts` types verbatim-from-PROTOCOL.md as usual.
- [x] Provider semantics: MAY alarm when observed uploads go stale beyond 2× declared cadence; MAY reject a policy it cannot meet, with a typed error the client surfaces.
- [x] Engine pushes policy on backup enable + every change; provider echo ≠ local ⇒ health warning (drift).
- [x] `conformance.ts`: policy round-trip, reject shape, stale-alarm contract; clawgnition interop (companion clawgnition issue to follow).
- [x] Open question: client-chosen retention riding the policy doc (downward-only override of the provider ladder)? Leaning no for now (D8).
- [x] Organized by the user's question, live status beside each knob (last snapshot, last WAL drain, blobs pending offsite):
- [x] Mobile-first per the standing rule; desktop enhancements ≥720 px.
- [x] Extend the variant vocabulary beyond `thumb`/`preview`: **`poster`** (video frame — device `<video>` seek + canvas, zero new deps), **`text`** (device pdf.js text layer for real PDFs; platform OCR for scans), **`transcript`** (video/audio speech, §12), **`embedding`**, **`phash`** — all submitted via the existing `?variant=…&variant_of=<sha>` door (`blob-routes.ts`), client-always-wins rule unchanged (`preview.ts:158-161`).
- [x] Per-variant backstop registry on the gateway: raster rungs → codec sweep (exists); `text` → cheap extractor at ingest + `doc-text-extractor` LLM enricher (both exist — device pdf.js becomes the *primary*, replacing the honest-but-limited uncompressed-ops parser for most PDFs); `poster` → none in v0 (honest `null` until a capable device contributes — same posture as Ente); `embedding` → optional LLM/backstop, off by default per #299.
- [x] Docs app upload gains the same client-processing step photos already has: pdf.js text extraction on attach, submitted as the `text` variant; FTS triggers index it exactly as `core.set_extracted_text` does today.
- [x] Validation: gateway sanity-checks contributed derivatives (decodable image, plausible dimensions, text size caps) — bugs-not-adversaries tier.
- [x] Upload endpoint accepts an optional client-declared `sha256`; the §2 tee verifies incrementally and rejects the claim on mismatch. Gateway hash stays authoritative.
- [x] New pre-flight: `HEAD`-style "have sha X?" (existence + custody state) so a second device re-adding an existing library ships metadata only.
- [ ] Client side: WebCrypto streaming sha256 in `photos/upload.js` / docs upload — computed on the same pass that feeds the multipart body.
- [x] Extend `getHostCapabilities()` → device declares compute capabilities (`previews`, `poster`, `pdfText`, `ocr`, `embedding`, tiers as available); web clients cover the canvas/pdf.js set, native/Electron shells add NPU-class ML.
- [x] `enrich_request` queue gains TTL leases: opted-in idle devices (charging + unmetered) pull jobs, compute, submit via §8; expired leases return to the pool; gateway backstop sweeps whatever no device claimed. Duplicate submissions safe by always-wins.
- [x] UI: per-device toggle ("help index your library while charging") + queue depth on the gateway status screen.
- [x] Client CBSF framing + AES-GCM seal (WebCrypto); plaintext sha in the AEAD-authenticated header.
- [x] Key distribution: per-blob content keys wrapped by the gateway-rooted vault seal key; paired devices receive wrap material over the #376 pairing channel; revocation = rotate wrap key + re-wrap (never re-encrypt CAS objects).
- [x] Presign service on the gateway: per-object presigned PUT/GET (multipart-presigned for large objects); provider credential never leaves the gateway; claim transaction still gateway-mediated.
- [x] Custody: device-completion report ⇒ gateway HEAD-verify (existence/size) before `pending-offsite → replicated`; sampled spot-check downloads verify header sha. Evict-only-if-replicated never trusts an unverified client claim.
- [x] Mobile: direct-to-S3 uploads ride OS background-transfer sessions (survive app suspension — closes the D3 gap for the away-from-home case).
- [x] Fallback door unchanged: thin client / `curl` POSTs plaintext to the gateway (§2), which seals itself — two doors, one custody model; edge sealing is the primary path for capable paired devices, never a requirement for a client to exist.
- [x] Stated invariant: enrichers/agents read derivatives, never originals (`AGENT_CONTENT_VARIANTS`, `enrich/content.ts:15-16`) — independent of where sealing happens.
- [x] **Poster frames (device, D9 §8).** On video upload, client seeks `~1s` via `<video>` + canvas (hardware decode, zero new deps) and submits `poster` + a `thumb` derived from it through the §8 door; grid (`gridSrc()`) and docs previews consume `poster` exactly like image `thumb`. Existing library backfill: poster jobs enter the §10 work-lease queue — an idle device sweeps old videos overnight. No gateway backstop (D13); placeholder-with-play-badge remains the honest empty state.
- [ ] **Scrub thumbnails (device, optional rung).** Sprite/strip of N frames as one more variant for lightbox scrubbing — same mechanics, explicitly nice-to-have.
- [x] **Container metadata — the one new gateway parser.** Pure-JS ISO-BMFF/moov (+ WebM/EBML) parser in `pipeline.ts` beside the JPEG-EXIF branch: duration, width/height, codec, `creation_time` → populates the already-plumbed `duration_s`, dims, `captured_at`. Device sends the same fields with the claim (it parsed the file anyway); gateway parser is the backstop for `curl`-door uploads. Parse-not-decode keeps it Pi-cheap. Grid badges show duration; timeline ordering uses container `captured_at`.
- [x] **Captions ride the poster.** `photo-captioner` drops its `kind !== 'photo'` skip and captions video via the `poster`/`thumb` variant — no new enricher, one changed guard (`handler.js:102`). Feeds the same tags/FTS path as photos.
- [x] **Transcription (D11 work lease).** New `transcript` variant: device with speech capability (platform APIs / whisper-class NPU model) leases transcription jobs for video audio tracks + audio files; result lands via `core.set_extracted_text`-style write so the #296 FTS triggers index it — videos become searchable by what was said. Gateway backstop: optional LLM audio turn enricher, off by default per #299. Capability flag in §10's advertisement.
- [x] **Docs app renders media.** `typeMeta()` gains video/audio categories; inline `<video>`/`<audio controls>` for media MIME (the Range endpoint already does the hard part) instead of the bare download link.
- [x] **Audio parity.** Player UI in photos + docs; `audio/*` joins the poster-less path (placeholder = waveform badge; an actual waveform strip is an optional device-computed variant); transcription as above; ID3/Vorbis title-artist into metadata.
- [x] **Explicit non-goals (D13):** no gateway transcoding, no HLS/DASH, no ffmpeg dependency. Progressive + Range is the playback story; a device-encoded low-bitrate proxy rung may come later as one more §8 variant.
- [x] **Protocol: `GET /v1/backup/vaults/:id/inventory`** (new optional capability `inventory`, additive per layering rules): paginated per-store-class object listing — `{ key, sizeBytes, etagOrHash, storedAt, storageClass?, state: 'live'|'soft-deleted' }` — covering `backup` (manifests, snapshot parts, WAL segments) and `cas` objects. Cursor-paginated (CAS can be 100k+ objects); optional `?since=` for incremental pulls. Provider-attested; MUST be consistent with what a raw S3 LIST under the read grant returns (conformance checks exactly this — inventory lying about the bucket is a contract violation).
- [x] **Protocol: prune/lifecycle audit — `GET /v1/backup/vaults/:id/events`** (optional capability `audit`): append-only rows `{ at, kind: 'prune'|'soft-delete'|'undelete'|'purge'|'credential-issued'|'policy-changed', detail }` — prune rows say *which retention rung* justified the removal (ties to the provider-declared ladder, D8) and what was removed; credential rows give the user visibility into every grant ever issued against their data. Registry rows already carry `prunedAt`; events add the *why* and the non-snapshot kinds.
- [x] **Gateway reconciliation sweep** (weekly default, rides `verifyEveryDays` cadence): pull inventory, diff three ways — (1) `blob_replica` says replicated but inventory lacks the object ⇒ **critical health alarm + custody demoted** (blob becomes un-evictable again; this is the D1 safety audit); (2) inventory holds objects the gateway doesn't know ⇒ orphan report (candidate GC after grace window, surfaced not auto-deleted); (3) WAL ledger vs backup-store segments ⇒ PITR chain completeness check without a restore drill. Drift in any direction = health warning with counts.
- [x] **UI: "What does your provider hold?"** panel on the Backup screen — per store class: object count + bytes (from inventory, cross-checked against `usage`), snapshot list with sizes/dates/format (registry, already available — surface it), WAL chain span ("PITR covers last N days"), prune history (events), last-reconciled stamp + drift status. Provider-attested numbers labeled as such, with a "verify against bucket" action that runs the raw-LIST cross-check on demand.
- [x] **Conformance (`conformance.ts`)**: inventory pagination + `since` semantics, inventory↔bucket-LIST consistency, event ordering + prune-reason presence, reconciliation fixtures (missing-object, orphan, clean); fake provider implements both capabilities; clawgnition interop extends the companion issue.
- [x] Providers without the capabilities degrade honestly: UI falls back to registry + raw S3 LIST under a read grant (client-computed inventory, labeled "computed from bucket listing, not provider-attested"); reconciliation still runs — the safety loop must not depend on an optional capability.

## What changed

Centraid now treats a configured remote CAS as the primary home for attachment bytes, with a bounded local outbox/cache and a single policy that drives RPO, snapshots, restore verification, acknowledgment, storage limits, throttling, and destination choice. Capable paired devices hash, seal, derive, and upload directly; the gateway keeps a streaming CBSF fallback for thin clients and curl. The same work adds resumable transfers, honest custody/admission semantics, device work leases, first-class video/audio/PDF derivatives, provider inventory/audit, safety reconciliation, and the mobile-first control/observability UI.

### Checklist evidence

1. Primary-store seam: `primary = remote ?? localFs`; local FS demotes to cache + outbox when a remote exists. Custody states gain **`pending-offsite`** (in outbox, drain in progress) alongside `replicated` / `local-only` / `remote-only` / `missing`. — The custody seam now selects remote primary or local primary, persists `pending-offsite`, and exposes the state through routes and UI.
2. Evict-only-if-replicated unchanged; `pending-offsite` blobs are pinned un-evictable by definition. — Custody and eviction checks pin every non-replicated outbox object; tests cover refusal to evict it.
3. Real free-disk watermark gating at admission (the ½-free/1 GiB-floor budget math is fiction on small disks); reserved headroom for WAL staging, snapshot assembly, journal. — Admission uses actual free-space/headroom probes and reports the requested, available, reserved, and outbox byte counts.
4. Snapshot: assert (test) that a remote-primary vault's snapshot materializes only outbox contents — the mechanism exists (`backup-service.ts:1106`); make it a stated guarantee. — Backup-source tests prove remote-primary snapshots include only durable outbox bytes and lazy restore rehydrates remote-only content.
5. Replace full-buffer-only `ingestSync` ingress with a streaming pipeline; one pass over the incoming iroh stream, tee'd: **incremental sha256** (verifying the D10 client-declared sha when present) ‖ **framed AES-GCM seal** (streaming-friendly per #405's format revision) ‖ **preview generation while plaintext is in hand** (never re-fetch a 500 MB video to thumbnail it; dovetails #405 gateway codec) ‖ **outbox spool**. — The fallback ingress is a bounded one-shot stream through incremental SHA-256, framed CBSF sealing, metadata/preview extraction, and outbox/remote transfer.
6. Common path: blob fits the outbox ⇒ sha known before upload ⇒ direct PUT to final `sha256/<sha>` key. Oversized path (blob > available outbox): stream-through under a temp key, `CopyObject` to the sha key on completion, delete temp. Multipart-abort lifecycle rule + staging TTL sweep learns to GC the `tmp/` prefix. — Every outbox-resident known-SHA object writes directly at the final key: small objects use one PUT and larger objects use receipt-persisted final-key multipart; only hash-unknown stream-through uses temp promotion, with abort/orphan cleanup.
7. Resumable upload sessions (init/append/commit) on both hops: S3 multipart parts persist server-side; sha256 midstate is serializable; a killed 500 MB transfer resumes from offset, neither hop restarts. — Persisted upload/session records retain parts, offsets, serialized SHA state, and commit state. Fallback `committing` replay persists the resolved digest before adoption, recovers before/after temp adoption and logical finalization, heals a lost response/missing outbox, and remains idempotent across restart.
8. Dedup: **pre-upload known-sha check (D10)** short-circuits before any bytes ship; streaming path without a client sha checks at stream end (a duplicate wastes one upload — rare, acceptable), aborts the copy. — Preflight returns custody without a body; mismatch and zero-body dedup tests keep the gateway-computed digest authoritative and abort duplicate promotion.
9. Drain respects `throttleBytesPerSec` + replication concurrency (`cache.ts:52`); interactive read-through QoS (#405 §4) preempts drain. Provider read path (single-flight, retry/backoff) is promoted from nice-to-have to **load-bearing** — in remote-primary, a flaky provider is flaky *reads*. — The drain runner applies byte throttling, bounded concurrency, interactive-read preemption, and retry/single-flight remote reads.
10. `casAck: 'receipt'` (default): attach returns on outbox commit; UI shows "n pending offsite". `casAck: 'replicated'` (strict): client/UI gates completion on the `pending-offsite → replicated` custody event over the existing status/SSE channel — e.g. "safe to delete from camera roll". The transport is identical in both modes (D3). — The policy, attach responses, status API, events, and UI implement receipt versus replicated acknowledgment without changing the byte transport.
11. Offline (LAN-up/WAN-down): attach succeeds while the outbox has room; drain resumes on reconnect. Outbox full + remote unreachable ⇒ typed admission error with honest numbers. Strict mode with provider down: attach still claims, reports "attached locally, offsite pending" — strict failure never rolls back the claim (bytes + row are locally durable). — Offline/resume and full-outbox/provider-down tests prove successful local custody when possible and a typed HTTP 429 with honest capacity values otherwise.
12. Invariants unchanged: evict-only-if-replicated, backpressure-never-loss, staging TTL (`staging.ts:17`). — Staging TTL, orphan multipart GC, custody transitions, and eviction tests preserve the no-loss invariants.
13. Single per-vault `BackupPolicy` subsuming today's scattered keys: `{ rpoSeconds, snapshotIntervalHours, verifyEveryDays, casAck: 'receipt'|'replicated', outboxBudgetBytes?, cacheBudgetBytes?, throttleBytesPerSec?, storageClass? }`. Existing keys map mechanically (pre-release, no compat machinery). — PARTIAL: the unified policy is implemented, but the legacy-key mapping is deliberately omitted under the user's v0/no-compatibility direction.
14. Offsite drain interval derives from `rpoSeconds` — kill the `WAL_DRAIN_MS` constant (`backup-service.ts:67`); `walTickMs` follows (capture at least as often as drain). Floor 30 s. — WAL capture and drain scheduling both derive from the policy RPO with the 30-second floor; the constant drain cadence was removed.
15. Health thresholds (`backup-health.ts`) derive from the policy (2× stays) — tightening the RPO tightens the alarms. — Health evaluates snapshot, WAL, verify, provider-policy drift, and reconciliation freshness against policy-derived 2× thresholds.
16. Explicit three-way destination per vault: **gateway-local only** (default) / **own S3-compatible endpoint** (reuse `S3BlobStoreOptions`) / **provider `cas` grant** (`provider.ts:91-106`). — The policy/UI and runtime select local-only, user S3-compatible, or provider-grant CAS independently per vault.
17. Local-only UI states the consequence plainly: attachments have no offsite copy beyond snapshot cadence. `casAck` hidden for local-only (meaningless without a remote). — The local-only selection explains its snapshot-only offsite consequence and suppresses the meaningless CAS acknowledgment control.
18. `PUT /v1/backup/vaults/{id}/policy` + echo in `GET`: `{ rpoSeconds, snapshotIntervalHours, verifyEveryDays, casAck }` + `declaredAt`. Additive per the protocol's layering rules; `provider.ts` types verbatim-from-PROTOCOL.md as usual. — Protocol types/docs and the fake/remote providers implement policy PUT/GET echo with `declaredAt`.
19. Provider semantics: MAY alarm when observed uploads go stale beyond 2× declared cadence; MAY reject a policy it cannot meet, with a typed error the client surfaces. — Typed policy rejection and stale-observation alarm behavior are exercised by conformance tests and surfaced by the client.
20. Engine pushes policy on backup enable + every change; provider echo ≠ local ⇒ health warning (drift). — Enable/update pushes the local policy; provider echo mismatch is persisted and reported as degraded health.
21. `conformance.ts`: policy round-trip, reject shape, stale-alarm contract; clawgnition interop (companion clawgnition issue to follow). — The conformance suite covers round-trip, rejection, stale alarms, and an environment-gated live Clawgnition interop case.
22. Open question: client-chosen retention riding the policy doc (downward-only override of the provider ladder)? Leaning no for now (D8). — Retention remains provider-declared; the client policy intentionally has no retention override.
23. Organized by the user's question, live status beside each knob (last snapshot, last WAL drain, blobs pending offsite): — The Backup screen groups destination, RPO, attachment acknowledgment, snapshots/restore proof, and advanced limits with adjacent live state.
24. Mobile-first per the standing rule; desktop enhancements ≥720 px. — Responsive styles make the controls single-column/mobile-first and add desktop layout only from 720 px.
25. Extend the variant vocabulary beyond `thumb`/`preview`: **`poster`** (video frame — device `<video>` seek + canvas, zero new deps), **`text`** (device pdf.js text layer for real PDFs; platform OCR for scans), **`transcript`** (video/audio speech, §12), **`embedding`**, **`phash`** — all submitted via the existing `?variant=…&variant_of=<sha>` door (`blob-routes.ts`), client-always-wins rule unchanged (`preview.ts:158-161`). — Routes, schemas, validation, clients, and workers support poster, text, transcript, embedding, and perceptual-hash contributions keyed by source SHA.
26. Per-variant backstop registry on the gateway: raster rungs → codec sweep (exists); `text` → cheap extractor at ingest + `doc-text-extractor` LLM enricher (both exist — device pdf.js becomes the *primary*, replacing the honest-but-limited uncompressed-ops parser for most PDFs); `poster` → none in v0 (honest `null` until a capable device contributes — same posture as Ente); `embedding` → optional LLM/backstop, off by default per #299. — The registry schedules raster, text, semantic, and poster work with explicit null/no-decode behavior where no gateway backstop is valid.
27. Docs app upload gains the same client-processing step photos already has: pdf.js text extraction on attach, submitted as the `text` variant; FTS triggers index it exactly as `core.set_extracted_text` does today. — Docs uses bundled pdf.js client extraction, uploads a text contribution, and the gateway/automation path indexes late text into FTS.
28. Validation: gateway sanity-checks contributed derivatives (decodable image, plausible dimensions, text size caps) — bugs-not-adversaries tier. — Contribution validation bounds text and metadata and decodes image derivatives before accepting them.
29. Upload endpoint accepts an optional client-declared `sha256`; the §2 tee verifies incrementally and rejects the claim on mismatch. Gateway hash stays authoritative. — Fallback uploads accept a declared digest, verify it incrementally, and reject mismatches before claim completion.
30. New pre-flight: `HEAD`-style "have sha X?" (existence + custody state) so a second device re-adding an existing library ships metadata only. — The preflight endpoint reports existence and custody so already-held objects require no byte upload.
31. Client side: WebCrypto streaming sha256 in `photos/upload.js` / docs upload — computed on the same pass that feeds the multipart body. — DEFERRED: browsers must read the original twice—one bounded streaming hash pass, then seal/upload—because the final key, key wrap, AAD, and presign depend on the digest.
32. Extend `getHostCapabilities()` → device declares compute capabilities (`previews`, `poster`, `pdfText`, `ocr`, `embedding`, tiers as available); web clients cover the canvas/pdf.js set, native/Electron shells add NPU-class ML. — Capability payloads advertise preview, poster, PDF text, OCR, embedding, perceptual hash, and transcript tiers honestly per host.
33. `enrich_request` queue gains TTL leases: opted-in idle devices (charging + unmetered) pull jobs, compute, submit via §8; expired leases return to the pool; gateway backstop sweeps whatever no device claimed. Duplicate submissions safe by always-wins. — Enrichment requests have TTL leases, capability matching, retry after expiry, idempotent contributions, and gateway fallback sweeps.
34. UI: per-device toggle ("help index your library while charging") + queue depth on the gateway status screen. — Devices UI adds the charging/unmetered opt-in and displays eligible workers plus queue depth.
35. Client CBSF framing + AES-GCM seal (WebCrypto); plaintext sha in the AEAD-authenticated header. — The browser worker frames CBSF and seals each frame with WebCrypto AES-GCM while authenticating the plaintext digest header.
36. Key distribution: per-blob content keys wrapped by the gateway-rooted vault seal key; paired devices receive wrap material over the #376 pairing channel; revocation = rotate wrap key + re-wrap (never re-encrypt CAS objects). — Gateway-rooted content keys are wrapped per blob, distributed only through paired-device tokens, and rewrapped after wrap-key rotation without touching CAS bytes.
37. Presign service on the gateway: per-object presigned PUT/GET (multipart-presigned for large objects); provider credential never leaves the gateway; claim transaction still gateway-mediated. — Presign endpoints authorize single and multipart PUT/GET per object; credentials remain server-side and metadata claims remain gateway-mediated.
38. Custody: device-completion report ⇒ gateway HEAD-verify (existence/size) before `pending-offsite → replicated`; sampled spot-check downloads verify header sha. Evict-only-if-replicated never trusts an unverified client claim. — Completion performs HEAD size binding plus CBSF header authentication/spot-check before allowing replicated custody.
39. Mobile: direct-to-S3 uploads ride OS background-transfer sessions (survive app suspension — closes the D3 gap for the away-from-home case). — Mobile dispatch persists direct transfer sessions through the native FileSystem background upload/download facility and reports completion on resume.
40. Fallback door unchanged: thin client / `curl` POSTs plaintext to the gateway (§2), which seals itself — two doors, one custody model; edge sealing is the primary path for capable paired devices, never a requirement for a client to exist. — The plaintext fallback upload remains available to curl/thin clients and converges on the same CBSF/custody state machine.
41. Stated invariant: enrichers/agents read derivatives, never originals (`AGENT_CONTENT_VARIANTS`, `enrich/content.ts:15-16`) — independent of where sealing happens. — Agent-readable variant selection excludes originals; new enrichment code consumes only validated derivatives.
42. **Poster frames (device, D9 §8).** On video upload, client seeks `~1s` via `<video>` + canvas (hardware decode, zero new deps) and submits `poster` + a `thumb` derived from it through the §8 door; grid (`gridSrc()`) and docs previews consume `poster` exactly like image `thumb`. Existing library backfill: poster jobs enter the §10 work-lease queue — an idle device sweeps old videos overnight. No gateway backstop (D13); placeholder-with-play-badge remains the honest empty state. — Capable browser workers generate video poster plus thumb, Photos/Docs consume them, and expired poster jobs return to device leases with honest placeholders.
43. **Scrub thumbnails (device, optional rung).** Sprite/strip of N frames as one more variant for lightbox scrubbing — same mechanics, explicitly nice-to-have. — OPTIONAL/DEFERRED: the issue labels scrub sprites as nice-to-have; no scrub-strip variant was added.
44. **Container metadata — the one new gateway parser.** Pure-JS ISO-BMFF/moov (+ WebM/EBML) parser in `pipeline.ts` beside the JPEG-EXIF branch: duration, width/height, codec, `creation_time` → populates the already-plumbed `duration_s`, dims, `captured_at`. Device sends the same fields with the claim (it parsed the file anyway); gateway parser is the backstop for `curl`-door uploads. Parse-not-decode keeps it Pi-cheap. Grid badges show duration; timeline ordering uses container `captured_at`. — Pure-JS ISO-BMFF/WebM and audio tag parsing records duration, dimensions, codec, capture time, title, and artist without decoding media.
45. **Captions ride the poster.** `photo-captioner` drops its `kind !== 'photo'` skip and captions video via the `poster`/`thumb` variant — no new enricher, one changed guard (`handler.js:102`). Feeds the same tags/FTS path as photos. — The caption automation accepts video and consumes poster/thumbnail derivatives through the existing FTS/tag contribution path.
46. **Transcription (D11 work lease).** New `transcript` variant: device with speech capability (platform APIs / whisper-class NPU model) leases transcription jobs for video audio tracks + audio files; result lands via `core.set_extracted_text`-style write so the #296 FTS triggers index it — videos become searchable by what was said. Gateway backstop: optional LLM audio turn enricher, off by default per #299. Capability flag in §10's advertisement. — The shipping desktop host probes an explicitly configured loopback file-ASR adapter, advertises transcript only while it answers, and runs lease → existing media Blob → ASR → transcript contribution → completion; the gateway route indexes the contribution into FTS.
47. **Docs app renders media.** `typeMeta()` gains video/audio categories; inline `<video>`/`<audio controls>` for media MIME (the Range endpoint already does the hard part) instead of the bare download link. — Docs and Photos render video/audio controls over the existing Range route rather than forcing downloads.
48. **Audio parity.** Player UI in photos + docs; `audio/*` joins the poster-less path (placeholder = waveform badge; an actual waveform strip is an optional device-computed variant); transcription as above; ID3/Vorbis title-artist into metadata. — Photos/Docs provide audio playback and honest poster-less media states; ID3/Vorbis metadata and transcript contributions share the media path.
49. **Explicit non-goals (D13):** no gateway transcoding, no HLS/DASH, no ffmpeg dependency. Progressive + Range is the playback story; a device-encoded low-bitrate proxy rung may come later as one more §8 variant. — No gateway transcode, HLS/DASH, or ffmpeg path was introduced; progressive Range playback remains the contract.
50. **Protocol: `GET /v1/backup/vaults/:id/inventory`** (new optional capability `inventory`, additive per layering rules): paginated per-store-class object listing — `{ key, sizeBytes, etagOrHash, storedAt, storageClass?, state: 'live'|'soft-deleted' }` — covering `backup` (manifests, snapshot parts, WAL segments) and `cas` objects. Cursor-paginated (CAS can be 100k+ objects); optional `?since=` for incremental pulls. Provider-attested; MUST be consistent with what a raw S3 LIST under the read grant returns (conformance checks exactly this — inventory lying about the bucket is a contract violation). — Provider protocol/types implement cursor-paginated inventory by store class, `since`, hashes, timestamps, storage class, and live/deleted state.
51. **Protocol: prune/lifecycle audit — `GET /v1/backup/vaults/:id/events`** (optional capability `audit`): append-only rows `{ at, kind: 'prune'|'soft-delete'|'undelete'|'purge'|'credential-issued'|'policy-changed', detail }` — prune rows say *which retention rung* justified the removal (ties to the provider-declared ladder, D8) and what was removed; credential rows give the user visibility into every grant ever issued against their data. Registry rows already carry `prunedAt`; events add the *why* and the non-snapshot kinds. — Append-only provider events cover prune reason/rung, lifecycle, credential, and policy events in stable order.
52. **Gateway reconciliation sweep** (weekly default, rides `verifyEveryDays` cadence): pull inventory, diff three ways — (1) `blob_replica` says replicated but inventory lacks the object ⇒ **critical health alarm + custody demoted** (blob becomes un-evictable again; this is the D1 safety audit); (2) inventory holds objects the gateway doesn't know ⇒ orphan report (candidate GC after grace window, surfaced not auto-deleted); (3) WAL ledger vs backup-store segments ⇒ PITR chain completeness check without a restore drill. Drift in any direction = health warning with counts. — Policy-scheduled reconciliation diffs provider inventory, raw bucket listing, replica rows, and WAL ledgers; missing remote data demotes and re-pins, while original eviction is authorized only in the immediately post-reconciliation sweep so stale replica evidence cannot delete the last copy.
53. **UI: "What does your provider hold?"** panel on the Backup screen — per store class: object count + bytes (from inventory, cross-checked against `usage`), snapshot list with sizes/dates/format (registry, already available — surface it), WAL chain span ("PITR covers last N days"), prune history (events), last-reconciled stamp + drift status. Provider-attested numbers labeled as such, with a "verify against bucket" action that runs the raw-LIST cross-check on demand. — The Backup inventory panel labels attested versus computed data, shows counts/bytes/snapshots/WAL/prunes/reconciliation, and exposes verify-against-bucket.
54. **Conformance (`conformance.ts`)**: inventory pagination + `since` semantics, inventory↔bucket-LIST consistency, event ordering + prune-reason presence, reconciliation fixtures (missing-object, orphan, clean); fake provider implements both capabilities; clawgnition interop extends the companion issue. — Fake-provider conformance and gateway fixtures cover pagination, `since`, LIST consistency, ordered prune reasons, clean/missing/orphan reconciliation.
55. Providers without the capabilities degrade honestly: UI falls back to registry + raw S3 LIST under a read grant (client-computed inventory, labeled "computed from bucket listing, not provider-attested"); reconciliation still runs — the safety loop must not depend on an optional capability. — Providers lacking inventory/audit fall back to registry plus read-grant LIST, clearly labeled computed, while reconciliation remains enabled.

### Acceptance proof

- The constrained-disk proof combines a real streamed ingress/drain test with a 500 MiB structural capacity simulation: the selected stream-through path never reserves the full payload locally, transitions `pending-offsite → replicated`, and stays below the declared headroom. A 500 MiB zero-filled allocation is not presented as a 500 MiB byte-copy benchmark.
- LAN-up/WAN-down, remote recovery, outbox exhaustion, typed 429 capacity fields, strict receipt semantics, and non-rollback are covered by transfer/service/route tests.
- Persisted final-key/temp multipart parts, serialized incremental SHA state, fallback commit replay across adoption/finalization/lost-response boundaries, stale-session restart, provider orphan enumeration, and abort GC cover kill/resume and crash windows.
- Known-SHA preflight ships zero body; declared-SHA mismatch is rejected; unknown-stream duplicates abort temp promotion.
- Both direct and fallback provider fixtures assert CBSF framing, authenticated header digest, declared plaintext size, corruption detection, and no provider plaintext.
- A capable-device flow contributes preview/thumbnail/pHash/poster/PDF text without a backstop tick; curl raster/PDF paths are completed by real gateway backstops. Poster remains honestly device-only.
- Lease expiry/reclaim, duplicate contribution idempotency, a live-probed desktop loopback ASR adapter, adapter-backed worker execution, and transcript-to-FTS are covered across the host/worker/gateway boundary.
- Changing RPO to 15 minutes moves WAL capture, drain, and health windows together; remote-primary backup and lazy restore tests cover snapshot/restore.
- Direct completion cannot mark replicated before HEAD and CBSF verification; rewrap rotates wrapped keys without rewriting object bytes; sampled verification rejects corrupt headers.
- The native mobile bridge schedules background FileSystem transfers and resumes reporting, while direct-path tests prove only claim/HEAD touches the gateway. Physical OS suspension could not be reproduced in the test container.
- Video/audio tests cover device poster/thumbnail, gateway container metadata, captioning, transcript FTS, inline controls, HTTP 206 Range, and covering-frame decryption.
- Inventory conformance matches bucket LIST; reconciliation demotes/re-pins missing objects, reports orphans without deletion, validates WAL continuity, and preserves prune reason/rung.
- The transparency panel exposes provider-attested or computed counts, bytes, snapshots, WAL span, events, drift, and on-demand independent verification.

### Changed paths

- `.gitignore`
- `ARCHITECTURE.md`
- `README.md`
- `apps/desktop/src/main/device-transcription.test.ts`
- `apps/desktop/src/main/device-transcription.ts`
- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/src/preload.ts`
- `apps/mobile/package.json`
- `apps/mobile/src/lib/bridge/dispatch.ts`
- `apps/mobile/src/lib/bridge/injected.ts`
- `apps/mobile/src/lib/bridge/protocol.ts`
- `apps/mobile/src/lib/bridge/transfer-policy.test.ts`
- `apps/mobile/src/lib/bridge/transfer-policy.ts`
- `apps/mobile/src/screens/AppDetail.tsx`
- `apps/mobile/vitest.config.ts`
- `apps/web/src/web-host.ts`
- `bun.lock`
- `packages/app-engine/src/http/security.ts`
- `packages/app-engine/src/http/static-server.test.ts`
- `packages/automation/src/fire/fire.test.ts`
- `packages/automation/src/fire/fire.ts`
- `packages/automation/src/handler/lint.test.ts`
- `packages/automation/src/handler/lint.ts`
- `packages/automation/src/handler/runner.ts`
- `packages/automation/src/manifest/enricher-templates.test.ts`
- `packages/automation/src/worker/runner.ts`
- `packages/backup/PROTOCOL.md`
- `packages/backup/src/conformance-observability.ts`
- `packages/backup/src/conformance.ts`
- `packages/backup/src/index.ts`
- `packages/backup/src/local-provider.test.ts`
- `packages/backup/src/local-provider.ts`
- `packages/backup/src/object-store.ts`
- `packages/backup/src/provider-observability.ts`
- `packages/backup/src/provider.ts`
- `packages/backup/src/remote-provider.test.ts`
- `packages/backup/src/remote-provider.ts`
- `packages/backup/src/s3-store.ts`
- `packages/backup/src/testing/fake-provider-server.ts`
- `packages/backup/src/testing/s3-test-server.ts`
- `packages/blueprints/README.md`
- `packages/blueprints/apps/docs/app.css`
- `packages/blueprints/apps/docs/components/Details.jsx`
- `packages/blueprints/apps/docs/components/Grid.jsx`
- `packages/blueprints/apps/docs/components/History.jsx`
- `packages/blueprints/apps/docs/components/List.jsx`
- `packages/blueprints/apps/docs/components/QuickLook.jsx`
- `packages/blueprints/apps/docs/components/Toolbar.jsx`
- `packages/blueprints/apps/docs/format.js`
- `packages/blueprints/apps/docs/logic.js`
- `packages/blueprints/apps/docs/pdf-text.js`
- `packages/blueprints/apps/docs/queries/drive.js`
- `packages/blueprints/apps/docs/queries/history.js`
- `packages/blueprints/apps/docs/queries/search.js`
- `packages/blueprints/apps/docs/upload.js`
- `packages/blueprints/apps/docs/versions.js`
- `packages/blueprints/apps/photos/app.css`
- `packages/blueprints/apps/photos/components/Editor.jsx`
- `packages/blueprints/apps/photos/components/Lightbox.jsx`
- `packages/blueprints/apps/photos/format.js`
- `packages/blueprints/apps/photos/index.html`
- `packages/blueprints/apps/photos/media.js`
- `packages/blueprints/apps/photos/queries/_shared.js`
- `packages/blueprints/apps/photos/queries/duplicates.js`
- `packages/blueprints/apps/photos/queries/library.js`
- `packages/blueprints/apps/photos/queries/search.js`
- `packages/blueprints/apps/photos/upload.js`
- `packages/blueprints/automations/doc-text-extractor/automations/doc-text-extractor/handler.js`
- `packages/blueprints/automations/face-proposer/automations/face-proposer/handler.js`
- `packages/blueprints/automations/photo-captioner/automations/photo-captioner/handler.js`
- `packages/blueprints/kit/edge-upload.js`
- `packages/blueprints/kit/kit.js`
- `packages/blueprints/manifest.json`
- `packages/blueprints/package.json`
- `packages/blueprints/scripts/lint-apps.mjs`
- `packages/blueprints/scripts/vendor-pdfjs.mjs`
- `packages/blueprints/src/app-boot-harness.ts`
- `packages/blueprints/src/docs-media.test.ts`
- `packages/blueprints/src/edge-upload.test.ts`
- `packages/blueprints/src/photos-media.test.ts`
- `packages/client/package.json`
- `packages/client/src/centraid-api.d.ts`
- `packages/client/src/device-blob-source.ts`
- `packages/client/src/device-enrichment-compute.ts`
- `packages/client/src/device-enrichment-worker.test.ts`
- `packages/client/src/device-enrichment-worker.ts`
- `packages/client/src/gateway-client-backup.ts`
- `packages/client/src/gateway-client-device-work-source.test.ts`
- `packages/client/src/gateway-client-devices.ts`
- `packages/client/src/gateway-client-storage.ts`
- `packages/client/src/gateway-client.ts`
- `packages/client/src/react/boot.tsx`
- `packages/client/src/react/screens/BackupCard.module.css`
- `packages/client/src/react/screens/BackupCard.test.tsx`
- `packages/client/src/react/screens/BackupCard.tsx`
- `packages/client/src/react/screens/BackupInventoryPanel.tsx`
- `packages/client/src/react/screens/BackupPolicyPanel.tsx`
- `packages/client/src/react/screens/DevicesCard.module.css`
- `packages/client/src/react/screens/DevicesCard.tsx`
- `packages/client/src/react/screens/GatewayScreen.tsx`
- `packages/client/src/react/shell/routes/GatewayRoute.tsx`
- `packages/client/src/vite-assets.d.ts`
- `packages/gateway/src/backup/backup-cas-inventory.ts`
- `packages/gateway/src/backup/backup-cas-reconciliation.test.ts`
- `packages/gateway/src/backup/backup-cas-reconciliation.ts`
- `packages/gateway/src/backup/backup-config.ts`
- `packages/gateway/src/backup/backup-e2e.test.ts`
- `packages/gateway/src/backup/backup-health.test.ts`
- `packages/gateway/src/backup/backup-health.ts`
- `packages/gateway/src/backup/backup-provider-observability.test.ts`
- `packages/gateway/src/backup/backup-provider-observability.ts`
- `packages/gateway/src/backup/backup-reconciliation-state.ts`
- `packages/gateway/src/backup/backup-reconciliation.test.ts`
- `packages/gateway/src/backup/backup-reconciliation.ts`
- `packages/gateway/src/backup/backup-service.test.ts`
- `packages/gateway/src/backup/backup-service.ts`
- `packages/gateway/src/backup/backup-sources.test.ts`
- `packages/gateway/src/backup/backup-sources.ts`
- `packages/gateway/src/backup/backup-state.ts`
- `packages/gateway/src/backup/restore-lazy-e2e.test.ts`
- `packages/gateway/src/backup/storage-e2e.test.ts`
- `packages/gateway/src/backup/wal-e2e.test.ts`
- `packages/gateway/src/cli/backup-admin.test.ts`
- `packages/gateway/src/cli/endpoint-host.ts`
- `packages/gateway/src/preview/codec.test.ts`
- `packages/gateway/src/preview/codec.ts`
- `packages/gateway/src/routes/backup-observability-routes.test.ts`
- `packages/gateway/src/routes/backup-routes.test.ts`
- `packages/gateway/src/routes/backup-routes.ts`
- `packages/gateway/src/routes/blob-custody-events.ts`
- `packages/gateway/src/routes/blob-route-errors.ts`
- `packages/gateway/src/routes/blob-routes.test.ts`
- `packages/gateway/src/routes/blob-routes.ts`
- `packages/gateway/src/routes/device-work-routes.test.ts`
- `packages/gateway/src/routes/device-work-routes.ts`
- `packages/gateway/src/routes/devices-routes.test.ts`
- `packages/gateway/src/routes/devices-routes.ts`
- `packages/gateway/src/routes/pair-routes.ts`
- `packages/gateway/src/routes/storage-routes.test.ts`
- `packages/gateway/src/routes/storage-routes.ts`
- `packages/gateway/src/routes/vault-routes.test.ts`
- `packages/gateway/src/routes/vault-routes.ts`
- `packages/gateway/src/serve/build-gateway.ts`
- `packages/gateway/src/serve/enrollment-store.ts`
- `packages/gateway/src/serve/serve.test.ts`
- `packages/gateway/src/serve/vault-plane.ts`
- `packages/skills/skills/automation-authoring/SKILL.md`
- `packages/vault/src/backup-policy.test.ts`
- `packages/vault/src/backup-policy.ts`
- `packages/vault/src/blob/blob.test.ts`
- `packages/vault/src/blob/cache-headroom.test.ts`
- `packages/vault/src/blob/cache.test.ts`
- `packages/vault/src/blob/cache.ts`
- `packages/vault/src/blob/content-keys.test.ts`
- `packages/vault/src/blob/content-keys.ts`
- `packages/vault/src/blob/custody-state.ts`
- `packages/vault/src/blob/custody-types.ts`
- `packages/vault/src/blob/custody.ts`
- `packages/vault/src/blob/derivatives.test.ts`
- `packages/vault/src/blob/derivatives.ts`
- `packages/vault/src/blob/direct-transfers.ts`
- `packages/vault/src/blob/evict.ts`
- `packages/vault/src/blob/existing-local.ts`
- `packages/vault/src/blob/fallback-finalize.ts`
- `packages/vault/src/blob/flow.test.ts`
- `packages/vault/src/blob/incremental-sha256.test.ts`
- `packages/vault/src/blob/incremental-sha256.ts`
- `packages/vault/src/blob/ingress-admission.ts`
- `packages/vault/src/blob/local.ts`
- `packages/vault/src/blob/media-metadata.test.ts`
- `packages/vault/src/blob/media-metadata.ts`
- `packages/vault/src/blob/one-shot-stream.ts`
- `packages/vault/src/blob/orphan-multipart.test.ts`
- `packages/vault/src/blob/orphan-multipart.ts`
- `packages/vault/src/blob/outbox-drain.test.ts`
- `packages/vault/src/blob/outbox-drain.ts`
- `packages/vault/src/blob/outbox-runner.test.ts`
- `packages/vault/src/blob/outbox-runner.ts`
- `packages/vault/src/blob/pdf-text.ts`
- `packages/vault/src/blob/pipeline.ts`
- `packages/vault/src/blob/preflight.ts`
- `packages/vault/src/blob/preview.test.ts`
- `packages/vault/src/blob/preview.ts`
- `packages/vault/src/blob/promote.ts`
- `packages/vault/src/blob/read.ts`
- `packages/vault/src/blob/remote-audit.ts`
- `packages/vault/src/blob/remote-transfer.ts`
- `packages/vault/src/blob/remote-verify.ts`
- `packages/vault/src/blob/s3-transfer.test.ts`
- `packages/vault/src/blob/s3-transfer.ts`
- `packages/vault/src/blob/s3.test.ts`
- `packages/vault/src/blob/seal-frames.ts`
- `packages/vault/src/blob/seal.test.ts`
- `packages/vault/src/blob/seal.ts`
- `packages/vault/src/blob/semantic-contributions.ts`
- `packages/vault/src/blob/sigv4.ts`
- `packages/vault/src/blob/staging-record.test.ts`
- `packages/vault/src/blob/staging-record.ts`
- `packages/vault/src/blob/staging.ts`
- `packages/vault/src/blob/stream-ingress.test.ts`
- `packages/vault/src/blob/stream-ingress.ts`
- `packages/vault/src/blob/transfer-state.ts`
- `packages/vault/src/blob/transfers.test.ts`
- `packages/vault/src/blob/transfers.ts`
- `packages/vault/src/blob/unknown-hash-stream.ts`
- `packages/vault/src/commands/enrich.ts`
- `packages/vault/src/commands/media.ts`
- `packages/vault/src/db.ts`
- `packages/vault/src/enrich/content.ts`
- `packages/vault/src/enrich/enrich.test.ts`
- `packages/vault/src/enrich/leases.test.ts`
- `packages/vault/src/enrich/leases.ts`
- `packages/vault/src/errors.ts`
- `packages/vault/src/gateway/gateway.ts`
- `packages/vault/src/gateway/reseal.ts`
- `packages/vault/src/index.ts`
- `packages/vault/src/ingest/stage-file.ts`
- `packages/vault/src/schema/blob-transfer.ts`
- `packages/vault/src/schema/blob.ts`
- `packages/vault/src/schema/enrich.ts`
- `packages/vault/src/schema/migrate.ts`
- `packages/vault/src/wal-shipper.test.ts`
- `packages/vault/src/wal-shipper.ts`
- `receipts/issue-414-backup-bytes.md`
- `scripts/docs-site/src/content/backups.html`
- `vitest.config.ts`

## Out of scope

- Legacy settings/backfill compatibility is intentionally omitted. The user explicitly scoped this as v0 and said not to worry about compatibility; new vaults and the current policy schema are authoritative.
- A browser cannot hash and upload the original in one pass without durable client spooling because its final SHA determines the object key, wrapped content key, authenticated header, and presign. The implementation uses bounded streaming reads and never buffers the whole file.
- Scrub-thumbnail sprites remain the issue's explicitly optional nice-to-have rung.
- The live Clawgnition interop test is implemented but environment-gated; no live endpoint/credential was available in this workspace. Fake-provider conformance is fully exercised.
- The Pi-cheap PDF backstop deliberately handles bounded clear/Flate literal text. Custom font maps, chained filters, object streams, and scans rely on device pdf.js/OCR contributions.
- Physical iOS/Android suspension was not reproducible here. The mobile implementation uses the native FileSystem background-session API and tests its scheduling/resume contract.

## Decisions

- Remote-primary is the configured-remote default; no remote means local-primary.
- Receipt acknowledgment remains the default; replicated acknowledgment gates UI completion on the custody event without holding a socket open.
- Retention remains provider-declared.
- Known-SHA uploads use a direct final-key PUT when bounded; large or unknown streams use resumable multipart/temp promotion and lifecycle GC.
- Direct edge sealing is the primary capable-device path; gateway streaming is a permanent compatibility-of-capability fallback, not a release phase.
- Gateway media work parses containers and consumes derivatives but never transcodes video/audio.
- Provider inventory is attested data cross-checked against independently listed objects; missing replicas are demoted and pinned before eviction.

## Verification

```sh
bun install --frozen-lockfile
bun run format
bun run ci
bun run build
bun run docs:build
bun run test --filter=@centraid/backup
bunx vitest run packages/gateway/src/backup packages/gateway/src/routes/backup-routes.test.ts packages/gateway/src/routes/backup-observability-routes.test.ts packages/gateway/src/routes/blob-routes.test.ts packages/gateway/src/routes/device-work-routes.test.ts packages/gateway/src/routes/storage-routes.test.ts
bunx vitest run packages/client
bunx vitest run packages/blueprints
bunx vitest run apps/mobile/src/lib/bridge/transfer-policy.test.ts
bunx vitest run apps/desktop/src/main/device-transcription.test.ts packages/client/src/device-enrichment-worker.test.ts
git diff --check
.governance/run.sh
```

- `bun run ci`: PASS — formatting, oxlint, all 26 build/typecheck tasks, and type-policy lint.
- `bun run build`: PASS — all 13 build tasks.
- Documentation build: PASS.
- Backup package: 271 non-interop tests pass; 23 live-provider cases skip without credentials.
- Issue-focused gateway backup/storage/blob/device routes: 106 tests pass after the final health-fixture correction.
- Client: 805 tests pass. Blueprints: 161 tests pass. Mobile transfer policy: 2 tests pass. Desktop file-ASR adapter: 3 tests pass.
- Vault: all issue-relevant transfer, custody, admission, direct completion, derivatives, pHash, PDF, lease, and reconciliation suites pass; the final fallback/outbox/cache blocker suite passes 34/34. A full sandbox run reached 700 passes; 14 loopback-server cases failed only because this sandbox denies `listen(2)`, and one constrained disk-image test intentionally skipped. An earlier permitted run completed 712 passes with only that intentional skip.
- Automation: the changed enrichment/document suites pass 53/53. A full sandbox run reached 202 passes; 28 loopback cases were blocked by the same `listen EPERM`.
- App engine: all changed static-server tests pass. A full sandbox run reached 345 passes; 35 loopback cases were blocked by `listen EPERM`.
- A final outside-sandbox aggregate rerun could not be authorized after the environment's execution-approval quota was exhausted; package-focused results and the complete deterministic CI gate are reported instead.
- `git diff --check`: PASS.
- Governance: 20/21 directives pass. The sole `repo-hygiene` failure lists nine over-500-line files already oversized on `origin/main`; #414 introduces no new violation (its boundary files are `transfers.ts` 499, `custody.ts` 500, `cache.ts` 429). The one-off commit uses the documented threshold override so accounting/trailer hooks still run; the baseline debt is not hidden or expanded.

## Audit

PASS — the final fresh-context audit found no remaining acceptance blocker.

- **What changed vs. diff:** PASS. A literal set comparison found all 226 changed/untracked paths named in the receipt, including the receipt itself, with no extra path claimed.
- **Checked items vs. implementation:** PASS. The audit re-inspected fallback `committing` replay, reconciliation-gated original eviction, durable final-SHA multipart, the shipping desktop file-ASR path, and their focused tests; every checked line has concrete implementation evidence. The three unchecked boundaries—v0 legacy mapping, same-pass browser hashing/upload, and optional scrub sprites—are honest.
- **Issue-workstream coverage:** PASS. The crosswalk covers D1–D14 and every acceptance boundary, distinguishes structural 500 MiB evidence from a physical byte-copy benchmark, and records physical suspension/live Clawgnition as unavailable environment proof rather than claiming they ran.

## Steering

PASS — the initial request set the complete issue scope and explicitly authorized v0 without compatibility. The later “continue” message resumed the same scope and did not redirect implementation.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019f66ed-32c-1784162634-1 | codex | 019f66ed-32c6-7f81-bc43-f4ff20145d69 | #414 | gpt-5.6-sol | 2923520 | 0 | 112772352 | 267118 | 3190638 | 39.5087 | 2923520 | 0 | 112772352 | 267118 | feat(storage): make backup bytes remote-primary (#414) -m governance: allow-tool |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
