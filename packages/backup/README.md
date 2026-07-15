# @centraid/backup

Offsite storage: the **`centraid-storage-provider/1`** wire protocol seam
(`PROTOCOL.md`) — an account+grant layer (Layer 1) with workload semantics
layered on top per store class (Layer 2: `backup`, `cas`) — plus the
**`centraid-snapshot/1`** snapshot format engine (`FORMAT.md`) for the
`backup` store class. Read those two files first — they are normative; this
package is their reference implementation, and `conformance.ts` is the
protocol's own definition of "certified provider" (PROTOCOL.md § Conformance).

Zero runtime dependencies — Node >=22 builtins only (`node:crypto` webcrypto,
`node:fs`, `node:http` for test fakes, `fetch`).

## What's here

- **`provider.ts`** — the `BackupProvider` seam, `BackupProviderError` +
  reserved error codes, and every wire type (`ProviderCapabilities`,
  `SnapshotRow`, `TargetInfo`, `Usage`, `AccountStatus`, `S3Grant`,
  `StoreClass`, `StoreUsageReport`).
- **`object-store.ts`** / **`s3-store.ts`** — the `ObjectStore` data-plane
  seam; `FsObjectStore` (local disk) and `S3ObjectStore` (a minimal SigV4
  client over `fetch`, no AWS SDK; region comes from the grant, not a
  hardcode).
- **`wire-client.ts`** — shared HTTP + `{data}`/`{error}` envelope handling
  for `RemoteBackupProvider` and `cas-grant.ts`.
- **`cas-grant.ts`** — `requestStorageGrant` / `requestCasGrant`: a standalone
  Layer-1 grant path for a `cas` consumer (e.g. the vault's `S3BlobStore`)
  that has no business pulling in the snapshot engine.
- **`parts.ts`** — deterministic fixed-size splitting (format `/1`: 16 MiB)
  for encrypted, keyed-content-addressed snapshot objects.
- **`crypto.ts`** — AES-256-GCM object encryption, HKDF-SHA256 per-vault key
  derivation, keyed chunk ids, and keyring (epoch) custody.
- **`manifest.ts`** — canonical-JSON manifest build/seal/open/verify.
- **`engine.ts`** — provider-agnostic `createSnapshot` / `restoreSnapshot` /
  `verifySnapshot` / `writeRecoveryKit`.
- **`wal-format.ts`** / **`wal-restore.ts`** — authenticated WAL segment,
  closer and pair-marker codecs; rolling SQLite checksum validation; and
  coordinated two-database PITR replay.
- **`local-provider.ts`** — a full `BackupProvider` backed by the local
  filesystem (`purgeAuthTier: 'api-key'` — the local disk IS the user's own
  custody). Doubles as this package's conformance reference implementation.
- **`remote-provider.ts`** — the HTTP+S3 client side of the protocol
  (`purgeAuthTier: 'interactive'`, enforced server-side).
- **`conformance.ts`** — `providerConformanceCases()`, the grading suite any
  `BackupProvider` (this package's own or a third party's) is run against.

## Running tests

```
bun run test        # this package only (vitest run)
bun run typecheck    # tsc -p tsconfig.test.json --noEmit
bun run build         # tsc -p tsconfig.json -> dist/
```

Or from the repo root: `turbo run test --filter=@centraid/backup`, or
`vitest run --project @centraid/backup` (this package is registered in the
root `vitest.config.ts` projects list).

Tests use real temp dirs (`fs.mkdtemp`) and a real in-process `node:http`
fake gateway (`remote-provider.test.ts`) — no fs or network mocks.
