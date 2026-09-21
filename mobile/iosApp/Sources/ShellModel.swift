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

    /// PAINT THE SWITCHER MASK, and take it down (`docs/mobile-offline.md:253`).
    ///
    /// **`masked` had no writer.** `grep -n 'masked' mobile/iosApp/Sources/` on
    /// the commit before this one finds one line — this declaration — so the
    /// overlay in `CentraidApp` could never appear and a member's rows went
    /// into every app-switcher snapshot iOS took. It was reachable only through
    /// the scene phase, and the scene phase spent both of its cases opening and
    /// closing the gateway tail. With the tail gone this is the only thing left
    /// for it to do, so it is wired rather than left as a flag nothing sets.
    ///
    /// Not this lane's subject and stated here rather than hidden: found while
    /// deleting the tail that was standing in front of it.
    func mask() { masked = true }

    func unmask() { masked = false }

    /// THE FOREGROUND TRIGGER (#1029 W18-6).
    ///
    /// The amendment's posture is that the phone drains **in the foreground and
    /// inside the background window iOS grants**, so the foreground half needs a
    /// caller and this is it: `CentraidApp`'s scene phase already observes
    /// `.active` for the switcher mask, and becoming active is the one moment
    /// worth spending a drain on without asking whether one ran recently.
    ///
    /// Fire-and-forget. A member who has just opened Centraid is looking at
    /// their vault, not at a progress bar for a pass they did not ask for; the
    /// backup row updates from the claim when the answer lands.
    func becameActive() {
        #if canImport(CentraidShared)
        home.becameActive(onDone: { _ in })
        #endif
    }
    /// Whether the vault sheet is up.
    @Published var vaultSheetOpen = false
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
    /// The last thing the vault sheet said, in a member's words.
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
            // THE BACKGROUND WINDOWS NOW HAVE SOMETHING TO RUN (#1029 W18-6).
            //
            // `BackgroundPasses` registered both handlers at launch — it has to,
            // before the app finishes launching — but what a pass IS belongs to
            // `commonMain`, and there was no shelf to drain until this moment.
            // So the handler is installed here, when the session exists, and a
            // window that opens before it completes honestly rather than
            // claiming a drain ran.
            //
            // `Bool` in, `Bool` out: the answer is handed straight to
            // `setTaskCompleted(success:)`.
            BackgroundPasses.pass = { deadline in
                await withCheckedContinuation { continuation in
                    self.home.drain(
                        deadlineMs: Int64(deadline * 1000),
                        onDone: { drained in continuation.resume(returning: drained.boolValue) }
                    )
                }
            }
            // AND THE FIRST FOREGROUND PASS. `becameActive` below runs on every
            // later activation; this is the one at launch, which would otherwise
            // be missed because the session did not exist when the scene became
            // active.
            self.home.becameActive(onDone: { _ in })
        }
        // THE DEVICE MAKES ITS OWN VAULT (#1025 S5; #1029 §1).
        //
        // This used to hand over every `.db` file that had been PLACED in the
        // container by `mobile/scripts/demo-vault.sh`, because there was no way
        // for a phone to get a vault of its own. S5 made that a pairing and
        // #1029 makes it a FOUNDING: the phone is the vault. So what crosses is
        // the DIRECTORY vaults live in, and an empty one is the ordinary first
        // run — Home draws the empty shelf and the member's next move is the
        // vault sheet.
        //
        // **NOTHING UNDER THIS DIRECTORY GOES INTO iCLOUD BACKUP** (#1029 line
        // 84, F5). Once before the core opens, so the directory itself carries
        // the attribute, and once after, so the vault file, its `-wal` and
        // `-shm`, its `.bytes` store and the backup home the core just made
        // carry it too — iOS does not inherit `isExcludedFromBackup`, so each
        // item needs it in its own right. `VaultFileProtection` says why this
        // is the layer that can do it.
        VaultFileProtection.secure(directory: Self.vaultDirectory)
        home.open(vaultDir: Self.vaultDirectory)
        VaultFileProtection.secure(directory: Self.vaultDirectory)
        // AND AGAIN ON THE WAY TO THE BACKGROUND, which is the moment before
        // iOS would take a backup. Every file the core created while the app
        // was in the foreground is swept then, which is what makes a per-item
        // attribute hold for files nothing here created.
        enteredBackground = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { _ in
            VaultFileProtection.secure(directory: Self.vaultDirectory)
        }
        // THE OS ASKING FOR MEMORY BACK IS THE ONLY THING THAT CLOSES A
        // BACKGROUND VAULT'S CORE (#1025 S7-13, ruling F).
        //
        // Every held vault's core is open, so a switch is a pointer move rather
        // than a SQLite close-and-open. The bound on that is not a count of
        // cores — that would make "is this vault open" depend on how recently
        // some other vault was touched — it is this notification: under
        // pressure, every core but the foreground's closes, and a rested vault
        // reopens on the next tap.
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
        if let enteredBackground {
            NotificationCenter.default.removeObserver(enteredBackground)
        }
    }

    /// The background observer that re-sweeps the vault directory's backup
    /// exclusion, held so it can be removed.
    private var enteredBackground: NSObjectProtocol?

    /// The memory-warning observer, held so it can be removed.
    private var memoryWarning: NSObjectProtocol?

    /// WHERE THIS DEVICE'S VAULTS LIVE.
    ///
    /// Documents and not Caches: a vault is the member's data, and the one
    /// directory iOS promises not to evict under pressure is this one.
    ///
    /// The DIRECTORY is the roster — there is no manifest beside it, because a
    /// manifest would be a second place a vault's name and existence live, and
    /// the two would disagree the moment one was renamed from another device.
    /// What each file is CALLED is read out of the file itself (`VaultRoster`),
    /// and so is which VAULT it holds: the file name is a label the shelf
    /// minted and never an identity.
    static var vaultDirectory: String {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].path
    }

    #endif

    /// MAKE A VAULT ON THIS PHONE (#1029 §1).
    ///
    /// What `pair(ticket:)` became. It took a pasted ticket, this device's name
    /// and a platform string and redeemed them against a gateway; none of the
    /// three has a reader now. The phone is the vault, so the only input is the
    /// tap.
    func found(done: @escaping () -> Void) {
        #if canImport(CentraidShared)
        home.found { [weak self] outcome in
            // KOTLIN'S NESTED CLASSES FLATTEN IN OBJECTIVE-C. A sealed
            // interface's members export as `FoundResultMade` and
            // `FoundResultRefused`, not as nested types — so `FoundResult.Made`
            // does not exist on this side and the compiler says so.
            switch outcome {
            case let made as FoundResultMade:
                // THE NAME COMES OUT OF THE VAULT (#1025 S7-9). A ticket used
                // to carry the gateway CLI's `--vault-name` flag and the sheet
                // printed it as fact; this one is `core_vault.display_name`,
                // read off the file that was just founded.
                self?.gatewayStatus = "Made \(made.vaultName)."
            case let refused as FoundResultRefused:
                self?.gatewayStatus = refused.sentence
            default:
                self?.gatewayStatus = "Centraid is still opening."
            }
            done()
        }
        #else
        gatewayStatus = "This build has no core."
        done()
        #endif
    }

    /// FORGET A VAULT — the inverse of [found] (#1025 S7-9).
    ///
    /// The shelf closes the core, deletes the file and its byte store, and
    /// rebinds the session onto whatever came forward; the roster the switcher
    /// is drawing arrives as the ordinary `RosterChanged`, so nothing here
    /// removes a row by hand.
    ///
    /// **ON A PHONE THAT IS THE VAULT THIS DESTROYS THE MEMBER'S ROWS**
    /// (#1029 §1). It used to be local and reversible — the gateway kept this
    /// device enrolled and a re-pair took the copy again — and there is no
    /// gateway and no copy. The confirmation in `VaultSheet` has to say so.
    func forget(vaultID: String) {
        #if canImport(CentraidShared)
        home.forget(vaultId: vaultID) {}
        // R-SHELL-2: member-visible sentences name the FOREGROUND holding,
        // not the last successful found() call. Forgetting (or switching away
        // from) a vault must not leave "Made Fresh Vault." over Tahoe Weekend.
        gatewayStatus = ""
        #else
        gatewayStatus = "This build has no core."
        #endif
    }

    /// Clear member-visible copy that named a vault no longer in front.
    ///
    /// Called when the switcher picks another vault. Outcomes that land
    /// afterwards rewrite the line for the vault now open.
    func clearStaleGatewayStatus() {
        gatewayStatus = ""
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
        vaultSheetOpen = false
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
