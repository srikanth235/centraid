# @centraid/backup

Offsite backup: the **`centraid-backup-provider/1`** wire protocol seam
(`PROTOCOL.md`) plus the **`centraid-snapshot/1`** snapshot format engine
(`FORMAT.md`). Read those two files first — they are normative; this
package is their reference implementation, and `conformance.ts` is the
protocol's own definition of "certified provider" (PROTOCOL.md § Conformance).

Zero runtime dependencies — Node >=22 builtins only (`node:crypto` webcrypto,
`node:fs`, `node:http` for test fakes, `fetch`).

## What's here

- **`provider.ts`** — the `BackupProvider` seam, `BackupProviderError` +
  reserved error codes, and every wire type (`ProviderCapabilities`,
  `SnapshotRow`, `TargetInfo`, `Usage`, `AccountStatus`, `S3Grant`).
- **`object-store.ts`** / **`s3-store.ts`** — the `ObjectStore` data-plane
  seam; `FsObjectStore` (local disk) and `S3ObjectStore` (a minimal SigV4
  client over `fetch`, no AWS SDK).
- **`chunker.ts`** — FastCDC content-defined chunking with a frozen,
  deterministic gear table (format `/1`: min 512 KiB, avg 1 MiB, max 4 MiB).
- **`crypto.ts`** — AES-256-GCM object encryption, HKDF-SHA256 per-vault key
  derivation, keyed chunk ids, and keyring (epoch) custody.
- **`manifest.ts`** — canonical-JSON manifest build/seal/open/verify.
- **`engine.ts`** — provider-agnostic `createSnapshot` / `restoreSnapshot` /
  `verifySnapshot` / `writeRecoveryKit`.
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
