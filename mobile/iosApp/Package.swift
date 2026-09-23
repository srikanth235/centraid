// swift-tools-version:5.9
//
// SPM, NOT COCOAPODS (#1020, D-1020-E1; the JetBrains CocoaPods→SPM guidance).
//
// The shared framework reaches Xcode as an XCFramework through this local
// package rather than through a podspec. Three reasons, in the order they
// matter here:
//
//   1. The XCFramework is a RELEASE ARTIFACT that `lane-prebuilt-core.yml`
//      publishes (lane G), and `binaryTarget(url:checksum:)` is how a checksum
//      travels with it. A podspec's `vendored_frameworks` carries no checksum,
//      so a stale or swapped artifact would link silently — which is the whole
//      failure shape `ArtifactIdentity` exists to refuse.
//   2. CocoaPods needs a Ruby toolchain on every machine that opens the
//      project, and `.xcode-version` is already the one toolchain nix cannot
//      pin. A second unpinnable toolchain is a second way for two developers to
//      build different things.
//   3. `swift test` worked against this package directly, which was what made
//      `Tests/ScreenFixtureTests.swift` an owner hand-off that was a single
//      command rather than an Xcode scheme. **THAT REASON HAS LAPSED** — see
//      the note below. Reasons 1 and 2 stand on their own and are why this
//      file is still SPM.
//
// THE HOST BUILD IS DEAD, AND EVERYTHING BELOW ABOUT IT IS VESTIGIAL.
//
// `swift test` builds `Sources/` for macOS, and `Sources/` imports **UIKit**.
// That is not a framework macOS has, and unlike `CentraidShared` it cannot be
// guarded into existence by `#if canImport` without a macOS-shaped stub behind
// every use. `ShellModel.swift` took the first unguarded `import UIKit` in
// `a4dd49d0d` and `ContentImage.swift` the second in `b3832bb6e` — both #1020
// waves — and the host build has failed at clang dependency scanning ever
// since. The three files under `Tests/` were therefore not merely unrun but
// uncompiled, by either build system, until `project.yml` was given
// `GENERATE_INFOPLIST_FILE` and a matching `PRODUCT_MODULE_NAME`.
//
// The tests now run as a SIMULATOR bundle (`mobile/README.md` step 4), which is
// the better home for them anyway: `FontRegistrationTests` asserts `UIAppFonts`
// and `UIFont(name:)`, and neither exists without a real app bundle.
//
// **An owner ruling is wanted on what to do with the wreckage.** Either restore
// the host build — guard every UIKit use and keep a second, cheaper route that
// needs no simulator — or delete the `macOS` platform line, the
// `CentraidAppTests` target and the commented-out `binaryTarget` below, and let
// this manifest be only what reasons 1 and 2 need. Leaving it exactly as-is is
// the one option that keeps arguing for a command that cannot run.
//
// THE DEPLOYMENT FLOOR IS READ FROM ONE FILE. `mobile/ios-deployment-target`
// holds `17.5`, the shipped floor. SPM's manifest cannot read a file at manifest time, so the
// literal below is checked against it by `mobile/README.md`'s hand-off command
// and by the XcodeGen project, which CAN read it.

import PackageDescription

let package = Package(
    name: "CentraidShared",
    platforms: [
        // KEEP IN STEP WITH `mobile/ios-deployment-target` (17.5).
        .iOS(.v17),
        // THE HOST FLOOR WAS WHAT MADE `swift test` THE HAND-OFF COMMAND —
        // and it is no longer sufficient; see the header's note on UIKit.
        //
        // `swift test` builds for the HOST, and a package that names only iOS
        // gets SPM's default macOS floor (10.13) — under which every SwiftUI
        // symbol in `Sources/` is unavailable and the fixture test cannot even
        // link. Reason 3 in the header ("`swift test` works against this
        // package directly") is only true with a macOS floor stated here.
        // This is a floor for compiling the package on a developer's Mac; the
        // shipped product's floor is `ios-deployment-target`, above.
        .macOS(.v14),
    ],
    products: [
        .library(name: "CentraidApp", targets: ["CentraidApp"]),
    ],
    dependencies: [
        // The generated screen types. `buf.gen.yaml` names this plugin as lane
        // E's, and the schema is `crates/api-proto/proto` — the same tree Wire
        // reads on the Kotlin side.
        .package(url: "https://github.com/apple/swift-protobuf.git", from: "1.28.2"),
    ],
    targets: [
        // THE XCFRAMEWORK, when there is one.
        //
        // A `binaryTarget(path:)` against a local build for a developer, and
        // `binaryTarget(url:checksum:)` against the published artifact for a
        // release — `mobile/README.md` names both and which to use when. It is
        // commented out rather than pointed at a path that does not exist,
        // because a manifest that fails to resolve makes `swift test`
        // impossible and the fixture test is the one thing here that can run on
        // a bare macOS.
        //
        // .binaryTarget(
        //     name: "CentraidShared",
        //     path: "../shared/build/XCFrameworks/debug/CentraidShared.xcframework"
        // ),
        // `Design/` IS PART OF THE TARGET, NOT A SIBLING FOLDER.
        //
        // The emitted token and catalogue tables live there because they are
        // generated artifacts and the generator writes them somewhere a reader
        // can find; the code in `Sources/` cannot compile without them. Naming
        // only `Sources` here left `swift test` unable to see `CentraidTokens`
        // at all while the XcodeGen project, which lists both, built fine —
        // which is two different definitions of the target.
        .target(
            name: "CentraidApp",
            dependencies: [
                .product(name: "SwiftProtobuf", package: "swift-protobuf"),
            ],
            path: ".",
            sources: ["Sources", "Design"]
        ),
        .testTarget(
            name: "CentraidAppTests",
            dependencies: ["CentraidApp"],
            path: "Tests"
        ),
    ]
)
