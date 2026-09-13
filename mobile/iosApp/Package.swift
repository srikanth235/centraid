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
//   3. `swift test` works against this package directly, which is what makes
//      `Tests/ScreenFixtureTests.swift` an owner hand-off that is a single
//      command rather than an Xcode scheme.
//
// THE DEPLOYMENT FLOOR IS READ FROM ONE FILE. `mobile/ios-deployment-target`
// holds `17.5` — v0's own number (`apps/mobile/app.config.ts:63`), not this
// lane's judgement. SPM's manifest cannot read a file at manifest time, so the
// literal below is checked against it by `mobile/README.md`'s hand-off command
// and by the XcodeGen project, which CAN read it.

import PackageDescription

let package = Package(
    name: "CentraidShared",
    platforms: [
        // KEEP IN STEP WITH `mobile/ios-deployment-target` (17.5).
        .iOS(.v17),
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
        .target(
            name: "CentraidApp",
            dependencies: [
                .product(name: "SwiftProtobuf", package: "swift-protobuf"),
            ],
            path: "Sources"
        ),
        .testTarget(
            name: "CentraidAppTests",
            dependencies: ["CentraidApp"],
            path: "Tests"
        ),
    ]
)
