# `mobile/maestro` — the device flows for the native shells

The flows under `flows/` — Home, search, onboarding and Agenda's three (`agenda-day.yaml`, `agenda-todo.yaml` and `agenda-task-from-search.yaml`, which cover Day, To-do and a task opened from search: [#1128](https://github.com/srikanth235/centraid/issues/1128)) — and the protocol for the backup measurement ([#1080](https://github.com/srikanth235/centraid/issues/1080)), `backup-measurement.md`: the first backup of a 2,000-asset library in one evening, a night's photos confirmed by morning with the app closed on iOS, and a fresh phone's full grid within minutes of the words. It supersedes the iOS background-transfer experiment of [#1020](https://github.com/srikanth235/centraid/issues/1020), whose question — which transport — #1080 ruling 2 answered.

## Hosted visual verification

The pull-request `gate` workflow runs `visual/` on a macOS iOS simulator and an Ubuntu Android emulator. Each job rebuilds this revision's Rust core with llama, runs native unit tests, installs the native app, captures Welcome, and seeds the public demo vault through the real command plane. Each capture must find the intended content or control first; a launch screen or failed vault read cannot count as a passing app screenshot.

Both jobs capture light and dark appearance at default and largest system text: iOS AX5 and Android 200%. Home, Calendar, Reminders (including the natural-language date preview and keyboard tools), Photos, Notes, Docs, People, Money, Backup and the first-use states of Health, Locker and Chat are covered. The demo fixture has no Health records; that screen must show Connect. Locker remains locked, and Chat has no downloaded model, so its capture verifies the actual model setup state. These checks do not establish model inference, unlocked Locker content, physical-device behavior or visual correctness by themselves.

After the base image profiles, a separate interaction types two new reminders and presses Return after each without tapping the field again. Both saved rows must be present, proving that Return keeps the keyboard usable for the next reminder. These writes happen after the base profiles so they share one unchanged fixture.

An additional iOS phase installs the separate HealthSeeder debug app, writes real HealthKit samples, and connects Centraid through Apple's permission sheet using `health-seed.yaml` and `health-connect.yaml`. It then captures Health Summary and the steps chart at all four appearance/text profiles. The seed and permission flow must pass; failed grants remain visible failures. Android Health captures currently cover Connect only. The iOS suite has 70 cases; Android has 61. Reminder details include the Files and Add photo actions at every appearance/text profile.

Download `ios-visual-verification` or `android-visual-verification` from the workflow run. Open `index.html` to see unmodified captures beside each case's status, Maestro log and JUnit results. `manifest.json` records the revision and exact appearance/text profiles. Failed cases preserve a diagnostic screenshot and do not prevent independent cases from running; any failure makes the job fail. The first seeded Home capture is a prerequisite: if it fails, dependent captures stop and the report remains incomplete. Android streams logcat from before app startup so crashes remain inspectable after cancellation. An explicit ADB `device offline` transport failure is retained under `transport-attempt-1` and retried once after reconnecting; assertion failures and app crashes remain failures. Scrolling requires full visibility without forced centering: a control at the end of a scroll view can be fully visible even when it cannot reach the viewport center. Home waits for drawing to settle before its first screenshot. Readiness and scroll timeouts allow a minute on loaded runners, including accessibility layouts with one widget per row; these are infrastructure backstops, not app performance assertions.

Inspect the images for clipping, contrast, spacing and usable controls. A configured job is not evidence of a passing run: use its uploaded results. The separate `ios-verification` artifact holds the compiler logs, generated protobuf and XCTest result bundles.

`cargo xtask gate` itself still does not own a simulator or emulator. Its nightly `device-lanes` step reports `Skipped` unless `CENTRAID_DEVICE_RUNNER` is set on a machine with phones attached. The hosted visual jobs are separate required work in the PR workflow.

## The CLI is pinned

```
MAESTRO_VERSION=2.6.1
```

Driving a local simulator with a different CLI than the one a runner installs is how a flow passes on one machine and fails on the other. `mobile/scripts/visual-install-maestro.sh` also checks the release archive's SHA-256 before installation.

## The selectors

Compose gets `Modifier.testTag`, SwiftUI gets `.accessibilityIdentifier`, and both use **the same string**, which is what lets one flow file drive both platforms. The ids are listed in `flows/selectors.md` beside the screen that renders them. An id no screen renders selects nothing, so a flow may only name ids that table lists; nothing checks that rule mechanically.

## Running it, when there is a device

For the same screenshots as CI, install Maestro 2.6.1, rebuild the core, and run `CENTRAID_VISUAL=1 bash mobile/scripts/verify-ios.sh` on macOS. On Linux with the Android SDK, API 35 Google APIs x86_64 system image and KVM, rebuild with `mobile/scripts/android-core.sh x86_64`, assemble the debug APK, then run `bash mobile/scripts/visual-android.sh`. These scripts use disposable simulators/emulators and the public demo fixture.

```sh
# Android
export ANDROID_HOME=/path/to/sdk
cd mobile && ./gradlew -Pcentraid.android=true :androidApp:installDebug
maestro test maestro/flows

# iOS
cd mobile/iosApp && export CENTRAID_IOS_DEPLOYMENT_TARGET=$(cat ../ios-deployment-target)
xcodegen generate && xcodebuild -scheme Centraid -destination 'generic/platform=iOS' build
maestro test ../maestro/flows
```
