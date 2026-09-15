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
    /// Whether the transfer-rules sheet is up (#1025 S4).
    @Published var transferRulesOpen = false
    /// THE MEMBER'S TRANSFER RULE, as the STORE's own word.
    ///
    /// A word and not an enum: an ordinary Kotlin enum exports as an
    /// Objective-C class whose cases a Swift `switch` cannot be exhaustive
    /// over, and an inexhaustive switch over a member's spending rule is the
    /// worst place to lose that guarantee. `HomeBridge` parses the word, in
    /// Kotlin, in one place.
    @Published var transferRule = ""
    /// The three choices, each a plain sentence from the shell's copy source.
    @Published var transferRuleChoices: [(stored: String, sentence: String)] = []
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

    /// The three app screens' bridges (#1025 S5, lane L5).
    ///
    /// One each, held for the life of the shell rather than made per view: a
    /// `ScreenHost` is routed onto the session's change stream when it is
    /// attached and that registration has no removal, so a bridge rebuilt on
    /// every push would leave the routed host drawing into a view that is gone.
    ///
    /// They live in `CentraidShared`'s app packages, not in `shell/`, because a
    /// bridge names its screen's types and `PerAppLayoutSpec` keeps that inside
    /// the app.
    private let tally = TallyBridge()
    private let photos = PhotosBridge()
    private let notes = NotesBridge()

    init() {
        home.observe { [weak self] bytes in
            self?.homeState = bytes.data
        }
        tally.observe { [weak self] bytes in self?.tallyState = bytes.data }
        photos.observe { [weak self] bytes in self?.photosState = bytes.data }
        notes.observe { [weak self] bytes in self?.notesState = bytes.data }
        // THE SESSION OWNS THE ONE CORE (R-1020-24), so the app screens are
        // attached TO it rather than opening one. It is opened asynchronously,
        // so this is a callback and not a getter: there is exactly one moment
        // the session comes into existence and a poll would either miss it or
        // spin.
        home.onSession { [weak self] session in
            guard let self else { return }
            self.tally.attach(session: session)
            self.photos.attach(session: session)
            self.notes.attach(session: session)
        }
        // THE DEVICE MAKES ITS OWN REPLICA (#1025 S5).
        //
        // This used to hand over every `.db` file that had been PLACED in the
        // container by `mobile/scripts/demo-vault.sh`, because there was no way
        // for a phone to get a vault of its own. There is now: open unpaired,
        // pair, and the pairing takes the copy ([D-1025-S1-1]). So what crosses
        // is the DIRECTORY replicas live in, and an empty one is the ordinary
        // first run — Home draws, its reads are refused `Unpaired`, and the
        // member's next move is the gateway sheet.
        home.open(replicaDir: Self.replicaDirectory)
        // THE OS ASKING FOR MEMORY BACK IS THE ONLY THING THAT CLOSES A
        // BACKGROUND VAULT'S CORE (#1025 S7-13, ruling F).
        //
        // Every held vault's core is open, so a switch is a pointer move rather
        // than a SQLite close-and-open. The bound on that is not a count of
        // cores — that would make "is this vault open" depend on how recently
        // some other vault was touched — it is this notification: under
        // pressure, every core but the foreground's closes, and a rested vault
        // reopens on the next tap or the next sync round.
        memoryWarning = NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.home.rest()
        }
    }

    deinit {
        if let memoryWarning {
            NotificationCenter.default.removeObserver(memoryWarning)
        }
    }

    /// The memory-warning observer, held so it can be removed.
    private var memoryWarning: NSObjectProtocol?

    /// WHERE THIS DEVICE'S REPLICAS LIVE.
    ///
    /// Documents and not Caches: a vault is the member's data, and the one
    /// directory iOS promises not to evict under pressure is this one.
    ///
    /// The DIRECTORY is the roster — there is no manifest beside it, because a
    /// manifest would be a second place a vault's name and existence live, and
    /// the two would disagree the moment one was renamed from another device.
    /// What each file is CALLED is read out of the file itself; see
    /// `VaultRoster`, and `Replicas` for what they are NAMED.
    static var replicaDirectory: String {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].path
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
                // A DEVICE THAT JUST PAIRED IS A DEVICE IN THE FOREGROUND
                // (#1025 S2, D-1025-S7-40). The scene never changed — the
                // member has been looking at this sheet the whole time — so
                // nothing else would open the tail until they left and came
                // back.
                self?.foreground()
            // THE TICKET'S NAME IS NOT THE VAULT'S NAME (#1025 S7-9). A
            // ticket carries the gateway CLI's `--vault-name` flag and not
            // the vault's own `display_name`, so between redeeming one and
            // holding a replica that can answer for itself there is nothing
            // truthful to print — which is exactly this case, and why it
            // carries no name to interpolate.
            case is PairOutcomeCopying:
                self?.gatewayStatus = "Paired. Your vault is being copied."
                self?.foreground()
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

    /// FORGET A VAULT — the inverse of [pair] (#1025 S7-9).
    ///
    /// The shelf closes the core, deletes the replica and its byte store,
    /// drops the pairing record and the endpoint key, and rebinds the session
    /// onto whatever came forward; the roster the switcher is drawing arrives
    /// as the ordinary `RosterChanged`, so nothing here removes a row by hand.
    ///
    /// **Forgetting is LOCAL.** The gateway keeps this device enrolled —
    /// "this phone is not holding that vault any more" is not "that vault
    /// should stop trusting this phone", which is a decision for whoever holds
    /// the vault to take there. The confirmation in `VaultSheet` says so.
    func forget(vaultID: String) {
        #if canImport(CentraidShared)
        home.forget(vaultId: vaultID) {}
        // R-SHELL-2: pairing sentences name the FOREGROUND holding, not the
        // last successful pair() call. Forgetting (or switching away from) a
        // vault must not leave "Paired with Fresh Vault." over Tahoe Weekend.
        gatewayStatus = ""
        #else
        gatewayStatus = "This build has no core."
        #endif
    }

    /// Clear member-visible gateway copy that named a vault no longer in front.
    ///
    /// Called when the switcher picks another vault. Sync / pair outcomes that
    /// land afterwards rewrite the line for the vault now open.
    func clearStaleGatewayStatus() {
        gatewayStatus = ""
    }

    /// THE MEMBER ARRIVED: catch up, then hold the log open (#1025 S2,
    /// D-1025-S7-40).
    ///
    /// Called from the scene phase and from nowhere else. **There is no timer
    /// here.** A foreground interval is a deleted concept: the tail stays open
    /// for as long as the app is active, and a page written on the gateway is
    /// on this device within one round trip.
    func foreground() {
        #if canImport(CentraidShared)
        home.foreground { _ in }
        #endif
    }

    /// THE MEMBER LEFT: close the tail.
    ///
    /// Both halves of leaving — the app switcher and a real background — do the
    /// same thing here, because a stream held open by a process the OS is about
    /// to suspend is a socket nobody is reading. What resumes it is the next
    /// `active`, from the durable cursor.
    func leftTheForeground() {
        #if canImport(CentraidShared)
        home.stopTail()
        #endif
    }

    /// Run one sync pass and report what moved.
    func syncNow(done: @escaping () -> Void) {
        #if canImport(CentraidShared)
        // THE WAKE IS NAMED, and a Kotlin default does not cross this
        // boundary — Objective-C export has no default arguments, so the shell
        // states which window it is asking for. This one is the member holding
        // the phone, which is a foreground window: nothing is held back and
        // what bounds it is them closing the app.
        home.syncNow(wake: .foreground) { [weak self] outcome in
            // AN UNREACHABLE GATEWAY IS A STATE, NOT A FAILURE. A phone in a
            // lift is not a broken phone, and the sentence the core supplies
            // says so without a red banner.
            // THE COPY, WHILE IT IS STILL COMING (#1025 S7, item 3). "Paired,
            // no file yet" is a real state and it used to read "Synced: 0
            // changes, 0 files" — the sentence that makes a working device look
            // broken. It is first because it is what is happening: a seat that
            // has no vault yet has nothing else to say.
            if let copying = outcome.copying {
                self?.gatewayStatus = copying
            } else if outcome.unreachable {
                self?.gatewayStatus = outcome.sentence.isEmpty
                    ? "Centraid could not reach your gateway."
                    : outcome.sentence
            } else if let blocked = outcome.blocked {
                // WHY A PASS MOVED NOTHING, when something stopped it (#1025
                // S5). This drew "Synced: 0 changes, 0 files" over a queued
                // write whose attempt count was climbing — the reason existed
                // in the pass's report and had no field to travel in, which is
                // the same way the `query_only` defect hid for three slices.
                // The sentence is the core's; nothing here composes one.
                self?.gatewayStatus = blocked
            } else if let stale = outcome.stale {
                self?.gatewayStatus = stale
            } else {
                // The byte plane's own two, because "0 files" alone is the
                // sentence that made a working byte plane look broken (#1025
                // S5). `budget`/`metered` are the window the core ACTUALLY ran
                // under, echoed back, so which plan a pass took is answerable
                // from the device rather than inferable.
                var line = "Synced: \(outcome.rowsApplied) changes, "
                    + "\(outcome.blobsCompleted) files."
                if outcome.originalsWithheld > 0 {
                    line += " \(outcome.originalsWithheld) waiting for Wi-Fi."
                }
                if let stalled = outcome.bytesStalled { line += " " + stalled }
                line += " [\(outcome.budget)\(outcome.metered ? ", metered" : "")]"
                self?.gatewayStatus = line
            }
            done()
        }
        #else
        gatewayStatus = "This build has no core."
        done()
        #endif
    }

    /// Forward an event. The shared module reduces; nothing here decides.
    ///
    /// The `screen` string is the machine's own `SCREEN_ID` — the same constant
    /// its `ReadPage` effects carry — so the routing here and the routing in
    /// `ScreenRuntime` are keyed on one name rather than on two spellings of
    /// one idea.
    ///
    /// An unknown screen is DROPPED rather than fatal. The `fatalError` that
    /// stood here was right while three of four screens had no bridge at all —
    /// a half-wired build should fail on the first tap instead of looking inert
    /// — and it is wrong now that they are wired: it would turn a typo in a
    /// view's screen name into a crash on a member's phone, in a build where
    /// every screen that exists is connected.
    func send(screen: String, event: Data) {
        #if canImport(CentraidShared)
        switch screen {
        case "home": home.send(event: event.kotlin)
        case "tally.list": tally.send(event: event.kotlin)
        case "photos.grid": photos.send(event: event.kotlin)
        case "notes.editor": notes.send(event: event.kotlin)
        default: break
        }
        #endif
    }

    /// Open the transfer-rules sheet, reading the current rule as it opens.
    ///
    /// READ ON OPEN and not cached at launch: the store is the authority and a
    /// value held since launch is a value a second device — or this device's
    /// own restore — may have moved underneath.
    func openTransferRules() {
        #if canImport(CentraidShared)
        transferRuleChoices = home.transferRuleChoices().map {
            (stored: $0.stored, sentence: $0.sentence)
        }
        home.transferRule { [weak self] stored in
            self?.transferRule = stored
        }
        #endif
        // ONE SHEET AT A TIME. The gateway sheet is one of the two doors into
        // this one, and iOS will not present a second sheet over a sheet that
        // is still up — it drops the request silently, which reads as a button
        // that does nothing.
        gatewaySheetOpen = false
        transferRulesOpen = true
    }

    /// The member picked one.
    ///
    /// The published value is set from what came BACK, so the sheet draws what
    /// the store holds rather than what was tapped — an unknown word is the
    /// conservative default, and a selection the next launch would not have is
    /// worse than a tap that appears to do nothing.
    func setTransferRule(_ stored: String) {
        #if canImport(CentraidShared)
        home.setTransferRule(stored: stored) { [weak self] settled in
            self?.transferRule = settled
        }
        #endif
    }

    /// Run one camera-roll pass now (#1025 S6).
    ///
    /// Not a screen event, because it is not a reduction: the pass is a shell
    /// effect with I/O in it, and the states it publishes come BACK as
    /// `BackupChanged` events through the bridge's own runner. A view that sent
    /// an event here would be asking the reducer to do a file read.
    func backUpCameraRoll() {
        #if canImport(CentraidShared)
        photos.backUpNow()
        #endif
    }

    /// Tell a screen it is on screen (#1025 S5, lane L5).
    ///
    /// **A SCREEN READS BECAUSE IT WAS OPENED, not because it was built.** The
    /// `Opened` event is what makes the machine emit its first `ReadPage`, and
    /// until this existed nothing on either shell sent one to the app screens —
    /// so a screen that was pushed sat on its seeded `LOADING` state with no
    /// read ever issued, which is indistinguishable from a vault that has not
    /// synced.
    ///
    /// Notes carries its note's id because the editor's read is parameterised
    /// by it: `NotesReads` binds it into the predicate, and an editor that
    /// opened without one reads nothing rather than reading whichever note
    /// sorted first.
    func opened(_ route: Route) {
        #if canImport(CentraidShared)
        switch route {
        case .tally:
            var event = Centraid_Screen_V1_TallyListEvent()
            event.opened = .init()
            send(screen: "tally.list", event: (try? event.serializedData()) ?? Data())
        case .photos:
            // Re-read the OS grant, then open (R-PHOTOS-1). Sending `Opened`
            // alone left a post-attach grant as NOT_ASKED on first paint.
            photos.opened()
        case let .note(identifier):
            var event = Centraid_Screen_V1_NotesEditorEvent()
            event.opened = .with { $0.noteID = identifier }
            send(screen: "notes.editor", event: (try? event.serializedData()) ?? Data())
        }
        #endif
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
