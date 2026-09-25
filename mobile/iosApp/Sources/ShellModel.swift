import Combine
import Foundation
import SwiftUI
import UIKit

// THE FRAMEWORK IS OPTIONAL AT COMPILE TIME, AND `Package.swift` SAYS WHY.
//
// Its `binaryTarget` is commented out on purpose: `swift test` had to run on a
// bare macOS with no Kotlin toolchain, and that was what made
// `Tests/ScreenFixtureTests.swift` a one-command hand-off rather than an Xcode
// scheme. THE `import UIKit` FOUR LINES UP IS WHAT ENDED THAT — it arrived with
// this file in `a4dd49d0d` and macOS has no UIKit, so the host build has failed
// at dependency scanning ever since and the guard below now protects a build
// nobody can run. `Package.swift`'s header carries the whole account and the
// open question. An unconditional `import CentraidShared` here breaks that promise for
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
        /// A REGISTERED SCREEN, by its machine's `SCREEN_ID`, with its
        /// parameter as bytes (K5). Every app registered through
        /// `AppRegistry` routes here — Tally, Notes and Agenda today, and each
        /// port after them — so a new app adds no case to this enum, no branch
        /// to `CentraidApp`'s destination switch and none to `opened`.
        case screen(String, Data)
        case photos

        // THE PHOTOS MINIAPP'S OTHER NINE SCREENS (#1029, photos port).
        //
        // **The shelf carries its parameter as `Data`, not as a message.** The
        // route holds an ENCODED `PhotoShelf`, because `Centraid_Screen_V1_*`
        // is SwiftProtobuf's struct and the bridge wants Wire's Kotlin class —
        // generated from the same `.proto` and not the same type, so bytes are
        // the only thing both halves agree on. It is also what makes `Route`
        // `Hashable` without SwiftProtobuf conforming to it.
        //
        // `more` is deliberately absent, as it is from `Destination`: it is a
        // `PhotosGridState.Sheet` and there is no route it could be. So are
        // Collections and Search, which are band DESTINATIONS on
        // `photos.grid` — a parameter, never a push, so back does not walk
        // through the bands a member happened to tap.
        case photoShelf(Data)
        // THE ALBUM IT WAS OPENED FROM rides along, empty from anywhere else,
        // so "Make key photo" knows which cover it sets.
        case photoLightbox(String, [String], album: String = "")
        case photoPicker(String, String)
        case places
        case photosPeople
        case photoFaceReview
        case photosMemories
        case photoDuplicates
        case photoDuplicateReview(String)
        /// The editor over one photograph, with the lightbox's neighbours so a
        /// save can come back to the same shelf's order (#1029).
        case photoEditor(String, [String])
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
    /// EVERY REGISTERED SCREEN'S BYTES, by `SCREEN_ID` (K5). A port's view
    /// reads `shell.state(id)`; the registry's observer writes here.
    @Published var states: [String: Data] = [:]
    /// Each registered screen's opener and view, by `SCREEN_ID`.
    var routes: [String: ScreenRoute] = [:]
    @Published var photosState = Data()
    @Published var photoShelfState = Data()
    @Published var photoLightboxState = Data()
    @Published var photoPickerState = Data()
    @Published var photosCollectionsState = Data()
    @Published var photosSearchState = Data()
    @Published var placesState = Data()
    @Published var photosPeopleState = Data()
    @Published var faceReviewState = Data()
    @Published var duplicatesState = Data()
    @Published var duplicateReviewState = Data()
    @Published var photosMemoriesState = Data()
    @Published var photoEditorState = Data()

    /// The shelf's own sentences, read off the bridge when it opens.
    ///
    /// Not derived here and not a second table in Swift: `PhotoShelfMachine`
    /// owns every empty sentence and title, and `PhotoShelfBridge.sentences()`
    /// hands the ANSWERS across because the machine's functions take Wire's
    /// `PhotoShelf` and this side holds SwiftProtobuf's. A Swift copy of that
    /// table is exactly the drift that gave v0 a `PlaceDetail` with an empty
    /// sentence and three state views without one.
    @Published var photoShelfCopy = PhotoShelfCopy.unknown

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
    private let photos = PhotosBridge()

    /// THE REGISTERED SCREENS' PORTS AND ROUTES (K5) — `ScreenRegistry.swift`.
    /// Filled once, in `init`, by `AppRegistry.apps`; held for the life of the
    /// shell for the same reason the Photos bridges below are.
    var ports: [String: ScreenPort] = [:]
    /// The one session, once it exists, so a port registered after it opens
    /// is still attached.
    var session: HomeSession?

    /// THE PHOTOS MINIAPP'S OTHER NINE, held for the same reason as the three
    /// above: a `ScreenHost` routed onto the change stream cannot be
    /// un-routed, so a bridge rebuilt per push would leave a routed host
    /// drawing into a view that is gone.
    private let photoShelf = PhotoShelfBridge()
    private let photoLightbox = PhotoLightboxBridge()
    private let photoPicker = PhotoPickerBridge()
    private let photosCollections = PhotosCollectionsBridge()
    private let photosSearch = PhotosSearchBridge()
    private let places = PlacesBridge()
    private let photosPeople = PhotosPeopleBridge()
    private let faceReview = FaceReviewBridge()
    private let duplicates = DuplicatesBridge()
    private let duplicateReview = DuplicateReviewBridge()
    private let photosMemories = PhotosMemoriesBridge()
    private let photoEditor = PhotoEditorBridge()

    init() {
        home.observe { [weak self] bytes in
            self?.homeState = bytes.data
        }
        photos.observe { [weak self] bytes in self?.photosState = bytes.data }
        // ONE LINE PER APP lives in `AppRegistry.apps`, not here.
        for app in AppRegistry.apps { app.register(into: self) }
        photoShelf.observe { [weak self] bytes in
            guard let self else { return }
            self.photoShelfState = bytes.data
            // THE COPY FOLLOWS THE STATE, NOT THE OPEN.
            //
            // It was read once, straight after `openedEncoded` — and
            // `opened` LAUNCHES a coroutine, so `sentences()` ran before the
            // reduce that set the shelf. Every shelf drew
            // `PhotoShelfCopy.unknown`: the favourites shelf was titled
            // "Photographs" and the trash offered no retention sentence.
            // Reading it here instead means it is re-derived after each
            // reduce, from the shelf the host actually holds.
            self.photoShelfCopy = self.shelfWords()
        }
        photoLightbox.observe { [weak self] bytes in self?.photoLightboxState = bytes.data }
        photoPicker.observe { [weak self] bytes in self?.photoPickerState = bytes.data }
        photosCollections.observe { [weak self] bytes in self?.photosCollectionsState = bytes.data }
        photosSearch.observe { [weak self] bytes in self?.photosSearchState = bytes.data }
        places.observe { [weak self] bytes in self?.placesState = bytes.data }
        photosPeople.observe { [weak self] bytes in self?.photosPeopleState = bytes.data }
        faceReview.observe { [weak self] bytes in self?.faceReviewState = bytes.data }
        duplicates.observe { [weak self] bytes in self?.duplicatesState = bytes.data }
        duplicateReview.observe { [weak self] bytes in self?.duplicateReviewState = bytes.data }
        photosMemories.observe { [weak self] bytes in self?.photosMemoriesState = bytes.data }
        photoEditor.observe { [weak self] bytes in self?.photoEditorState = bytes.data }
        // THE EDITOR'S SAVE RENDERS ON THIS SHELL'S OWN DECODER and ingests
        // through the bridge — the camera roll's path (#1029).
        photoEditor.onRender = { [weak self] key, path, plan in
            self?.renderEdit(key: key, path: path, plan: plan.data)
        }
        // THE SESSION OWNS THE ONE CORE (R-1020-24), so the app screens are
        // attached TO it rather than opening one. It is opened asynchronously,
        // so this is a callback and not a getter: there is exactly one moment
        // the session comes into existence and a poll would either miss it or
        // spin.
        home.onSession { [weak self] session in
            guard let self else { return }
            self.session = session
            for port in self.ports.values { port.attach(session) }
            self.photos.attach(session: session)
            self.photoShelf.attach(session: session)
            self.photoLightbox.attach(session: session)
            self.photoPicker.attach(session: session)
            self.photosCollections.attach(session: session)
            self.photosSearch.attach(session: session)
            self.places.attach(session: session)
            self.photosPeople.attach(session: session)
            self.faceReview.attach(session: session)
            self.duplicates.attach(session: session)
            self.duplicateReview.attach(session: session)
            self.photosMemories.attach(session: session)
            self.photoEditor.attach(session: session)
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

    /// THE EDITOR SAVED, AND THE MEMBER GOES TO WHAT THEY MADE (#1029).
    ///
    /// The editor comes off the stack and the lightbox under it is REPLACED by
    /// one on the new photograph — the shelf's order kept behind it, so a swipe
    /// still walks where it walked. An empty id (an output that named nothing)
    /// returns to the photograph the member came from rather than to a guess.
    func photoEditSaved(_ saved: String, neighbours: [String]) {
        guard !path.isEmpty else { return }
        path.removeLast()
        guard !saved.isEmpty, case .photoLightbox? = path.last else { return }
        path[path.count - 1] = .photoLightbox(saved, [saved] + neighbours.filter { $0 != saved })
    }

    /// DRAW AN EDIT, OFF THE MAIN THREAD, and hand the JPEG to the bridge —
    /// which gives it the original's date, place and caption (#1029).
    private func renderEdit(key: String, path: String, plan: Data) {
        #if canImport(CentraidShared)
        let decoded = (try? Centraid_Screen_V1_PhotoEditPlan(serializedBytes: plan)) ?? .init()
        // THE BRIDGE, NOT `self`, crosses into the detached task: it is the one
        // thing the answer goes to, and a captured model is a main-actor type
        // read from a background thread.
        let bridge = photoEditor
        Task.detached(priority: .userInitiated) {
            let made = PhotoEditRenderer.render(sourcePath: path, plan: decoded)
            await MainActor.run {
                switch made {
                case let .made(file, width, height):
                    bridge.rendered(key: key, path: file, width: Int32(width), height: Int32(height))
                case let .refused(sentence):
                    bridge.renderRefused(key: key, sentence: sentence)
                }
            }
        }
        #endif
    }

    /// A BAND BODY CAME ON SCREEN (#1029, photos port).
    ///
    /// Collections and Search are DESTINATIONS on `photos.grid`, not routes —
    /// law 2 — so neither gets a `Route` and neither passes through
    /// [opened]. They still have to be told they are showing, for the reason
    /// that method's doc gives: a screen reads because it was OPENED, and one
    /// that is merely composed sits on its seeded `LOADING` for ever.
    ///
    /// Idempotence is the machines': a second `Opened` re-reads, which is what
    /// a member returning to a band should get.
    func openedPhotosBand(_ destination: Centraid_Screen_V1_PhotosGridState.Destination) {
        #if canImport(CentraidShared)
        switch destination {
        case .collections: photosCollections.opened()
        case .search: photosSearch.opened()
        case .library, .unspecified, .UNRECOGNIZED: break
        }
        #endif
    }

    /// THE MACHINE'S ANSWERS, CROSSING THE ABI AS SIX PLAIN VALUES.
    ///
    /// `PhotoShelfMachine` owns every shelf title and empty sentence; its
    /// functions take Wire's `PhotoShelf` and the views hold SwiftProtobuf's,
    /// so the DERIVATION stays put and only the answers cross. A Swift table
    /// of shelf sentences beside the Kotlin one is the drift that left v0 with
    /// a `PlaceDetail` carrying an empty sentence and three state views
    /// carrying none.
    private func shelfWords() -> PhotoShelfCopy {
        #if canImport(CentraidShared)
        let words = photoShelf.sentences()
        return PhotoShelfCopy(
            title: words.title,
            empty: words.empty,
            emptyRemedy: words.emptyRemedy,
            purgeWindow: words.purgeWindow,
            isTrash: words.isTrash,
            isArchive: words.isArchive
        )
        #else
        return .unknown
        #endif
    }

    /// THE THREE SHELVES THAT ARE REACHED FROM ANOTHER SCREEN, ENCODED.
    ///
    /// A place card, a person and a memory each open the SAME screen —
    /// `photos.shelf`, the library under a predicate — so each of these builds
    /// the parameter that says which. They are here rather than in the views
    /// because a route's payload is the shell's business, and because
    /// `PhotoShelfRoute` carries bytes: SwiftProtobuf's `PhotoShelf` and
    /// Wire's are different types generated from one `.proto`.
    ///
    /// **Names ride along** (`navigation.ts:63-69`), so the shelf's app bar
    /// says "Lisbon" before its page read has landed and never paints under
    /// the previous shelf's title.
    func placeShelf(identifier: String, name: String) -> Data {
        var shelf = Centraid_Screen_V1_PhotoShelf()
        shelf.place = .with {
            $0.placeID = identifier
            $0.placeName = name
        }
        return (try? shelf.serializedData()) ?? Data()
    }

    func personShelf(identifier: String, name: String) -> Data {
        var shelf = Centraid_Screen_V1_PhotoShelf()
        // A PERSON IS A `PhotoStateView`, NOT AN ARM OF ITS OWN — law 3, and
        // the shape `navigation.ts:43-46` chose: the state view is a
        // discriminated union and "one person's photographs" is one of its
        // cases, beside favourites, archive, trash and videos.
        shelf.stateView = .with {
            $0.person = .with {
                $0.partyID = identifier
                $0.personName = name
            }
        }
        return (try? shelf.serializedData()) ?? Data()
    }

    func memoryShelf(identifier: String, title: String) -> Data {
        var shelf = Centraid_Screen_V1_PhotoShelf()
        shelf.memory = .with {
            $0.memoryID = identifier
            $0.title = title
        }
        return (try? shelf.serializedData()) ?? Data()
    }

    /// The four standing shelves, for Collections and for anything else that
    /// names one. A `Mode` and never a string.
    func modeShelf(_ kind: Centraid_Screen_V1_PhotoStateView.Mode.Kind) -> Data {
        var shelf = Centraid_Screen_V1_PhotoShelf()
        shelf.stateView = .with { $0.mode = .with { $0.kind = kind } }
        return (try? shelf.serializedData()) ?? Data()
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
        case "photos.grid": photos.send(event: event.kotlin)
        case "photos.shelf": photoShelf.send(event: event.kotlin)
        case "photos.lightbox": photoLightbox.send(event: event.kotlin)
        case "photos.picker": photoPicker.send(event: event.kotlin)
        case "photos.collections": photosCollections.send(event: event.kotlin)
        case "photos.search": photosSearch.send(event: event.kotlin)
        case "photos.places": places.send(event: event.kotlin)
        case "photos.people": photosPeople.send(event: event.kotlin)
        case "photos.faces": faceReview.send(event: event.kotlin)
        case "photos.duplicates": duplicates.send(event: event.kotlin)
        case "photos.duplicate": duplicateReview.send(event: event.kotlin)
        case "photos.memories": photosMemories.send(event: event.kotlin)
        case "photos.editor": photoEditor.send(event: event.kotlin)
        // EVERY REGISTERED SCREEN: a lookup, not a case (K5).
        default: ports[screen]?.send(event)
        }
        #endif
    }

    /// "Send a copy" and "Download original" over a shelf's pick. The work is
    /// `ShelfCopyExport.swift`'s; this only lends it the shelf's bridge.
    func exportShelf(_ assetIdentifiers: [String], as kind: ShelfCopyExport.Kind) {
        #if canImport(CentraidShared)
        ShelfCopyExport.run(kind, assetIdentifiers, bridge: photoShelf)
        #endif
    }

    /// "Send a copy" over the library's selection — the shelf's batch hand-off,
    /// lent the grid's `LibraryCopies` so the outcome lands on the library.
    func exportLibrary(_ assetIdentifiers: [String], keepLocation: Bool) {
        #if canImport(CentraidShared)
        ShelfCopyExport.run(.send(keepLocation: keepLocation), assetIdentifiers, bridge: photos.copies)
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
        case let .screen(identifier, parameter):
            routes[identifier]?.open(parameter)
        case .photos:
            // Re-read the OS grant, then open (R-PHOTOS-1). Sending `Opened`
            // alone left a post-attach grant as NOT_ASKED on first paint.
            photos.opened()

        // THE SHELF OPENS ON ITS PARAMETER, AND READS THE MACHINE'S WORDS.
        //
        // `openedEncoded` and not `opened`: the bridge wants Wire's
        // `PhotoShelf` and this route holds SwiftProtobuf's bytes. The copy is
        // read straight after, because `sentences()` is a function of the
        // shelf the host has just been told about — which is why it is read at
        // the moment of the call rather than published.
        case let .photoShelf(shelf):
            photoShelf.openedEncoded(shelf: shelf.kotlin)

        case let .photoLightbox(identifier, neighbours, album):
            photoLightbox.opened(assetId: identifier, neighbours: neighbours, albumId: album)

        case let .photoPicker(identifier, name):
            // ALREADY IN THE ALBUM IS EMPTY FROM HERE, and the picker knows
            // it: the set is what the album's own entries say, and this route
            // carries the album's id and name, not its contents. The reducer
            // treats an empty list as "nothing is known to be taken" rather
            // than "nothing is", which is the conservative reading — a member
            // can add a photograph twice and the second add is a no-op at the
            // vault, where a wrongly-greyed cell would be a photograph they
            // could not add at all.
            photoPicker.opened(
                collectionId: identifier,
                collectionName: name,
                alreadyInAlbumAssetIds: []
            )

        case .places: places.opened()
        case .photosPeople: photosPeople.opened()
        case .photoFaceReview: faceReview.opened()
        case .photosMemories: photosMemories.opened()
        case .photoDuplicates: duplicates.opened()
        case let .photoEditor(identifier, _):
            photoEditor.opened(assetId: identifier)
        case let .photoDuplicateReview(clusterIdentifier):
            duplicateReview.opened(clusterId: clusterIdentifier)
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
