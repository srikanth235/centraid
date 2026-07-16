# Issue #418 — remote-primary review hardening

## Checklist

- [x] Prevent AES-GCM nonce reuse across CBSF sealing paths.
- [x] Preserve replica byte size during remote-only preflight.
- [x] Include synchronous-ingest blobs in remote-primary snapshots until replication is evidenced.
- [x] Make custody SSE validation and publication safe after headers are sent.
- [x] Reset replication evidence and re-enqueue local bytes on S3 identity changes.
- [x] Protect newly replicated evidence from LIST/index reconciliation races.
- [x] Add fresh-target WAL-RPO grace and persist shipper-unavailable errors.
- [x] Do not stamp skipped WAL drain attempts.
- [x] Include pending-offsite bytes in stale sweep health.
- [x] Restore the kit's legacy authoritative-POST fallback.
- [x] Fall back on unknown direct-upload plan kinds.
- [x] Enforce the chunked upload cap before fsync and abort failed ingress.
- [x] Disable PDF.js eval in device enrichment.
- [x] Reject fractional backup cadence fields.
- [x] Migrate and honor legacy blob-store storage/throttle settings through backup policy.
- [x] Fence asynchronous transfer settlement during synchronous vault close.
- [x] Reject removed backup cadence configuration keys.
- [x] Keep the custody SSE callback stable across GatewayRoute ticks.
- [x] Catch DevicesCard work-status polling failures.
- [x] Avoid paid doc summarization for already-processed late derivatives.
- [x] Distinguish resumable upload failures from unreadable photos.
- [x] Confirm plaintext remote objects with bounded samples instead of full downloads.
- [x] Resume multipart CBSF uploads without re-reading/re-sealing confirmed frames.
- [x] Fetch backup manifests with bounded concurrency.
- [x] Remove the dead O(table) `evictOne` API.
- [x] Share S3 signed requests, retry, throttle, and multipart machinery.
- [x] Share SigV4 date, scope, signing-key, and signature derivation.
- [x] Derive binary-variant runtime and SQL membership from one registry.
- [x] Share CBSF constants, AAD builders, and directory codec across all runtimes.
- [x] Share the browser video poster/thumb capture pipeline and ladder edges.
- [x] Have the gateway advertise the canonical native-upload allowlist prefix.

## What changed

### Cryptographic and durability blockers

CBSF retry-stable nonces now bind a keyed digest of the actual AEAD plaintext in addition to the frame/directory identity. Store-only and compressed representations of one SHA therefore cannot reuse an AES-GCM nonce, and differing directory length maps are separated as well. The new dependency-free `@centraid/blob-format` package owns the CBSF magic, version, sizes, AAD builders, and directory codec used by the vault, browser edge uploader, and device reader.

Remote-only preflight retains the replica index's known plaintext size instead of overwriting it with zero. Remote-primary snapshot assembly now includes both durable outbox obligations and live resident bytes without target-specific replica evidence, including journal archive segments and mint-spill content; provider-evidenced bytes remain excluded. The restore regression now explicitly seeds replica evidence when it models a provider-confirmed object.

Changing any S3 identity component—connection, endpoint, region, bucket, or prefix—clears evidence scoped to the old target, enqueues resident local bytes, and starts the outbox. Reconciliation records replica timestamps and keeps evidence marked during the LIST window, closing the list-versus-index race.

Custody SSE validates the SHA and completes the first preflight before committing headers. Subsequent event publication is rejection-safe and closes the stream rather than attempting a JSON error after headers were sent.

### Backup, ingress, and lifecycle correctness

Fresh targets receive WAL-RPO grace from `firstBackupAt`; a missing WAL shipper persists the real error; and a drain already serialized behind another run no longer advances its attempt clock. Sweep health counts `pending-offsite` together with `local-only`, so a stale remote-primary backlog cannot report green.

Backup cadence values are integer-only at the vault boundary. Removed daemon keys are rejected instead of silently ignored. Legacy `blob_store.storageClass` and `throttleBytesPerSec` values migrate into backup policy, and new writes update the policy-backed canonical location rather than dead settings fields.

Chunked ingress checks the cumulative cap before durable append/fsync and aborts the session on every spool-loop failure. Synchronous `VaultDb.close()` now fences the runner without starting an unawaited close promise; durable rows remain pending for restart. Explicit asynchronous coordinator shutdown still waits for in-flight settlement, preserving its graceful-close contract.

The kit treats missing/refused direct-init routes and unknown plan kinds as fallback signals, attempts the resumable gateway route, then uses the legacy authoritative POST while preserving documented extra query data. Retryable upload errors retain their classification so Photos asks the owner to add the file again to resume instead of calling it unreadable.

### Client and automation behavior

Device PDF extraction now passes `isEvalSupported: false`. GatewayRoute memoizes its custody stream callback, so its one-second display ticker does not reopen SSE. DevicesCard absorbs work-status polling failures without producing unhandled rejections.

The document text automation checks its durable external entity marker before invoking the paid summarizer for a late derivative. The shared `captureVideoFrames` browser utility now owns decode, seek, timeout, JPEG quality, and cleanup for both Photos upload and idle-device enrichment; its poster/thumb sizes come from the same preview-ladder constants as the Photos image path and vault backstop.

### Efficiency and maintainability

Plaintext remote confirmation uses stat size plus bounded head/tail ranged samples rather than downloading and hashing the whole object. Durable encrypted multipart upload maps one store-only CBSF frame to one provider part, restores saved receipts, seeks directly to missing plaintext frames, and emits only the required header/directory/trailer parts. Filesystem ranged reads no longer materialize the entire object.

Manifest analysis runs at bounded concurrency eight. The unused `evictOne` full-table classifier was removed. `S3BlobStore` and `S3TransferStore` now use one signed-request/retry/token-bucket/multipart pipeline, including full-jitter backoff and one ETag XML codec. SigV4 signing and presigning share date, scope, key, and signature helpers.

Binary derivative identifiers and SQL literals come from `DERIVATIVE_REGISTRY`; read, eviction, staging, and live-SHA discovery consume that source. The enrichment backlog's SQL prefilter is likewise generated from the device derivative rules used at enqueue time. Native mobile upload policy consumes the gateway-advertised canonical S3 temporary prefix rather than re-deriving path-style encoding.

The final governance pass found the cohesive blob transfer coordinator nine lines over the 500-line limit after adding its synchronous shutdown fence, and the public vault API barrel one line over after exporting the canonical transfer helpers. Both carry the directive's narrow, issue-scoped file-size waiver with the cohesion reason; no lint, type, or runtime check is suppressed.

### Checklist crosswalk

- **Prevent AES-GCM nonce reuse across CBSF sealing paths.** The nonce HMAC includes a keyed plaintext digest; regressions compare compressed/store-only frame and directory nonces.
- **Preserve replica byte size during remote-only preflight.** Preflight reads existing evidence and never marks an absent local blob as size zero.
- **Include synchronous-ingest blobs in remote-primary snapshots until replication is evidenced.** Snapshot sources union pending outbox, live local CAS, and archived segment SHAs, then subtract replica evidence.
- **Make custody SSE validation and publication safe after headers are sent.** SHA/initial preflight precede headers and every later publish rejection is contained.
- **Reset replication evidence and re-enqueue local bytes on S3 identity changes.** The vault route compares all target identity fields, clears evidence, enqueues, and kicks.
- **Protect newly replicated evidence from LIST/index reconciliation races.** Reconciliation uses `replicated_at`/`checkedAt` as a recently-marked grace boundary.
- **Add fresh-target WAL-RPO grace and persist shipper-unavailable errors.** Target creation stamps the grace clock and unavailable shippers write `lastError`.
- **Do not stamp skipped WAL drain attempts.** The busy guard runs before the per-vault attempt timestamp is advanced.
- **Include pending-offsite bytes in stale sweep health.** Both unreplicated custody states feed backlog totals and the stale alarm.
- **Restore the kit's legacy authoritative-POST fallback.** Hashed staging reaches the authoritative POST after direct and resumable init decline.
- **Fall back on unknown direct-upload plan kinds.** Unknown kinds return `null` before any completion call.
- **Enforce the chunked upload cap before fsync and abort failed ingress.** The route checks prospective size and aborts from its spool catch path.
- **Disable PDF.js eval in device enrichment.** The device worker passes `isEvalSupported: false` through its typed options.
- **Reject fractional backup cadence fields.** All three schedule fields require integers.
- **Migrate and honor legacy blob-store storage/throttle settings through backup policy.** Reads migrate old values and PUTs write the policy authority.
- **Fence asynchronous transfer settlement during synchronous vault close.** `abandon()` synchronously closes the settlement gate while graceful `close()` awaits current work.
- **Reject removed backup cadence configuration keys.** Config validation emits an actionable error for either legacy key.
- **Keep the custody SSE callback stable across GatewayRoute ticks.** `useCallback` pins it to the client.
- **Catch DevicesCard work-status polling failures.** Poll rejections are handled and the last good badge remains.
- **Avoid paid doc summarization for already-processed late derivatives.** Existing external entity identity returns before the agent invocation.
- **Distinguish resumable upload failures from unreadable photos.** Retryable errors are tagged and surfaced as resumable owner guidance.
- **Confirm plaintext remote objects with bounded samples instead of full downloads.** Confirmation checks size and bounded head/tail ranges.
- **Resume multipart CBSF uploads without re-reading/re-sealing confirmed frames.** Saved part receipts drive missing-frame ranged reads and deterministic frame sealing.
- **Fetch backup manifests with bounded concurrency.** Inventory analysis uses eight independent workers.
- **Remove the dead O(table) `evictOne` API.** The method and its test-only assertion are gone.
- **Share S3 signed requests, retry, throttle, and multipart machinery.** `S3RequestPipeline` is used by both S3 surfaces.
- **Share SigV4 date, scope, signing-key, and signature derivation.** Both signing modes call the same helpers.
- **Derive binary-variant runtime and SQL membership from one registry.** Registry-derived values feed guards and SQL across all blob lifecycle paths.
- **Share CBSF constants, AAD builders, and directory codec across all runtimes.** `@centraid/blob-format` is consumed by vault, client, and blueprint edge code.
- **Share the browser video poster/thumb capture pipeline and ladder edges.** Both callers use `captureVideoFrames`.
- **Have the gateway advertise the canonical native-upload allowlist prefix.** The trusted settings response carries `allowedUploadPrefix`, produced by the S3 transfer owner and consumed by mobile.

### Files

- `apps/mobile/src/lib/bridge/transfer-policy.test.ts`
- `apps/mobile/src/lib/bridge/transfer-policy.ts`
- `bun.lock`
- `packages/blob-format/package.json`
- `packages/blob-format/src/index.ts`
- `packages/blob-format/tsconfig.json`
- `packages/blueprints/apps/photos/upload.js`
- `packages/blueprints/apps/photos/media.js`
- `packages/blueprints/automations/doc-text-extractor/automations/doc-text-extractor/handler.js`
- `packages/blueprints/kit/edge-upload.js`
- `packages/blueprints/kit/kit.js`
- `packages/blueprints/package.json`
- `packages/blueprints/src/edge-upload.test.ts`
- `packages/client/package.json`
- `packages/client/src/device-blob-source.ts`
- `packages/client/src/device-enrichment-compute.ts`
- `packages/client/src/react/screens/DevicesCard.tsx`
- `packages/client/src/react/shell/routes/GatewayRoute.tsx`
- `packages/client/src/video-frame.ts`
- `packages/gateway/src/backup/backup-cas-reconciliation.ts`
- `packages/gateway/src/backup/backup-config.ts`
- `packages/gateway/src/backup/backup-reconciliation.ts`
- `packages/gateway/src/backup/backup-service.ts`
- `packages/gateway/src/backup/backup-sources.test.ts`
- `packages/gateway/src/backup/backup-sources.ts`
- `packages/gateway/src/backup/restore-lazy-e2e.test.ts`
- `packages/gateway/src/routes/blob-custody-events.ts`
- `packages/gateway/src/routes/blob-routes.ts`
- `packages/gateway/src/routes/vault-routes.ts`
- `packages/gateway/src/serve/blob-sweep-health.ts`
- `packages/vault/package.json`
- `packages/vault/src/backup-policy.ts`
- `packages/vault/src/blob/cache.test.ts`
- `packages/vault/src/blob/cache.ts`
- `packages/vault/src/blob/derivatives.ts`
- `packages/vault/src/blob/evict.ts`
- `packages/vault/src/blob/local.ts`
- `packages/vault/src/blob/outbox-drain.test.ts`
- `packages/vault/src/blob/outbox-drain.ts`
- `packages/vault/src/blob/outbox-runner.ts`
- `packages/vault/src/blob/preflight.ts`
- `packages/vault/src/blob/preview.ts`
- `packages/vault/src/blob/read.ts`
- `packages/vault/src/blob/replica-index.ts`
- `packages/vault/src/blob/s3-pipeline.ts`
- `packages/vault/src/blob/s3-transfer.ts`
- `packages/vault/src/blob/s3.ts`
- `packages/vault/src/blob/seal-frames.ts`
- `packages/vault/src/blob/seal.test.ts`
- `packages/vault/src/blob/sigv4.ts`
- `packages/vault/src/blob/staging.ts`
- `packages/vault/src/blob/transfers.ts`
- `packages/vault/src/db.ts`
- `packages/vault/src/enrich/leases.ts`
- `packages/vault/src/index.ts`
- `receipts/issue-418-remote-primary-review.md`

## Out of scope

- The issue's explicitly labelled follow-up about repairing a corrupt-but-still-listed remote object during `BlobCustody.heal()`. It requires a separate provider-audit/repair policy beyond the 31 reviewed findings; this change does not resurrect evidence through backup reconciliation, which performs authenticated verification.
- Running the opt-in real disk-full and launchd tests, which require dedicated host fixtures. Their normal-suite skip markers remain intact.

## Decisions

- Bind CBSF nonces to a keyed digest of the complete AEAD plaintext rather than only the compression byte. This also separates any future representation change without another nonce rule.
- Treat replica evidence as target-scoped and clear it on every material S3 identity change; preserving old rows would be faster but could attest to the wrong provider.
- Keep synchronous `VaultDb.close()` synchronous by fencing late settlements and relying on the durable outbox for restart, while preserving an explicit awaitable graceful close for tests and coordinated shutdown paths.
- Use one CBSF frame per provider multipart part for durable encrypted resume. The fixed store-only representation trades compression on this path for deterministic offsets and true missing-frame seek.
- Introduce the small dependency-free `@centraid/blob-format` workspace package instead of allowing vault, client, or blueprints to own a wire protocol consumed by the other two.
- Update the restore fixture to model provider durability accurately by recording replica evidence after its manual remote write; without that evidence the new snapshot safety rule correctly includes the local bytes.
- Keep the transfer lifecycle coordinator and public API barrel intact with the repository's explicit file-size waiver instead of introducing a shutdown-only fragment or a second public entry point solely to satisfy a line counter.

## Verification

```sh
bun install --frozen-lockfile
bun run build
bun run check
bunx vitest run packages/vault --no-file-parallelism
bunx vitest run packages/gateway packages/client packages/blueprints --no-file-parallelism
bunx vitest run packages/gateway/src/backup/restore-lazy-e2e.test.ts
bunx vitest run packages/vault/src/enrich/leases.test.ts
git diff --check
```

- `bun install --frozen-lockfile` passed after the workspace lockfile update.
- `bun run build` passed across all 16 packages.
- `bun run check` passed formatting, Oxlint, and blueprint lint.
- Complete vault suite, file-sequential: 82 files passed; 723 tests passed; 1 opt-in test skipped.
- Complete gateway/client/blueprints suite, file-sequential: 221 files passed and 1 stale restore-fixture assertion failed after 1,649 tests passed / 2 opt-in tests skipped. The fixture manually wrote the remote object but omitted replica evidence; it was corrected to model the production contract.
- Corrected remote-primary lazy-restore suite: 2/2 passed in isolation.
- Enrichment lease/backlog suite after shared-rule SQL generation: 8/8 passed.
- Focused CBSF, S3, outbox, backup-source, edge-upload, device-read, mobile-transfer, route, reconciliation, policy, cache, and UI tests passed.
- Final resumable-upload, late-settlement, and device-polling regressions passed: 3 files, 20/20 tests.
- The default parallel repository graph can starve inherited 5-second tests. A deterministic file-sequential vault run passed the two cases that timed out under worker fan-out.
- `git diff --check` passed.

## Audit

Fresh-context audit against the complete diff and GitHub issue #418:

- **A1 — `## What changed` faithfully describes the diff:** PASS — The receipt accounts for all 56 changed paths and accurately covers the crypto/durability, backup/ingress/lifecycle, client/automation, efficiency, and shared-module work without a material omission.
- **A2 — every checked item is realized:** PASS — All 31 findings have implementation evidence. The auditor directly rechecked resumable direct/fallback error classification, late outbox settlement fencing, and last-good DevicesCard polling state; the focused three-file regression run passed 20/20.
- **A3 — `## Checklist` mirrors the issue:** PASS — The receipt maps one-for-one and in order to the issue's 31 numbered confirmed/plausible findings. The separately labelled `heal()` residual is correctly declared out of scope.

## Steering

Fresh-context audit of Codex session `019f69a1-52c9-7020-8c7d-b1a46f1d5160`:

- **B1 — every human-steering event is recorded:** PASS — The transcript contains no human interrupt or mid-task correction. The initial `/goal` is the ordinary task request and later continuation envelopes are runtime-generated, so no steering ledger row is owed.
- **B2 — no non-steering message is recorded as steering:** PASS — No steering rows are present, correctly excluding the initial task, ordinary agent/tool traffic, and runtime-generated continuation messages.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019f69a1-52c-1784188153-1 | codex | 019f69a1-52c9-7020-8c7d-b1a46f1d5160 | #418 | gpt-5.6-sol | 882555 | 0 | 44429568 | 87100 | 969655 | 14.6203 | 882555 | 0 | 44429568 | 87100 | fix(vault): harden remote-primary custody (#418) |
| codex-019f69a1-52c-1784188207-1 | codex | 019f69a1-52c9-7020-8c7d-b1a46f1d5160 | #418 | gpt-5.6-sol | 6191 | 0 | 353280 | 517 | 6708 | 0.1116 | 888746 | 0 | 44782848 | 87617 | fix(vault): harden remote-primary custody (#418) -m governance: allow-toolchain- |
