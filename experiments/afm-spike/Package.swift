// swift-tools-version: 6.0
//
// The Apple Foundation Models spike. A standalone executable, deliberately
// outside `mobile/`: it links `FoundationModels`, which needs macOS 26 and
// Apple silicon, and the mobile package's floor is iOS 17.5 / macOS 14.
//
// No dependencies. Everything the harness needs — the corpus, the lexicon,
// the scorer — is already in this repository and is reached by PATH at run
// time (`--map`), never vendored, so the spike cannot drift from the grammar
// `crates/candidates`'s `run-model` scores against.

import PackageDescription

let package = Package(
    name: "afm-spike",
    platforms: [
        // FoundationModels ships in the macOS 26 SDK. A lower floor here does
        // not "support older Macs" — it fails to compile the import.
        .macOS("26.0")
    ],
    targets: [
        .executableTarget(
            name: "afm-spike",
            path: "Sources/afm-spike",
            swiftSettings: [
                .swiftLanguageMode(.v6)
            ]
        )
    ]
)
