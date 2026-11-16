# Native verification: #1201 review

## Source and tools

- App source: published HEAD `7d22a64fe2241cc84b59c3a283630f1a96d462dd`. Root verified the iOS and Android application source directories remained at this commit; later workspace changes are docs/build checks.
- iOS build: Xcode 27.1 (repo pin 26.3), iOS 17.5 deployment target, built from `/private/tmp/centraid-1200-ios-build/Build/Products/Debug-iphonesimulator/Centraid.app`; executable SHA-256 `62eff5183cb906d3965d70234b8cf860e315203c4d82b25efa39bff405b8f19f`.
- Android SDK: `/opt/homebrew/share/android-commandlinetools`, JDK 21, NDK `27.0.12077973`; API 35 arm64 core built with `mobile/scripts/android-core.sh arm64-v8a`.
- Pinned Maestro 2.6.1 is task-local at `/private/tmp/centraid-1200-target/tools/maestro-2.6.1/unpacked/maestro/bin/maestro`. Official `cli-2.6.1` release archive SHA-256: `3440825f514f537c6a96bcf5de995780c2a4a7f83a43208fdc95d4f1fecfad3b`. Global Maestro remains 2.0.0.
- All builds and Maestro tests cited below ran through `/private/tmp/centraid-1200-build-guard.py`. At the reviewed docs-batch checkpoint: 35.3 GiB free and 10.9 GiB watched build artifacts; the task-owned Android AVD occupied 802 MiB. The task AVD's 3 GiB data partition has snapshots disabled. Pinned Maestro tests ran with `MAESTRO_CLI_NO_ANALYTICS=true`.

## iOS simulator flows

Disposable simulator: iPhone 17 Pro, iOS 26.5, name `centraid-1201-review`, UDID `85951957-FC74-4E86-959C-70E15F419EFA`. No existing simulator was erased or modified. All final UI runs below used pinned Maestro 2.6.1.

| Flow | Result | Evidence |
| --- | --- | --- |
| Fresh onboarding, empty Docs, return Home, People import entry | 17 completed, 1 conditional `words-shown` subflow skipped, 0 failed | `/private/tmp/centraid-1201-ios-onboarding-pinned/2026-11-17_003742/commands-(onboarding.yaml).json` |
| Home density | 11 UI steps/checks completed (Home control plus grid and nine tile IDs); 0 failed | `/private/tmp/centraid-1201-ios-home-density-pinned/2026-11-17_003953/commands-(home-density.yaml).json`; screenshot `/private/tmp/centraid-1201-home-density-pinned.png` (SHA-256 `c2c0b1bdb66a259af2d0b4a4f79f0c0a38f804f8b10be89410dbcc99b6f410e4`) |
| Direct task detail Trash and Undo | 25 completed, 0 failed. The task is gone on the retained detail route with Undo; Undo returns to that task detail with the same unique title. | `/private/tmp/centraid-1201-ios-task-trash-undo-pinned-final/2026-11-17_005218/commands-(task-detail-trash-undo.yaml).json`; screenshots `.../screenshots/task-detail-gone.png` (SHA-256 `b3e3f88f1834a5386c2ddb274a2b4cefe0ac1e88d7cb3a3ba3dee672e08969d5`) and `.../screenshots/task-detail-restored.png` (SHA-256 `72a4686e9ef25724549225e8fbc064de934e810af5e13ba78dec40f6f65428e3`) |
| Direct person detail Trash and Undo | 20 completed, 0 failed. The person is gone on its retained detail route with Undo; Undo returns to that detail with the same unique name. | `/private/tmp/centraid-1201-ios-person-trash-undo-pinned/2026-11-17_005343/commands-(person-detail-trash-undo.yaml).json`; screenshots `.../screenshots/person-detail-gone.png` (SHA-256 `ddd33b2830b8c4acfce8665d037226fd5ffb04650671b43c1922c64fcd8c41af`) and `.../screenshots/person-detail-restored.png` (SHA-256 `5bf1ec007e421bda5e363e55fa8c5c8c7798a856ffaebaed5e2cea5198680b25`) |

Root reviewed the final iOS and Android task/person JSON and screenshots, plus Android onboarding/Home command JSON and its Home screenshot. The earlier onboarding run failed on the stale root `BackButton` selector; `onboarding.yaml` now taps the actual `docs-band-home` control. Earlier task-flow trials stopped before Trash because one used an unexpanded Maestro environment variable and another looked for a new task on the Reminders smart-list home instead of opening `agenda-smart-all`. Those failed trials are not Trash/Undo evidence; the corrected flow asserts `Added to Inbox`, opens All, then checks the task detail and Undo.

## Android build, unit tests, and emulator flows

- Guarded Android core build succeeded for `aarch64-linux-android`; copied library: [`libcentraid_core_ffi.so`](../../mobile/androidApp/src/main/jniLibs/arm64-v8a/libcentraid_core_ffi.so), 112 MiB, SHA-256 `bc73565cdae43bfe3a26ffb59a7b8c0148e9e4e64dd61e9bb8005fdda8ce994c`.
- Guarded Gradle command `./gradlew -Pcentraid.android=true :androidApp:assembleDebug :androidApp:testDebugUnitTest --console=plain` succeeded. APK: `mobile/androidApp/build/outputs/apk/debug/androidApp-debug.apk`, 140 MiB, SHA-256 `45830d9ae2d3217694af79384a4f30f400db9b9ea49e13a959df7d6ec02b2314`.
- Root parsed the JUnit XML: 35 suites, 154 tests, 0 failures, errors, or skips. These are Gradle/Robolectric tests, separate from Maestro UI flows and CI's iOS XCTest run (121 tests, 0 failures).
- A task-owned Pixel 7 API 35 Google APIs arm64 AVD is booted as `centraid-1201-review`, serial `emulator-5554`, under `/private/tmp/centraid-1201-android-avd/avds/centraid-1201-review.avd`. `sys.boot_completed=1`. The app was installed and exercised on this AVD with pinned Maestro 2.6.1. Each completed-command count below includes Maestro setup commands recorded in the JSON.

| Flow | Result | Evidence |
| --- | --- | --- |
| Fresh onboarding, empty Docs, Home, People import entry | 20/20 commands completed | `/private/tmp/centraid-1201-android-onboarding-final/2026-11-17_013131/commands-(onboarding-android.yaml).json` |
| Home density | 13/13 commands completed, including Home control, grid, and nine tile IDs | `/private/tmp/centraid-1201-android-home-density/2026-11-17_013331/commands-(home-density-android.yaml).json` |
| Direct task detail Trash and Undo | 26/26 commands completed. The removed task stays on detail with Undo; Undo returns to the same unique title. | `/private/tmp/centraid-1201-android-task-trash-undo-rerun/2026-11-17_013758/commands-(task-detail-trash-undo-android.yaml).json`; screenshots `/private/tmp/centraid-1201-android-task-trash-undo-rerun/screenshots/task-detail-gone.png` and `.../task-detail-restored.png` |
| Direct person detail Trash and Undo | 15/15 commands completed. The removed person stays on detail with Undo; Undo restores the same unique name. | `/private/tmp/centraid-1200-target/tools/maestro-2.6.1/home/.maestro/tests/2026-11-17_015652/commands-(person-trash-undo-android-continuation.yaml).json`; screenshots `/private/tmp/centraid-1201-android-person-trash-undo-continuation/person-detail-gone.png` (SHA-256 `372eff28c6420a3860d857c1e564e761ff2efb3f2f1e4f4b722349607abf5870`) and `/private/tmp/centraid-1201-android-person-trash-undo-continuation/person-detail-restored.png` (SHA-256 `af05e3091fbaf8b70ef3e61fa1619dea2c9e9c63743246edc5f01f919020fae7`) |

The first person-flow attempt waited on `home-grid`; the screenshot showed Home, but the container tag was not surfaced to Maestro in that state. The flow was corrected to use the People tile ID already verified by Home density. A later combined create-and-delete attempt created the unique synthetic person and returned to People but lost the Maestro driver during editor close; the separate continuation from the visible person row completed Trash and Undo. These harness attempts are not counted as passes.

## Still unverified

Android/iOS native notification permission prompts, cold-process notification actions/replay, and vault-isolation behavior remain unverified by this lane; build, unit tests, and screen flows do not establish those OS callbacks or system behaviors. No recovery drill is claimed here.
