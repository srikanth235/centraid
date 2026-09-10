# Issue #1011 — recognition as a system tier, and generated mobile native projects

One receipt for one umbrella, worked by orchestration: four lanes on disjoint reading sets plus a verifier pass. Every ruling the owner made on 2026-09-09 is recorded in [`docs/decisions.md`](../docs/decisions.md) as current state with supersession pointers over what it replaces.

## Checklist

- [x] **"System" is a provenance tier** — `faces`, `photo-ocr`, `doc-text-extractor` ship with the release, arm from the catalogue on every boot with no `enabled` flag read, run in a `system` sandbox lane; `embed-image`, `embed-text`, `transcript`, `place-names` are bundled-optional and ship off
- [x] **Consent is for egress** — on-device recognition needs no answer; the cloud tier still does; `enrich_request` is a priority hint, never a gate; the Photos consent surface deleted
- [x] **Models** — SFace → ArcFace ResNet100 (Apache-2.0, 512-d); PP-OCRv4 `ch` → PP-OCRv5; YuNet kept; an OCR normalisation bug fixed on the way
- [x] **Weights arrive at first boot** — `ensureModelAssets` behind a host-owned `modelAssets.provision` switch; a recipe is *preparing*, not off, until they land
- [x] **Regenerate** — `enrich.regenerate` and `enrich.regenerate_all`; model-id stamps make a weights swap self-invalidating
- [x] **Continuous Native Generation** — `apps/mobile/{ios,android}` become gitignored prebuild outputs; every divergence expressed in config, four plugins, one local Expo module
- [x] **The phone probes `vec0`** at open, pins its extension version, and offline keyword search over OCR text was confirmed already covered
- [x] **Docs** — decisions, recognition automations, config ownership, mobile offline, a new trap, CHANGELOG, QUALITY

## What changed

### "System" is a provenance tier, for automations exactly as for apps

Every bundled recognition recipe shipped `"enabled": false`, so **a fresh gateway ran no recognition at all** while three places in the tree said otherwise. The first attempt on this branch flipped six manifests to `true`; testing it against a fresh vault with real weights and a real photograph then showed the recipes could not complete a run: `sharp` requires `node:child_process` at load, the `model-runtime` sandbox lane refuses it, and the static lane-conformance test cannot see a dependency that lives in `runtime/node_modules`. The owner's rethink replaced the flag flip with a tier.

A bundled app is shipped with the release, first-party, present in every vault, upgraded with the release, on, and trusted as the shell is trusted. Applied to automations ([`system-recognition.ts`](../packages/server/src/enrich/system-recognition.ts)):

- **`SYSTEM_AUTOMATION_IDS`** = `faces`, `photo-ocr`, `doc-text-extractor`. Armed from the catalogue on every boot, independent of `experimental.automations`; no `enabled` bit is read, so nothing per-vault can drift. `set-enabled` is refused with `409 system_automation`; the owner's background pause (#528) is the control that works, honoured at the cursor engine's `processSafely` so a paused tick consumes no trigger element, and again at fire time as the backstop.
- **`BUNDLED_OPTIONAL_AUTOMATION_IDS`** = `embed-image`, `embed-text`, `transcript`, `place-names`. Today's `enabled` semantics, shipped `false`, sandboxed. `embed-image` gained the `core` scope and `doc-text-extractor` the `enrich` read scope it was using undeclared — both found by the live probe.
- **Lane routing is by provenance.** `runFire` sends `sandboxLane: "system"` when the ref is in the system constant; the worker installs `systemAutomationPolicy()`, which grants nothing the gateway process does not already have. Manifests may still name only `model-runtime` or `media-transcode`, bundled ids are reserved against code-store apps, so nothing outside the release can reach the lane. [`bundle-lane-conformance.test.ts`](../packages/server/src/engine/sandbox/bundle-lane-conformance.test.ts) proves the same `node:child_process` require is accepted in `system` and refused in `model-runtime`.
- **Consent is for egress.** `resolveEnrichmentPolicy` resolves an unwritten policy to enabled-on-device for a system automation and seals `ctx.delegate`; an explicit `off`, a capability-off rule, and the provider-egress ledger refuse exactly as before. `enrich_request` is a priority hint.
- **`faces` fires on ingest** — trigger moved from `enrich.request` to `media.asset`; the handler runs the priority queue, the prior-stamp sweep, then an ambient cursor pass over one `BATCH = 16` budget.

### The models

| Capability | Was | Now | Why |
| --- | --- | --- | --- |
| Face detection | YuNet 2023mar | unchanged | best tiny detector for phone photographs |
| Face recognition | SFace 2021, 128-d | ArcFace ResNet100 (ONNX Model Zoo, Apache-2.0), 512-d, 261 MB | SFace is the weakest embedder in common use; InsightFace `buffalo_l` is stronger still but its weights are non-commercial, which the model-lock law and `LICENSES.md` forbid — **rejected by the owner on that ground** |
| OCR | PP-OCRv4 `ch` | PP-OCRv5 (RapidOCR export), 21 MB | better English and mixed-script recognition; same runtime code |

The v5 upgrade surfaced a real bug: the recogniser was fed ImageNet normalisation where PaddleOCR expects `(x/255 − 0.5)/0.5`; corrected, the golden reads `CENTRAID 725` as one region. `models.lock.json` entries now carry `capabilities` and `bytes` and are commit-pinned. `enrich_derivation.model` records the model id and every handler treats a stamp naming a superseded model as absent, so a swap re-derives the library behind each recipe's own cursor with no migration.

### Weights arrive at first boot, on the host's say-so

`SystemModelAssets` ([`system-model-assets.ts`](../packages/server/src/enrich/system-model-assets.ts)) runs after the first scheduler reconcile, never awaited, for exactly the capabilities the system handlers' model constants pin in the lock, into the directory `resolveAutomationRuntimeDir` says the handler reads. A recipe whose weights are absent is *preparing*: its scheduled fire is skipped with a stated reason, health carries `recognition-models`, and when the assets land the gateway fires the recipe once so what was ingested meanwhile is caught up. Fetching is a network side effect, so it is the host's decision: `modelAssets: { provision: "fetch" | "verify-only" }` on `BuildGatewayOptions`, **default `verify-only`** (verify what is on disk, never open a connection, never retry); the CLI and the desktop embedded gateway pass `fetch` explicitly, and a test asserts an unconfigured `serve()` makes zero fetches. That default exists because the first cut fetched 277 MB on every gateway boot, including the 23 tests that boot `serve()`.

### Regenerating

`enrich.regenerate { capability, content_id | asset_id }` clears the derivation stamps for one photograph and enqueues a manual `enrich_request`; `enrich.regenerate_all { capability }` drops every stamp for the capability and rewinds the owning recipe's cursor keys. Both in [`packages/vault/src/commands/enrich.ts`](../packages/vault/src/commands/enrich.ts), with a commons route declared for the asset form.


### Proven on a phone, and what that exposed

The system tier was proven in-process first, then against a real simulator paired by ticket to a fresh `centraid-gateway serve`. The phone run failed in ways the in-process probe could not show, and each was fixed at its cause:

- **No preview for anything the phone uploaded.** The in-process probe called `sweepBlobs()` by hand; a real gateway sweeps every 1–2 h. Three ingress doors never contributed display rungs at ingest: the phone's multipart `direct-transfers.ts` (now reads the sealed object back through the custody stream and contributes), and the synchronous `stageBlobBytes` seam behind JSON uploads, `gateway.stageBlob` and the camera-roll import's file-drop path (`/centraid/_vault/imports`), which is what the phone's Import actually uses. Rungs now land at ingest on every door; the sweep is the backstop ([`derived-ledger.md`](../docs/photos/derived-ledger.md)).
- **One unready asset failed the whole recognition batch.** The handlers threw on a missing preview; they now count it `notReady`, write no stamp, and park the cursor before it so it is revisited.
- **A preview that can never exist parked the cursor forever.** The codecs decline HEIC — iPhone's default — and nothing recorded the decline. `preview-codec@1` unsupported is now a durable `enrich_derivation` stamp keyed by codec version; recognition skips it and the walk advances. The pinned `@img/sharp-libvips` ships libheif **without an HEVC decoder**, so the gateway cannot decode iPhone HEIC at all; the phone therefore renders `thumb`/`preview`/`phash`/`thumbhash` for HEIC on Import through the variant door, and a client rung retires the marker. A thumbhash bug (`rgbaToThumbHash` fed a 256-px rung, throws above 100 px) had silently broken device rung generation on every path; fixed with a separate ≤100 px render.
- **The owner's own phone showed the vault as read-only.** Camera-roll rows carried no `canWrite`, and the replica branch read an unknown scope as refused; both now follow row-provenance's rule: absent answer = writable, only an explicit `canWrite:false` locks.
- **The seat never pulled after bootstrap.** `ReplicaProvider` fed the session's connectivity oracle from the pull it gates, and `catchUp()` refused without a retry, latching the mount shut on one transient failure. Fixed; the gateway now logs each seat page; `lastSyncError` is durable on the session.
- **The app stayed offline after a fresh bundle.** expo-sqlite bundles `vec.framework` but never loads it — every connection must `loadExtensionSync` — so the new vec probe threw on a correct build and the swallowed seat-open left the provider loading forever. Fixed (load before probe; a failed open now settles the provider with an error).
- **The viewer wasted the screen.** The filmstrip `ScrollView` kept RN's default `flexGrow:1` and took 372 pt; the viewer is now image-first with overlay chrome that toggles on tap ([`docs/photos/README.md`](../docs/photos/README.md)).

Final live state on the phone: pairing by ticket; Import of 9 camera-roll assets (JPEG + HEIC); rungs at ingest; two faces at 0.913/0.912 proposed with 512-d embeddings; OCR text; seat at the gateway's watermark; viewer full-screen with no read-only refusal on vault rows.

### The phone

`ExpoSeatDriver.open()` probes FTS5, then `vec0`, then asserts `vec_version()` against one constant (`v0.1.7-alpha.2`, what expo-sqlite bundles and what the iOS build script tags); the gateway's `sqlite-vec` 0.1.9 is deliberately not part of that agreement, since planes compare vectors, not extensions. Offline keyword search over OCR text needed nothing: the replica creates no FTS tables of its own, it rebuilds every fts5 table in the gateway snapshot, and extracted text is indexed under `core.document`. sqlite-vec on the phone serves the people lane — face vectors replicate, the phone ranks them. Semantic search is not in v0.

### The Photos enrichment consent moment is gone

The sheet claimed a power it never had. Answering it wrote an `enrich.request`; the standing permission sat in `resolveEnrichmentPolicy` and the recipe's enabled bit, neither of which that surface can reach. Under the ruling above it does not even gate a run.

- **The web gate** — `createEnrichmentGate` becomes `createPeopleEmptyState`; `components/EnrichmentConsent.tsx` is deleted and `People.tsx` renders the empty state inline: the status line, one sentence naming the recipe and Automations → Recognition, and one action.
- **The native screen** — `apps/mobile/src/apps/photos/EnrichmentConsent.tsx` was mounted **nowhere** in the navigator and is deleted. `PhotosPeopleView` loses `showGate` and the decline path, and mounts the new `PeopleEmptyState`.
- **The copy module** — `ON_DEVICE_PANEL`, `onDeviceTitle`, `ENRICHMENT_NOTE`, `ENRICHMENT_DECLINED_NOTE`, `ENRICHMENT_REQUESTED_NOTE`, `ENRICHMENT_TITLE` and `deviceAnswerFor` are removed; `prioritiseAnswerFor` replaces the last of those and returns `available: true` on the gateway tier, because the priority action is really wired. `CLOUD_PANEL`, `CLOUD_EGRESS_DISCLOSURE` and `CLOUD_ANSWER` stay and stay pinned: a provider choice still needs its own granted row, and the disclosure is the point of that panel.
- **The library menu** — "Detect faces" becomes "Prioritise faces" and keeps opening the People shelf rather than writing.
- **Pre-rename tier spellings** — `local` / `model` compat branches are deleted across the consent module and `people-model.ts`. v0 carries no legacy spellings.

### The mobile native projects are generated

`apps/mobile/ios` and `apps/mobile/android` were committed while `app.config.ts` also carried config plugins — a hybrid in which whichever half a contributor trusts, the other drifts. The most recent instance is the dead `op-sqlite` `sqlitevec.framework` reference in `project.pbxproj` that outlived the dependency's removal in [#996](https://github.com/srikanth235/centraid/issues/996) and was only dropped when a local `pod install` regenerated the embed phase.

Both trees are now gitignored outputs of `expo prebuild`. Every divergence between the committed trees and a clean prebuild was inventoried empirically (copy aside, `prebuild --clean`, diff) and expressed in config:

- **`modules/centraid-upload/`** — the Android upload foreground service becomes a local Expo module, autolinked, carrying its own `<service>` and permissions in a library manifest that AGP merges. `withCentraidUploadService.cjs` is deleted. The JS API is unchanged, so no caller moves.
- **`plugins/withCentraidAndroidPrivacy.cjs`** — the network security config, the backup and data-extraction rules that replace expo-secure-store's defaults, and the removal of `requestLegacyExternalStorage`, `RECORD_AUDIO` and `READ_MEDIA_VISUAL_USER_SELECTED` that upstream plugins add.
- **`plugins/withCentraidAndroidBuild.cjs`** — the OpenSSL force, the release signing config and debug suffix, and `org.gradle.caching`.
- **`plugins/withCentraidAndroidSplash.cjs`** — the splash logo drawable, supplied by hand because setting `android.image` on `expo-splash-screen` rewrites the adaptive icon's background.
- **`plugins/withCentraidIos.cjs`** — the deployment target held at `ios.deploymentTarget` across every build configuration (quick-crypto's plugin hard-codes 16.4), the `aps-environment` entitlement removed, the share extension's bundle id, the version and build number on every bundle-identified configuration, the splash storyboard's colorset, and the repo-owned `ShareViewController.swift` copied from `plugins/native/`.
- **Dropped as dead** — the `op-sqlite` public-header guard in the Podfile, and the hand-copied `$MLRN.post_install` the maplibre plugin now emits itself.
- **`ios.privacyManifests`** in `app.config.ts` replaces the hand-written `PrivacyInfo.xcprivacy`.

Plugin **order is load-bearing**: `@expo/config-plugins` composes mods last-registered-first, so Centraid's plugins are listed first in order to see and overwrite upstream output.

Verified end to end on a booted simulator: `expo prebuild --clean`, the sqlite-vec build, `pod install` (141 dependencies, every pod at 17.5), `expo run:ios`, install, and the app boots and renders a replicated vault. `vec.framework` and `ShareExtension.appex` are in the built bundle.

### The native-state gate and CI

`ci:native-state` keeps its four fail-closed layers and its `--status` / `--write` flags, but changes subject from "the committed native tree agrees with config" to "config, plugins and local modules are the only native inputs":

- **L1 generated-tree purity** — nothing tracked under `ios`/`android`, and both ignored. Two halves, because `git add -f` and a `.gitignore` edit each bypass one alone. The ignore query uses a trailing slash: the rule is `/ios/`, and git cannot tell a bare path names a directory when the directory is absent, i.e. on every CI checkout.
- **L2 input coverage** — every `plugins/*.cjs` and local-module platform dir appears in the fingerprint's source list, plus the synthetic `expoConfig` / `expoAutolinkingConfig` sources. A ratchet that stops reading an input goes quiet, not red; this is the layer that says so.
- **L3 host independence** — every fingerprint source under `ios/`/`android/` must hash to `null`. Asserting the emptiness rather than the ignore array means deleting the ignore entry reds a gate instead of silently localising every hash.
- **L4 identity ratchet** — unchanged in shape; fingerprints re-keyed once, deliberately.

Deleted because they no longer protect anything: pod-lock module completeness, the node_modules pod-drift check, Expo/React-Core/Hermes version coherence, and `REACT_NATIVE_PATH` hygiene over `project.pbxproj`. Each compared a committed artifact against its inputs; `pod install` now runs only in a lane that prebuilt first, from that lane's own `node_modules`, so the two are the same thing by construction.

- **`.github/workflows/mobile-ios-lock.yml` deleted** — its only purpose was regenerating and committing `Podfile.lock`, and its `paths:` filter (`apps/mobile/ios/**`) can never match again.
- **Prebuild steps** added to `ci.yml` (`mobile-device-gate`), `e2e.yml` (both mobile lanes), `candidate.yml` (`mobile-canary-android`, `mobile-ios-smoke`), `mobile-alarm-test.yml`, and `lane-release-mobile.yml`, whose `working-directory: apps/mobile/android` named a directory that no longer exists.
- **`android-gradle-v2-*` → `v3-*`** across every save and restore site: the widest `restore-keys` prefix carries no fingerprint, so a pre-CNG build directory could otherwise be restored into a generated tree.
- **The release scripts stop stamping native files.** `sync-versions.mjs` loses `patchAndroidVersions` / `patchIosPbxproj` / `patchInfoPlist` and `publish.mjs` stops `git add`-ing four generated paths. `app.config.ts` already derives `version`, `ios.buildNumber` and `android.versionCode` from the workspace package.json at every prebuild, so stamping the workspace package **is** the native stamp.

### Also carried

The replica seat fixes this session started from, kept together because the simulator verification above depends on them: the gateway seats replicas (`seatReplica: true`), the seat loop tracks its gateway base across reconnects, `ReplicaProvider` passes the opened seat through `setBuilt`, and `expo-seat-driver` encodes the file URI. Tunnel traces drop from `console.error` to `console.log`.

## Verification

| Check | Result |
| --- | --- |
| `packages/server` test, uninterrupted, after every lane | 389 files, 3518 passed, 3 expected-fail, 7 skipped; **1 failed**: `peer-link-tickets.test.ts` 1 ms-TTL flake, file untouched, 1-in-4 in isolation (QUALITY) |
| `packages/server` typecheck · `bun run lint` · `bun run format` | clean |
| `packages/vault` test + typecheck | 210 files, 1754 passed, 1 skipped; clean |
| `packages/model-runtime` test + typecheck + live goldens | 21 files, 213 passed; clean; goldens 2/2 with `embeddingDim: 512` |
| `apps/mobile` typecheck · lint · test | clean; 2354 passed; two pre-existing reds reproduced with the changes stashed |
| `declared-writes.conformance.test.ts` | red on this branch, green on pristine `origin/main` — **ours**, fixed; 3/3 consecutive green |
| `bundle-lane-conformance.test.ts` | `node:child_process` accepted in `system`, refused in `model-runtime` and at the floor |
| Fresh gateway, real photograph, weights present, `provision: "fetch"` | `scheduler reconcile — added=3`; `enrich_request` rows 0; one face region at 0.913, one 512-d embedding; `Face recognition ok=1`, `Photo OCR ok=1` |
| Fresh gateway, empty runtime dir | boot never blocked; both fires skipped as preparing; 277 MB fetched and digest-verified; readiness flipped per automation |
| Simulator paired by ticket to a fresh `centraid-gateway serve`; camera-roll Import (JPEG + HEIC) | rungs at ingest on every asset, `not ready 0`; faces 0.913 + 0.912 proposed, 512-d; seat `applied_commit_seq` = gateway watermark; viewer full-screen, writable |
| iOS, from a tree with no `ios/` | prebuild → sqlite-vec → `pod install` → build → install → app boots on a replicated vault |

## Decisions

- **System is a tier, not a flag.** Flipping `enabled` on six manifests turned on recipes that could not run; the fix was to give bundled automations the properties bundled apps already have, not to widen the third-party sandbox.
- **Image embeddings are parked.** `embed-image` stays bundled-optional; the CLIP pin is the wrong model for offline query embedding either way (see Open).
- **ArcFace over `buffalo_l`, on licence.** The owner kept the Apache-2.0 checkpoint after the non-commercial grant on InsightFace's weights was raised.
- **Fetching is the host's decision.** `verify-only` by default; a forgotten option degrades visibly in Diagnostics instead of spending bandwidth.
- **`doc-text-extractor` is system** now that consent is for egress: it is the documents pipeline, and its every run being a delegate turn is a cost the ledger already shows.
- **`doc-text-extractor` is not a recognition default.** It ships disabled with the others' defaults flipped, because it has no bundled engine: every run is a delegate turn with a billing consequence. "Bundled recognizer" and "delegate recipe" are different classes, and only the first is default-on.
- **The provider-egress disclosure outlives the consent sheet that carried it.** Deleting the panels would have deleted the one place Photos says a downscaled copy of every photograph would leave the device. The copy and its tests stay even though no Photos surface offers a provider choice today.
- **The priority ask stays, as an action rather than an answer.** It writes exactly one manual `enrich.request` tagged `faces`, and its copy says "sooner", never "whether". An empty state with no action would have been honest but useless on a large library.
- **The pre-rename tier spellings go.** v0 carries no compat branch for `local` / `model`; a raw `enrich.policy` row with those values is a bug to fix at the writer, not a shape to accept at every reader.
- **CNG over a hardened bare workflow.** The bare option was real — commit the native trees deliberately, regenerate them in the same PR as any native dependency change, and pin CocoaPods so the lockfile stops flipping per machine. CNG wins because the share extension, entitlements, and privacy manifest were already expressed in config, leaving one Kotlin module as the whole migration.
- **The native-state gate is re-aimed, not relaxed.** The invariant it protected still exists; only its subject moved. Four layers in, four layers out, with the pod-lock comparisons deleted because they became tautological rather than inconvenient.

## Open

- **Face threshold not re-tuned.** `FACE_PARTY_MAX_DISTANCE` 0.3 / `FACE_CLUSTER_MAX_DISTANCE` 0.22 were tuned for SFace and kept: conservative for 512-d ArcFace (false splits, not merges). The photos sample set is synthetic renders that ArcFace collapses; tuning needs a small labelled set of real photographs.
- **`doc-text-extractor` has no model-version invalidation** — it ships no bundled model and stamps the provider id; its skip is derivative-presence based.
- **`enrich.regenerate` on `photo-ocr`** un-skips on the next library lap rather than immediately, because that handler has no request pass.
- **The four CLIP lock entries point at `resolve/main/`**, a moving ref; fix when image embeddings are picked up (recommended: SigLIP B/16 on the gateway, phone-side text tower decided separately).
- **`.mjs` → `.ts` sweep** for the ~460 scripts is its own issue (QUALITY).
- **`packages/blueprints/apps/_shared/ConsentGate.tsx` is orphaned on web.** Photos was its only importer; the Docs capture-time OCR moment renders through the mobile `kit/components/ConsentGate.tsx`. It is named in [`blueprint-seats.md`](../docs/blueprint-seats.md) as engine C's web renderer, so it is left in place: keep it as the shared engine's renderer, or delete it and amend that doc.
- **Android status bar, navigation bar and `colorPrimaryDark` colours are not reproduced.** `@expo/config-plugins`' `withSystemBars` warns that `androidStatusBar` / `androidNavigationBar` are deprecated and have no effect under SDK 57, and writes transparent bars unconditionally. The committed values were already dead config; this is a behaviour change on API < 35.
- **`AppDelegate.swift` loses a hand-edit.** The committed file used `public import Expo` and `@UIApplicationMain public class`; the generated one emits `internal import Expo` and `@main class`, which is self-consistent under the Swift 6.3 explicit-import rule the old comment cited. It compiles, but it was judged obsolete rather than proven equivalent.
- **`ci:native-state` fingerprints will move on the next Expo SDK bump.** That is the ratchet working; the bump is a `--write` and a review of what changed, not a surprise.
