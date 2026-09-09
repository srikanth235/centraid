# Issue #1011 — recognition on by default, and generated mobile native projects

One receipt, one commit. Two rulings the owner made on 2026-09-09, each recorded in [`docs/decisions.md`](../docs/decisions.md) as current state with supersession pointers over what they replace.

## Checklist

- [x] **Recognition defaults** — the six bundled recipes ship `enabled: true`; `faces` triggers on `media.asset` with an ambient cursor pass behind its priority queue; `doc-text-extractor` stays disabled
- [x] **The Photos consent surface** — replaced by an honest empty state plus one priority action; the provider-egress disclosure kept; the unmounted mobile consent screen deleted
- [x] **Continuous Native Generation** — `apps/mobile/{ios,android}` become gitignored prebuild outputs; every divergence expressed in `app.config.ts`, four plugins, and one local Expo module
- [x] **The native-state gate** — four fail-closed layers re-aimed from the committed tree at the config inputs
- [x] **CI** — `mobile-ios-lock.yml` deleted; five lanes gain a prebuild step; the gradle cache re-keyed
- [x] **Docs** — decisions, recognition automations, derived ledger, dogfood, dev environment, mobile offline, release, and the native-state trap

## What changed

### Recognition is on by default, `faces` included

Every bundled recognition recipe shipped `"enabled": false`, and install honours the manifest for a fresh vault (`enabled: current?.enabled ?? desired.enabled` in [`build-gateway.ts`](../packages/server/src/serve/build-gateway.ts)), so **a fresh gateway ran no recognition at all**. Three places in the tree said otherwise: [`system-recognition.ts`](../packages/server/src/enrich/system-recognition.ts) described "always-on recipes" keeping the photos pipeline flowing with `place-names` as the lone opt-in, `docs/decisions.md` said the schedulers always run, and `resolveEnrichmentPolicy` defaults every capability to enabled on any tier but `off`. They have shipped disabled since [#731](https://github.com/srikanth235/centraid/issues/731); the toggle under Automations → Recognition is what hid it.

- **The six manifests** — `photo-ocr`, `transcript`, `embed-image`, `embed-text`, `faces`, `place-names` now carry `"enabled": true`. `doc-text-extractor` stays `false`: it has no bundled deterministic engine, declares `lane: "gateway"`, and every run is a billed model turn — it is a delegate recipe, not a bundled recognizer. Owner state is preserved on upgrade, so this changes fresh installs.
- **`faces` fires on ingest** — the trigger moves from `enrich.request` to `media.asset`, matching `photo-ocr` and `embed-image`. [`automation-handlers/faces.js`](../packages/model-runtime/automation-handlers/faces.js) now runs three passes over one `BATCH = 16` budget, in order: the open `enrich_request(capability='faces')` queue, the prior-derivation-stamp sweep, then a new ambient pass over `media_asset` behind its own cursor, skipping what the earlier passes already processed. `seedAmbientCursor` mirrors `embed-image`'s seeding so a library whose newest photograph already carries a stamp at this model does not re-derive it, and a model bump resets both cursors.
- **The queue is the priority lane, not the gate** — a manual ask still drains first, so it changes *when* a library is reached, never *whether*. That is the whole of what the answer buys.

This makes face detection **opt-out**: the recipe's own enabled bit, and the vault's `enrich_policy` tier. It supersedes "faces drains only the consent queue and never scans the ambient library" ([`recognition-automations.md`](../docs/recognition-automations.md), [`derived-ledger.md`](../docs/photos/derived-ledger.md)) and "`place-names` is *the* opt-in recognition recipe" ([#816](https://github.com/srikanth235/centraid/issues/816)); both rows are filed as superseded rather than rewritten.

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
| `bun run lint` | clean (under the ESLint governance from [#1005](https://github.com/srikanth235/centraid/issues/1005)) |
| `bun run format:check` | clean |
| `packages/server` typecheck + `src/enrich src/automation` | 40 files, 613 tests pass |
| `packages/model-runtime` test | 20 files, 204 tests pass |
| `packages/blueprints` typecheck + photos suites | clean; 27 tests pass |
| `apps/mobile` typecheck + `src/apps/photos` | clean; 56 files, 624 tests pass |
| `scripts/release` unit lane | 6 files, 53 tests pass |
| `apps/mobile ci:native-state` | L1–L4 green, and green again with the native dirs moved aside |
| `lint:workflow-pins` / `lint:path-filters` | 23 workflows clean; 10 filters cover every path |
| Fresh gateway, `build-gateway` on this tree | six recognition recipes install `enabled`, `scheduler reconcile — added=6` |
| iOS, from a tree with no `ios/` | prebuild → sqlite-vec → `pod install` → build → install → app boots on a replicated vault |

**Not verified here.** No faces run was observed against a live gateway: the demo corpus is excluded from the provenance feed by design ([#290](https://github.com/srikanth235/centraid/issues/290)), so seeded rows fire no automation, and this host has no model weights installed. The ambient pass is covered by unit tests instead. The workflow edits are unrun — `expo prebuild` on a CI runner, CocoaPods under `LANG=en_US.UTF-8` on `macos-26`, and the first cold `android-gradle-v3-*` restore are all first-run-in-CI.

## Decisions

- **`doc-text-extractor` is not a recognition default.** It ships disabled with the others' defaults flipped, because it has no bundled engine: every run is a delegate turn with a billing consequence. "Bundled recognizer" and "delegate recipe" are different classes, and only the first is default-on.
- **The provider-egress disclosure outlives the consent sheet that carried it.** Deleting the panels would have deleted the one place Photos says a downscaled copy of every photograph would leave the device. The copy and its tests stay even though no Photos surface offers a provider choice today.
- **The priority ask stays, as an action rather than an answer.** It writes exactly one manual `enrich.request` tagged `faces`, and its copy says "sooner", never "whether". An empty state with no action would have been honest but useless on a large library.
- **The pre-rename tier spellings go.** v0 carries no compat branch for `local` / `model`; a raw `enrich.policy` row with those values is a bug to fix at the writer, not a shape to accept at every reader.
- **CNG over a hardened bare workflow.** The bare option was real — commit the native trees deliberately, regenerate them in the same PR as any native dependency change, and pin CocoaPods so the lockfile stops flipping per machine. CNG wins because the share extension, entitlements, and privacy manifest were already expressed in config, leaving one Kotlin module as the whole migration.
- **The native-state gate is re-aimed, not relaxed.** The invariant it protected still exists; only its subject moved. Four layers in, four layers out, with the pod-lock comparisons deleted because they became tautological rather than inconvenient.

## Open

- **`packages/blueprints/apps/_shared/ConsentGate.tsx` is orphaned on web.** Photos was its only importer; the Docs capture-time OCR moment renders through the mobile `kit/components/ConsentGate.tsx`. It is named in [`blueprint-seats.md`](../docs/blueprint-seats.md) as engine C's web renderer, so it is left in place: keep it as the shared engine's renderer, or delete it and amend that doc.
- **Android status bar, navigation bar and `colorPrimaryDark` colours are not reproduced.** `@expo/config-plugins`' `withSystemBars` warns that `androidStatusBar` / `androidNavigationBar` are deprecated and have no effect under SDK 57, and writes transparent bars unconditionally. The committed values were already dead config; this is a behaviour change on API < 35.
- **`AppDelegate.swift` loses a hand-edit.** The committed file used `public import Expo` and `@UIApplicationMain public class`; the generated one emits `internal import Expo` and `@main class`, which is self-consistent under the Swift 6.3 explicit-import rule the old comment cited. It compiles, but it was judged obsolete rather than proven equivalent.
- **`ci:native-state` fingerprints will move on the next Expo SDK bump.** That is the ratchet working; the bump is a `--write` and a review of what changed, not a surprise.
