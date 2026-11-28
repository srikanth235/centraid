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

## Captured screens and outstanding extension check

The earlier source-`096e04cb` run produced ten light/dark screenshot PNGs. It showed the Calendar hourly grid, blank Notes editor, placeholder Photos tiles, and a positive Money amount in red. These are historical observations; the matching Core/native Photos implementation and later Money correction are in `be6c4d0`.

The `be6c4d0` run produced ten required light/dark captures and two XXXL repair originals, all verified and visually reviewed in the [snapshot folders](snapshots/ios/) with [provenance](snapshots/ios/provenance.json). Review found purple People and indigo Money headers, positive Money income green and expenses black, the day/hour Calendar grid with overdue reminders, blank Notes editor with keyboard, and Photos placeholders. At XXXL, Calendar segments reflow without the earlier overlap and Reminders Due stacks above its date picker; Reminders Title still has clipped-text findings. These are simulator captures and do not establish physical-device behavior or completion of OS effects.

The share-extension host-app flow remains unverified: no screenshot of another app's share sheet, confirmed import, or resulting arrival label was captured. Simulator images also do not replace physical-device checks for owner authentication, followed stores, clipboard expiry, photo picking/deletion, and background Locker relock.

## GitHub runner verification

The PR's macOS job now builds both simulator and device Rust targets, runs the simulator unit/UI tests, requires the five light/dark screenshot attachments, exports PNGs from the result bundle, and builds the generic iPhone app with code signing disabled. An unsigned build verifies compilation; it does not install on or exercise an iPhone. The share extension still needs a real host-app/share-sheet flow and is not covered by these screenshot assertions.

Run [46084049333](https://github.com/srikanth235/centraid/actions/runs/46084049333), source `be6c4d0edd65ad4bc80b0cd916284b74ec023521`, iOS job `140789379909`: both Rust targets, Swift and 175 unit tests passed; normal UI was 8 tests, 1 expected skip, 53 failures; Reduce Motion was 1 test, 26 failures. All three focus-order tests passed. The unsigned generic-device build and artifact uploads passed. The overall job failed due to UI and Motion findings. See [normal UI assertions](validation/ios-audit-be6.txt) and [Motion assertions](validation/ios-motion-be6.txt). No physical device or share-extension flow was exercised.

The previous completed native run [46071464163](https://github.com/srikanth235/centraid/actions/runs/46071464163) verified source `096e04cb2354aef9b4ab42002e240bb1e02306ec`: both Rust targets passed, Swift compiled, 174 unit tests passed, and the unsigned generic iPhone build passed. The UI suite ran 8 tests, 1 expected skip, and 55 failures. The three focus-order tests passed. The accessibility audits reported contrast, Dynamic Type and clipping failures; the largest-text audit could not hit the Backup tab. The separate Reduce Motion pass did not run. This older run is failed, with no all-green claim.

The small [iOS review artifact](https://github.com/srikanth235/centraid/actions/runs/46071464163/artifacts/15236093703) is 14,785,933 bytes; its downloaded SHA-256 is `0f12fbad4ea8ce1e4450e2286f6fc1596ce7828328e2c5e3f9a4ed358fa3a869`. The archive contains test logs and rendered pages; all ten required screenshot PNGs were verified by signature, dimensions and hash. Its two Photos tiles are placeholders, the Calendar screen is an hourly grid, and Notes is a blank new editor. Share-extension host-app flow and physical-device behavior remain unverified. The large result bundle may contain additional evidence, but no digest or local download is claimed here. See [the actual native result](validation/ios-unit.txt) and [attempt history](validation/ios-runner-attempts.txt).

## Linux checks already completed

Swift 6.4.3 syntax-only parsing passed for 14 changed Swift files after the `Room.hue_key` binding landed. A final source review then added the `RoomHeaderKeyView` environment read, an explicit `UniformTypeIdentifiers` import, and a generic core-error sentence mapping; those small edits were not parsed again. Linux parsing did not typecheck against the iOS SDK or run XCTest. The Swift toolchain archive was verified with Swift’s published signing key before use; receipts are [signature verification](validation/swift-signature.txt) and [syntax parsing](validation/swift-syntax.txt).
