# Issue #419 — M0 foundations for native Photos

## Checklist

- [x] Replace the hand-vendored iroh-ffi artifacts with official iroh 1.0 release sources.
- [x] Delete the vendored-binary fetch script and its companion document.
- [x] Record a verdict on replacing the browser WASM crate with an official binding.
- [x] Add a golden-frame tunnel wire conformance suite across the Node, Swift, and Kotlin twins.
- [x] Extract a platform-neutral ReplicaStore interface over a minimal SQLite driver.
- [x] Add a native op-sqlite replica store with a day-one FTS5 gate.
- [x] Add a durable SQLite intent outbox that survives replica rebootstrap.
- [x] Add a single-process native sync loop with foreground pull and SSE while active.
- [x] Inject digest and id factories so intent writes work without WebCrypto.
- [x] Add thumbhash as an inline derivative with a gateway backstop and device contribution.
- [x] Promote favorite, archive, and capture timezone offset to first-class asset columns.
- [x] Add a windowed replica bootstrap protocol for large libraries.
- [x] Converge windowed bootstrap by replaying the change log from the first page cursor.
- [x] Add a durable sha-addressed upload queue resumable at part granularity.
- [x] Prove kill-at-any-byte resume with no duplicate or lost objects.
- [x] Add Photos, Apps, and Settings tab navigation over a generated token theme.

## What changed

### Official iroh 1.0 artifacts

The iOS podspec now reconstructs the Iroh xcframework and its generated Swift wrapper from the checksum-pinned n0 release archive through a `prepare_command`, so no iroh bytes and no bespoke fetch script live in the tree. Upstream's own `IrohLib.podspec` is stale at 0.35.0 and unusable, so the release archive is the supported 1.0 source.

Android keeps its cargo-ndk provisioning step, now documented in the module README rather than a separate script. The published `computer.iroh:iroh` Maven artifact bundles JNA natives for darwin, linux, and win32 only — it carries no Android `jniLibs` and no AAR variant — so adopting it would ship an Android build that cannot load its native library. Verified upstream packaging state, not preference, keeps that step.

### Tunnel wire conformance

`packages/tunnel/fixtures/wire-golden.json` pins byte-exact vectors covering request, response, pair, and gateway-pair header frames plus empty-header, multi-value-header, unicode, and boundary cases, alongside the ALPN strings, the size caps, and the hop-by-hop header set. The Node suite is the fixture's source of truth and regenerates it under `UPDATE_GOLDEN=1`. Swift XCTest and Kotlin JUnit suites read the same fixture. Framing was extracted into pure `frame`/`decodeFrameLength` helpers in both native twins so the wire can be tested without iroh stream I/O; object-level encoding is round-tripped rather than byte-compared, because JSON key order legitimately differs across serializers.

### Platform-neutral replica store

`ReplicaStore` names the async surface the coordinator consumes, and `ReplicaWorkerClient` now satisfies it, so the coordinator depends on the interface rather than the web worker class. The store's logic moved into a core written once over a minimal synchronous driver (`run`, `all`, `one`, `transaction`, plus capability hooks); the sqlite-wasm `Database` became one adapter behind it. `sqlite-store.test.ts` needed no change for that refactor, which is the evidence that web behavior is preserved; its single edit here is a `user_version` assertion following the schema bump to 4 that windowed bootstrap's progress table required.

Reaching that interface from React Native required a real extraction, not only a type. The barrel value-imported the web worker, IndexedDB key ranges, and a change feed whose module body touches `window`, so importing it under Hermes failed at load. Pure `gateway-auth`, `vault-change-sse`, `intent-record-store`, and `coordinator-web` modules were split out beneath a curated `native` entry point whose transitive graph reaches no web-engine module.

### Native replica and sync loop

The native store instantiates that same core over an op-sqlite driver in-process, with no worker and no serialization hop. Opening probes FTS5 and raises a named error identifying the build flag when it is absent. The intent outbox is a SQLite table pair matching the IndexedDB store's semantics — idempotent add, payload-hash conflict rejection, atomic claim, settle-and-scrub — and lives outside the replica's schema rebuild so queued writes survive a rebootstrap. A single-process session wires store, outbox, windowed bootstrap, SSE over streaming fetch, and AppState transitions, pulling on foreground and pausing the stream on background.

Intent writes previously depended on WebCrypto, which Hermes does not provide, so the digest and id factory became injectable behind defaults that keep every existing web call site unchanged. The native session supplies expo-crypto implementations, and a fixture pins one canonical payload to an exact digest asserted across both implementations, because a divergence would break intent idempotency across a device swap.

### Photos shape and thumbhash

Thumbhash joins the derivative registry as an inline variant carrying unpadded standard base64, validated by decoding and re-encoding so non-canonical spellings are rejected. A faithful port of the reference encoder lives in the gateway preview codec, and an independent port in the photos blueprint produces byte-identical output for the same pixels, pinned by fixtures on both sides. The gateway backstop fills missing hashes for JPEG and PNG through the existing lease-respecting sweep, and `media.add_asset` accepts a device-supplied hash.

Favorite, archived state, and the capture timezone offset became first-class asset columns, and the media command surface writes them directly. The starred-tag path was removed from media rather than dual-written, because a native client granted only the photos shape cannot reconstruct a star from a tag, concept, and scheme join it never receives.

### Windowed bootstrap

Bootstrap accepts a window size and a continuation token, returning the full envelope on the first page and rows with a continuation on the rest, while the parameterless path stays byte-identical for the existing web shell. Each page opens its own snapshot, because the reader's transaction cannot span requests, so pages are not mutually consistent and each reports its own cursor. Convergence is therefore part of the protocol rather than advice: the driver commits at the first page's cursor and replays the change log from it to a fixpoint before reporting success, which is what repairs anything that shifted between pages. A crash mid-walk leaves rows with no cursor, which reads reject, so the next open restarts rather than presenting a partial replica as complete.

### Upload queue

The queue is a SQLite-backed item and part ledger in its own database file, keyed by a content hash computed at enqueue over bounded windows so memory stays flat regardless of file size. Beginning a session by hash is simultaneously the dedupe check, the resume path, and the settlement reconciliation, because the server returns an already-present marker or the parts it already holds. Parts are fixed 16 MiB, sealed on device in the vault's frame format using derived nonces so a replayed part is byte-identical after a crash, and every presigned URL passes the existing gateway-minted assertion before any transfer. iOS hands parts to a background URLSession; the Android drainer and its notification are wired in JavaScript while the foreground service itself remains unwritten.

### Native shell

Navigation is now Photos, Apps, and Settings tabs, with the WebView app grid and detail preserved beneath the Apps stack and approvals reachable from Settings. A generator lowers the blueprint token stylesheet into a checked-in typed theme, resolving nested custom properties and skipping what cannot map rather than mangling it, and the resolved theme drives both React Navigation and the existing screens in light and dark.

### Checklist crosswalk

- **Replace the hand-vendored iroh-ffi artifacts with official iroh 1.0 release sources.** The podspec pulls the checksum-pinned official release archive; Android's step remains only because the published Maven artifact carries no Android natives.
- **Delete the vendored-binary fetch script and its companion document.** `scripts/fetch-iroh-binaries.sh` and `BINARIES.md` are removed, with their remaining iOS and Android steps relocated to the podspec and the module README.
- **Record a verdict on replacing the browser WASM crate with an official binding.** `apps/web/iroh-wasm/OFFICIAL-BINDING-EVALUATION.md` records KEEP against n0's published browser guidance.
- **Add a golden-frame tunnel wire conformance suite across the Node, Swift, and Kotlin twins.** A shared byte-exact fixture is asserted by Node, Swift, and Kotlin suites over extracted pure framing helpers.
- **Extract a platform-neutral ReplicaStore interface over a minimal SQLite driver.** The store core is written once against a four-method driver, with sqlite-wasm as one adapter and the coordinator typed to the interface.
- **Add a native op-sqlite replica store with a day-one FTS5 gate.** The native store runs the shared core over an op-sqlite driver and refuses to open with a named error when FTS5 is missing.
- **Add a durable SQLite intent outbox that survives replica rebootstrap.** The outbox tables sit outside the replica schema rebuild, proven by a test asserting queued intents survive a wipe.
- **Add a single-process native sync loop with foreground pull and SSE while active.** One session wires store, outbox, feed, and AppState, pulling on foreground and pausing the stream on background.
- **Inject digest and id factories so intent writes work without WebCrypto.** Both seams take injected implementations behind unchanged web defaults, with an exact digest fixture asserted across implementations.
- **Add thumbhash as an inline derivative with a gateway backstop and device contribution.** The registry carries the inline variant, the backstop fills holes for JPEG and PNG, and the add-asset command accepts a device hash.
- **Promote favorite, archive, and capture timezone offset to first-class asset columns.** The media asset table carries the three columns and the commands write them, replacing the starred-tag path.
- **Add a windowed replica bootstrap protocol for large libraries.** Bootstrap accepts a window and continuation token and bypasses the single-shot row ceiling, leaving the parameterless path unchanged.
- **Converge windowed bootstrap by replaying the change log from the first page cursor.** The driver replays deltas from the first page's cursor to a fixpoint before reporting success, and disabling that replay fails its test.
- **Add a durable sha-addressed upload queue resumable at part granularity.** A SQLite item and part ledger resumes by hash against server-held parts across process death.
- **Prove kill-at-any-byte resume with no duplicate or lost objects.** An exhaustive and randomized kill harness rebuilds the queue from disk and asserts one object per hash with plaintext recovered through the vault's reader.
- **Add Photos, Apps, and Settings tab navigation over a generated token theme.** Tabs wrap the preserved WebView stack and settings, themed from a generated lowering of the blueprint tokens in light and dark.

### Files

- `apps/mobile/App.tsx`
- `apps/mobile/modules/centraid-tunnel/.gitignore`
- `apps/mobile/modules/centraid-tunnel/BINARIES.md`
- `apps/mobile/modules/centraid-tunnel/README.md`
- `apps/mobile/modules/centraid-tunnel/android/build.gradle`
- `apps/mobile/modules/centraid-tunnel/android/src/main/java/expo/modules/centraidtunnel/TunnelWire.kt`
- `apps/mobile/modules/centraid-tunnel/android/src/test/java/expo/modules/centraidtunnel/TunnelWireConformanceTest.kt`
- `apps/mobile/modules/centraid-tunnel/ios/CentraidTunnel.podspec`
- `apps/mobile/modules/centraid-tunnel/ios/Tests/TunnelWireConformanceTests.swift`
- `apps/mobile/modules/centraid-tunnel/ios/TunnelWire.swift`
- `apps/mobile/modules/centraid-tunnel/scripts/fetch-iroh-binaries.sh`
- `apps/mobile/package.json`
- `apps/mobile/scripts/generate-theme.ts`
- `apps/mobile/src/components/AppHeader.tsx`
- `apps/mobile/src/components/Button.tsx`
- `apps/mobile/src/components/Tile.tsx`
- `apps/mobile/src/lib/replica/native-change-feed.ts`
- `apps/mobile/src/lib/replica/native-hash.ts`
- `apps/mobile/src/lib/replica/native-replica-store.test.ts`
- `apps/mobile/src/lib/replica/native-replica-store.ts`
- `apps/mobile/src/lib/replica/native-session.test.ts`
- `apps/mobile/src/lib/replica/native-session.ts`
- `apps/mobile/src/lib/replica/node-sqlite-driver.ts`
- `apps/mobile/src/lib/replica/op-sqlite-driver.ts`
- `apps/mobile/src/lib/replica/replica-fts5-error.ts`
- `apps/mobile/src/lib/replica/sqlite-intent-store.test.ts`
- `apps/mobile/src/lib/replica/sqlite-intent-store.ts`
- `apps/mobile/src/lib/upload/boot.ts`
- `apps/mobile/src/lib/upload/bytes.ts`
- `apps/mobile/src/lib/upload/cbsf.test.ts`
- `apps/mobile/src/lib/upload/cbsf.ts`
- `apps/mobile/src/lib/upload/crash.property.test.ts`
- `apps/mobile/src/lib/upload/crypto.ts`
- `apps/mobile/src/lib/upload/enqueue.test.ts`
- `apps/mobile/src/lib/upload/enqueue.ts`
- `apps/mobile/src/lib/upload/expo-native.ts`
- `apps/mobile/src/lib/upload/fake-direct-transfer.ts`
- `apps/mobile/src/lib/upload/file-source.ts`
- `apps/mobile/src/lib/upload/gateway-client.ts`
- `apps/mobile/src/lib/upload/incremental-sha256.test.ts`
- `apps/mobile/src/lib/upload/incremental-sha256.ts`
- `apps/mobile/src/lib/upload/index.ts`
- `apps/mobile/src/lib/upload/native-queue.ts`
- `apps/mobile/src/lib/upload/node-sqlite-driver.ts`
- `apps/mobile/src/lib/upload/store.test.ts`
- `apps/mobile/src/lib/upload/store.ts`
- `apps/mobile/src/lib/upload/uploader.test.ts`
- `apps/mobile/src/lib/upload/uploader.ts`
- `apps/mobile/src/navigation.ts`
- `apps/mobile/src/screens/AppDetail.tsx`
- `apps/mobile/src/screens/Approvals.tsx`
- `apps/mobile/src/screens/Home.tsx`
- `apps/mobile/src/screens/MobileFallback.tsx`
- `apps/mobile/src/screens/Settings.tsx`
- `apps/mobile/src/screens/photos/PhotosHome.tsx`
- `apps/mobile/src/screens/photos/timeline-source.ts`
- `apps/mobile/src/theme.ts`
- `apps/mobile/src/theme/generate.test.ts`
- `apps/mobile/src/theme/generate.ts`
- `apps/mobile/src/theme/index.ts`
- `apps/mobile/src/theme/resolve.test.ts`
- `apps/mobile/src/theme/resolve.ts`
- `apps/mobile/src/theme/tokens.generated.ts`
- `apps/mobile/src/theme/useTheme.ts`
- `apps/web/iroh-wasm/OFFICIAL-BINDING-EVALUATION.md`
- `bun.lock`
- `packages/blueprints/apps/photos/app.json`
- `packages/blueprints/apps/photos/queries/_shared.js`
- `packages/blueprints/apps/photos/queries/library.js`
- `packages/blueprints/apps/photos/queries/search.js`
- `packages/blueprints/apps/photos/thumbhash.js`
- `packages/blueprints/apps/photos/upload.js`
- `packages/blueprints/manifest.json`
- `packages/blueprints/src/photos-thumbhash.test.ts`
- `packages/client/package.json`
- `packages/client/src/gateway-auth.ts`
- `packages/client/src/gateway-client-core.ts`
- `packages/client/src/replica/coordinator-web.ts`
- `packages/client/src/replica/coordinator.test.ts`
- `packages/client/src/replica/coordinator.ts`
- `packages/client/src/replica/digest.ts`
- `packages/client/src/replica/index.ts`
- `packages/client/src/replica/intent-record-store.ts`
- `packages/client/src/replica/intent-store.ts`
- `packages/client/src/replica/intents.ts`
- `packages/client/src/replica/key.ts`
- `packages/client/src/replica/memory-intent-store.ts`
- `packages/client/src/replica/native.ts`
- `packages/client/src/replica/payload-hash-identity.test.ts`
- `packages/client/src/replica/payload-hash.ts`
- `packages/client/src/replica/shell-session.ts`
- `packages/client/src/replica/shell-transport.ts`
- `packages/client/src/replica/sqlite-store.test.ts`
- `packages/client/src/replica/sqlite-store.ts`
- `packages/client/src/replica/sqlite-worker.ts`
- `packages/client/src/replica/store-core.test.ts`
- `packages/client/src/replica/store-core.ts`
- `packages/client/src/replica/store.ts`
- `packages/client/src/replica/types.ts`
- `packages/client/src/replica/wasm-sqlite-driver.ts`
- `packages/client/src/replica/windowed-bootstrap.test.ts`
- `packages/client/src/replica/windowed-bootstrap.ts`
- `packages/client/src/replica/worker-client.ts`
- `packages/client/src/replica/worker-protocol.ts`
- `packages/client/src/vault-change-feed.ts`
- `packages/client/src/vault-change-sse.ts`
- `packages/gateway/src/preview/codec.test.ts`
- `packages/gateway/src/preview/codec.ts`
- `packages/gateway/src/preview/thumbhash.ts`
- `packages/gateway/src/routes/blob-routes.test.ts`
- `packages/gateway/src/routes/replica-routes.test.ts`
- `packages/gateway/src/routes/replica-routes.ts`
- `packages/gateway/src/routes/replica-shape.test.ts`
- `packages/tunnel/fixtures/wire-golden.json`
- `packages/tunnel/src/wire-conformance.test.ts`
- `packages/vault/src/blob/derivatives.test.ts`
- `packages/vault/src/blob/derivatives.ts`
- `packages/vault/src/blob/preview.test.ts`
- `packages/vault/src/blob/preview.ts`
- `packages/vault/src/commands/media.test.ts`
- `packages/vault/src/commands/media.ts`
- `packages/vault/src/gateway/gateway.ts`
- `packages/vault/src/schema/blob.ts`
- `packages/vault/src/schema/domains-social-knowledge-media.ts`
- `packages/vault/src/schema/enrich.ts`
- `receipts/issue-419-m0-foundations.md`

## Out of scope

- Every M1 through M4 item in #419: the timeline, lightbox, albums, trash, free-up-space, search, faces, memories, duplicates, places, and platform share targets. M0 delivers only the foundations they stand on.
- Rewriting `apps/web/iroh-wasm` against an official browser binding. n0 publishes none and documents the app-owned `wasm-bindgen` wrapper this crate already is.
- Adopting `computer.iroh:iroh` for Android. The published artifact carries no Android natives, so the cargo-ndk step cannot be deleted until n0 ships an AAR.
- The Android foreground service class, manifest entries, and config plugin. Native Android code cannot be compiled or verified in this environment, so the drainer and its policy are wired in JavaScript and the native surface is left explicitly unwritten rather than half-written.
- Switching the web shell to windowed bootstrap. The single-shot path carries admission and storage-manifest behavior that deserves its own review, and the row ceiling is a mobile-library problem today.
- Installing an AES-GCM provider for React Native. The upload queue's crypto is injected and fails at a named seam until a provider is chosen, which is a dependency decision rather than an implementation gap.

## Decisions

- Keep `apps/web/iroh-wasm`. n0's browser guidance states the Wasm build is not bundled as an NPM package and directs consumers to an application-specific `wasm-bindgen` wrapper over the `iroh` crate, which is exactly this crate. Issue #419's premise that first-party bindings retire both vendored layers held only for the mobile module.
- Pin iroh-ffi 1.0.0 rather than the 1.0.2 named in the issue. No iroh-ffi 1.0.2 is published on GitHub, Maven Central, or the Swift Package Index; the referenced iroh-relay fix ships in the iroh Rust crate, which the browser crate tracks through `cargo update` and the FFI bindings do not.
- Keep the Android cargo-ndk step. The published Maven artifact ships desktop JNA natives only, so adopting it would produce a build that cannot load its native library; the issue's expected emulator and page-size wins are unavailable until upstream ships an Android AAR.
- Replace the starred-tag favorite rather than dual-writing it. A consent-scoped native client cannot reconstruct a flag from a join it was never granted, so the column is the single source of truth and the tag path is removed from media only.
- Make windowed bootstrap converge in the driver rather than documenting it as a caller obligation, because per-page snapshots leak deletions without the replay and a caller that forgets it produces a silently wrong replica.
- Restart rather than resume an interrupted windowed bootstrap. The commit that writes the cursor is what makes a replica readable, so an interrupted walk is indistinguishable from never having started, and a resumed continuation token cannot be trusted once the server may have collected its snapshot.
- Give the upload queue its own database file. The replica owns its schema version and rebuilds destructively on mismatch, while a queued upload is unreplicated source-of-truth that must outlive many rebootstraps.
- Seal device parts with derived rather than random nonces, diverging from the browser edge-upload path, because deterministic sealing makes a replayed part byte-identical and therefore a true no-op after a crash.
- Write a third sealed-format writer for React Native rather than importing either existing one, since the vault's depends on Node crypto and the browser's on `File` and WebCrypto; drift is prevented by unsealing its output with the vault's own reader in tests.

## Verification

```sh
bun --cwd packages/tunnel run test
bun --cwd packages/client run test
bun --cwd apps/mobile run test
bun --cwd packages/gateway run test
bun --cwd packages/vault run test
bun --cwd packages/blueprints run test
bun run format:check
bunx oxlint .
bun run typecheck
bun run lint:types
```

- `bun --cwd packages/tunnel run test` — 3 files / 59 tests passed, including the conformance fixture and the existing real-loopback iroh suites.
- `bun --cwd packages/client run test` — 111 files / 850 tests passed.
- `bun --cwd apps/mobile run test` — 12 files / 113 tests passed, including the kill harness and the sealed round-trip through the vault's reader.
- `bun --cwd packages/gateway run test` — 91 files / 682 passed / 2 skipped on a quiet run.
- `bun --cwd packages/vault run test` — 722 passed / 1 skipped; `src/blob/stream-ingress.test.ts` times out only under full-suite load and fails identically on a clean checkout at `74a596db`, so it is inherited rather than introduced.
- `bun --cwd packages/blueprints run test` — 164 passed; `src/docs-media.test.ts` fails identically on a clean checkout at `74a596db` because the vendored PDF runtime calls `Promise.try`, absent in this Node.
- `bun run format:check` — all matched files use the correct format.
- `bunx oxlint .` — 0 warnings, 0 errors.
- `bun run typecheck` — 26/26 Turbo tasks passed.
- `bun run lint:types` — all packages ok.
- Gateway `src/serve/vault-registry.test.ts` and `src/cli/admin.test.ts` time out only under full parallel load and pass in isolation; a clean checkout at `74a596db` fails four different backup tests under the same load, so the suite's parallel flakiness is inherited.
- Swift `xcodebuild test`, Kotlin `./gradlew test`, op-sqlite on device, and the iOS `pod install` prepare step are not runnable in this environment.

## Audit

- **A1 — `## What changed` faithfully describes the diff (no misrepresentation, no omission).** PASS — All material claims verified against working tree. Official iroh podspec correctly pins `v1.0.0` release with SHA checksum via prepare_command (lines 35–52 of `ios/CentraidTunnel.podspec`). `scripts/fetch-iroh-binaries.sh` and `BINARIES.md` are both deleted in git diff. `OFFICIAL-BINDING-EVALUATION.md` exists and records KEEP verdict against n0's FFI-for-native guidance. Wire conformance fixture (`packages/tunnel/fixtures/wire-golden.json`) and conformance tests (Node, Swift, Kotlin suites) are present and parse-checked. `ReplicaStore` interface defined in `packages/client/src/replica/store.ts` (lines 38–71). Native op-sqlite store in `packages/mobile/src/lib/replica/native-replica-store.ts` exists. Intent outbox in `packages/mobile/src/lib/replica/sqlite-intent-store.ts` exists and tested. Windowed bootstrap in `packages/client/src/replica/windowed-bootstrap.ts` (lines 44, 60–64) implements mandatory convergence replay. Upload queue (16 MiB parts documented in `cbsf.ts` line 50) in `apps/mobile/src/lib/upload/{store,uploader}.ts`. Thumbhash in `packages/vault/src/blob/derivatives.ts` lines 89–98 (inline variant, canonical base64 validation lines 185–198). Favorite, archived_at, tz_offset_min in media schema (`packages/vault/src/schema/domains-social-knowledge-media.ts` lines 105–129). File-coverage: receipt lists 126 individual files; all corresponding untracked directories (`apps/mobile/src/lib/{replica,upload}/`, `apps/mobile/src/theme/`, `apps/mobile/scripts/`, `apps/mobile/src/screens/photos/`) are present with matching file counts. **Minor note:** `packages/client/src/replica/sqlite-store.test.ts` has 1-line modification (user_version: 3 → 4, a schema version bump), not byte-unchanged as claimed; intent preserved (test structure unchanged, only assertion updated for schema migration).

- **A2 — Each `- [x]` item is realized in the diff.** PASS — All 16 checklist items have corresponding code evidence. (1) Official iroh 1.0: podspec downloads `v1.0.0`. (2) Delete fetch script: both `fetch-iroh-binaries.sh` and `BINARIES.md` deleted. (3) Browser WASM verdict: `OFFICIAL-BINDING-EVALUATION.md` records KEEP. (4) Wire conformance: `fixtures/wire-golden.json` and `wire-conformance.test.ts` (Node), `TunnelWireConformanceTests.swift` (iOS), `TunnelWireConformanceTest.kt` (Android). (5) ReplicaStore interface: `store.ts` defines async surface. (6) Native op-sqlite store: `native-replica-store.ts` + FTS5 gate in `replica-fts5-error.ts`. (7) Intent outbox: `sqlite-intent-store.ts` survives rebootstrap (tested). (8) Sync loop: `native-session.ts` wires store, outbox, windowed bootstrap, SSE, AppState. (9) Crypto gap: `digest.ts` and `key.ts` define injectable seams. (10) Thumbhash: `derivatives.ts` registry entry + gateway codec test in `codec.test.ts` + device path in `photos/thumbhash.js`. (11) First-class asset columns: favorite (default 0), archived_at, tz_offset_min in media schema + commands in `media.ts`. (12) Windowed bootstrap API: `bootstrapBegin/bootstrapPage/bootstrapCommit` in `store.ts` + protocol implementation in `windowed-bootstrap.ts`. (13) Convergence replay: `windowed-bootstrap.ts` lines 44, 114 implement post-page-1 change log replay to fixpoint. (14) Upload queue: `store.ts` + `uploader.ts` with SQLite item/part ledger in separate DB file. (15) Kill-at-any-byte resume: property test in `crash.property.test.ts` with randomized kill points. (16) Tab navigation: `navigation.ts` defines Photos/Apps/Settings + `App.tsx` renders themed tabs.

- **A3 — The `## Checklist` mirrors the issue's checklist.** PASS — Receipt's 16 items align with issue #419's M0.1–M0.5 scope. M0.1 maps: replace iroh-ffi (item 1), delete scripts (item 2), WASM verdict (item 3), wire conformance (item 4). M0.2 maps: ReplicaStore interface (item 5), native store (item 6), outbox (item 7), sync loop (item 8), crypto gap (item 9). M0.3 maps: thumbhash (item 10), first-class columns (item 11). M0.4 maps: windowed bootstrap (items 12–13), upload queue (items 14–15). M0.5 maps: tab navigation (item 16). **Disclosure of deferrals:** receipt's `## Out of scope` explicitly defers M1–M4 and documents five M0 sub-deferrals (Android native foreground service, Maven artifact adoption, WASM rewrite, web windowed bootstrap, AES-GCM provider). These match issue's non-goals section. **Critical claim verification (iroh 1.0.2 assertion):** receipt claims "No iroh-ffi 1.0.2 is published on GitHub, Maven Central, or the Swift Package Index." This is documented in decisions (line 224). Verified: podspec pins `v1.0.0` (line 35 of podspec), not 1.0.2. The receipt's explanation that the relay fix ships in the iroh Rust crate (tracked via `cargo update`), not FFI bindings, is accurate and properly disclosed as a decision diverging from the issue's expected 1.0.2.

## Steering

- **B1 — Every human-steering event is recorded.** PASS — Zero steering events found. Analysis of transcript (session `80311240-f7e2-4eec-a3d3-3c75870a9a4e`) across all 14 recorded user interactions: (1) Initial task (2026-07-16T06:39:49Z): "implement the M0 foundations part of the issue (M0.1 to M0.5)" — initial request, excluded by audit directive. (2–10) Task notifications (2026-07-16T06:45–08:09Z): system-generated completion summaries for agents "Map mobile app", "M0.1 iroh bindings", "M0.5 shell", "M0.3 thumbhash", "M0.2 ReplicaStore", "Windowed bootstrap", "M0.4 upload queue" — not user steering. (11) Local command caveat and `/model` command (2026-07-16T07:29:52Z) — system directive, not user steering. (12) Reference URL (2026-07-16T08:32:37Z): "https://docs.iroh.computer/languages/wasm-browser#webassembly-and-browsers → for desktop apps, the recommendation is to use FFI" — information provision, not mid-task redirect. (13) Clarification question (2026-07-16T08:35:58Z): "for our electron app, what are we using?" — context-seeking, not task interruption. (14) Completion signal (2026-07-16T08:37:55Z): "okay, create PR" — final directive after all work complete, not mid-task steering. No interrupts or mid-task corrections detected.

- **B2 — No non-steering message is recorded as a steering event.** PASS — No steering table rows exist in the receipt (correct, as there are zero events to record).

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-80311240-f7e-1784191268-1 | claude-code | 80311240-f7e2-4eec-a3d3-3c75870a9a4e | #419 | claude-opus-4-8 | 419 | 829991 | 33077253 | 250314 | 1080724 | 27.9860 | 419 | 829991 | 33077253 | 250314 |  |
| claude-code-80311240-f7e-1784191362-1 | claude-code | 80311240-f7e2-4eec-a3d3-3c75870a9a4e | #419 | claude-opus-4-8 | 8 | 17441 | 971208 | 9044 | 26493 | 0.8208 | 427 | 847432 | 34048461 | 259358 |  |
| claude-code-80311240-f7e-1784192044-1 | claude-code | 80311240-f7e2-4eec-a3d3-3c75870a9a4e | #419 | claude-opus-4-8 | 66 | 72327 | 8927828 | 70995 | 143388 | 6.6912 | 493 | 919759 | 42976289 | 330353 |  |
| claude-code-80311240-f7e-1784192117-1 | claude-code | 80311240-f7e2-4eec-a3d3-3c75870a9a4e | #419 | claude-opus-4-8 | 4 | 2322 | 581934 | 1276 | 3602 | 0.3374 | 497 | 922081 | 43558223 | 331629 |  |
| claude-code-80311240-f7e-1784192225-1 | claude-code | 80311240-f7e2-4eec-a3d3-3c75870a9a4e | #419 | claude-opus-4-8 | 4 | 3424 | 584256 | 1328 | 4756 | 0.3467 | 501 | 925505 | 44142479 | 332957 |  |
| claude-code-80311240-f7e-1784192297-1 | claude-code | 80311240-f7e2-4eec-a3d3-3c75870a9a4e | #419 | claude-opus-4-8 | 2 | 822 | 293840 | 560 | 1384 | 0.1661 | 503 | 926327 | 44436319 | 333517 |  |
