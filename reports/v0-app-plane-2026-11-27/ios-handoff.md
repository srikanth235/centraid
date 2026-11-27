# iOS owner handoff

The XcodeGen app target and scheme are both **`Centraid`**. Unit tests are in **`CentraidTests`** and UI/accessibility tests are in **`CentraidUITests`**. The project is generated from `mobile/iosApp/project.yml`; it is not checked in. The deployment floor is iOS 17.5, and the repository pins Xcode 26.3 in `.xcode-version`.

## Mac simulator verification

Run from a clean checkout on a Mac with the pinned Xcode and an iPhone 17 Pro simulator runtime installed:

```bash
bash mobile/scripts/select-xcode.sh
brew install xcodegen protobuf swift-protobuf

IPHONEOS_DEPLOYMENT_TARGET="$(cat mobile/ios-deployment-target)" \
  mobile/scripts/ios-core.sh aarch64-apple-ios-sim

bash mobile/scripts/verify-ios.sh
```

`verify-ios.sh` generates the project and SwiftProtobuf bindings, runs the complete `CentraidTests` unit-test bundle, installs and seeds a demo vault, runs `CentraidUITests`, and runs the Reduce Motion accessibility test. Logs and `.xcresult` bundles are written under `target/ios-verification`. It creates and deletes a throwaway simulator by default. To keep an existing named simulator available for manual review, run:

```bash
CENTRAID_IOS_SIMULATOR='iPhone 17 Pro' bash mobile/scripts/verify-ios.sh
```

For a focused RoomStore run after generation, from `mobile/iosApp`:

```bash
xcodebuild -project Centraid.xcodeproj -scheme Centraid \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath "$PWD/../../target/ios-roomstore-derived" \
  -only-testing:CentraidTests/RoomStoreTests test
```

This covers the fake-core effect-result cases, stale secure-epoch behavior, appearance deletion, and the Calendar, Reminders, Contacts, Files, Health, and Camera Roll snapshot fixtures in `Tests/RoomStoreTests.swift`.

## Header-accent screenshots

After running the full verification with `CENTRAID_IOS_SIMULATOR='iPhone 17 Pro'`, launch the seeded app, select People and Money, and capture each app’s header key in light and dark appearance. The header accent must follow the room’s Rust-provided `hue_key`; the shell’s default teal should not appear on those app rooms.

```bash
xcrun simctl ui booted appearance light
xcrun simctl launch --terminate-running-process booted dev.centraid.Centraid
# Navigate to People in Simulator, then:
mkdir -p target/ios-verification/screenshots
xcrun simctl io booted screenshot target/ios-verification/screenshots/people-light.png

xcrun simctl ui booted appearance dark
# Navigate to Money in Simulator, then:
xcrun simctl io booted screenshot target/ios-verification/screenshots/money-dark.png
```

Repeat the captures for People dark and Money light. Keep the screenshots and both `.xcresult` bundles with the Mac verification artifacts for review.

## Remaining canvas and extension captures

These captures have not run. With the seeded simulator still open, navigate to each state below and capture both appearances. Use an existing note and photo from the demo vault; do not substitute a static mockup.

- Calendar: select a month or week grid with visible events (`calendar_grid`).
- Notes: open a note in the actual editor (`note_editor`).
- Photos: open the library grid with visible photos (`photo_grid`).
- Share extension: open another app's system share sheet, choose Centraid, and capture its destination/preview before confirming (`share_extension`). Also confirm one import and inspect the resulting item and its arrival label in Centraid.

For each state, replace the screenshot name in this command:

```bash
xcrun simctl ui booted appearance light
xcrun simctl io booted screenshot target/ios-verification/screenshots/calendar_grid-light.png
xcrun simctl ui booted appearance dark
xcrun simctl io booted screenshot target/ios-verification/screenshots/calendar_grid-dark.png
```

Simulator images do not replace the physical-device checks for owner authentication, followed stores, clipboard expiry, photo picking/deletion, and background Locker relock.

## GitHub runner verification

The PR's macOS job now builds both simulator and device Rust targets, runs the simulator unit/UI tests, requires the five light/dark screenshot attachments, exports PNGs from the result bundle, and builds the generic iPhone app with code signing disabled. An unsigned build verifies compilation; it does not install on or exercise an iPhone. The share extension still needs a real host-app/share-sheet flow and is not covered by these screenshot assertions.

On [hosted iOS run 46028285993](https://github.com/srikanth235/centraid/actions/runs/46028285993), the simulator and device Rust Core builds passed, but Swift 6 compilation failed in `Core.startPump` on four implicit property captures (`effectSink`/`changeSink` at lines 219, 221, 231, and 232). XCTest did not run, the screenshot assertions were not reached, and the unsigned generic iPhone build was skipped. A local-stream-constant fix is now in the source and still needs a successful hosted rerun. The prior hosted run 46024313714's `String: Error` picker/scanner bridge issue was fixed with a local Swift error type; that run also does not establish a green end-to-end iOS result. Full attempt details are in [validation/ios-runner-attempts.txt](validation/ios-runner-attempts.txt).

## Linux checks already completed

Swift 6.4.3 syntax-only parsing passed for 14 changed Swift files after the `Room.hue_key` binding landed. A final source review then added the `RoomHeaderKeyView` environment read, an explicit `UniformTypeIdentifiers` import, and a generic core-error sentence mapping; those small edits were not parsed again. Linux parsing did not typecheck against the iOS SDK or run XCTest. The Swift toolchain archive was verified with Swift’s published signing key before use; receipts are [signature verification](validation/swift-signature.txt) and [syntax parsing](validation/swift-syntax.txt).
