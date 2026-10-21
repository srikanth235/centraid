import Combine
import Contacts
import EventKit
import Foundation
import SwiftUI
import UIKit

import CentraidShared

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
    /// ONE PER PROCESS, AND REACHABLE WITHOUT A SCENE (#1080).
    ///
    /// The core is one handle per vault file per process (R-1020-24), and this
    /// is what opens it. A background relaunch — a `BGProcessingTask`, or iOS
    /// waking the app to report finished uploads — may never connect a scene,
    /// so the app delegate and `BackgroundPasses` reach the shell here rather
    /// than through SwiftUI's `@StateObject`, which `CentraidApp` points at
    /// this same instance. Two `ShellModel`s would be two `HomeSession`s and
    /// the second would be refused every file the first holds.
    static let shared = ShellModel()

    enum Route: Hashable {
        /// A REGISTERED SCREEN, by its machine's `SCREEN_ID`, with its
        /// parameter as bytes (K5). Every app registered through
        /// `AppRegistry` routes here — Notes and Agenda today, and each
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
        case photosMemories
        case photoDuplicates
        case photoDuplicateReview(String)
        /// The editor over one photograph, with the lightbox's neighbours so a
        /// save can come back to the same shelf's order (#1029).
        case photoEditor(String, [String])
    }

    @Published var path: [Route] = [] {
        // A SETTLED IMPORT LINE GOES WITH THE NEXT MOVE (DESIGN.md: the line
        // never clears on a timer; the member's own next step puts it away).
        didSet { if path != oldValue { importLineMoved() } }
    }
    @Published var masked = false

    /// WHICH PLACE THE BAND'S ROOT IS SHOWING: Home's springboard, or the Chat
    /// tab drawn in its place. Apps are covers pushed over either, so this is
    /// never part of `path`. Chat is a band place and not an app: it has no
    /// tile, no route and no catalogue row.
    enum Tab: Hashable {
        case home, chat, backup
    }

    @Published var tab: Tab = .home {
        didSet { if tab != oldValue { importLineMoved() } }
    }

    /// THE ON-DEVICE CHAT, with its own observable (see `ChatModel`): a state
    /// per streamed token must not re-evaluate Home.
    let chat = ChatModel()

    /// The app the member last had open and has not yet carried into Chat. The
    /// next time the tab opens on an empty thread it is the scope, so asking
    /// "what is due" right after Tasks is about Tasks. The member clears
    /// it with the chip.
    private var lastVisitedApp = ""
    /// The scope the chat is in now. Kept so a tab switch re-opens the same
    /// scope, which is what keeps the thread.
    private var chatScope = ""

    /// PAINT THE SWITCHER MASK, and take it down: on `.background`, so the
    /// snapshot iOS keeps for the app switcher shows no rows (`CentraidApp`).
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
    /// backup line updates from `backup_status` when the answer lands.
    ///
    /// **HELD UNDER A GRACE** (#1080): if the member leaves while the pass is
    /// running, iOS gives it the background task's seconds to finish its
    /// current part instead of suspending it mid-part.
    func becameActive() {
        let grace = ForegroundGrace(name: "dev.centraid.pass.active")
        home.becameActive(onDone: { _ in grace.end() })
        followPhone()
    }

    /// THE APP CAME FORWARD, or the OS announced a change: People, Agenda, Docs
    /// and Health follow the phone (#1127, #1129). Cheap; the shared gate decides
    /// whether a pass runs. Health is read on coming forward only — background
    /// delivery is a later wave — and a pass never asks HealthKit for access.
    func followPhone() {
        follow.requested(source: .contacts)
        follow.requested(source: .calendar)
        follow.requested(source: .files)
        follow.requested(source: .health)
    }

    /// A folder was just followed, or picked again: read it now (#1127).
    func followFolders() {
        follow.requested(source: .files)
    }

    /// CONNECT HEALTH (#1129): the member tapped Connect with [chosen]. The OS
    /// is asked for exactly those types, read only; then the vault is told, and
    /// the first pass runs. [done] hears whether both answered.
    func connectHealth(_ chosen: [String], done: @escaping (Bool) -> Void) {
        Task { @MainActor in
            guard await HealthAccess.request(chosen) else {
                done(false)
                return
            }
            healthConnect.connect(store: HealthDevices.shared.APPLE_HEALTH, chosen: chosen) { ok in
                done(ok.boolValue)
            }
        }
    }

    /// STOP (#1129): Health stops reading the store; every day and workout stays.
    func stopHealth() {
        HealthAccess.stopped()
        healthConnect.stop { _ in }
    }

    /// The question a held account or calendar leaves (R-1127-9), or nil. The
    /// words are the shared bridge's; this shell draws them.
    @Published var followQuestion: PhoneFollowQuestion?

    /// The member's answer to [followQuestion]; Keep is the default.
    func answerFollowQuestion(keep: Bool) {
        guard let question = followQuestion else { return }
        followQuestion = nil
        follow.answer(question: question, keep: keep)
    }

    /// THE APP WENT TO THE BACKGROUND (#1080, the shells).
    ///
    /// Two things, in this order. The night's windows are asked for first —
    /// leaving the app is what arms them, and a one-shot request that was only
    /// ever resubmitted from inside a handler never ran at all. Then
    /// `enteredBackground` under the background task's grace, bounded by
    /// [backgroundPassSeconds]. It FORCES a snapshot, so what the member just
    /// wrote is sealed before the app is suspended; it waits inside the grace
    /// for a pass already running ("Back up now", say) rather than being
    /// refused by it; and it ends like every iOS pass, handing what is sealed
    /// to the OS to carry. The vault directory's backup exclusion is swept by
    /// the `didEnterBackground` observer below, not here.
    func wentToBackground() {
        BackgroundPasses.resubmitAll()
        let grace = ForegroundGrace(name: "dev.centraid.pass.background")
        home.enteredBackground(
            graceMs: Int64(Self.backgroundPassSeconds * 1000),
            onDone: { _ in grace.end() }
        )
    }

    /// Under the ~30 seconds iOS grants a background task, with room for the
    /// part in flight to finish after the deadline is read.
    static let backgroundPassSeconds: TimeInterval = 20

    /// THE FIRST-LAUNCH GATE: true once the shelf has read its directory and
    /// the device holds no vault — a fresh install, or the last vault
    /// forgotten. `CentraidApp` draws `FirstLaunchView` instead of Home while
    /// it holds. **Nil until the read lands**, and the root draws bare paper
    /// for that moment — neither the gate on a phone that holds a vault nor Home
    /// (a loading grid, or "No vault is open") on one that holds none. The
    /// answer is the shared shelf's (`Shelf.holdsNoVault`), and this is only
    /// where SwiftUI hears it.
    @Published var holdsNoVault: Bool?
    /// The vault Home's lockup names, or empty before the first lockup lands.
    var homeVaultID: String {
        ((try? Centraid_Screen_V1_HomeState(serializedBytes: homeState)) ?? .init()).vault.vaultID
    }
    /// THE SHELL'S ONE BANNER LINE: an import's progress and outcome (DESIGN.md: a banner, never a toast).
    /// Empty draws nothing.
    @Published var importNotice = ""
    /// The contacts import is running: its banner has no exit until it ends.
    @Published var importing = false
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
    /// THE MEMBER'S APPEARANCE (R-CHROME-7), as the store's own word, read at
    /// launch. `HomeBridge` parses it; empty until the read lands, which
    /// follows the phone exactly as "system" does.
    @Published var appearance = ""
    /// The last thing the vault sheet said, in a member's words.
    ///
    /// A SENTENCE THE CORE ALREADY DECIDED WAS SHOWABLE. Nothing here composes
    /// one out of an error: `Error.detail` is logs-only, and a shell that made
    /// its own sentence from a peer's words would be the hole in that rule.
    @Published var gatewayStatus = ""

    /// WHICH 24-WORDS SCREEN IS UP (#1047 E2), if any: `words.make` or
    /// `words.enter`. One sheet at the root for both, so switching from one to
    /// the other (RESTORE_FIRST's "Restore my vaults") is an item change the
    /// presentation handles, and Locker's wall can raise it from any depth.
    @Published var wordsSheet: WordsSheet?
    /// `words.make`'s and `words.enter`'s last states, as bytes.
    @Published var vaultWordsState = Data()
    @Published var wordsEntryState = Data()
    /// `words.show`'s and `pair.laptop`'s last states (#1047 E5), as bytes.
    @Published var wordsShowState = Data()
    /// Bumped on each open of the Backup tab: `BackupView` scrolls to its top.
    @Published var backupScrollTop = 0
    @Published var pairLaptopState = Data()
    /// The Backup screen's last state, as bytes (#1080).
    @Published var backupState = Data()

    /// The root custody sheet: the two words screens (#1047 E2), and the two
    /// the More sheet's rows open (#1047 E5) — showing the words again, and
    /// pairing with the laptop.
    /// `backup` is the Backup screen (#1080): one sheet at the root like the
    /// custody screens, so "Add a gateway" can swap it for `pair` in place.
    enum WordsSheet: String, Identifiable {
        case make, enter, show, pair
        var id: String { rawValue }
    }

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

    /// Home's bridge into `CentraidShared`. Created once, observed once.
    ///
    /// Home is the only screen wired this way so far: wave A built it, so wave A
    /// connected it. The other three still go through `unwired()` below, and
    /// `mobile/README.md` carries that hand-off.
    private let home = HomeBridge()
    private let contacts = ContactsImportBridge()
    private let calendar = CalendarImportBridge()
    /// THE PHONE FOLLOWED (#1127): People, Agenda and Docs keep following what the
    /// phone holds after the member imported it. One bridge for both; the gate,
    /// the passes and the question are in `CentraidShared`.
    private let follow = PhoneFollowBridge()
    /// HEALTHKIT, READ ONLY (#1129): the follower's reader and Connect's.
    private let healthReader = HealthKitReader()
    /// CONNECT AND STOP (#1129): what the vault is told after the member's
    /// Connect tap and the OS's answer, and when they stop. Health's screens
    /// reach it through `connectHealth` and `stopHealth`.
    private lazy var healthConnect = HealthConnectBridge(
        reader: healthReader,
        clock: PlatformServices_iosKt.platformServices().clock
    )
    private let reminders = RemindersImportBridge()

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

    /// THE 24 WORDS' TWO BRIDGES (#1047 E2), held for the life of the shell.
    private let vaultWords = VaultWordsBridge()
    private let wordsEntry = WordsEntryBridge()
    /// `words.show` and `pair.laptop` (#1047 E5), held for the same reason.
    private let wordsShow = WordsShowBridge()
    /// words.show was opened from the Backup tab and has not closed: its
    /// sheet goes up once the owner check has answered.
    private var showWordsRequested = false
    /// The owner check is on screen, so a second `check_now` waits for it.
    private var ownerChecking = false
    private let pairLaptop = PairLaptopBridge()
    /// THE BACKUP SCREEN'S BRIDGE (#1080, seam contract A11), held for the
    /// same reason. Its shape — `observe`, `open`, `send`, `attach` — is every
    /// kit bridge's.
    private let backup = BackupBridge()

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
    private let duplicates = DuplicatesBridge()
    private let duplicateReview = DuplicateReviewBridge()
    private let photosMemories = PhotosMemoriesBridge()
    private let photoEditor = PhotoEditorBridge()

    init() {
        home.observe { [weak self] bytes in
            self?.homeState = bytes.data
        }
        // THE OS SAYS THE ADDRESS BOOK OR A CALENDAR CHANGED: follow it (#1127).
        // The shared gate folds a burst of these into one pass, and a pass does
        // nothing unless the member imported the source and access is already given.
        NotificationCenter.default.addObserver(forName: .CNContactStoreDidChange, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.follow.requested(source: .contacts) }
        }
        NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.follow.requested(source: .calendar) }
        }
        // EventKit posts only for a store that is alive.
        _ = PhoneCalendar.watcher
        // THE PHONE'S HEALTH FACTS (#1129): the store, the units and the chosen
        // set, stated before any Health screen opens and again whenever the
        // member changes the region's measurement system.
        HealthAccess.state()
        NotificationCenter.default.addObserver(forName: NSLocale.currentLocaleDidChangeNotification, object: nil, queue: .main) { _ in
            HealthAccess.state()
        }
        photos.observe { [weak self] bytes in self?.photosState = bytes.data }
        home.observeHoldsNoVault { [weak self] none in self?.holdsNoVaultChanged(none.boolValue) }
        home.appearance { [weak self] stored in self?.appearance = stored }
        vaultWords.observe { [weak self] bytes in self?.vaultWordsChanged(bytes.data) }
        // A VAULT WAS MADE (`VaultWordsBridge.made`, once per make): its
        // sentence stays on the vault sheet, as `found`'s did, and what the
        // phone already holds is asked for once and brought in (R-ONBOARD-8):
        // the photos, then the contacts, the calendar and the reminders, each
        // prompt after the last one was answered — nobody is sent to an empty
        // app to find its import.
        vaultWords.observeMade { [weak self] sentence in
            guard let self else { return }
            self.gatewayStatus = sentence
            self.photos.askForPhotos { [weak self] in
                DispatchQueue.main.async { self?.importEverythingFromPhone() }
            }
        }
        wordsEntry.camera = PairScanner.available
        wordsEntry.observe { [weak self] bytes in self?.wordsEntryChanged(bytes.data) }
        wordsShow.observe { [weak self] bytes in self?.wordsShowChanged(bytes.data) }
        pairLaptop.observe { [weak self] bytes in self?.pairLaptopChanged(bytes.data) }
        backup.observe { [weak self] bytes in self?.backupChanged(bytes.data) }
        // ONE LINE PER APP lives in `AppRegistry.apps`, not here.
        for app in AppRegistry.apps { app.register(into: self) }
        // HOME'S SEARCH (R-CHROME-6): Home's own screen, not an app's.
        HomeSearchScreens.register(into: self)
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
            self.vaultWords.attach(session: session)
            self.wordsEntry.attach(session: session)
            self.wordsShow.attach(session: session)
            self.pairLaptop.attach(session: session)
            self.contacts.attach(session: session)
            self.calendar.attach(session: session)
            self.follow.attach(
                session: session,
                sources: [
                    ContactsFollow(reader: ContactsFollowReader()),
                    CalendarFollow(reader: CalendarFollowReader()),
                    FilesFollow(reader: FolderFollowReader()),
                    HealthFollow(reader: self.healthReader, clock: PlatformServices_iosKt.platformServices().clock),
                ],
                ask: { [weak self] question in DispatchQueue.main.async { self?.followQuestion = question } }
            )
            self.reminders.attach(session: session)
            self.healthConnect.attach(session: session)
            self.backup.attach(session: session)
            self.photoShelf.attach(session: session)
            self.photoLightbox.attach(session: session)
            self.photoPicker.attach(session: session)
            self.photosCollections.attach(session: session)
            self.photosSearch.attach(session: session)
            self.places.attach(session: session)
            self.duplicates.attach(session: session)
            self.duplicateReview.attach(session: session)
            self.photosMemories.attach(session: session)
            self.photoEditor.attach(session: session)
            self.chat.attach(session: session)
            // THE BACKGROUND WINDOWS NOW HAVE SOMETHING TO RUN (#1029 W18-6).
            //
            // `BackgroundPasses` registered both handlers at launch — it has to,
            // before the app finishes launching — but what a pass IS belongs to
            // `commonMain`, and there was no shelf to drain until this moment.
            // So the handler is installed here, when the session exists; a
            // window that opens first waits a bounded time for it and then
            // completes honestly rather than claiming a pass ran.
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
            // THE PINS, NOW THAT THE CORE CAN ANSWER `pins` (#1080).
            self.refreshUploadPins()
            // AND THE FIRST FOREGROUND PASS. `becameActive` below runs on every
            // later activation; this is the one at launch, which would otherwise
            // be missed because the session did not exist when the scene became
            // active. Held under a grace like every foreground pass.
            let grace = ForegroundGrace(name: "dev.centraid.pass.launch")
            self.home.becameActive(onDone: { _ in grace.end() })
        }
        // THE BACKGROUND MOVER'S SEAM (#1080 §2), before the core opens, so a
        // relaunch's reports have somewhere to wait.
        wireUploads()
        // FREE UP SPACE'S HAND ON THE PHOTO LIBRARY (#1080 A20), installed once;
        // `HomeBridge` hands it to the session when the session opens.
        home.installLibraryDeleter(deleter: PhotoLibraryDeleter())
        // THE GATEWAY BROWSE (#1080, Q-1080-D3): `NWBrowser` over
        // `_centraid-gateway._tcp`, run in the foreground after a pass found no
        // paired gateway. Outbound only; the phone never listens.
        home.installGatewayBrowser(browser: BonjourGatewayBrowser())
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
        // `-shm`, its `.bytes` store, the backup ledger and the spool the core
        // just made carry it too — iOS does not inherit `isExcludedFromBackup`,
        // so each item needs it in its own right. `VaultFileProtection` names
        // every one (R-1029-8) and says why this is the layer that can do it.
        VaultFileProtection.secure(directory: Self.vaultDirectory)
        home.open(vaultDir: Self.vaultDirectory, devSeedHex: Self.devSeedHex)
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

    // MARK: The background mover's seam (#1080 §2, A6, A11)
    //
    // EVERY KOTLIN NAME THE MOVER NEEDS IS IN THESE TWO FUNCTIONS: how each
    // side is handed the other — `BackgroundUploads`, which
    // `BackgroundUploader` implements, and `UploadEvents`, which the core's
    // side implements — and how the pinned certificates reach a shell that
    // must answer a server-trust challenge before any vault is open. Both
    // `HomeBridge` doors are seam contract A11's.

    /// Hand the core this shell's mover, and take the core's sink for what
    /// the mover reports. Called at construction, before the core opens.
    private func wireUploads() {
        // A11: `HomeBridge.installUploads(uploads: BackgroundUploads): UploadEvents`.
        let events = home.installUploads(uploads: BackgroundUploader.shared)
        UploadSettlement.shared.attach(CoreUploadSink(events))
    }

    /// Re-read the pinned certificates from the core and keep them where a
    /// cold background launch can read them (`UploadPins`). Called when the
    /// session opens, when a pairing closes and when a destination is
    /// forgotten — the three moments the core's answer to `pins` changes.
    func refreshUploadPins() {
        // A11: `HomeBridge.uploadPins(onPins: (List<UploadPin>) -> Unit)`, where
        // `UploadPin(gateway: String, certDer: ByteArray, addrs: List<String>)`
        // is the core's `pins` arm's `Destination`, cut to what the mover needs.
        // A refusal never calls back, so the pins kept are never emptied by one.
        home.uploadPins { pins in
            var table: [String: UploadPins.Pin] = [:]
            for pin in pins {
                table[pin.gateway] = UploadPins.Pin(
                    certificate: pin.certDer.data,
                    hosts: pin.addrs.map { UploadPins.host(of: $0) }
                )
            }
            BackgroundUploader.shared.pins.replace(with: table)
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

    /// THE DEMO VAULT'S SEED, HANDED TO A DEBUG BUILD AT LAUNCH (#1047 W2).
    ///
    /// `mobile/scripts/demo-vault.sh ios` relaunches the app with
    /// `SIMCTL_CHILD_CENTRAID_DEV_SEED` set to what `seed-demo-vault` printed
    /// as `CENTRAID_DEMO_SEED` — the public all-`abandon` words' seed — and the
    /// shelf stores it where a real seed lives, so the demo Locker opens keyed.
    /// A release build compiles `nil` here and carries nothing of the demo's.
    static var devSeedHex: String? {
        #if DEBUG
        ProcessInfo.processInfo.environment["CENTRAID_DEV_SEED"]
        #else
        nil
        #endif
    }


    /// THE SHELF'S ANSWER TO "DOES THIS DEVICE HOLD NO VAULT?" (`Shelf.holdsNoVault`).
    ///
    /// Engaging the gate leaves nothing of Home standing: a route pushed over
    /// it, the switcher the last Forget was made from, and the vault sheet
    /// would each come back the moment a vault is made and Home returns. The
    /// words sheet is deliberately left alone — it is the gate's own door, and
    /// it closes itself on its machine's `CLOSED`.
    private func holdsNoVaultChanged(_ none: Bool) {
        if none {
            path = []
            tab = .home
            transferRulesOpen = false
            // A DISMISSAL, as the switcher's own swipe sends it: shut the
            // machine's sheet flag, change no vault.
            send(screen: HomeMachine.shared.SCREEN_ID, event: HomeEvents.vaultPicked(""))
        }
        holdsNoVault = none
    }

    // MARK: Chat

    /// THE CHAT TAB WAS PRESSED. It opens scoped to the app the member last
    /// had open — but only onto an empty thread: a conversation in progress is
    /// never re-scoped by a glance at an app.
    func openChatTab(asking question: String? = nil, thread: String? = nil, title: String = "") {
        leaveBackupTab()
        tab = .chat
        if !lastVisitedApp.isEmpty, chat.state.messages.isEmpty {
            chatScope = lastVisitedApp
        }
        lastVisitedApp = ""
        chat.open(app: chatScope, vaultName: foregroundVaultName, asking: question, thread: thread, title: title)
    }

    /// The foreground vault's name, for the chat's header.
    var foregroundVaultName: String {
        (try? Centraid_Screen_V1_HomeState(serializedBytes: homeState))?.vault.vaultName ?? ""
    }

    /// ASK THE ASSISTANT, from a screen that found nothing (search's "Ask
    /// about", #1097): back to Home's root, the Chat tab, and the question sent
    /// when the chat is ready. The router's act and not a view's: the view only
    /// reports the intent, and the words are the machine's.
    func askChat(_ question: String) {
        let line = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty else { return }
        path.removeAll()
        openChatTab(asking: line)
    }

    /// OPEN ONE PAST CHAT, from a screen that found it (Home's search, #1097,
    /// R-1097-24): back to Home's root, the Chat tab, and that thread opened.
    /// The router's act and not a view's, and the twin of `askChat`: the view
    /// reports the intent, the shell switches the tab. `title` is the hit's, so
    /// a chat older than the drawer's list still has its name in the header at
    /// once.
    func openChatThread(_ id: String, title: String) {
        guard !id.isEmpty else { return }
        path.removeAll()
        openChatTab(thread: id, title: title)
    }

    func openHomeTab() {
        leaveBackupTab()
        tab = .home
        // Chat keeps its thread, but not an open drawer: coming back to a
        // drawer left open would read as the app having forgotten the chat.
        chat.toggleDrawer(false)
    }

    /// THE COMPOSER'S SCOPE MENU: the chat opens on `app`, or on every app when
    /// it is empty. A different scope starts a new thread (the machine's
    /// `Opened` rule), exactly as clearing the old chip did.
    func setChatScope(_ app: String) {
        chatScope = app
        chat.open(app: app, vaultName: foregroundVaultName, scopeChosen: true)
    }

    /// The foreground vault changed. The chat belongs to the one that was in
    /// front, so it starts over; if it is showing, it opens again at once.
    func vaultChanged(to id: String) {
        let hadChat = chat.opened
        chat.vaultChanged(to: id)
        if hadChat, !chat.opened, tab == .chat { chat.open(app: chatScope, vaultName: foregroundVaultName) }
        // THE BACKUP TAB IS THE VAULT IN FRONT'S: another vault, another read.
        if tab == .backup { readBackup() }
    }

    /// A RESULT CARD WAS TAPPED: push the real row's route over the thread.
    func openChatCard(
        _ card: Centraid_Screen_V1_ChatCard,
        among cards: [Centraid_Screen_V1_ChatCard]
    ) {
        guard let route = ChatRouting.route(for: card, among: cards) else { return }
        path.append(route)
    }

    /// Remember the scope a route gives the Chat tab.
    private func noteVisit(_ route: Route) {
        guard let app = ChatRouting.app(of: route) else { return }
        let scope = ChatRouting.scope(of: app)
        guard !scope.isEmpty else { return }
        lastVisitedApp = scope
    }

    // MARK: The 24 words (#1047 E2)

    /// SHUT THE VAULT SWITCHER, changing no vault: its make and restore rows
    /// open sheets of their own (R-ONBOARD-11), and iOS drops a sheet asked
    /// for over one still up. A pick with no id is the machine's "shut".
    /// Answers how long to wait before presenting: the switcher's own
    /// dismissal has to finish first, or the next sheet is dropped.
    @discardableResult
    private func closeVaultSwitcher() -> Double {
        let state = (try? Centraid_Screen_V1_HomeState(serializedBytes: homeState)) ?? .init()
        guard state.vaultSheetOpen else { return 0 }
        send(screen: HomeMachine.shared.SCREEN_ID, event: HomeEvents.vaultPicked(""))
        return 0.45
    }

    /// MAKE A VAULT, THROUGH ITS WORDS. What the make-vault control does now:
    /// `words.make` decides whether this phone mints words, makes the next
    /// vault from a seed it already holds, or must restore first. The vault
    /// switcher goes first — one sheet at a time.
    ///
    /// THE SHEET RISES ONLY WHEN THE MEMBER HAS SOMETHING TO DO. A first
    /// vault on a synced keychain is minted, kept unshown and made with no
    /// question (R-ONBOARD-10), so a sheet raised at the tap drew "Making your
    /// vault" for a moment and fell again before Home — a flicker. The sheet
    /// waits for a phase that asks the member (`asksMember`); a make that
    /// never asks lands on Home with no sheet at all.
    func makeVault() {
        let wait = closeVaultSwitcher()
        makePending = true
        makeReadyAt = Date().addingTimeInterval(wait)
        vaultWords.open()
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) { self.presentMakeIfAsked() }
    }

    /// A make is under way and its sheet is not up yet.
    private var makePending = false
    /// Not before the switcher has gone: one sheet at a time.
    private var makeReadyAt = Date.distantPast

    private func presentMakeIfAsked() {
        guard makePending, Date() >= makeReadyAt, wordsSheet == nil else { return }
        let state = (try? Centraid_Screen_V1_VaultWordsState(serializedBytes: vaultWordsState)) ?? .init()
        if Self.asksMember(state.phase) {
            makePending = false
            wordsSheet = .make
        }
    }

    /// The phases of words.make that need the member: a name to choose, the
    /// key to see, a failure to retry or close, a restore to start.
    private static func asksMember(_ phase: Centraid_Screen_V1_VaultWordsState.Phase) -> Bool {
        switch phase {
        case .choose, .show, .failed, .restoreFirst: return true
        default: return false
        }
    }

    /// RESTORE ONTO THIS PHONE from the 24 words (`words.enter`,
    /// PURPOSE_RESTORE): the make-vault sheet's second door, the empty
    /// shelf's, and words.make's RESTORE_FIRST intent.
    func openRestore() {
        let wait = closeVaultSwitcher()
        wordsEntry.openRestore()
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) { self.wordsSheet = .enter }
    }

    /// HAND THE WORDS BACK to this phone's vaults (`words.enter`,
    /// PURPOSE_REKEY): Locker's wall's `WordsTapped` intent.
    func openRekey() {
        wordsEntry.openRekey()
        wordsSheet = .enter
    }

    /// The same re-key from pair.laptop's `WordsTapped`: the screen explains
    /// the words in pairing's terms, not Locker's (#1047 F5).
    private func openRekeyForPairing() {
        wordsEntry.openRekeyForPairing()
        wordsSheet = .enter
    }

    /// An event for `words.make`. `RestoreTapped` is an INTENT the machine
    /// ignores: the shell closes words.make (RESTORE_FIRST holds no words)
    /// and opens words.enter for a restore in its place.
    func sendVaultWords(_ event: Data) {
        vaultWords.send(event: event.kotlin)
        let decoded = (try? Centraid_Screen_V1_VaultWordsEvent(serializedBytes: event)) ?? .init()
        if case .restore = decoded.kind {
            // WHICH RESTORE IS THE STATE'S (#1047 E4): RESTORE_FIRST means
            // this phone holds a seed, so words.enter opens RESTORE_HELD — no
            // words to type, only the laptop's address.
            let purpose = ((try? Centraid_Screen_V1_VaultWordsState(serializedBytes: vaultWordsState)) ?? .init()).restorePurpose
            vaultWords.send(event: VaultWordsView.event { $0.dismissed = .init() }.kotlin)
            if purpose == .restoreHeld {
                wordsEntry.openRestoreHeld()
            } else {
                wordsEntry.openRestore()
            }
            wordsSheet = .enter
        }
    }

    func sendWordsEntry(_ event: Data) {
        wordsEntry.send(event: event.kotlin)
    }

    /// THE SHEET WAS SWIPED AWAY. words.make hears `Dismissed` (the words are
    /// dropped); words.enter has no dismissal of its own and its swipe is its
    /// Cancel — the sheet allows the swipe only while ENTERING.
    func wordsSwipedAway() {
        switch wordsSheet {
        case .make:
            sendVaultWords(VaultWordsView.event { $0.dismissed = .init() })
        case .enter:
            sendWordsEntry(WordsEntryView.event { $0.secondary = .init() })
        case .show:
            sendWordsShow(WordsShowView.event { $0.dismissed = .init() })
        case .pair:
            sendPairLaptop(PairLaptopView.event { $0.dismissed = .init() })
        case nil:
            break
        }
        wordsSheet = nil
    }

    // MARK: The Backup tab's custody controls (#1047 E5, R-ONBOARD-10)

    /// SHOW THE RECOVERY KEY AGAIN (`words.show`): the Backup tab's
    /// `key_show_label`. Any other sheet goes first — one sheet at a time.
    ///
    /// NO SHEET BEFORE THE CHECK: the machine opens in ASK with `check_now`,
    /// `wordsShowChanged` runs the owner check, and the sheet is presented
    /// only once the machine has something to draw.
    func openShowWords() {
        showWordsRequested = true
        wordsShow.open()
    }

    /// PAIR WITH THE LAPTOP (`pair.laptop`): the Backup screen's "Add".
    /// Whether this phone has a camera is the one fact the machine is told.
    func openPairLaptop() {
        pairLaptop.open(camera: PairScanner.available)
        DispatchQueue.main.async { self.wordsSheet = .pair }
    }

    // MARK: The Backup screen (#1080)

    /// OPEN THE BACKUP SCREEN: Home's backup line. The member's rule is read
    /// as it opens — the store is the authority, and the screen draws the same
    /// three sentences the Home header's sheet does.
    func openBackup() {
        // EVERY OPEN STARTS AT THE TOP, and the tab pressed again scrolls
        // back there: the title is never left under the vault's lockup.
        backupScrollTop += 1
        guard tab != .backup else { return }
        chat.toggleDrawer(false)
        tab = .backup
        readBackup()
    }

    /// THE BACKUP TAB'S READ: the rule's three sentences from the store, and
    /// the screen's `Opened`, which reads the line and the destinations.
    private func readBackup() {
        transferRuleChoices = home.transferRuleChoices().map {
            (stored: $0.stored, sentence: $0.sentence)
        }
        home.transferRule { [weak self] stored in self?.transferRule = stored }
        backup.open()
    }

    /// LEAVING THE BACKUP TAB tells its machine the screen is gone, as a
    /// swipe told the sheet it was.
    private func leaveBackupTab() {
        if tab == .backup { sendBackup(BackupEvents.dismissed()) }
    }

    func sendBackup(_ event: Data) {
        backup.send(event: event.kotlin)
    }

    /// "ADD A BACKUP DEVICE" IS PAIRING: `pair.laptop` opens over the Backup
    /// tab, with its scan and its paste field. The tab reads again when the
    /// pairing closes (`pairLaptopChanged`), so the new device's row is there.
    func addBackupDestination() {
        openPairLaptop()
    }

    /// "Show my 24 words" on the Backup tab: `words.show` opens over it.
    func backupShowWords() {
        openShowWords()
    }

    /// The Backup screen's state arrived.
    ///
    /// A run in flight holds no grace of its own here: the screen's state
    /// stops describing a run once the screen is dismissed, and leaving the
    /// app runs `enteredBackground`, which waits for a running pass inside its
    /// own grace ([wentToBackground]). The screen stays awake for the run
    /// through the core's own `backlog` hook, not through this shell.
    private func backupChanged(_ data: Data) {
        let before = BackupScreenModel(decoding: backupState)
        backupState = data
        let now = BackupScreenModel(decoding: data)
        // A GATEWAY FORGOTTEN OR ADDED CHANGES THE PINS: the mover must never
        // trust a certificate this phone no longer pairs with.
        if before.destinations.map(\.id) != now.destinations.map(\.id) { refreshUploadPins() }
    }

    func sendWordsShow(_ event: Data) {
        wordsShow.send(event: event.kotlin)
    }

    /// An event for `pair.laptop`. `WordsTapped` is an INTENT: the machine
    /// closes the pairing and the shell opens words.enter's re-key in its
    /// place — Locker's wall's door. The sheet swaps before the machine's
    /// CLOSED arrives, so that arrival leaves the words sheet up.
    func sendPairLaptop(_ event: Data) {
        pairLaptop.send(event: event.kotlin)
        if case .words = (try? Centraid_Screen_V1_PairLaptopEvent(serializedBytes: event))?.kind {
            openRekeyForPairing()
        }
    }

    /// THE APP LEFT THE FOREGROUND: words.show drops its words (`Dismissed`),
    /// as a swipe would. `.background` only — the owner check's own prompt
    /// makes the scene inactive, and that is not leaving.
    func leftForeground() {
        if wordsSheet == .show {
            sendWordsShow(WordsShowView.event { $0.dismissed = .init() })
        }
    }

    /// Pairing cannot be swiped away while the core is pairing.
    var pairLaptopSwipeable: Bool {
        ((try? Centraid_Screen_V1_PairLaptopState(serializedBytes: pairLaptopState)) ?? .init()).phase != .pairing
    }

    private func wordsShowChanged(_ data: Data) {
        wordsShowState = data
        let state = (try? Centraid_Screen_V1_WordsShowState(serializedBytes: data)) ?? .init()
        if state.checkNow, showWordsRequested, !ownerChecking {
            ownerChecking = true
            WordsShowView.ownerCheck(reason: state.verifyReason) { [weak self] event in
                self?.ownerChecking = false
                self?.sendWordsShow(event)
            }
        }
        if showWordsRequested, !state.checkNow, state.phase != .closed, state.phase != .unspecified,
           wordsSheet == nil {
            wordsSheet = .show
        }
        if state.phase == .closed { showWordsRequested = false }
        if state.phase == .closed, wordsSheet == .show {
            wordsSheet = nil
            // "I'VE SAVED IT" quiets the recovery key's warning (R-ONBOARD-10).
            if tab == .backup { readBackup() }
        }
    }

    private func pairLaptopChanged(_ data: Data) {
        let before = ((try? Centraid_Screen_V1_PairLaptopState(serializedBytes: pairLaptopState)) ?? .init()).phase
        pairLaptopState = data
        let state = (try? Centraid_Screen_V1_PairLaptopState(serializedBytes: data)) ?? .init()
        // A NEW DESTINATION IS A NEW PIN (#1080): the mover must hold its
        // certificate before the next batch is handed to the OS, which may be
        // the moment this app goes to the background.
        if state.phase == .paired, before != .paired { refreshUploadPins() }
        if state.phase == .closed, wordsSheet == .pair {
            wordsSheet = nil
            if tab == .backup { readBackup() }
        }
    }

    /// A swipe is a way out only where the machine hears one: not while the
    /// key is being kept or the vault made, and not while words.enter works.
    var vaultWordsSwipeable: Bool {
        let phase = ((try? Centraid_Screen_V1_VaultWordsState(serializedBytes: vaultWordsState)) ?? .init()).phase
        return phase != .checking && phase != .making
    }

    var wordsEntrySwipeable: Bool {
        ((try? Centraid_Screen_V1_WordsEntryState(serializedBytes: wordsEntryState)) ?? .init()).phase == .entering
    }

    private func vaultWordsChanged(_ data: Data) {
        vaultWordsState = data
        let state = (try? Centraid_Screen_V1_VaultWordsState(serializedBytes: data)) ?? .init()
        if state.phase == .closed {
            makePending = false
            if wordsSheet == .make { wordsSheet = nil }
        } else {
            presentMakeIfAsked()
        }
    }

    private func wordsEntryChanged(_ data: Data) {
        wordsEntryState = data
        let state = (try? Centraid_Screen_V1_WordsEntryState(serializedBytes: data)) ?? .init()
        if state.phase == .closed, wordsSheet == .enter {
            wordsSheet = nil
            // THE GATE RE-READS `keyed` ON ITS NEXT EVENT: a re-key that just
            // landed turns Locker's "Enter your 24 words" into "Unlock with …".
            LockerLockSeam.attached(self)
        }
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
        home.forget(vaultId: vaultID) {}
        // R-SHELL-2: member-visible sentences name the FOREGROUND holding,
        // not the last successful found() call. Forgetting (or switching away
        // from) a vault must not leave "Made Fresh Vault." over Tahoe Weekend.
        gatewayStatus = ""
    }

    /// RENAME A VAULT from the switcher: written into the vault's own file
    /// (`core.rename_vault`), and the header and the roster follow the shelf.
    /// A name that did not take says so on the switcher's status line.
    func renameVault(vaultID: String, name: String) {
        home.renameVault(vaultId: vaultID, name: name) { [weak self] renamed in
            DispatchQueue.main.async {
                self?.gatewayStatus = renamed.boolValue ? "" : HomeWords.shared.VAULTS_RENAME_FAILED
            }
        }
    }

    // MARK: One-tap imports (docs/decisions.md, "Onboarding without sample data")

    /// IMPORT FROM WHERE THE PHONE ALREADY HOLDS THE DATA, asked at the point
    /// of use: the OS asks its own permission now, and never at launch.
    /// Contacts → People, Calendar → Agenda, Reminders → Tasks.
    func importFromPhone(_ source: Centraid_Screen_V1_ImportSource) {
        guard !importing, let words = Self.importWords(source) else { return }
        // CONTACTS SHARED IN PART (iOS 18's limited access): a second ask
        // draws no prompt and reads only what was already shared, so the tap
        // opens iOS's picker to share more, and what it hands back is
        // imported (`contactsShared`).
        if source == .contacts, PhoneContacts.limited {
            contactAccessPickerShown = true
            return
        }
        importing = true
        importNotice = words.running
        // ASKED FROM THE APP ITSELF: the rows land on the page the member is
        // reading, so the line has nowhere else to send them.
        importOpens = ""
        Task { @MainActor in
            let sentence = await self.imported(source)
            self.importing = false
            self.importNotice = sentence ?? words.denied
        }
    }

    /// A VAULT WAS JUST MADE: contacts, calendar and reminders, one after
    /// another, after the photos (R-ONBOARD-8). One banner says what came in
    /// (`PhoneImport.madeSummary`); a store the member refused, or one with
    /// nothing in it, says nothing.
    private func importEverythingFromPhone() {
        guard !importing else { return }
        importing = true
        Task { @MainActor in
            var apps: [String] = []
            var outcomes: [String] = []
            for source in [Centraid_Screen_V1_ImportSource.contacts, .calendar, .reminders] {
                self.importNotice = Self.importWords(source)?.running ?? ""
                if let sentence = await self.imported(source) {
                    apps.append(Self.importApp(source))
                    outcomes.append(sentence)
                }
            }
            self.importing = false
            self.importNotice = PhoneImport.shared.madeSummary(outcomes: outcomes)
            // THE LINE'S ONE ACTION opens what came in (the first app that
            // received anything); a line with nothing new opens nothing.
            self.importOpens = self.importNotice.isEmpty ? "" : PhoneImport.shared.madeOpens(apps: apps, outcomes: outcomes)
        }
    }

    /// The app an import writes to: Contacts → People, Calendar → Agenda, Reminders → Tasks.
    /// Reminders land in the tasks domain, which opens in Agenda's To-do (#1128, R-1128-7):
    /// the id stays the write app's, and `openImported` routes it through `appHomeRoute`.
    private static func importApp(_ source: Centraid_Screen_V1_ImportSource) -> String {
        switch source {
        case .contacts: return "people"
        case .calendar: return "agenda"
        case .reminders: return "tasks"
        default: return ""
        }
    }

    private static func importWords(_ source: Centraid_Screen_V1_ImportSource) -> (running: String, denied: String)? {
        switch source {
        case .contacts: return (PeopleCopy.shared.IMPORT_CONTACTS_RUNNING, PeopleCopy.shared.IMPORT_CONTACTS_DENIED)
        case .calendar: return (AgendaCopy.shared.IMPORT_CALENDAR_RUNNING, AgendaCopy.shared.IMPORT_CALENDAR_DENIED)
        case .reminders: return (TasksCopy.shared.IMPORT_REMINDERS_RUNNING, TasksCopy.shared.IMPORT_REMINDERS_DENIED)
        default: return nil
        }
    }

    /// ONE IMPORT, AWAITED: the OS asks its permission, then the shared
    /// importer writes. The outcome's sentence, or nil when the OS said no.
    private func imported(_ source: Centraid_Screen_V1_ImportSource) async -> String? {
        switch source {
        case .contacts:
            switch await PhoneContacts.read() {
            case .denied: return nil
            case let .read(read):
                let sentence: String = await withCheckedContinuation { done in
                    contacts.sync(contacts: read.contacts, origins: read.origins, complete: read.complete) { outcome in
                        done.resume(returning: ContactsImport.shared.sentence(outcome: outcome))
                    }
                }
                // What an import leaves held (an account that left the phone) is asked by the follower.
                follow.requested(source: .contacts)
                return sentence
            }
        case .calendar:
            switch await PhoneCalendar.read() {
            case .denied: return nil
            case let .read(read):
                let sentence: String = await withCheckedContinuation { done in
                    calendar.sync(
                        events: read.events,
                        origins: read.origins,
                        complete: read.complete,
                        deviceTz: read.deviceTz,
                        now: read.now
                    ) { outcome in
                        done.resume(returning: CalendarImport.shared.sentence(outcome: outcome))
                    }
                }
                follow.requested(source: .calendar)
                return sentence
            }
        case .reminders:
            switch await PhoneReminders.read() {
            case .denied: return nil
            case let .read(found):
                return await withCheckedContinuation { done in
                    reminders.run(reminders: found) { done.resume(returning: $0) }
                }
            }
        default: return ""
        }
    }

    /// iOS's contact picker is up (limited access, iOS 18).
    @Published var contactAccessPickerShown = false

    /// THE PICKER CLOSED: read again, now over what it shared, and bring in what
    /// is new. Over limited access the read is incomplete, so nothing is trashed.
    /// Nothing shared is nothing to say.
    func contactsShared(_ identifiers: [String]) {
        guard !importing, !identifiers.isEmpty else { return }
        importing = true
        importNotice = PeopleCopy.shared.IMPORT_CONTACTS_RUNNING
        importOpens = ""
        Task { @MainActor in
            guard let read = await PhoneContacts.readIfGranted() else {
                self.importing = false
                self.importNotice = PeopleCopy.shared.IMPORT_CONTACTS_DENIED
                return
            }
            let sentence: String = await withCheckedContinuation { done in
                contacts.sync(contacts: read.contacts, origins: read.origins, complete: read.complete) { outcome in
                    done.resume(returning: ContactsImport.shared.sentence(outcome: outcome))
                }
            }
            self.importing = false
            self.importNotice = sentence
            self.follow.requested(source: .contacts)
        }
    }

    /// The app the import line's one action opens ("Open People"), or empty.
    @Published var importOpens = ""

    /// The import line's close key.
    func dismissImportNotice() {
        guard !importing else { return }
        importNotice = ""
        importOpens = ""
    }

    /// The import line's action: put the line away and open what came in.
    func openImported() {
        let app = importOpens
        dismissImportNotice()
        guard let route = ShellModel.Route.home(of: app) else { return }
        tab = .home
        path.append(route)
    }

    /// The member moved: a settled line has been read, and goes. A running
    /// import keeps its line, since the work it describes is not done.
    private func importLineMoved() {
        guard !importing, !importNotice.isEmpty else { return }
        importNotice = ""
        importOpens = ""
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
        switch destination {
        case .collections: photosCollections.opened()
        case .search: photosSearch.opened()
        case .library, .unspecified, .UNRECOGNIZED: break
        }
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
        let words = photoShelf.sentences()
        return PhotoShelfCopy(
            title: words.title,
            empty: words.empty,
            emptyRemedy: words.emptyRemedy,
            purgeWindow: words.purgeWindow,
            isTrash: words.isTrash,
            isArchive: words.isArchive
        )
    }

    /// THE TWO SHELVES THAT ARE REACHED FROM ANOTHER SCREEN, ENCODED.
    ///
    /// A place card and a memory each open the SAME screen —
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
        switch screen {
        case HomeMachine.shared.SCREEN_ID: home.send(event: event.kotlin)
        case PhotosScreens.grid: photos.send(event: event.kotlin)
        case PhotosScreens.shelf: photoShelf.send(event: event.kotlin)
        case PhotosScreens.lightbox: photoLightbox.send(event: event.kotlin)
        case PhotosScreens.picker: photoPicker.send(event: event.kotlin)
        case PhotosScreens.collections: photosCollections.send(event: event.kotlin)
        case PhotosScreens.search: photosSearch.send(event: event.kotlin)
        case PhotosScreens.places: places.send(event: event.kotlin)
        case PhotosScreens.duplicates: duplicates.send(event: event.kotlin)
        case PhotosScreens.duplicateReview: duplicateReview.send(event: event.kotlin)
        case PhotosScreens.memories: photosMemories.send(event: event.kotlin)
        case PhotosScreens.editor: photoEditor.send(event: event.kotlin)
        // EVERY REGISTERED SCREEN: a lookup, not a case (K5).
        default: ports[screen]?.send(event)
        }
    }

    /// "Send a copy" and "Download original" over a shelf's pick. The work is
    /// `ShelfCopyExport.swift`'s; this only lends it the shelf's bridge.
    func exportShelf(_ assetIdentifiers: [String], as kind: ShelfCopyExport.Kind) {
        ShelfCopyExport.run(kind, assetIdentifiers, bridge: photoShelf)
    }

    /// "Send a copy" over the library's selection — the shelf's batch hand-off,
    /// lent the grid's `LibraryCopies` so the outcome lands on the library.
    func exportLibrary(_ assetIdentifiers: [String], keepLocation: Bool) {
        ShelfCopyExport.run(.send(keepLocation: keepLocation), assetIdentifiers, bridge: photos.copies)
    }

    /// Open the transfer-rules sheet, reading the current rule as it opens.
    ///
    /// READ ON OPEN and not cached at launch: the store is the authority and a
    /// value held since launch is a value a second device — or this device's
    /// own restore — may have moved underneath.
    func openTransferRules() {
        transferRuleChoices = home.transferRuleChoices().map {
            (stored: $0.stored, sentence: $0.sentence)
        }
        home.transferRule { [weak self] stored in
            self?.transferRule = stored
        }
        transferRulesOpen = true
    }

    /// The member picked one.
    ///
    /// The published value is set from what came BACK, so the sheet draws what
    /// the store holds rather than what was tapped — an unknown word is the
    /// conservative default, and a selection the next launch would not have is
    /// worse than a tap that appears to do nothing.
    ///
    /// **A CHANGED RULE CANCELS WHAT iOS HOLDS** (#1080 A10). Each handed-off
    /// part carries the verdict of the rule it was handed off under, and iOS
    /// keeps a task for up to a day: a member who has just chosen to spend less
    /// must not be spent by an upload handed off before. Every task ends
    /// `CANCELLED`, the core requeues it, and the next handoff carries the new
    /// rule's verdict. A tap on the rule already held cancels nothing.
    func setTransferRule(_ stored: String) {
        let before = transferRule
        home.setTransferRule(stored: stored) { [weak self] settled in
            self?.transferRule = settled
            if settled != before { BackgroundUploader.shared.cancelEverything() }
        }
    }

    /// THE SCHEME THE WINDOW IS HELD TO, or nil to follow the phone.
    var preferredScheme: ColorScheme? {
        guard let held = home.appearanceHeldDark(stored: appearance) else { return nil }
        return held.boolValue ? .dark : .light
    }

    /// What the PHONE shows, under any hold this app puts on its own window:
    /// the screen's trait, which `preferredColorScheme` does not override.
    private var phoneDark: Bool {
        let screen = UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.screen }
            .first
        return screen?.traitCollection.userInterfaceStyle == .dark
    }

    /// Home's appearance key as drawn on a screen that is `dark`.
    func appearanceKey(dark: Bool) -> (iconKey: String, label: String) {
        let key = home.appearanceKey(dark: dark)
        return (key.iconKey, key.label)
    }

    /// The key's tap: flipped against the phone, written, and drawn from
    /// what the store answers.
    func toggleAppearance() {
        home.toggleAppearance(current: appearance, phoneDark: phoneDark) { [weak self] stored in
            self?.appearance = stored
        }
    }

    /// Run one camera-roll pass now (#1025 S6).
    ///
    /// Not a screen event, because it is not a reduction: the pass is a shell
    /// effect with I/O in it, and the states it publishes come BACK as
    /// `BackupChanged` events through the bridge's own runner. A view that sent
    /// an event here would be asking the reducer to do a file read.
    func backUpCameraRoll() {
        photos.backUpNow()
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
        noteVisit(route)
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
        case .photosMemories: photosMemories.opened()
        case .photoDuplicates: duplicates.opened()
        case let .photoEditor(identifier, _):
            photoEditor.opened(assetId: identifier)
        case let .photoDuplicateReview(clusterIdentifier):
            duplicateReview.opened(clusterId: clusterIdentifier)
        }
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
