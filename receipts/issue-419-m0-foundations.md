# Issue #419 — native Photos, Docs, and Agenda v0

## Checklist

- [x] Replace hand-vendored iroh-ffi with the available first-party iroh 1.0 bindings, retaining cargo-ndk only where no Android AAR exists.
- [x] Delete the vendored-binary fetch script and companion document.
- [x] Evaluate the official browser/WASM binding and record the KEEP verdict.
- [x] Add byte-exact tunnel wire conformance across Node, Swift, and Kotlin.
- [x] Extract a platform-neutral ReplicaStore under the native client entry point.
- [x] Add the native op-sqlite replica, FTS5 gate, coordinator, and durable intent outbox.
- [x] Add foreground delta pull, active SSE, and convergent windowed bootstrap.
- [x] Land the #417 idempotency and settlement prerequisites through #421.
- [x] Add the consent-scoped Photos shape with first-class favorite, archive, and timezone fields.
- [x] Add the canonical inline ThumbHash derivative with device/gateway agreement.
- [x] Add the durable SQLite sha-addressed, part-resumable upload queue.
- [x] Add pre-upload SHA dedupe.
- [x] Define settlement as a replicated casAck and reconcile receipts on foreground.
- [x] Use direct edge-sealed upload sessions with the tunnel for begin/complete.
- [x] Add foreground and iOS background transfer drainers.
- [x] Add Photos, Apps, and Settings native tab navigation.
- [x] Generate the React Native light/dark theme from blueprint tokens.
- [x] Wire native AES-GCM and SHA through Quick Crypto.
- [x] Add the Android data-sync foreground service with progress notification and restart-safe draining.
- [x] Generate device thumb, preview, poster, ThumbHash, and dHash derivatives at upload.
- [x] Set the iOS deployment target to 17.5.
- [x] Connect the Photos producer to the durable upload queue.
- [x] Merge device and replica timelines sha-first with dHash as a hint and five backup states.
- [x] Render FlashList v2 cells with ThumbHash placeholders and no blank fallback.
- [x] Add day/month sections and 2–7-column pinch density.
- [x] Add the month/year timeline scrubber.
- [x] Add long-press drag selection and select-all-in-day.
- [x] Add horizontal lightbox paging, pinch/double-tap zoom, swipe-down dismiss, and a native-stack transition.
- [x] Load ThumbHash, thumb, preview, then original on demand.
- [x] Stream video with poster and Range-capable original URLs.
- [x] Preserve and play Live Photo HEIC+MOV pairs as one logical asset.
- [x] Show EXIF, date/offset, place, size, sha, backup state, and containing albums.
- [x] Add selective album backup with Wi-Fi, metered, and charger rules.
- [x] Add observable backup health and Android OEM battery guidance.
- [x] Fetch iCloud-offloaded originals on demand before enqueue.
- [x] Add optimistic favorites and archive intents.
- [x] Add vault trash/restore without deleting device originals.
- [x] Add albums with create/rename/delete, bulk add/remove, ordered covers, and replica sort order.
- [x] Add save-to-device and native OS share export.
- [x] Gate Free up space on replicated casAck receipts with preview bytes and per-album keep pins.
- [x] Show bounded-storage usage and policy status.
- [x] Add offline Photos FTS5 search, typed OnlineOnlyError fallback, and filters.
- [x] Add people browsing and face proposal confirm/reject intents.
- [x] Add on-this-day memories and slideshow.
- [x] Add dHash duplicate review without automatic merging.
- [x] Map geotagged assets with clustering and set-place intents.
- [x] Add enrichment request and status surfaces.
- [x] Add the iOS ShareExtension and Android share target to the shared queue.
- [x] Add local on-this-day notifications.
- [x] Add slideshow, haptics, app icon, and splash polish.
- [ ] Execute the airplane, Wi-Fi/cellular, force-kill, 50k-device, and six-hour soak matrix on release devices.
- [x] Split mobile into kit, per-app folders, and platform lib with import-direction lint.
- [x] Grow the tab bar to Photos, Docs, Agenda, Apps, and Settings.
- [x] Multiplex additive Photos, Docs, and Agenda shapes through one database, sync loop, and outbox.
- [x] Add the Docs consent shape with SKOS folder concepts, tags, content metadata, custody, and windowed bootstrap.
- [x] Add instant offline Docs folder browsing and FTS5 search.
- [x] Add image/PDF preview viewers, Range audio/video, and original export.
- [x] Add Docs picker and share-target ingest through the shared upload queue.
- [x] Add the Agenda shape with events, timezones, attendees, parties, and calendars.
- [x] Document and implement bounded local expansion of canonical recurrence series.
- [x] Add instant offline month, week, and agenda-list views.
- [x] Add optimistic create, reschedule, cancel, and RSVP intents with native approval routing.
- [x] Add local Agenda reminders without push infrastructure.

## What changed

### Full native v0 continuation (2026-07-16)

This continuation closes the residue and M1–M5 scope that was added to #419 after the original M0 receipt landed. The mobile entrypoint installs Quick Crypto before the app or headless drainer loads; Photos and Docs now enqueue originals into the existing sha-addressed CBSF queue, while Android exposes a `dataSync` foreground service with progress notification and iOS keeps its background transfer path. Device contribution generates thumb, preview, video poster, canonical ThumbHash, and dHash derivatives before the producer submits the media intent. The queue commits addressed bytes, a stable replica intent ID, and their canonical Photos/Docs follow-up in one SQLite transaction, then retains settled follow-ups until derivative contribution and `session.write` have entered the replica outbox; foreground recovery replays the same ID after process death, including a kill after server execution but before local clearing. Wi-Fi/charger policy is a drain rule rather than a correctness dependency.

The React Native surface is reorganized as `kit/`, app-local Photos/Docs/Agenda folders, and the existing platform `lib/`; a repository-local lint rejects kit-to-app and cross-app imports. One `ReplicaProvider` discovers the vault, opens one native session, and adds the photos, docs, and agenda shapes to the same SQLite database, sync loop, and intent outbox. Cold start always resolves/restarts the iroh tunnel instead of trusting its cached ephemeral loopback port, and later reachability changes replace the session base before waking the coordinator; reads remain network-independent. The tab bar now exposes Photos, Docs, Agenda, the WebView Apps long tail, and Settings.

Photos renders a sha-first merge of MediaLibrary and consent-scoped replica rows through FlashList v2. It includes month and day sections, 2–7-column pinch density, a date scrubber, long-press-activated drag selection that accumulates every crossed asset, five backup states, thumbhash-backed recycled cells, local memories, and a 50k-row performance fixture. The lightbox pages across assets, pinch/double-tap zooms, swipe-dismisses, streams videos, plays paired HEIC+MOV captures, exports originals, and exposes EXIF/file/sha/place/album/backup details plus favorite/archive/trash/set-place intents. Library surfaces cover album cover selection, face proposals, duplicate hints, clustered places, enrichment, storage, selective backup, and a receipt-gated free-up-space action whose per-album keep-original pins exclude protected assets.

Docs receives an additive shape for content, document, SKOS folder concepts/schemes, tags, and custody rows. Its offline drive supports folder navigation and FTS5; picker and share-target ingestion use the same upload queue; image/PDF/audio/video viewers use preview or Range endpoints and can export the original. Agenda receives additive event, attendee, party, extension, and calendar rows. Month, week, and list views expand a bounded recurrence subset locally from the canonical series row, and create/reschedule/cancel/RSVP are optimistic intents with parked writes routed to native Approvals. Reminders and on-this-day notices are local notifications only.

Platform config now generates a real iOS ShareExtension target with the shared app-group entitlement and Android MIME share filters. Android's checked-in service/module/manifest can resume the queue under the six-hour cap. Expo prebuild confirms iOS 17.5 and the extension target. `NATIVE_V0.md` records recurrence, compound-camera, backup/deletion, and platform decisions, while the agent-E2E flow covers all five tabs, restart, network handoff, kill-mid-upload, and soak instructions.

The simulator continuation exercised both native shells rather than stopping at static checks. Metro now resolves the source TypeScript behind workspace-relative `.js` ESM specifiers; React Navigation packages are pinned to one compatible generation; the app root supplies `GestureHandlerRootView`; Android declares the API 33+ image/video permissions; and the headless upload service supplies the non-null task payload required by the current React Native Kotlin API. CocoaPods regenerated the iOS project integration and lockfile. With those runtime-only gaps closed, Centraid built, installed, launched, requested photo access, and rendered populated Photos timelines on Android API 35 and iOS 26.5 simulators.

### Continuation checklist crosswalk

- **Wire native AES-GCM and SHA through Quick Crypto.** `index.ts` installs Quick Crypto before queue boot and `native-digest.ts` uses its native hash.
- **Add the Android data-sync foreground service with progress notification and restart-safe draining.** The manifest, Kotlin service/module/package, headless task, and config plugin share one ledger.
- **Generate device thumb, preview, poster, ThumbHash, and dHash derivatives at upload.** `derivatives-native.ts` creates and contributes every D9 rung.
- **Set the iOS deployment target to 17.5.** Expo config, Pod properties, Podfile, and the Xcode project agree.
- **Connect the Photos producer to the durable upload queue.** Manual, album, Live Photo, and share-target paths call `backupDeviceMedia`; byte enqueue and the canonical follow-up are atomic and replay after settlement.
- **Merge device and replica timelines sha-first with dHash as a hint and five backup states.** Exact SHA merges; repeated perceptual hashes only mark review hints.
- **Render FlashList v2 cells with ThumbHash placeholders and no blank fallback.** Recycled image cells always have a sunken fallback and optional canonical ThumbHash.
- **Add day/month sections and 2–7-column pinch density.** Timeline rows emit distinct month and capture-day headers, and pinch adjusts column count.
- **Add the month/year timeline scrubber.** The right rail maps position to row and displays its month/year bubble.
- **Add long-press drag selection and select-all-in-day.** Selection uses haptic coordinate drag plus the day header action.
- **Add horizontal lightbox paging, pinch/double-tap zoom, swipe-down dismiss, and a native-stack transition.** The pager and nested gestures implement these interactions; the New Architecture transition deviation is recorded below.
- **Load ThumbHash, thumb, preview, then original on demand.** `MediaPage` promotes thumb to preview on load and exposes an explicit Original control.
- **Stream video with poster and Range-capable original URLs.** Expo Video receives the immutable original URL while timeline cells use poster derivatives.
- **Preserve and play Live Photo HEIC+MOV pairs as one logical asset.** Producer and vault persist one `capture_group_id`; the timeline coalesces the two immutable contents onto the HEIC row, and the lightbox plays its hidden MOV companion.
- **Show EXIF, date/offset, place, size, sha, backup state, and containing albums.** The info sheet joins the three replica entities and exposes set-place.
- **Add selective album backup with Wi-Fi, metered, and charger rules.** Backup settings persist album IDs plus independent Wi-Fi-only, allow-metered/cellular, and charger-only constraints.
- **Add observable backup health and Android OEM battery guidance.** The screen reports count, bytes, per-item errors, last successful sync, storage policy, and links to system settings.
- **Fetch iCloud-offloaded originals on demand before enqueue.** MediaLibrary asset info requests network access before the queue reads the local URI.
- **Add optimistic favorites and archive intents.** Both update the local media row in the same write that enters the durable outbox.
- **Add vault trash/restore without deleting device originals.** Vault intents own trash state; only Free up space calls the MediaLibrary delete API.
- **Add albums with create/rename/delete, bulk add/remove, ordered covers, and replica sort order.** Library cards use cover content/first asset in `sort_order`; album detail can select one member as the cover through a typed vault command.
- **Add save-to-device and native OS share export.** The lightbox downloads originals before MediaLibrary or OS share export.
- **Gate Free up space on replicated casAck receipts with preview bytes and per-album keep pins.** Eligibility requires `receipt.casAck === 'replicated'`, exact merge, local ID, and no pinned album membership.
- **Show bounded-storage usage and policy status.** Backup health reads the bounded storage status route and displays replicated/backlog/policy state.
- **Add offline Photos FTS5 search, typed OnlineOnlyError fallback, and filters.** Native search distinguishes `OnlineOnlyError`, supports arbitrary from/to dates and cycling across every album/person/place plus favorite/media filters, and routes its online fallback to the Photos blueprint.
- **Add people browsing and face proposal confirm/reject intents.** The face screen renders party/proposal rows and submits both typed actions.
- **Add on-this-day memories and slideshow.** Capture-date filtering powers the rail and the lightbox timer.
- **Add dHash duplicate review without automatic merging.** Repeated remote phashes and device-to-remote matches are review-only flags.
- **Map geotagged assets with clustering and set-place intents.** Map points are asset/place joins grouped into coordinate cells; the lightbox submits optimistic corrections.
- **Add enrichment request and status surfaces.** Library shows consent policies and invokes the Photos enrichment action.
- **Add the iOS ShareExtension and Android share target to the shared queue.** Generated native targets converge in `ShareIntentIngest` by MIME.
- **Add local on-this-day notifications.** Photos schedules only OS-local notifications when permission already exists.
- **Add slideshow, haptics, app icon, and splash polish.** Native interactions, Expo assets, and Android's splash drawable are included.
- **Split mobile into kit, per-app folders, and platform lib with import-direction lint.** The new layout and lint script enforce the dependency direction.
- **Grow the tab bar to Photos, Docs, Agenda, Apps, and Settings.** Apps remains the WebView long-tail entry.
- **Multiplex additive Photos, Docs, and Agenda shapes through one database, sync loop, and outbox.** `ReplicaProvider` discovers grants and adds them to one `NativeReplicaSession`.
- **Add the Docs consent shape with SKOS folder concepts, tags, content metadata, custody, and windowed bootstrap.** The manifest grants and gateway test prove those entities; all shapes use the session's windowed bootstrap.
- **Add instant offline Docs folder browsing and FTS5 search.** `useDocsLibrary` rebuilds the SKOS folder tree locally and DocsHome searches the replica.
- **Add image/PDF preview viewers, Range audio/video, and original export.** Image/PDF request preview; media use original Range URLs; sharing strips the variant.
- **Add Docs picker and share-target ingest through the shared upload queue.** Both call `backupDocument` and retain D10 dedupe.
- **Add the Agenda shape with events, timezones, attendees, parties, and calendars.** The additive shape test covers event, extension, attendee, party, and calendar entities.
- **Document and implement bounded local expansion of canonical recurrence series.** `NATIVE_V0.md` and `recurrence.ts` keep the series canonical.
- **Add instant offline month, week, and agenda-list views.** AgendaHome switches views over locally expanded replica rows.
- **Add optimistic create, reschedule, cancel, and RSVP intents with native approval routing.** Every top write has an optimistic mutation and parked writes link to Approvals.
- **Add local Agenda reminders without push infrastructure.** Event reminders use Expo's date trigger on the device only.

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

The following paragraph records the state at the original M0 landing; the continuation above supersedes its Android-service limitation.

The queue is a SQLite-backed item and part ledger in its own database file, keyed by a content hash computed at enqueue over bounded windows so memory stays flat regardless of file size. Beginning a session by hash is simultaneously the dedupe check, the resume path, and the settlement reconciliation, because the server returns an already-present marker or the parts it already holds. Parts are fixed 16 MiB, sealed on device in the vault's frame format using derived nonces so a replayed part is byte-identical after a crash, and every presigned URL passes the existing gateway-minted assertion before any transfer. iOS hands parts to a background URLSession; the Android drainer and its notification are wired in JavaScript while the foreground service itself remains unwritten.

### Native shell

The following paragraph likewise describes the original M0 shell; the continuation grows it to the five-tab native v0.

Navigation is now Photos, Apps, and Settings tabs, with the WebView app grid and detail preserved beneath the Apps stack and approvals reachable from Settings. A generator lowers the blueprint token stylesheet into a checked-in typed theme, resolving nested custom properties and skipping what cannot map rather than mangling it, and the resolved theme drives both React Navigation and the existing screens in light and dark.

`apps/mobile/vitest.config.ts` raises the suite's timeout to the budget `packages/backup` and `packages/tunnel` already use. The sealing and crash-resume suites do real AES-GCM over multi-part payloads and rebuild the queue from disk across many simulated process deaths, so they land near the 5-second default on an idle machine and time out under a full-repository run.

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

### Original M0 issue-checklist crosswalk

- **Replace hand-vendored iroh-ffi with the available first-party iroh 1.0 bindings, retaining cargo-ndk only where no Android AAR exists.** The official archive/podspec path and the verified Android packaging exception are recorded above.
- **Delete the vendored-binary fetch script and companion document.** The obsolete script and `BINARIES.md` were removed in the original M0 landing.
- **Evaluate the official browser/WASM binding and record the KEEP verdict.** The evaluation document records why the app-owned wasm-bindgen wrapper remains correct.
- **Add byte-exact tunnel wire conformance across Node, Swift, and Kotlin.** All three implementations consume the shared golden-frame fixture.
- **Extract a platform-neutral ReplicaStore under the native client entry point.** The shared store core and curated DOM-free native export implement this seam.
- **Add the native op-sqlite replica, FTS5 gate, coordinator, and durable intent outbox.** These native layers share the one replica database while the outbox survives rebootstrap.
- **Add foreground delta pull, active SSE, and convergent windowed bootstrap.** The single native session owns all three paths.
- **Land the #417 idempotency and settlement prerequisites through #421.** The prerequisite commit is part of the issue's landed M0 foundation and this continuation preserves its contracts.
- **Add the consent-scoped Photos shape with first-class favorite, archive, and timezone fields.** The Photos replica shape exposes those fields directly.
- **Add the canonical inline ThumbHash derivative with device/gateway agreement.** Cross-runtime fixtures pin the same canonical encoding.
- **Add the durable SQLite sha-addressed, part-resumable upload queue.** The independent upload ledger and kill harness prove this kernel.
- **Add pre-upload SHA dedupe.** Enqueue and gateway begin both key identity by exact SHA.
- **Define settlement as a replicated casAck and reconcile receipts on foreground.** The settled ledger receipt is the Free-up-space trust gate.
- **Use direct edge-sealed upload sessions with the tunnel for begin/complete.** The transfer client preserves the single transport/control contract.
- **Add foreground and iOS background transfer drainers.** The queue is lifecycle-independent and this continuation adds Android's foreground service as well.
- **Add Photos, Apps, and Settings native tab navigation.** The continuation grows that landed shell to all five v0 tabs.
- **Generate the React Native light/dark theme from blueprint tokens.** The generated typed theme continues to drive native navigation and screens.

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
- `apps/mobile/src/lib/upload/followup.ts`
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
- `apps/mobile/vitest.config.ts`
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

#### Full native v0 continuation paths

- `apps/mobile/App.tsx`
- `apps/mobile/NATIVE_V0.md`
- `apps/mobile/android/app/src/main/AndroidManifest.xml`
- `apps/mobile/android/app/src/main/java/com/centraid/mobile/MainApplication.kt`
- `apps/mobile/android/app/src/main/java/com/centraid/mobile/upload/UploadForegroundModule.kt`
- `apps/mobile/android/app/src/main/java/com/centraid/mobile/upload/UploadForegroundPackage.kt`
- `apps/mobile/android/app/src/main/java/com/centraid/mobile/upload/UploadForegroundService.kt`
- `apps/mobile/android/app/src/main/res/drawable/splashscreen_logo.xml`
- `apps/mobile/app.json`
- `apps/mobile/metro.config.js`
- `apps/mobile/index.ts`
- `apps/mobile/ios/Centraid.xcodeproj/project.pbxproj`
- `apps/mobile/ios/Podfile.lock`
- `apps/mobile/ios/Centraid/Centraid.entitlements`
- `apps/mobile/ios/Centraid/Images.xcassets/AppIcon.appiconset/App-Icon-1024x1024@1x.png`
- `apps/mobile/ios/Centraid/Images.xcassets/SplashScreenBackground.colorset/Contents.json`
- `apps/mobile/ios/Centraid/Images.xcassets/SplashScreenLegacy.imageset/Contents.json`
- `apps/mobile/ios/Centraid/Images.xcassets/SplashScreenLegacy.imageset/image.png`
- `apps/mobile/ios/Centraid/Images.xcassets/SplashScreenLegacy.imageset/image@2x.png`
- `apps/mobile/ios/Centraid/Images.xcassets/SplashScreenLegacy.imageset/image@3x.png`
- `apps/mobile/ios/Centraid/Info.plist`
- `apps/mobile/ios/Centraid/SplashScreen.storyboard`
- `apps/mobile/ios/Podfile`
- `apps/mobile/ios/Podfile.properties.json`
- `apps/mobile/ios/ShareExtension/MainInterface.storyboard`
- `apps/mobile/ios/ShareExtension/PrivacyInfo.xcprivacy`
- `apps/mobile/ios/ShareExtension/ShareExtension-Info.plist`
- `apps/mobile/ios/ShareExtension/ShareExtension.entitlements`
- `apps/mobile/ios/ShareExtension/ShareExtensionPreprocessor.js`
- `apps/mobile/ios/ShareExtension/ShareViewController.swift`
- `apps/mobile/modules/centraid-tunnel/.gitignore`
- `apps/mobile/package.json`
- `apps/mobile/plugins/withCentraidUploadService.cjs`
- `apps/mobile/scripts/check-import-boundaries.ts`
- `apps/mobile/scripts/generate-theme.ts`
- `apps/mobile/src/apps/agenda/AgendaEvent.tsx`
- `apps/mobile/src/apps/agenda/AgendaHome.tsx`
- `apps/mobile/src/apps/agenda/recurrence.test.ts`
- `apps/mobile/src/apps/agenda/recurrence.ts`
- `apps/mobile/src/apps/agenda/useAgenda.ts`
- `apps/mobile/src/apps/docs/DocsHome.tsx`
- `apps/mobile/src/apps/docs/DocumentViewer.tsx`
- `apps/mobile/src/apps/docs/docs-model.test.ts`
- `apps/mobile/src/apps/docs/docs-model.ts`
- `apps/mobile/src/apps/docs/useDocsLibrary.ts`
- `apps/mobile/src/apps/photos/AlbumDetail.tsx`
- `apps/mobile/src/apps/photos/BackupHealth.tsx`
- `apps/mobile/src/apps/photos/DuplicateReview.tsx`
- `apps/mobile/src/apps/photos/FaceReview.tsx`
- `apps/mobile/src/apps/photos/PhotoLightbox.styles.ts`
- `apps/mobile/src/apps/photos/PhotoLightbox.tsx`
- `apps/mobile/src/apps/photos/PhotoStateView.tsx`
- `apps/mobile/src/apps/photos/PhotoTimeline.tsx`
- `apps/mobile/src/apps/photos/PhotosHome.tsx`
- `apps/mobile/src/apps/photos/PhotosLibrary.tsx`
- `apps/mobile/src/apps/photos/PhotosSearch.tsx`
- `apps/mobile/src/apps/photos/PlacesMap.tsx`
- `apps/mobile/src/apps/photos/timeline-50k.test.ts`
- `apps/mobile/src/apps/photos/timeline-model.test.ts`
- `apps/mobile/src/apps/photos/timeline-model.ts`
- `apps/mobile/src/apps/photos/timeline-source.ts`
- `apps/mobile/src/kit/components/AppHeader.tsx`
- `apps/mobile/src/kit/components/Button.tsx`
- `apps/mobile/src/kit/components/Icon.tsx`
- `apps/mobile/src/kit/components/Logo.tsx`
- `apps/mobile/src/kit/components/Tile.tsx`
- `apps/mobile/src/kit/hooks/ShareIntentIngest.tsx`
- `apps/mobile/src/kit/hooks/useReplicaQuery.ts`
- `apps/mobile/src/kit/replica/ReplicaProvider.tsx`
- `apps/mobile/src/kit/theme/generate.test.ts`
- `apps/mobile/src/kit/theme/generate.ts`
- `apps/mobile/src/kit/theme/index.ts`
- `apps/mobile/src/kit/theme/resolve.test.ts`
- `apps/mobile/src/kit/theme/resolve.ts`
- `apps/mobile/src/kit/theme/tokens.generated.ts`
- `apps/mobile/src/kit/theme/useTheme.ts`
- `apps/mobile/src/lib/replica/native-session.test.ts`
- `apps/mobile/src/lib/replica/native-session.ts`
- `apps/mobile/src/lib/upload/boot.ts`
- `apps/mobile/src/lib/upload/derivatives-native.ts`
- `apps/mobile/src/lib/upload/enqueue.test.ts`
- `apps/mobile/src/lib/upload/enqueue.ts`
- `apps/mobile/src/lib/upload/followup.test.ts`
- `apps/mobile/src/lib/upload/followup-record.ts`
- `apps/mobile/src/lib/upload/followup.ts`
- `apps/mobile/src/lib/upload/foreground-service.ts`
- `apps/mobile/src/lib/upload/media-producer.ts`
- `apps/mobile/src/lib/upload/native-digest.ts`
- `apps/mobile/src/lib/upload/native-policy.ts`
- `apps/mobile/src/lib/upload/native-queue.ts`
- `apps/mobile/src/lib/upload/store.test.ts`
- `apps/mobile/src/lib/upload/store.ts`
- `apps/mobile/src/navigation.ts`
- `apps/mobile/src/screens/AppDetail.tsx`
- `apps/mobile/src/screens/Approvals.tsx`
- `apps/mobile/src/screens/Home.tsx`
- `apps/mobile/src/screens/MobileFallback.tsx`
- `apps/mobile/src/screens/Settings.tsx`
- `apps/mobile/src/screens/photos/PhotosHome.tsx`
- `apps/mobile/src/screens/photos/timeline-source.ts`
- `bun.lock`
- `packages/blueprints/apps/photos/actions/set-album-cover.js`
- `packages/blueprints/apps/photos/app.json`
- `packages/blueprints/manifest.json`
- `packages/gateway/src/routes/replica-shape.test.ts`
- `packages/vault/src/commands/media.test.ts`
- `packages/vault/src/commands/media.ts`
- `packages/vault/src/schema/domains-social-knowledge-media.ts`
- `receipts/issue-419-m0-foundations.md`
- `tests/agent-e2e-mobile/flows/native-v0-resilience.md`
- `tests/agent-e2e-mobile/flows/native-v0-resilience.mjs`

## Out of scope

- Rewriting `apps/web/iroh-wasm` against an official browser binding. n0 publishes none and documents the app-owned `wasm-bindgen` wrapper this crate already is.
- Adopting `computer.iroh:iroh` for Android. The published artifact carries no Android natives, so the cargo-ndk step cannot be deleted until n0 ships an AAR.
- Switching the web shell to windowed bootstrap. The single-shot path carries admission and storage-manifest behavior that deserves its own review, and the row ceiling is a mobile-library problem today.
- The issue's explicit non-goals remain unchanged: public links/collaborative albums, native editing, push infrastructure, upload leases, BGProcessingTask/UIDT orchestration, device calendar two-way sync, document editing/collaboration, and a native ask panel.
- Release-device measurements are not represented as passed. Android API 35 and iOS 26.5 simulator smoke runs now cover native build/install/launch, photo permission, timeline rendering, and Android lightbox rendering; LTE lightbox, multipath walk, OEM kill behavior, 50k-device measurement, and the six-hour soak remain release-device QA.

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
- Teach the upload fixture the `allowedUploadPrefix` allowlist shape that #422 moved to, rather than pinning the old `bucket`/`prefix` pair. The fixture exists to run the real `assertGatewayMintedUploadUrl` against a faithful payload, so serving a shape the gateway no longer emits would have made the crash suite pass against a contract that does not exist.
- Keep one canonical event series and expand a bounded DAILY/WEEKLY/MONTHLY/YEARLY subset locally on native, mirroring the gateway blueprint expansion. Persisting occurrence rows would introduce a second truth and unbounded replica growth.
- Treat favorite/archive as inapplicable to Agenda v0 because the canonical event and calendar contracts expose neither state; adding mobile-only flags would create an unsynced second truth. Photos implements both conventions where the underlying domain supports them.
- Model HEIC+MOV as two immutable contents sharing `capture_group_id`; exact SHA remains identity and dHash remains review evidence. Android motion photos, RAW, and bursts pass through intact without filename-based grouping guesses.
- Use the native-stack transition plus gesture-owned zoom/dismiss on Expo's New Architecture. Reanimated 4 does not expose Shared Element Transitions there, so pretending to ship the old-architecture experimental API would make the lightbox less portable; the selected asset still transitions immediately into the full-screen pager.
- Keep share targets, reminders, and on-this-day notifications local to the OS and route every imported byte through the one durable queue; no push broker or alternate byte plane is introduced.

## Verification

Continuation verification on 2026-07-16:

- `bun run ci` — format, oxlint, package lint, 28/28 Turbo build/typecheck tasks, and type-aware lint passed.
- `bun run --cwd apps/mobile test` — 17 files / 127 tests passed, including kill/resume crypto, stable-intent replay across a kill after Docs execution, tunnel-base replacement, cumulative drag selection, recurrence/docs models, logical Live Photo coalescing, and the 50k fixture (91 ms in the final recorded run).
- `bun run --cwd packages/gateway test -- src/routes/replica-shape.test.ts` — 18/18 passed, including additive Docs/Agenda shapes.
- `bun run --cwd packages/vault test -- src/commands/media.test.ts` — 18/18 passed, including logical capture-group persistence and explicit album-cover selection.
- `bun run --cwd packages/blueprints build:manifest && bun run --cwd packages/blueprints lint && bun run --cwd packages/blueprints typecheck` — generated 24 templates; lint/typecheck passed.
- `bunx expo config --type public` — resolved iOS 17.5, ShareExtension app group, Android MIME filters, MediaLibrary permissions, and foreground-service permissions.
- `bunx expo prebuild --platform ios --no-install` — generated and linked the ShareExtension target and entitlements successfully.
- `bun run android -- --no-bundler` — after locally generating the documented pinned iroh-ffi 1.0.0 Android bindings, Gradle completed 481 tasks, assembled and installed the debug APK, and opened `com.centraid.mobile/.MainActivity` on the API 35 `Centraid_API_35` emulator. The app requested API 33+ media access, rendered five indexed images in the Photos timeline, and opened the gesture-driven lightbox.
- `bun run ios -- --no-bundler --device C041CC61-F9E1-4277-A00E-D1535CAA7C3D` — CocoaPods and Xcode completed the first native build with 0 errors / 7 warnings, installed `Centraid.app`, and opened `com.centraid.mobile` on an iPhone 17 running iOS 26.5. After full photo access was granted, the timeline rendered all six seeded simulator photos.
- Metro development bundles completed on both targets: Android loaded 2,075 modules and iOS loaded 2,074 modules through the workspace-source resolver.
- `pod install` — regenerated the native Expo/React Native integration and `Podfile.lock`, including MediaLibrary, Gesture Handler, Quick Crypto, op-sqlite, tunnel, and ShareExtension dependencies.
- `node tests/agent-e2e-mobile/flows/native-v0-resilience.mjs` — the prior device-discovery blocker is retired by the successful simulator smoke runs above; the longer network/kill/soak matrix remains recorded beside the flow for release-device execution.

```sh
bun run --cwd packages/tunnel test
bun run --cwd packages/client test
bun run --cwd apps/mobile test
bun run --cwd packages/gateway test
bun run --cwd packages/vault test
bun run --cwd packages/blueprints test
bun run format:check
bunx oxlint .
bun run typecheck
bun run lint:types
```

- `bun run --cwd packages/tunnel test` — 3 files / 59 tests passed, including the conformance fixture and the existing real-loopback iroh suites.
- `bun run --cwd packages/client test` — 111 files / 850 tests passed.
- `bun run --cwd apps/mobile test` — 12 files / 113 tests passed, including the kill harness and the sealed round-trip through the vault's reader.
- `bun run --cwd packages/gateway test` — 91 files / 682 passed / 2 skipped on a quiet run.
- `bun run --cwd packages/vault test` — 722 passed / 1 skipped; `src/blob/stream-ingress.test.ts` times out only under full-suite load and fails identically on a clean checkout at `74a596db`, so it is inherited rather than introduced.
- `bun run --cwd packages/blueprints test` — 164 passed; `src/docs-media.test.ts` fails identically on a clean checkout at `74a596db` because the vendored PDF runtime calls `Promise.try`, absent in this Node.
- `bun run format:check` — all matched files use the correct format.
- `bunx oxlint .` — 0 warnings, 0 errors.
- `bun run typecheck` — 26/26 Turbo tasks passed.
- `bun run lint:types` — all packages ok.
- Gateway `src/serve/vault-registry.test.ts` and `src/cli/admin.test.ts` time out only under full parallel load and pass in isolation; a clean checkout at `74a596db` fails four different backup tests under the same load, so the suite's parallel flakiness is inherited.
- Swift `xcodebuild test`, Kotlin `./gradlew test`, op-sqlite behavior on a release device, and the long network/kill/soak matrix were not run in this simulator pass.

## Audit

- **A1 — What changed matches the diff. PASS.** All 109 changed paths are cited and the continuation summary accurately describes the implementation.
- **A2 — Checked items are realized. PASS.** The auditor verified stable follow-up intent replay, reconnect base replacement, cumulative drag selection, and the broader native v0 crosswalk against code and tests.
- **A3 — Checklist mirrors the issue. PASS.** The receipt covers landed M0, M0 residue, and M1–M5; release-device QA alone remains unchecked, while live issue boxes remain open until merge.
- **A4 — Decisions and deviations are honest. PASS.** The shared-element substitution, platform provisioning limitation, recurrence/media decisions, and release-device boundary are explicit.
- **A5 — Verification and limitations support the claims. PASS.** Reproducible CI, 17 files / 127 mobile tests, and 21/21 governance checks pass without representing unavailable device runs as complete.

## Steering

- **B1 — Every human-steering event is recorded.** PASS — The fresh audit covered both this full-native-v0 continuation and the historical M0 work. The continuation has one human message, the initial request to complete issue #419 and create a PR; initial requests are excluded by the directive. There were no later human corrections, redirects, or interrupts, so no continuation steering row is required. The historical M0 session (`80311240-f7e2-4eec-a3d3-3c75870a9a4e`) likewise had no qualifying steering events: its later human messages supplied context, asked a clarification, and authorized its PR after completion.

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
| claude-code-80311240-f7e-1784192357-1 | claude-code | 80311240-f7e2-4eec-a3d3-3c75870a9a4e | #419 | claude-opus-4-8 | 2 | 736 | 294662 | 623 | 1361 | 0.1675 | 505 | 927063 | 44730981 | 334140 |  |
| claude-code-80311240-f7e-1784192408-1 | claude-code | 80311240-f7e2-4eec-a3d3-3c75870a9a4e | #419 | claude-opus-4-8 | 2 | 780 | 295398 | 514 | 1296 | 0.1654 | 507 | 927843 | 45026379 | 334654 |  |
| claude-code-80311240-f7e-1784192453-1 | claude-code | 80311240-f7e2-4eec-a3d3-3c75870a9a4e | #419 | claude-opus-4-8 | 4 | 2440 | 592356 | 628 | 3072 | 0.3271 | 511 | 930283 | 45618735 | 335282 |  |
| claude-code-80311240-f7e-1784192530-1 | claude-code | 80311240-f7e2-4eec-a3d3-3c75870a9a4e | #419 | claude-opus-4-8 | 20 | 6934 | 2985442 | 4628 | 11582 | 1.6519 | 531 | 937217 | 48604177 | 339910 |  |
| claude-code-80311240-f7e-1784193639-1 | claude-code | 80311240-f7e2-4eec-a3d3-3c75870a9a4e | #419 | claude-opus-4-8 | 46 | 16056 | 6989396 | 11966 | 28068 | 3.8944 | 577 | 953273 | 55593573 | 351876 |  |
| claude-code-80311240-f7e-1784193691-1 | claude-code | 80311240-f7e2-4eec-a3d3-3c75870a9a4e | #419 | claude-opus-4-8 | 4 | 1296 | 617585 | 416 | 1716 | 0.3273 | 581 | 954569 | 56211158 | 352292 |  |
| claude-code-80311240-f7e-1784193732-1 | claude-code | 80311240-f7e2-4eec-a3d3-3c75870a9a4e | #419 | claude-opus-4-8 | 2 | 288 | 309542 | 237 | 527 | 0.1625 | 583 | 954857 | 56520700 | 352529 |  |
| claude-code-80311240-f7e-1784193790-1 | claude-code | 80311240-f7e2-4eec-a3d3-3c75870a9a4e | #419 | claude-opus-4-8 | 10 | 7604 | 1550699 | 4937 | 12551 | 0.9463 | 593 | 962461 | 58071399 | 357466 |  |
| claude-code-80311240-f7e-1784194698-1 | claude-code | 80311240-f7e2-4eec-a3d3-3c75870a9a4e | #419 | claude-opus-4-8 | 224 | 162564 | 11120918 | 49940 | 212728 | 7.8261 | 817 | 1125025 | 69192317 | 407406 |  |
| codex-019f6ab8-3b3-1784211462-1 | codex | 019f6ab8-3b3d-7522-aab1-56bd726a3a9b | #419 | gpt-5.6-sol | 2714701 | 0 | 89450240 | 224910 | 2939611 | 32.5230 | 2714701 | 0 | 89450240 | 224910 | feat(mobile): ship native Photos, Docs, and Agenda v0 (#419) -m governance: allo |
| codex-019f6ab8-3b3-1784219910-1 | codex | 019f6ab8-3b3d-7522-aab1-56bd726a3a9b | #419 | gpt-5.6-sol | 1745383 | 0 | 61581824 | 57169 | 1802552 | 20.6164 | 4460084 | 0 | 151032064 | 282079 | fix(mobile): complete native simulator paths (#419) -m governance: allow-doc-int |
