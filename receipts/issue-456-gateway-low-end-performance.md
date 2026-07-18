# Issue #456 — gateway low-end performance and Rust data plane

GitHub issue: [#456](https://github.com/srikanth235/centraid/issues/456)

## Checklist

- [x] M1 Gateway-side bench harness
- [x] M2 Event-loop lag probe
- [x] M3 Storage-latency probe at boot
- [x] E1 Stream blob egress
- [x] E2 Kill tunnel `Array<number>` byte boxing
- [x] E3 Tunable worker ceilings
- [x] E4 Stream tunnel request bodies
- [x] E5 Lower `replicationConcurrency`
- [x] S1 Read-tuning pragmas
- [x] S2 Collapse ordinary-command finalize
- [x] S3 `synchronous` as tunable
- [x] S4 Group commit
- [x] S5 WAL safety net
- [x] S6 Replace `MSG_COUNT_SUBQUERY`
- [x] S7 `page_size` 8–16 KB
- [x] C1 Get image previews off ingest
- [x] C2 Client-contributed previews
- [x] C3 Faster codec behind seam
- [x] C4 Async compression
- [x] C5 Precompress build/install
- [x] C6 Native SHA-256 resumable uploads
- [x] C7 Warm `WorkerPool` automation
- [x] C8 Gateway-native JSON compression
- [x] R1 Prefix dispatch table
- [x] R2 Kill per-request `statSync`
- [x] R3 HTTP server tuning
- [x] R4 Single-flight reads/SSE stringify
- [x] I1 Adaptive outbox timer
- [x] I2 Instance lease write
- [x] I3 Empty scheduler ledger skip
- [x] I4 Backup timer unconfigured
- [x] I5 Push replica delta
- [x] I6 Jitter timers
- [x] I7 Batch spool fsync
- [x] I8 Reflink detection
- [x] N0a Cross-language goldens
- [x] N0b Over-HTTP contract
- [x] N1 iroh typed-array binding experiment/upstream proposal
- [x] N2 Rust tunnel relay
- [x] N3 Rust blob egress
- [x] N4 Sealing/hashing
- [x] N5 Backup/provider pump
- [x] N6 Rust preview raster
- [x] N7 Bun experiment
- [x] A1 Semantic read-cache spec
- [x] A2 Consent-decision spec
- [x] A3 Materialization spec
- [x] A4 Boot-snapshot spec
- [x] A5 Lazy-mount spec
- [x] A6 Load shedding
- [x] A7 Hardware profiles
- [x] A8 Off-thread SQLite decision

## What changed

### Measure, iterate, and enforce

- **M1 Gateway-side bench harness** — added a real gateway workload that boots a
  vault, runs 120 authenticated writes split evenly across two Atlas write
  shapes with 30 authenticated reads interleaved, samples request latency,
  RSS, event-loop lag, filesystem activity, and idle wakeups, and emits stable
  JSON. Baseline, intermediate, runtime, and final measurements are documented
  in `packages/gateway/benchmarks/README.md`; the final artifact is committed.
- **M2 Event-loop lag probe** — one continuously enabled
  `monitorEventLoopDelay` histogram feeds rolling health snapshots and exposes
  current/peak p99 lag plus bounded load-shedding state without blind gaps.
- **M3 Storage-latency probe at boot** — boot performs an isolated 4 KiB
  write/fsync/unlink probe and reports its latency without touching vault data.
- The final explicitly constrained-profile run (120 writes, 30 reads,
  concurrency 4, 65-second idle window) measured write p50 **13.63 ms**, p99
  **19.09 ms**, max **19.38 ms**, and **281.43 writes/s**; read p99 was
  **2.41 ms**; peak RSS was **212,795,392 bytes**; event-loop peak p99 was
  **24.00 ms**; boot fsync was **5.59 ms**; idle context switches were
  **387,958/hour**; and idle filesystem writes were **0/hour**. Every locally
  available budget passed. Linux CI runs the same constrained primary workload
  untraced, then scopes a second `strace` run to workload markers and requires
  exact fsync data.
- The first Linux gate failed before trace injection because its child inherited
  the required-fsync flag. The second measured **1 fsync / 120 writes**
  (**0.0083/write**, against **6/write**) but also proved that Linux
  `resourceUsage().fsWrite` is an output-block count rather than portable write
  operations and that ptrace contaminated the idle context-switch sample. The
  final harness preserves that exact fsync gate while measuring primary
  latency/resource/idle metrics outside ptrace and gating physical
  `/proc/self/io.write_bytes` at **128 KiB/write**.
- A repeated two-second untraced sample moved the idle extrapolation from
  **375,859/hour** to **507,421/hour**, proving the short window was itself
  unstable. The ceiling was not widened: the final 65-second window covers both
  30-second and 60-second recurring gateway cadences, while the trace-only
  child uses a one-millisecond teardown wait after its measured fsync epoch.

### Eliminate byte and buffering pathologies

- **E1 Stream blob egress** — local reads use file streams; remote-only reads
  use backpressured 4 MiB provider windows, verify the content address, and
  promote through a same-filesystem temp file without a whole-object Buffer.
  Range handling is bounded, and response abort/close destroys the source.
- **E2 Kill tunnel `Array<number>` byte boxing** — the packaged napi-rs relay
  owns the gateway and desktop pairing ALPNs and streams request/response bytes
  directly between iroh and loopback HTTP. JavaScript receives only
  authorization, active-upstream, and pairing metadata;
  the deterministic binding probe documents why the JS fallback must box.
- **E3 Tunable worker ceilings** — handler, automation, and agent worker caps
  are profile-aware and configurable, with bounded FIFO admission.
- **E4 Stream tunnel request bodies** — request bodies flow as bounded byte
  chunks instead of being materialized as boxed arrays.
- **E5 Lower `replicationConcurrency`** — replication uses a profile-aware,
  lower default that reduces RSS pressure on constrained machines.

### Reduce SQLite and persistence costs

- **S1 Read-tuning pragmas** — gateway/vault connections apply bounded
  `mmap_size`, `cache_size`, and related read tuning per hardware profile.
- **S2 Collapse ordinary-command finalize** — ordinary commands now share one
  commit/finalize boundary instead of paying redundant persistence work.
- **S3 `synchronous` as tunable** — the standard profile retains `FULL`; the
  constrained profile selects `NORMAL`, explicitly documenting the durability
  trade-off instead of weakening the default.
- **S4 Group commit** — a true bounded group-commit queue coalesces concurrent
  ordinary-command finalization while preserving per-call outcomes. Every
  production request-path command entry point, including the benchmark's Atlas
  writes, passes through the queue; a database-level regression proves ten
  real commands in one window cross exactly one vault commit plus one journal
  commit. Proven marker cleanup piggybacks on the next shared pair rather than
  creating a third transaction. A failed journal finalization
  rejects only that queued call while preserving its canonical vault marker,
  so retries cannot duplicate an already-committed command.
- **S5 WAL safety net** — checkpointing remains bounded and detects foreign
  checkpoint/reset conditions without silently losing a stream.
- **S6 Replace `MSG_COUNT_SUBQUERY`** — conversation rows maintain `item_count`
  transactionally and migration/tests cover existing databases.
- **S7 `page_size` 8–16 KB** — new gateway databases use an 8 KiB page while
  existing databases are preserved.

### Move CPU work off hot paths

- **C1 Get image previews off ingest** — raw ingress records derivative work;
  the bounded background sweep performs fallback rendering.
- **C2 Client-contributed previews** — the mobile producer contributes typed
  derivative classes, and gateway validation accepts only well-formed
  contributions.
- **C3 Faster codec behind seam** — preview encoding has a native daemon seam,
  a bounded `wasm-vips` fallback for Electron/web-safe packaging, and the
  existing JS fallback.
- **C4 Async compression** — backup compression is asynchronous and can use the
  Rust plane rather than blocking the gateway event loop.
- **C5 Precompress build/install** — web assets receive deterministic Brotli
  and gzip variants during build/install and installed app bundles prewarm
  their variants.
- **C6 Native SHA-256 resumable uploads** — serializable incremental hashing
  can use native/hash-wasm state, preserving crash-resume semantics.
- **C7 Warm `WorkerPool` automation** — low-priority worker warmup is bounded,
  profile-aware, and reusable by automation runners.
- **C8 Gateway-native JSON compression** — route responses negotiate Brotli or
  gzip correctly, including `q=0`, and compress outside the route hot path.

### Remove per-request and idle overhead

- **R1 Prefix dispatch table** — gateway route selection reads/query-strips the
  pathname once and follows an immutable segment trie from most-specific to
  least-specific handlers; disjoint route families are never walked.
- **R2 Kill per-request `statSync`** — authentication metadata uses a TTL cache
  and indexed session/device state rather than synchronous filesystem stats.
- **R3 HTTP server tuning** — keep-alive/header/request timeouts and connection
  ceilings are explicit and profile-aware.
- **R4 Single-flight reads/SSE stringify** — repeated change reads share
  in-flight work and SSE payloads are serialized once per event.
- **I1 Adaptive outbox timer** — active/deferred work polls quickly, empty
  states use the hardware-profile idle cadence, failures exponentially back
  off to a cap, and every recursive timeout is jittered.
- **I2 Instance lease write** — the heartbeat widens from 30 to 60 seconds and
  its freshness window scales proportionally, halving steady-state writes.
- **I3 Empty scheduler ledger skip** — reconciliation performs no ledger write
  when there is no semantic scheduler change.
- **I4 Backup timer unconfigured** — no backup timer is installed until backup
  is configured; one-shot scheduling uses each vault's actual remaining RPO,
  and policy or live storage-backend create/update/delete transitions re-arm it
  immediately.
- **I5 Push replica delta** — commit-time doorbells name affected shapes so
  replicas wake from actual changes instead of polling the whole catalog.
- **I6 Jitter timers** — recurring vault/gateway timers share bounded jitter to
  avoid synchronized wakeup storms.
- **I7 Batch spool fsync** — WAL spool descriptors stay open and fsync at a
  bounded 4 MiB batch boundary instead of reopening/syncing every fragment.
- **I8 Reflink detection** — clone capability is probed and cached; supported
  filesystems use copy-on-write clones with a safe copy fallback.

### Rust data plane and architecture contract

- **N0a Cross-language goldens** — TypeScript and Rust verify the same format,
  ticket, crypto, and CBSF fixtures in both toolchains.
- **N0b Over-HTTP contract** — one lifecycle contract launches either the
  TypeScript reference implementation or the real Rust binary (and can target
  an external base URL/root). CI runs every health, one-use blob ticket/Range,
  hashing, compression, preview, and provider-pump assertion against both
  implementations without language-specific branches.
- **N1 iroh typed-array binding experiment/upstream proposal** — the committed
  deterministic probe proves `Array<number>` succeeds while `Uint8Array` and
  `Buffer` fail at the Node binding. The proposal and reproduction are filed as
  [`n0-computer/iroh-ffi#276`](https://github.com/n0-computer/iroh-ffi/issues/276).
- **N2 Rust tunnel relay** — the normal `packages/tunnel` build produces its
  target-specific napi module and both gateway-daemon and Electron-desktop
  production entry points require it (no silent JS fallback). Real integration
  tests prove both pairing modes, dynamic desktop upstreams, and 2 MiB tunneled
  request/response bodies stay in Rust while only authenticated control
  metadata crosses to TypeScript; revocation closes Rust-owned live connections.
  Gateway HTTP removal awaits the relay close, while the separate-process SSH
  CLI reaches the same handle through a directory watch on atomic enrollment
  rewrites, with no idle polling timer.
- **N3 Rust blob egress** — one-use, expiring, byte-bounded tickets authorize
  streamed full and Range responses; invalid suffix ranges return 416.
- **N4 Sealing/hashing** — Rust exposes streaming SHA-256, zstd compression,
  and CBSF-compatible sealing/opening through bounded `Read`/`Seek`/`Write`
  I/O. CBSF uses two-pass hashing, per-frame streaming, and expected-size
  decode caps rather than loading or expanding the full object in memory,
  without giving the byte plane control-plane authority.
- **N5 Backup/provider pump** — a bounded provider pump moves streamed data
  without buffering the entire object.
- **N6 Rust preview raster** — dimensions and allocation limits are checked
  before decode; output dimensions/quality are bounded.
- **N7 Bun experiment** — Node/Bun runtime and SQLite behavior are measured by
  a committed probe; the results do not justify a runtime migration.

### Safe adaptive behavior and gated next moves

- **A1 Semantic read-cache spec**, **A2 Consent-decision spec**, **A3
  Materialization spec**, **A4 Boot-snapshot spec**, and **A5 Lazy-mount
  spec** are written as gated designs with invalidation, authority, rollback,
  and measurement criteria. They were not built because the final constrained
  benchmark passes and the issue requires measurement before adding those
  complexity layers.
- **A6 Load shedding** — health-based admission rejects bounded low-priority
  work when event-loop lag crosses the configured threshold while core owner
  operations remain available.
- **A7 Hardware profiles** — auto/standard/constrained profiles coherently
  drive worker caps, cache sizes, compression quality, replication, HTTP
  ceilings, SQLite durability, adaptive timer cadences, and the lazy-created
  automation pool. Storage detection resolves before those runtime defaults;
  an explicit profile propagates through the built gateway and is recorded in
  benchmark artifacts. Vault mounts remain eager in both profiles until the A5
  correctness gate is met.
- **A8 Off-thread SQLite decision** — measured and recorded as a no-go for this
  change: serialization/ownership complexity outweighed any remaining hot-path
  benefit after the lower-risk work passed every budget.

## Decisions

- Rust has two packaging forms: the required napi tunnel module and the
  optional direct-HTTP sidecar. TypeScript retains identity/policy authority;
  Rust receives authenticated metadata or expiring byte-bounded capabilities.
- Standard durability remains `synchronous=FULL`. Only the explicitly selected
  constrained profile uses `NORMAL`; the profile is observable and reversible.
- A1–A5 are complete specifications but intentionally gated implementations.
  Building them after the measured budgets passed would add invalidation and
  recovery risk without evidence of need.
- The Bun runtime move and off-thread SQLite move are explicit no-go decisions
  from N7/A8 measurements, not silently omitted work.
- Benchmark warmup resets the measurement epoch. Linux syscall traces use
  unique trace files and workload markers so boot/shutdown calls and stale
  `unfinished/resumed` records cannot corrupt per-write fsync accounting.
- Native transform endpoints require the control secret. Byte tickets are
  one-use, expiring, path-scoped, and byte-bounded; Rust preview dimensions and
  allocation are bounded before decode.

## Out of scope

- Implementing A1–A5. Their issue-required specs and gates are complete; the
  final constrained benchmark passes all budgets, so their implementation
  trigger was not met.
- Migrating the gateway runtime to Bun or moving SQLite ownership to another
  thread. N7/A8 measured both and record the no-go rationale.

## Files

Changed paths covered by this receipt:

- `.github/workflows/ci.yml`
- `.github/workflows/pairing-relay-e2e.yml`
- `.gitignore`
- `ARCHITECTURE.md`
- `README.md`
- `apps/desktop/src/main/local-gateway.ts`
- `apps/desktop/src/main/phone-link.ts`
- `apps/mobile/src/lib/upload/media-producer.test.ts`
- `apps/web/package.json`
- `apps/web/scripts/precompress.mjs`
- `bun.lock`
- `docs/plans/gateway-low-end-and-rust-plane.md`
- `package.json`
- `packages/agent-runtime/src/automation/run-automation-host-agent.ts`
- `packages/agent-runtime/src/automation/run-automation-live-dispatch.ts`
- `packages/agent-runtime/src/backends/codex/backend.ts`
- `packages/agent-runtime/src/backends/codex/model-list.ts`
- `packages/agent-runtime/src/host-tools.ts`
- `packages/agent-runtime/src/low-priority.test.ts`
- `packages/agent-runtime/src/low-priority.ts`
- `packages/agent-runtime/src/preflight.ts`
- `packages/app-engine/src/changes/change-bus.ts`
- `packages/app-engine/src/conversation/store-sql.ts`
- `packages/app-engine/src/conversation/store.test.ts`
- `packages/app-engine/src/handlers/handler-pool.test.ts`
- `packages/app-engine/src/handlers/handler-runner.ts`
- `packages/app-engine/src/handlers/worker-admission.ts`
- `packages/app-engine/src/handlers/worker-pool.ts`
- `packages/app-engine/src/http/app-bundle.test.ts`
- `packages/app-engine/src/http/app-bundle.ts`
- `packages/app-engine/src/http/asset-variants.ts`
- `packages/app-engine/src/http/changes-sse.ts`
- `packages/app-engine/src/http/compression.test.ts`
- `packages/app-engine/src/http/compression.ts`
- `packages/app-engine/src/http/http-server.ts`
- `packages/app-engine/src/http/server-tuning.test.ts`
- `packages/app-engine/src/http/server-tuning.ts`
- `packages/app-engine/src/http/static-server.ts`
- `packages/app-engine/src/index.ts`
- `packages/app-engine/src/runtime.ts`
- `packages/app-engine/src/stores/gateway-db.test.ts`
- `packages/app-engine/src/stores/gateway-db.ts`
- `packages/automation/src/fire/in-process-scheduler.test.ts`
- `packages/automation/src/fire/in-process-scheduler.ts`
- `packages/automation/src/handler/runner.ts`
- `packages/automation/src/worker/runner.ts`
- `packages/backup/src/compress.test.ts`
- `packages/backup/src/compress.ts`
- `packages/backup/src/engine.ts`
- `packages/backup/src/rust-golden.test.ts`
- `packages/data-plane/Cargo.lock`
- `packages/data-plane/Cargo.toml`
- `packages/data-plane/README.md`
- `packages/data-plane/fixtures/format-golden.json`
- `packages/data-plane/package.json`
- `packages/data-plane/scripts/generate-golden.ts`
- `packages/data-plane/src/cbsf.rs`
- `packages/data-plane/src/format.rs`
- `packages/data-plane/src/http_plane.rs`
- `packages/data-plane/src/iroh_relay.rs`
- `packages/data-plane/src/iroh_wire.rs`
- `packages/data-plane/src/lib.rs`
- `packages/data-plane/src/main.rs`
- `packages/data-plane/src/ticket.rs`
- `packages/data-plane/tests/golden.rs`
- `packages/gateway/benchmarks/README.md`
- `packages/gateway/benchmarks/low-end-budgets.json`
- `packages/gateway/benchmarks/results/issue-456-final.json`
- `packages/gateway/benchmarks/results/issue-456-runtime.json`
- `packages/gateway/package.json`
- `packages/gateway/scripts/bench-low-end.mjs`
- `packages/gateway/scripts/probe-runtime-sqlite.mjs`
- `packages/gateway/src/backup/backup-service.test.ts`
- `packages/gateway/src/backup/backup-service.ts`
- `packages/gateway/src/backup/recover-job.ts`
- `packages/gateway/src/backup/wal-e2e.test.ts`
- `packages/gateway/src/cli/admin.test.ts`
- `packages/gateway/src/cli/cli.ts`
- `packages/gateway/src/cli/endpoint-host.ts`
- `packages/gateway/src/index.ts`
- `packages/gateway/src/lifecycle/byte-plane-over-http.test.ts`
- `packages/gateway/src/lifecycle/byte-plane-reference.ts`
- `packages/gateway/src/lifecycle/ext-band-over-http.test.ts`
- `packages/gateway/src/lifecycle/lifecycle-shared.test.ts`
- `packages/gateway/src/lifecycle/lifecycle-shared.ts`
- `packages/gateway/src/preview/codec.test.ts`
- `packages/gateway/src/preview/codec.ts`
- `packages/gateway/src/preview/native-codec.ts`
- `packages/gateway/src/preview/wasm-codec.ts`
- `packages/gateway/src/routes/automations-routes.ts`
- `packages/gateway/src/routes/backup-observability-routes.test.ts`
- `packages/gateway/src/routes/backup-routes.ts`
- `packages/gateway/src/routes/blob-routes.test.ts`
- `packages/gateway/src/routes/blob-routes.ts`
- `packages/gateway/src/routes/blob-response.ts`
- `packages/gateway/src/routes/connections-routes.ts`
- `packages/gateway/src/routes/data-plane-control.test.ts`
- `packages/gateway/src/routes/data-plane-control.ts`
- `packages/gateway/src/routes/devices-routes.test.ts`
- `packages/gateway/src/routes/devices-routes.ts`
- `packages/gateway/src/routes/import-routes.ts`
- `packages/gateway/src/routes/logs-routes.ts`
- `packages/gateway/src/routes/recover-routes.ts`
- `packages/gateway/src/routes/replica-routes.ts`
- `packages/gateway/src/routes/route-helpers.test.ts`
- `packages/gateway/src/routes/route-helpers.ts`
- `packages/gateway/src/routes/storage-routes.test.ts`
- `packages/gateway/src/routes/storage-routes.ts`
- `packages/gateway/src/routes/vault-routes.ts`
- `packages/gateway/src/runs/run-event-bus.ts`
- `packages/gateway/src/serve/build-gateway.ts`
- `packages/gateway/src/serve/connection-broker.ts`
- `packages/gateway/src/serve/data-plane-handoff.test.ts`
- `packages/gateway/src/serve/data-plane-handoff.ts`
- `packages/gateway/src/serve/device-plane.test.ts`
- `packages/gateway/src/serve/device-token-store.test.ts`
- `packages/gateway/src/serve/device-token-store.ts`
- `packages/gateway/src/serve/enrollment-store.ts`
- `packages/gateway/src/serve/gateway-instance-lease.ts`
- `packages/gateway/src/serve/gateway-log-store.ts`
- `packages/gateway/src/serve/gateway-performance.test.ts`
- `packages/gateway/src/serve/gateway-performance.ts`
- `packages/gateway/src/serve/group-commit-queue.test.ts`
- `packages/gateway/src/serve/group-commit-queue.ts`
- `packages/gateway/src/serve/hardware-profile.test.ts`
- `packages/gateway/src/serve/hardware-profile.ts`
- `packages/gateway/src/serve/health-registry.test.ts`
- `packages/gateway/src/serve/health-registry.ts`
- `packages/gateway/src/serve/outbox-executor.test.ts`
- `packages/gateway/src/serve/outbox-executor.ts`
- `packages/gateway/src/serve/route-prefix-dispatch.test.ts`
- `packages/gateway/src/serve/storage-latency.test.ts`
- `packages/gateway/src/serve/storage-latency.ts`
- `packages/gateway/src/serve/vault-picker.ts`
- `packages/gateway/src/serve/vault-plane.test.ts`
- `packages/gateway/src/serve/vault-plane.ts`
- `packages/gateway/src/serve/vault-registry.ts`
- `packages/gateway/src/serve/web-app-sessions.ts`
- `packages/gateway/src/serve/web-ui-server.test.ts`
- `packages/gateway/src/serve/web-ui-server.ts`
- `packages/tunnel/README.md`
- `packages/tunnel/native/Cargo.lock`
- `packages/tunnel/native/Cargo.toml`
- `packages/tunnel/native/build.rs`
- `packages/tunnel/native/src/lib.rs`
- `packages/tunnel/package.json`
- `packages/tunnel/scripts/build-native.mjs`
- `packages/tunnel/scripts/probe-typed-array.mjs`
- `packages/tunnel/src/gateway-endpoint.ts`
- `packages/tunnel/src/index.ts`
- `packages/tunnel/src/native-relay.test.ts`
- `packages/tunnel/src/native-relay.ts`
- `packages/tunnel/src/protocol.ts`
- `packages/vault/package.json`
- `packages/vault/src/blob/cache.ts`
- `packages/vault/src/blob/cache-profile.test.ts`
- `packages/vault/src/blob/custody.ts`
- `packages/vault/src/blob/custody-local-read.ts`
- `packages/vault/src/blob/custody-remote-stream.test.ts`
- `packages/vault/src/blob/custody-remote-stream.ts`
- `packages/vault/src/blob/incremental-sha256.test.ts`
- `packages/vault/src/blob/incremental-sha256.ts`
- `packages/vault/src/blob/local.ts`
- `packages/vault/src/blob/outbox-runner.test.ts`
- `packages/vault/src/blob/outbox-runner.ts`
- `packages/vault/src/blob/preview.test.ts`
- `packages/vault/src/blob/preview.ts`
- `packages/vault/src/blob/stream-ingress.ts`
- `packages/vault/src/blob/transfer-state.ts`
- `packages/vault/src/blob/transfers.test.ts`
- `packages/vault/src/blob/transfers.ts`
- `packages/vault/src/db.test.ts`
- `packages/vault/src/db.ts`
- `packages/vault/src/gateway/execution.ts`
- `packages/vault/src/gateway/gateway.test.ts`
- `packages/vault/src/gateway/gateway.ts`
- `packages/vault/src/index.ts`
- `packages/vault/src/replica/doorbell.ts`
- `packages/vault/src/replica/invocation-commits.ts`
- `packages/vault/src/rust-golden.test.ts`
- `packages/vault/src/timer-jitter.test.ts`
- `packages/vault/src/timer-jitter.ts`
- `packages/vault/src/wal-shipper-clone.test.ts`
- `packages/vault/src/wal-shipper.ts`
- `turbo.json`

## Verification

```sh
bun run ci
bun run build
node_modules/.bin/vitest run --coverage --maxWorkers=2 --minWorkers=1
bun run --cwd packages/data-plane lint
bun run --cwd packages/data-plane test
bun run --cwd packages/data-plane test:contract
bun run --cwd packages/tunnel test:native
bun run --cwd packages/tunnel perf:binding-probe
CENTRAID_HARDWARE_PROFILE=constrained bun run --cwd packages/gateway perf:low-end
node_modules/.bin/vitest run --project @centraid/gateway \
  packages/gateway/src/cli/admin.test.ts \
  packages/gateway/src/routes/devices-routes.test.ts \
  packages/gateway/src/routes/blob-routes.test.ts \
  packages/gateway/src/routes/route-helpers.test.ts \
  packages/gateway/src/serve/hardware-profile.test.ts \
  packages/gateway/src/serve/group-commit-queue.test.ts \
  packages/gateway/src/serve/gateway-performance.test.ts \
  packages/gateway/src/serve/storage-latency.test.ts
node_modules/.bin/vitest run --project @centraid/mobile \
  apps/mobile/src/lib/upload/media-producer.test.ts
git diff --check
```

All commands above pass. `bun run ci` completed all lint, build, and typecheck
tasks (29/29 typecheck tasks), and the normal root build produced the release
napi relay artifact. The bounded coverage run completed the full workspace
suite and its configured v8 thresholds. Rust clippy, six Rust unit tests,
three cross-language golden tests, and eight HTTP lifecycle assertions pass:
the same four-route contract ran against both the TypeScript reference and
the real Rust binary. The deterministic iroh binding probe proves that
`Array<number>` succeeds while `Uint8Array` and `Buffer` fail with
`Failed to get Array length`. Focused regressions cover aborted streams, Range
suffixes, content-encoding negotiation, hardware-profile propagation,
admission/group commit, preview limits, client-contributed derivatives, and
authenticated data-plane handoff. The release-built napi relay integration
passes both gateway and desktop pairing modes, dynamic desktop upstream
changes, and 2 MiB + 17 byte tunneled request/response bodies without invoking
JavaScript byte callbacks. The native test also proves endpoint revocation
closes an already-live Rust connection; the gateway route and separate-process
SSH CLI propagation regressions pass as part of **29/29** focused tests. The
final hygiene split's affected route, cache-profile, cache, and gateway suites
passed **61/61 tests**.

The final bounded coverage run passed **499 files / 4,385 tests**; three files
and 35 tests were skipped only by their explicit platform or opt-in
integration gates.

The unconstrained default-worker coverage attempt reached the tail of the
suite with no assertion failure but Vitest's process pool terminated with
`ERR_IPC_CHANNEL_CLOSED`; rerunning the same coverage gate with two workers
passed completely. This is recorded as host runner pressure, not hidden as a
test success.

The committed final constrained benchmark artifact reports all budget checks
passing. Exact fsync-per-write is unavailable from macOS process metrics, so
the local artifact records it as null and retains the OS-specific raw
filesystem-output counter only as a diagnostic. CI measures the constrained
primary workload untraced, runs a second workload under Linux `strace` solely
for scoped fsync accounting, and fails if that exact signal is absent or above
budget.

## Audit

PASS — fresh-context reviewer `/root/issue456_router_final_audit` read the live
issue, constitution/testing rules, all 185 changed paths, this receipt, the
post-router benchmark, and the verification evidence. It independently
validated R1, S4, I4, N0b, N2 (including HTTP/SSH-CLI live revocation), M1, and
the remaining acceptance matrix. The reviewer caught one stale pre-router M1
paragraph in the durable plan; after it was corrected while preserving the
historical row, the reviewer re-checked the documentation-only diff and
returned an unqualified `PASS`.

After the commit hook required the 532-line Rust relay to be split below the
repository's 500-line cap, fresh-context reviewer
`/root/issue456_staged_split_audit` inspected the complete staged tree. It
confirmed the 390-line relay plus 151-line private wire module are a purely
structural split, rechecked the post-split Rust/contracts/native results and
the exact 185-path inventory, and returned `PASS`.

After the first Linux CI run exposed that the straced child inherited the
parent's required-fsync gate before the parent could inject trace results,
fresh-context reviewer `/root/issue456_ci_fix_audit` checked the failed run and
the complete parent/child control flow. It confirmed the child-only override
preserves the parent's exact fsync presence and ceiling checks and returned
`PASS`. The replacement Linux run confirmed that conclusion by reporting one
scoped fsync, then exposed the separate OS-counter and ptrace-contamination
problems addressed in the final measurement iteration.

Fresh-context reviewer `/root/issue456_measurement_reaudit` then inspected the
complete revised diff, both failed Linux runs, current budgets, regenerated
65-second artifact, issue M1 contract, and all supporting documentation. It
confirmed the primary metrics are untraced, the separate child still produces
an exact required fsync signal, output arguments cannot clobber the artifact,
the physical-byte gate is substantive rather than budget evasion, and the
unchanged idle ceiling is now sampled stably. After two stale wording claims
were corrected, it returned `PASS`.

## Steering

PASS — the only human instruction in this task was the opening `/goal` to
complete the entire issue scope, follow its measurement/iteration directions,
and create a PR. There were no user corrections or mid-task redirects.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019f7389-37c-1784382112-1 | codex | 019f7389-37ce-7252-abb8-77936a8e13cb | #456 | gpt-5.6-sol | 5180906 | 0 | 234673408 | 551137 | 5732043 | 79.8877 | 5180906 | 0 | 234673408 | 551137 | perf(gateway): harden low-end control and data planes (#456) -m governance: allo |
| codex-019f7389-37c-1784383061-1 | codex | 019f7389-37ce-7252-abb8-77936a8e13cb | #456 | gpt-5.6-sol | 45439 | 0 | 6249472 | 7751 | 53190 | 1.7922 | 5226345 | 0 | 240922880 | 558888 | perf(gateway): harden low-end control and data planes (#456) -m governance: allo |
| codex-019f7389-37c-1784384195-1 | codex | 019f7389-37ce-7252-abb8-77936a8e13cb | #456 | gpt-5.6-sol | 79079 | 0 | 9083648 | 9313 | 88392 | 2.6083 | 5305424 | 0 | 250006528 | 568201 | fix(gateway): defer fsync gate to trace parent (#456) |
| codex-019f7389-37c-1784386147-1 | codex | 019f7389-37ce-7252-abb8-77936a8e13cb | #456 | gpt-5.6-sol | 167984 | 0 | 6912512 | 27419 | 195403 | 2.5594 | 5473408 | 0 | 256919040 | 595620 | perf(gateway): stabilize low-end measurement gate (#456) |
