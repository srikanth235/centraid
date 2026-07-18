# Gateway low-end performance and Rust byte plane

Issue [#456](https://github.com/srikanth235/centraid/issues/456) is a measured
hardening pass for Pi-class and otherwise constrained gateway hosts. This
document is the durable record of the measurements, implemented boundaries,
and accepted designs that are intentionally gated on later evidence. It does
not make the Rust process a second gateway: TypeScript remains the only place
that decides identity, consent, app policy, scheduling, and replication state.

## Measurement loop

The benchmark in `packages/gateway/scripts/bench-low-end.mjs` boots a real
authenticated gateway and submits 120 concurrent, journalled Atlas writes
split across party/place shapes with 30 interleaved authenticated status
reads. The checked-in budgets are request p99 <= 250 ms, peak RSS <= 512 MiB,
event-loop peak p99 <= 150 ms, <= 6 fsyncs and <= 128 KiB physical disk writes
per write, <= 500,000 idle context switches/hour, and <= 10 MiB idle physical
writes/hour. Platforms without a physical-byte counter fall back to <= 5,000
raw OS filesystem-output units/hour.

The primary idle observation lasts 65 seconds, covering the 30-second and
60-second recurring service cadences instead of extrapolating a two-second
scheduler sample. The separate fsync-only trace ends its measured epoch before
idle and therefore uses a one-millisecond teardown wait.

| Run | Request p50 | Request p99 | Throughput | Peak RSS | Event-loop peak p99 | Boot fsync | Idle context switches/hour | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Baseline | 39.70 ms | 381.76 ms | 66.06/s | 156.8 MB | 367.26 ms | 5.64 ms | 496,375 | request + event-loop fail |
| First implementation pass | 9.64 ms | 20.62 ms | 388.55/s | 184.3 MB | 173.67 ms | 12.93 ms | 226,717 | event-loop fail |
| Pre-final iteration | 6.14 ms | 15.88 ms | 604.19/s | 192.2 MB | 134.02 ms | 14.56 ms | 247,895 | pass |
| Pre-audit constrained-profile run | 15.10 ms | 24.73 ms | 265.57/s | 213.1 MB | 24.95 ms | 4.48 ms | 246,497 | pass |
| Completed scope after parse-once router | 18.74 ms | 40.23 ms | 188.55 writes/s | 212.2 MB | 35.03 ms | 12.20 ms | 383,457 | pass |
| First Linux traced-primary gate | 23.70 ms | 40.21 ms | 152.30 writes/s | 170.5 MB | 29.97 ms | 1.89 ms | 1,115,868 | fsync pass; OS-counter/ptrace fail |
| Corrected untraced 2s sample | 16.33 ms | 27.87 ms | 231.09 writes/s | 212.9 MB | 29.77 ms | 5.24 ms | 375,859 | pass |
| Two-second stability recheck | 13.21 ms | 18.05 ms | 288.15 writes/s | 208.0 MB | 23.10 ms | 5.51 ms | 507,421 | idle extrapolation fail |
| Corrected 65-second final | 13.63 ms | 19.09 ms | 281.43 writes/s | 212.8 MB | 24.00 ms | 5.59 ms | 387,958 | pass |

The first final attempt counted app install/bundle prewarming in the
event-loop workload epoch and reported a 674.23 ms peak. Boot and prewarming
are already measured separately, so the harness now performs authenticated
warmup and explicitly resets the performance measurement epoch before the
write sample. This is not an event-loop filter: every sample during the
measured write workload remains included. The result is stored at
`packages/gateway/benchmarks/results/issue-456-final.json`. The final run
explicitly sets `CENTRAID_HARDWARE_PROFILE=constrained`; the 8-core/16 GiB
measurement host therefore exercises the low-end worker, replication,
compression, and SQLite defaults. Linux CI repeats the constrained profile.

RSS rose from 156.8 MB to 212.8 MB after adding precompressed app variants,
codec runtimes, and the performance monitor. That remains well below the
512 MiB ceiling. The p99 improvement from 381.76 ms to 19.09 ms and event-loop
improvement from 367.26 ms to 24.00 ms are the deciding changes; throughput
rose from 66.06 to 281.43 writes/second after every Atlas write was moved
through the shared group-commit window.

macOS cannot provide an unprivileged exact SQLite fsync count. It reports
`process.resourceUsage()` write counters, while the Linux benchmark lane uses
an untraced primary run plus a separately traced fsync run and requires exact
fsync collection with
`CENTRAID_BENCH_REQUIRE_FSYNC=1`. Missing Linux fsync data is a failure, not a
zero. Trace markers scope the syscall count to the write epoch and resumed
syscalls count exactly once. Keeping the primary run outside ptrace avoids
inflating latency and idle context switches. Linux physical-write gating uses
`/proc/self/io.write_bytes`; the OS-specific `resourceUsage().fsWrite` counter
is diagnostic only because Linux exposes it in output blocks, not portable
write operations. The macOS final artifact therefore leaves `fsyncCalls` and
`fsyncPerWrite` as `null`.

### Runtime comparison (N7)

The same Node 24.4.1 process measured `node:sqlite` import/open at 0.825459 ms,
10,000 transaction writes at 10.989584 ms, 10,000 reads at 11.608666 ms, and
RSS at 53,051,392 bytes. Bun 1.3.13 cannot load `node:sqlite` (`No such built-in
module: node:sqlite`), so no honest like-for-like performance comparison is
possible. The runtime decision is no-go: retain Node until Bun supports the
required API and passes the same durability and gateway suites. The machine-
readable result is `packages/gateway/benchmarks/results/issue-456-runtime.json`.

## Implemented TypeScript workstreams

The implemented work follows the issue numbering:

- **M1-M3 — measurement:** a real-gateway authenticated write harness, checked
  budgets, event-loop/RSS/resource counters, and an explicit 4 KiB boot-fsync
  probe make latency, memory, storage, and idle regressions visible.
- **E1-E5 — byte egress:** blobs and tunnel bodies stream instead of being
  materialized; open-ended ranges are capped; relay buffers are reused or
  native; worker admission is hardware-bounded; replication uses an explicit
  low-end concurrency profile.
- **S1-S7 — SQLite:** the databases use deliberate page/WAL pragmas, NORMAL is
  available for constrained hardware while FULL remains the standard default,
  ordinary marker cleanup avoids a redundant transaction, arrival-window
  group commit shares the vault/journal transactions, WAL clone fallback is
  detected, maintained counts replace repeated full scans, and new databases
  use 8 KiB pages. Group commit preserves cross-database recovery markers: it
  commits vault state, commits the journal, then cleans markers. It therefore
  reduces per-invocation commits without pretending SQLite can atomically
  fsync two independent files.
- **C1-C8 — CPU/memory:** ingestion no longer generates previews; existing
  batching remains the write primitive; native daemon previews use `sharp`
  while Electron uses `wasm-vips`; compression is asynchronous; app assets are
  prebuilt with Brotli/gzip variants and prewarmed at publish/install; resumable
  SHA state comes from `hash-wasm` while ordinary hashing uses the native
  implementation; standard-profile automation workers stay warm while the
  constrained profile keeps no idle workers; and response compression uses
  native zlib outside the route body.
- **R1-R4 — request path:** route prefix dispatch avoids repeated full-list
  matching, authorization stats and sessions use bounded indexes, HTTP server
  limits are explicit, and SSE serialization is shared/single-flight.
- **I1-I8 — idle/background:** the outbox is adaptive, gateway ownership is
  leased, an empty scheduler does not write, backup timers do not start without
  configuration, replication is push-driven, periodic work is jittered, the
  spool reuses an fd and fsyncs every 4 MiB, and WAL shipping probes reflink
  support and logs copy fallbacks. Background jobs consult the health valve,
  and child agents run with `nice` (plus low-priority `ionice` on Linux) unless
  explicitly overridden.

The health valve defers background sweeps, scheduled backups, WAL drains, and
slow-clock connector work whenever rolling p99 exceeds 50 ms. Foreground work
and correctness-critical lease/commit operations are never deferred.

## Adaptive hardware profile (A7)

The profile is deterministic and observable. Explicit environment overrides
win. Otherwise a machine is constrained when it has at most four available
cores, at most 4 GiB RAM, or a boot fsync probe of at least 8 ms.

| Setting | Constrained | Standard |
| --- | ---: | ---: |
| SQLite synchronous | NORMAL | FULL |
| worker concurrency | 2 | 8 |
| worker old-generation cap | 128 MB | 256 MB |
| idle warm-worker pool | 0 | 2 |
| replication concurrency | 1 | 3 |
| static Brotli quality | 5 | 10 |
| vault sweep cadence | 2 hours | 1 hour |
| empty outbox cadence | 2 minutes | 1 minute |
| mount strategy | eager (scheduler-safe) | eager |

`CENTRAID_HARDWARE_PROFILE=constrained|standard` selects the class and
`CENTRAID_SQLITE_SYNCHRONOUS=FULL|NORMAL` overrides only SQLite durability.
Vault mounting remains eager in both profiles until the A5 scheduler index
below is implemented; silently skipping an automation wakeup would be a
correctness regression, not a performance optimization.

## Accepted, evidence-gated designs (A1-A5)

These designs close the architecture portion of #456. They are not claimed as
implemented because the final benchmark passes without their complexity.

### A1 — semantic read cache

Cache key: `(vaultId, normalized query/shape id, canonical arguments, consent
generation)`. Each result records the table dependency set captured by the
query/shape compiler. A bounded LRU stores only successful, immutable response
values. The vault change bus publishes the touched table set and replica
doorbell generation after commit; any intersecting entry is synchronously
invalidated before the next read. Consent generation changes invalidate the
whole app/vault partition. TTL may bound memory but must never be the
correctness mechanism. Unknown or dynamic dependencies bypass the cache.

### A2 — compiled consent decisions

Compile unconditional grants into a flat key
`(vaultId, appId, action, entityKind) -> allow|park|deny`. A grant-generation
counter rebuilds the affected app/vault table on grant mutation or revocation.
`deny` remains the default; confirmation-required grants compile to `park`.
Row predicates, sealed-field conditions, owner prompts, and any decision that
cannot be represented exactly take the existing slow policy path. Receipts and
journal writes remain on both paths.

### A3 — incremental materializations

`item_count` is implemented as a maintained counter. The same transaction-
ordered change bus can maintain `run_summary` rows and an FTS projection by
consuming committed conversation/item deltas. Each materializer stores its
last applied change generation and is idempotent; a missing generation or
schema epoch mismatch rebuilds from source tables before serving. Derived
tables never become the source of truth.

### A4 — verified boot snapshot

The boot snapshot is a binary, versioned blob containing only expensive,
reconstructible catalog/manifest indexes. Its cache key includes application
version, schema epoch, and every input file's stable path, size, and mtime. Boot
memory-maps or reads it only after checksum and key verification. Any mismatch,
decode error, or partial write falls back to the canonical files and atomically
rebuilds the snapshot. Secrets, consent decisions, leases, and mutable runtime
state are excluded.

### A5 — correctness-safe lazy vault mount

Lazy mount requires a small gateway-level scheduler index containing
`vaultId`, next automation fire time, scheduler epoch, and a checksum/version.
The index is updated transactionally with scheduling changes and rebuilt by an
eager reconciliation when absent or invalid. A foreground request mounts on
first access; the scheduler mounts before the indexed next-fire deadline and
then validates against the vault journal. Until that index and wakeup test
exist, eager mount stays the default for constrained and standard profiles.

## A6 and A8 decisions

**A6** is implemented as the p99 health valve and OS-level child priority
described above. It is deliberately a deferral valve, not cancellation: work
becomes eligible again when the rolling window recovers.

**A8** is a measured no-go for moving SQLite to a worker thread. The final
19.09 ms request p99 is below the 250 ms budget and 24.00 ms event-loop peak is
below the 150 ms budget. Crossing the database boundary would add a second
serialization/error surface without evidence it is needed. Revisit only if
the Linux Pi lane fails either p99 or event-loop lag after the implemented
background valve is active.

## Rust byte-plane strangler

`packages/data-plane` owns dumb byte movement and bounded native transforms.
Its trust boundary is intentionally narrow:

1. TypeScript authenticates a user/device and decides the permitted object,
   route, headers, range, provider operation, and expiry.
2. TypeScript gives Rust either a short-lived one-use HMAC ticket or a private
   control secret plus already-authorized parameters.
3. Rust validates the ticket/secret, confines local paths to the configured
   root, caps ranges and transform bodies, then streams bytes with backpressure.
4. Rust returns status, byte count, hashes, or provider receipt data. TypeScript
   alone updates custody, consent, journals, and replica state.

### Native surfaces and gates

- **N0a:** `cargo check/test --locked`, formatting, clippy in CI, and the
  release profile are workspace scripts. The crate declares Rust 1.91 and pins
  the resolved dependency graph in `Cargo.lock`.
- **N0b:** one HTTP lifecycle contract either spawns the selected binary or
  targets `CENTRAID_BYTE_PLANE_BASE_URL` plus a shared fixture root, so absorbed
  routes are tested without language-specific assertions.
- **N1:** the deterministic `@number0/iroh` probe records that `Array<number>`
  succeeds while `Uint8Array` and `Buffer` fail; the upstream fix is tracked in
  `n0-computer/iroh-ffi#276`.
- **N2:** the napi-rs module inside `packages/tunnel/native` owns both gateway
  ALPNs, calls private TS metadata routes for authorization/pairing, and streams
  QUIC bodies to loopback HTTP without surfacing bytes in JavaScript. The JS
  endpoint remains the rollback path when no target artifact exists.
- **N3:** `/v1/blob` serves one-use, 10-second HMAC tickets with root-confined
  paths, HEAD/GET, immutable metadata, and single bounded Range support.
- **N4:** `/v1/hash` and `seal-cbsf`/`open-cbsf` provide streaming RustCrypto
  SHA-256 and authenticated CBSF v2 store/zstd/raw-deflate frames. Snapshot/WAL
  JSON, HKDF, nonce, AES-GCM, and SHA have cross-language golden fixtures.
- **N5:** `/v1/compress` and `/v1/pump` move bounded compression/provider bytes
  with backpressure. TypeScript still chooses provider URL, headers,
  multipart/SigV4 policy, and custody transition.
- **N6:** `/v1/preview` validates dimensions and allocation before decode and
  runs the bounded JPEG transform off the gateway event loop.
- **N7:** Bun is rejected for the gateway runtime until the `node:sqlite`
  compatibility gate and the same benchmark/test suite pass.

The N1 binding probe lives at `packages/tunnel/scripts/probe-typed-array.mjs`.
The upstream report filed as
[`n0-computer/iroh-ffi#276`](https://github.com/n0-computer/iroh-ffi/issues/276)
is:

> **Title:** Node bindings: accept and return Buffer/Uint8Array for byte APIs
>
> `@number0/iroh@1.0.0` exposes byte-bearing Node APIs as `Array<number>` and
> validates the runtime input as an Array; passing a `Uint8Array`/`Buffer`
> produces `Failed to get Array length`. This forces high-volume tunnel frames
> through per-byte JS boxing and copies. Please expose byte values as
> `Uint8Array` (accepting Node `Buffer`, its subclass), retain an Array overload
> temporarily for compatibility, and return typed arrays from receive APIs.
> Centraid issue #456 has a deterministic control/variant binding probe and
> native-relay workaround.

The confirmed report was submitted through the authenticated GitHub issue
form and is live upstream.

## Compatibility and rollback

The golden fixture covers canonical snapshot JSON, WAL addressing and
encryption, HKDF, AES-GCM, SHA-256, and CBSF v2 in both TypeScript and Rust.
The HTTP lifecycle contract covers ticket expiry/replay, metadata, Range
limits, hashing, compression, previewing, and the provider pump. Deployments
can omit the direct-HTTP sidecar and continue on TypeScript paths; the tunnel
package also retains its JS rollback endpoint. No on-disk format or consent
authority depends on Rust availability.
