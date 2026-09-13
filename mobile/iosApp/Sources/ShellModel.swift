import Combine
import Foundation
import SwiftUI
import UIKit

// THE FRAMEWORK IS OPTIONAL AT COMPILE TIME, AND `Package.swift` SAYS WHY.
//
// Its `binaryTarget` is commented out on purpose: `swift test` has to run on a
// bare macOS with no Kotlin toolchain, and that is what makes
// `Tests/ScreenFixtureTests.swift` a one-command hand-off rather than an Xcode
// scheme. An unconditional `import CentraidShared` here breaks that promise for
// the WHOLE `Sources` target — wave A did exactly that and turned the hand-off
// command red — so the import and everything that touches Kotlin types is
// guarded. Xcode builds always have the framework; only the SPM host build does
// not, and on that build Home renders whatever `homeState` holds, which the
// fixture test sets by hand.
#if canImport(CentraidShared)
import CentraidShared
#endif

/// What holds the shared module's screen hosts on iOS (#1020, D-1020-E1).
///
/// It is deliberately thin. The screen state machines, the navigation model and
/// the sync scheduler are all in `CentraidShared`; this class exists because
/// SwiftUI needs an `ObservableObject` and Kotlin's `StateFlow` is not one.
///
/// **`call` never runs here.** Every read goes through `CentraidCore`, which
/// asserts it is not on the main thread in both actuals — and this class is a
/// `@MainActor` type, so the assertion is the thing standing between a
/// well-meaning `.task { }` and a frozen app (census §E seam 10).
@MainActor
final class ShellModel: ObservableObject {
    enum Route: Hashable {
        case tally
        case photos
        case note(String)
    }

    @Published var path: [Route] = []
    @Published var masked = false
    /// Whether the gateway sheet is up.
    @Published var gatewaySheetOpen = false
    /// The last thing pairing or a sync said, in a member's words.
    ///
    /// A SENTENCE THE CORE ALREADY DECIDED WAS SHOWABLE. Nothing here composes
    /// one out of an error: `Error.detail` is logs-only, and a shell that made
    /// its own sentence from a peer's words would be the hole in that rule.
    @Published var gatewayStatus = ""

    /// The last finished state for each screen, as encoded bytes.
    ///
    /// BYTES AND NOT A DECODED MESSAGE, until the view needs one: the shared
    /// module hands over a `ScreenState` whose `state` field is opaque, and a
    /// view decodes only its own. That is what lets one stream carry three
    /// screens without this class knowing about any of them.
    /// Home's own bytes. It is the ROOT screen, so it is the one that is
    /// always live: every other state here belongs to a pushed route.
    @Published var homeState = Data()
    @Published var tallyState = Data()
    @Published var photosState = Data()
    @Published var notesState = Data()

    #if canImport(CentraidShared)
    /// Home's bridge into `CentraidShared`. Created once, observed once.
    ///
    /// Home is the only screen wired this way so far: wave A built it, so wave A
    /// connected it. The other three still go through `unwired()` below, and
    /// `mobile/README.md` carries that hand-off.
    private let home = HomeBridge()

    init() {
        home.observe { [weak self] bytes in
            self?.homeState = bytes.data
        }
        // THE VAULT IS AN ARTIFACT THAT WAS PUT HERE, never founded on the
        // phone. `mobile/scripts/demo-vault.sh` copies a seeded one into this
        // container; with no file there the core does not open, Home draws its
        // loading grid and nothing lands — which is honest, and better than an
        // app that refuses to start because a fixture is missing.
        home.open(vaultPaths: Self.vaultPaths)
    }

    /// EVERY `.db` IN `Documents`, sorted by name.
    ///
    /// Documents and not Caches: a vault is the member's data, and the one
    /// directory iOS promises not to evict under pressure is this one.
    ///
    /// The DIRECTORY is the roster — there is no manifest beside it, because a
    /// manifest would be a second place a vault's name and existence live, and
    /// the two would disagree the moment one was renamed from another device.
    /// What each file is CALLED is read out of the file itself; see
    /// `VaultRoster`. Sorted so the same device opens the same vault twice
    /// running, rather than whichever one the filesystem happened to enumerate
    /// first.
    ///
    /// `-wal` and `-shm` are excluded by the extension filter: they are SQLite's
    /// sidecars, not vaults, and opening one as a vault fails at the door.
    static var vaultPaths: [String] {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let found = (try? FileManager.default.contentsOfDirectory(
            at: documents,
            includingPropertiesForKeys: nil
        )) ?? []
        return found
            .filter { $0.pathExtension == "db" }
            .map(\.path)
            .sorted()
    }
    #endif

    /// Redeem a pairing ticket (#1020, D-1020-B7).
    ///
    /// The ticket goes over UNCHANGED — the core mints the redemption from it.
    /// A shell that pulled the secret and the ticket id out and sent those
    /// would be a second place they live, and the device's public key is the
    /// endpoint's to state, not this class's.
    func pair(ticket: String, done: @escaping () -> Void) {
        #if canImport(CentraidShared)
        home.pair(
            ticket: ticket.trimmingCharacters(in: .whitespacesAndNewlines),
            deviceName: UIDevice.current.name,
            platform: "ios"
        ) { [weak self] outcome in
            // KOTLIN'S NESTED CLASSES FLATTEN IN OBJECTIVE-C. A sealed
            // interface's members export as `PairOutcomePaired` and
            // `PairOutcomeRefused`, not as nested types — so `PairOutcome.Paired`
            // does not exist on this side and the compiler says so.
            switch outcome {
            case let paired as PairOutcomePaired:
                self?.gatewayStatus = "Paired with \(paired.vaultName)."
            case let refused as PairOutcomeRefused:
                self?.gatewayStatus = refused.sentence
            default:
                self?.gatewayStatus = "There is no vault open on this device yet."
            }
            done()
        }
        #else
        gatewayStatus = "This build has no core."
        done()
        #endif
    }

    /// Run one sync pass and report what moved.
    func syncNow(done: @escaping () -> Void) {
        #if canImport(CentraidShared)
        home.syncNow { [weak self] outcome in
            // AN UNREACHABLE GATEWAY IS A STATE, NOT A FAILURE. A phone in a
            // lift is not a broken phone, and the sentence the core supplies
            // says so without a red banner.
            if outcome.unreachable {
                self?.gatewayStatus = outcome.sentence.isEmpty
                    ? "Centraid could not reach your gateway."
                    : outcome.sentence
            } else {
                self?.gatewayStatus =
                    "Synced: \(outcome.rowsApplied) changes, \(outcome.blobsCompleted) files."
            }
            done()
        }
        #else
        gatewayStatus = "This build has no core."
        done()
        #endif
    }

    /// Forward an event. The shared module reduces; nothing here decides.
    func send(screen: String, event: Data) {
        #if canImport(CentraidShared)
        if screen == "home" {
            home.send(event: event.kotlin)
            return
        }
        #endif
        // Wired to `CentraidShared`'s `ScreenHost` on a machine with an Xcode;
        // `mobile/README.md` names this as the first thing the iOS hand-off
        // connects, and it is a `fatalError` rather than a silent no-op so a
        // half-wired build fails on the first tap instead of looking inert.
        fatalError(
            "ShellModel.send is not wired to CentraidShared yet: see " +
            "mobile/README.md -> \"The iOS hand-off\". A no-op here would be a " +
            "screen that renders and never responds."
        )
    }
}


// THE ONE PLACE KOTLIN'S `ByteArray` MEETS SWIFT'S `Data` (#1020, wave A).
//
// Kotlin/Native exports `ByteArray` as `KotlinByteArray`, which is neither
// `Data` nor bridgeable to it. Converting HERE, at the boundary, keeps the
// shared module's signatures in Kotlin's own vocabulary — a `commonMain` that
// spoke `NSData` to please one shell would be a `commonMain` with a platform in
// it, which Konsist forbids and for good reason.
//
// A screen state is a few kilobytes at most, so the per-byte loop is not worth
// replacing with an unsafe-pointer copy until a measurement says so.
#if canImport(CentraidShared)
extension KotlinByteArray {
    var data: Data {
        var bytes = Data(count: Int(size))
        for index in 0..<size {
            bytes[Int(index)] = UInt8(bitPattern: get(index: index))
        }
        return bytes
    }
}

extension Data {
    var kotlin: KotlinByteArray {
        let array = KotlinByteArray(size: Int32(count))
        for (index, byte) in enumerated() {
            array.set(index: Int32(index), value: Int8(bitPattern: byte))
        }
        return array
    }
}
#endif
