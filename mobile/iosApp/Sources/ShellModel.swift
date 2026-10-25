import Combine
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
        /// A SCREEN RUST OWNS (#1135), drawn from the view state Rust sends
        /// (`RustScreenHost`). Pushing it opens the route on Rust's stack;
        /// popping it reports the pop. INTERIM HOSTING: this path still holds
        /// the back stack until the shell lane replaces it.
        case rust(RustEntry)
    }

    @Published var path: [Route] = [] {
        // A SETTLED IMPORT LINE GOES WITH THE NEXT MOVE (DESIGN.md: the line
        // never clears on a timer; the member's own next step puts it away).
        didSet {
            if path != oldValue {
                importLineMoved()
                rustPopped(from: oldValue)
            }
        }
    }

    /// THE SCREEN RUNTIME'S STORE (#1135), once a transport to the core is
    /// attached (`attachScreens`). The views of Rust-owned screens draw from it.
    @Published private(set) var screens: ScreenStore?
    /// The instance Rust opened for each Rust entry on `path`, by entry token.
    @Published private(set) var rustInstances: [Int: UInt64] = [:]
    private var rustOpening: Set<Int> = []
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

    /// THE FOREGROUND TRIGGER. The pass is Rust's: the scene's `.active` is reported as
    /// `AppLifecycle` (`CentraidApp`), and the pass scheduler decides that opening the app is
    /// worth a pass (`passes`). What is left here is Docs following the phone.
    func becameActive() {
        followPhone()
    }

    /// THE APP CAME FORWARD, or the OS announced a change: Docs follows the phone
    /// (#1127). Cheap; the shared gate decides whether a pass runs. Agenda's
    /// calendar, People's contacts and Health follow from their own screens (Rust
    /// asks the shell to read: `CalendarRead`, `ContactsRead`, `HealthRead`).
    func followPhone() {
        follow.requested(source: .files)
    }

    /// A folder was just followed, or picked again: read it now (#1127).
    func followFolders() {
        follow.requested(source: .files)
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
    /// An import is running: its banner has no exit until it ends.
    @Published var importing = false
    /// iOS's own contact picker is up: People's import met limited access (iOS 18).
    @Published var contactAccessPickerShown = false
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
    /// THE SCHEME THE WINDOW IS HELD TO, or nil to follow the phone: Home's
    /// `scheme` (R-CHROME-7), which Rust keeps in the Keychain (`ScreenStore.onHomeScheme`).
    @Published var preferredScheme: ColorScheme?
    /// The last thing the vault sheet said, in a member's words.
    ///
    /// A SENTENCE THE CORE ALREADY DECIDED WAS SHOWABLE. Nothing here composes
    /// one out of an error: `Error.detail` is logs-only, and a shell that made
    /// its own sentence from a peer's words would be the hole in that rule.
    @Published var gatewayStatus = "" {
        // The switcher's status line is Rust's (`HomeVaultSheet.status_line`); it is
        // told what a make or a restore came to, in the shelf's words.
        didSet { if gatewayStatus != oldValue { tellOutcome(gatewayStatus) } }
    }

    /// WHICH ROOT SHEET IS UP, if any. The 24 words' screens (`words.make`,
    /// `words.enter`, `words.show`) are Rust's and are pushed like any Rust route
    /// (`open`), not sheets.
    @Published var wordsSheet: WordsSheet?
    /// `pair.laptop`'s last state (#1047 E5), as bytes.
    /// Bumped on each open of the Backup tab: `BackupHomeView` scrolls to its top.
    @Published var backupScrollTop = 0
    @Published var pairLaptopState = Data()

    /// The root custody sheet: the two words screens (#1047 E2), and the two
    /// the More sheet's rows open (#1047 E5) — showing the words again, and
    /// pairing with the laptop.
    /// `backup` is the Backup screen (#1080): one sheet at the root like the
    /// custody screens, so "Add a gateway" can swap it for `pair` in place.
    enum WordsSheet: String, Identifiable {
        case pair
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

    /// Home's bridge into `CentraidShared`. Created once, observed once.
    ///
    /// Home is the only screen wired this way so far: wave A built it, so wave A
    /// connected it. The other three still go through `unwired()` below, and
    /// `mobile/README.md` carries that hand-off.
    private let home = HomeBridge()
    /// THE PHONE FOLLOWED (#1127): Docs and Health keep following what the phone
    /// holds after the member imported it. People's contacts and Agenda's calendar
    /// are Rust's (their home screens follow through the `ContactsRead` and
    /// `CalendarRead` effects); the gate, the passes and the question are in
    /// `CentraidShared`.
    private let follow = PhoneFollowBridge()
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
    /// THE CAMERA ROLL AND THE PHOTOS DEVICE (#1135, lane D): the roll, free up
    /// space and an original back from the gateway, which Rust's Photos screens ask
    /// for as effects (`ScreenStore`).
    private let photosDevice = PhotosDevice()

    /// `pair.laptop` (#1047 E5), held for the life of the shell.
    private let pairLaptop = PairLaptopBridge()
    /// THE BACKUP TAB'S ENTRY: the Rust screen `backup.home` the tab draws in
    /// place of the springboard. Interim hosting like every Rust page here: the
    /// shell opens the route on Rust's stack once (`openRust`) and the shell
    /// lane replaces the tab with the stack Rust holds. A vault switch makes a
    /// new entry, because the screen belongs to the core in front.
    var backupEntry = RustEntry.make(ShellModel.backupRoute)

    /// The route of the Backup screen. Rust builds every other route; this one
    /// is spelled here only while the tab is hosted by the shell.
    private static var backupRoute: Centraid_Core_V1_Route {
        var route = Centraid_Core_V1_Route()
        route.screen = "backup.home"
        route.backupHome = .init()
        return route
    }
    /// THE LINK AND THE CHARGER, reported to the pass scheduler (`PassFacts.swift`).
    private let links = LinkReporter()

    /// THE REGISTERED SCREENS' PORTS AND ROUTES (K5) — `ScreenRegistry.swift`.
    /// Filled once, in `init`, by `AppRegistry.apps`; held for the life of the
    /// shell for the same reason the Photos bridges below are.
    var ports: [String: ScreenPort] = [:]
    /// The one session, once it exists, so a port registered after it opens
    /// is still attached.
    var session: HomeSession?

    /// ATTACH THE SCREEN RUNTIME: the store that draws Rust-owned screens, over
    /// the core the session holds. Called once the transport exists.
    func attachScreens(core: any ScreenCore) {
        let store = ScreenStore(core: core)
        store.onOpenRoute = { [weak self] route in self?.open(route) }
        store.onVaultCommand = { [weak self] command in self?.perform(command) }
        store.onHomeScheme = { [weak self] scheme in
            let held: ColorScheme?
            switch scheme {
            case .light: held = .light
            case .dark: held = .dark
            default: held = nil
            }
            if self?.preferredScheme != held { self?.preferredScheme = held }
        }
        // HOME HAS ITS FIRST VIEW: tell it what the shelf already knows.
        store.onHomeAppeared = { [weak self] in
            self?.lastHomeFacts = [:]
            self?.tellHomeFacts()
            self?.tellPhoneScheme()
            self?.tellOutcome(self?.gatewayStatus ?? "")
        }
        store.onContactsLimited = { [weak self] in self?.contactAccessPickerShown = true }
        store.backgroundRegistered = { [weak self] in self?.session?.backgroundRegistered?.boolValue }
        screens = store
        // THE PASS SCHEDULER'S ROADS (`passes`): a granted window and what the OS uploaded reach
        // Rust as facts through the store, and the link is reported from the first reading.
        BackgroundPasses.store = store
        UploadSettlement.shared.attach(ScreenUploadSink(store))
        links.start(store)
        // AN UNLOCK is when Home's tile and chat's key slot learn the Locker is open.
        // (Rust files the key itself: `custody.filing` hears the same announcement.)
        store.onAnnounce = { [weak self] topic in
            switch topic {
            case "locker.unlocked":
                LockerEntry.shared.unlocked()
            // A GATEWAY WAS PAIRED (`pair.laptop`): the mover must hold its certificate.
            case "backup.destinations":
                self?.refreshUploadPins()
            // `pair.laptop` handed over to the words: a re-key, in pairing's terms.
            case "pair.rekey":
                self?.openRekeyForPairing()
            default:
                break
            }
        }
        Task {
            await store.start()
            store.reportEnvironment()
        }
    }

    /// Push a route Rust built onto the shell's stack (a row's `route`).
    func open(_ route: Centraid_Core_V1_Route) {
        path.append(.rust(RustEntry.make(route)))
    }

    /// Open a Rust entry's route on Rust's stack, once, and remember its instance.
    func openRust(_ entry: RustEntry) async {
        guard let screens, rustInstances[entry.token] == nil, !rustOpening.contains(entry.token) else { return }
        rustOpening.insert(entry.token)
        defer { rustOpening.remove(entry.token) }
        guard let instance = await screens.open(tab: RustScreens.tab(for: entry.route), route: entry.route) else { return }
        // Popped while the push was in flight: Rust is told at once.
        guard path.contains(.rust(entry)) || entry == backupEntry else {
            screens.popped(tab: RustScreens.tab(for: entry.route), instance: instance)
            return
        }
        rustInstances[entry.token] = instance
        // PHOTOS' HOME IS ON SCREEN: the camera-roll grant is read again (a read, never an ask).
        if entry.route.screen == "photos.home" { photosDevice.opened() }
    }

    /// A Rust entry left `path` (a back control, a swipe, Home): Rust drops its
    /// instance and everything above it. The lowest one removed is enough.
    private func rustPopped(from old: [Route]) {
        guard let screens else { return }
        let removed = old.compactMap { route -> RustEntry? in
            if case let .rust(entry) = route, !path.contains(route) { return entry }
            return nil
        }
        guard let lowest = removed.first else { return }
        for entry in removed { rustOpening.remove(entry.token) }
        guard let instance = rustInstances[lowest.token] else { return }
        for entry in removed { rustInstances[entry.token] = nil }
        screens.popped(tab: RustScreens.tab(for: lowest.route), instance: instance)
    }

    init() {
        home.observe { [weak self] bytes in
            self?.homeState = bytes.data
            // THE SHELF'S FACTS (vaults, backup line, ribbon) are told to Rust's Home.
            self?.tellHomeFacts()
        }
        home.observeHoldsNoVault { [weak self] none in self?.holdsNoVaultChanged(none.boolValue) }
        pairLaptop.observe { [weak self] bytes in self?.pairLaptopChanged(bytes.data) }
        // ONE LINE PER APP lives in `AppRegistry.apps`, not here.
        for app in AppRegistry.apps { app.register(into: self) }
        // THE SESSION OWNS THE ONE CORE (R-1020-24), so the app screens are
        // attached TO it rather than opening one. It is opened asynchronously,
        // so this is a callback and not a getter: there is exactly one moment
        // the session comes into existence and a poll would either miss it or
        // spin.
        home.onSession { [weak self] session in
            guard let self else { return }
            self.session = session
            self.attachScreens(core: SessionScreenCore(transport: session.screenTransport))
            for port in self.ports.values { port.attach(session) }
            self.photosDevice.attach(session: session)
            self.screens?.photos = self.photosDevice
            self.pairLaptop.attach(session: session)
            self.follow.attach(
                session: session,
                sources: [
                    FilesFollow(reader: FolderFollowReader()),
                ],
                ask: { [weak self] question in DispatchQueue.main.async { self?.followQuestion = question } }
            )
            if let screens = self.screens { self.chat.attach(store: screens) }
            // THE PINS, NOW THAT THE CORE CAN ANSWER `pins` (#1080).
            self.refreshUploadPins()
        }
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
    // THE OS-OWNED UPLOADS ARE RUST'S TO DECIDE AND THIS SHELL'S TO CARRY: the pass scheduler
    // (`passes`) asks for a hand-off batch and gives it to `BackgroundUploader` as an effect, and
    // what the OS reports comes back as facts through `UploadSettlement`, which holds a relaunch's
    // reports until `attachScreens` gives it the store. The pinned certificates still reach the
    // shell here, because a server-trust challenge is answered before any vault is open.

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
            // A DISMISSAL, as the switcher's own swipe sends it: shut Home's
            // sheet, change no vault.
            screens?.sendHome(.sheetClosed(.init()))
        }
        holdsNoVault = none
    }

    // MARK: Chat

    /// THE CHAT TAB WAS PRESSED. It opens scoped to the app the member last
    /// had open, but only onto an empty thread: a conversation in progress is
    /// never re-scoped by a glance at an app.
    func openChatTab() {
        tab = .chat
        if !lastVisitedApp.isEmpty, chat.state.messages.isEmpty {
            chatScope = lastVisitedApp
        }
        lastVisitedApp = ""
        chat.open(app: chatScope, vaultName: foregroundVaultName)
    }

    /// The foreground vault's name, for the chat's header.
    var foregroundVaultName: String {
        if let screens, let home = screens.homeInstance.flatMap({ screens.views[$0] })?.homeState {
            return home.bar.vault.name
        }
        return (try? Centraid_Screen_V1_HomeState(serializedBytes: homeState))?.vault.vaultName ?? ""
    }

    /// ASK THE ASSISTANT, from an app's search Ask row (#1097, #1135): a page of the chat
    /// (`chat.ask`) pushed over the stack, scoped to the app the member searched from (`scope`,
    /// empty is every app) with the question waiting for the model. Home's own search carries the
    /// finished route in its view state (`ask_route`) and pushes that. TRANSITIONAL: the app
    /// searches' view states hold the `SearchAsk` and not yet its route.
    func askChat(_ ask: Centraid_Screen_V1_SearchAsk) {
        let line = ask.question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty else { return }
        var route = Centraid_Core_V1_Route()
        route.screen = "chat.ask"
        route.ask = .with {
            $0.question = line
            $0.scope = ask.scope
        }
        open(route)
    }

    func openHomeTab() {
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
        // THE BACKUP SCREEN IS THE VAULT IN FRONT'S: another vault, another core,
        // another screen.
        backupEntry = RustEntry.make(ShellModel.backupRoute)
    }

    /// Remember the scope a route gives the Chat tab.
    private func noteVisit(_ route: Route) {
        guard let app = ChatRouting.app(of: route), app != BandPolicy.shared.PLACE_CHAT else { return }
        // Rust keeps the ids that are chat scopes and opens every app's otherwise (`chat::scope_of`).
        lastVisitedApp = app
    }

    // MARK: The 24 words (#1047 E2)

    /// SHUT THE VAULT SWITCHER, changing no vault: its make and restore rows
    /// open sheets of their own (R-ONBOARD-11), and iOS drops a sheet asked
    /// for over one still up. A pick with no id is the machine's "shut".
    /// Answers how long to wait before presenting: the switcher's own
    /// dismissal has to finish first, or the next sheet is dropped.
    @discardableResult
    private func closeVaultSwitcher() -> Double {
        guard screens?.homeView?.hasSheet == true else { return 0 }
        screens?.sendHome(.sheetClosed(.init()))
        return 0.45
    }

    /// MAKE A VAULT, THROUGH ITS WORDS. What the make-vault control does now:
    /// `words.make` (Rust's) decides whether this phone mints words, makes the
    /// next vault from a seed it already holds, or must restore first. The
    /// vault switcher goes first: one sheet at a time.
    func makeVault() {
        openAfterSwitcher(CustodyRoutes.make())
    }

    /// A vault was made (`WordsMakeState.made_line`, once per make): its
    /// sentence stays on the vault sheet, as `found`'s did, and the photos are
    /// asked for once (R-ONBOARD-8). The contacts and the calendar are offered
    /// by People's and Agenda's day-one empty states, which Rust owns (#1135).
    func vaultMade(_ sentence: String) {
        gatewayStatus = sentence
        photosDevice.askForPhotos {}
    }

    /// Open a custody screen once the vault switcher has gone.
    private func openAfterSwitcher(_ route: Centraid_Core_V1_Route) {
        let wait = closeVaultSwitcher()
        if wait == 0 {
            open(route)
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + wait) { self.open(route) }
        }
    }

    /// RESTORE ONTO THIS PHONE (`words.enter`): the make-vault sheet's second
    /// door and the empty shelf's. A phone already holding a seed restores from
    /// it, with no words typed (Rust decides).
    func openRestore() {
        openAfterSwitcher(CustodyRoutes.restore())
    }

    /// HAND THE WORDS BACK to this phone's vaults (`words.enter`, re-key):
    /// Locker's wall's `WordsTapped` intent.
    func openRekey() {
        open(CustodyRoutes.rekey(origin: .locker))
    }

    /// The same re-key from pair.laptop's `WordsTapped`: the screen explains
    /// the words in pairing's terms, not Locker's (#1047 F5).
    private func openRekeyForPairing() {
        open(CustodyRoutes.rekey(origin: .pairing))
    }

    /// `words.enter` finished: a Locker wall re-reads `keyed` on its next event, so
    /// a re-key that just landed turns Locker's "Enter your 24 words" into
    /// "Unlock with …".
    func wordsEnterFinished() {
        screens?.lifecycle(foreground: true)
    }

    /// `words.show` finished: "I'VE SAVED IT" quiets the recovery key's warning
    /// (R-ONBOARD-10), so the Backup tab reads again.
    func wordsShowFinished() {
        if tab == .backup { readBackup() }
    }

    // MARK: The Backup tab's custody controls (#1047 E5, R-ONBOARD-10)

    /// SHOW THE RECOVERY KEY AGAIN (`words.show`): the Backup tab's
    /// `key_show_label`. Rust asks the owner check before it draws anything.
    func openShowWords() {
        open(CustodyRoutes.show())
    }

    /// PAIR WITH THE LAPTOP (`pair.laptop`): the Backup screen's "Add".
    /// Whether this phone has a camera is the one fact the machine is told.
    func openPairLaptop() {
        pairLaptop.open(camera: PairScanner.available)
        DispatchQueue.main.async { self.wordsSheet = .pair }
    }

    // MARK: The Backup screen (#1080)

    /// OPEN THE BACKUP SCREEN: Home's backup line. The screen itself is Rust's
    /// (`backup.home`): it reads the rule from the phone's store and the line from
    /// the core as it opens.
    func openBackup() {
        // EVERY OPEN STARTS AT THE TOP, and the tab pressed again scrolls
        // back there: the title is never left under the vault's lockup.
        backupScrollTop += 1
        guard tab != .backup else { return }
        chat.toggleDrawer(false)
        tab = .backup
    }

    /// The Backup screen reads again: a sheet that closed over it may have
    /// changed what it shows (the key was marked saved, a device was paired).
    private func rereadBackup() {
        guard let screens, let instance = rustInstances[backupEntry.token] else { return }
        var event = Centraid_Core_V1_BackupHomeEvent()
        event.retry = .init()
        screens.send(instance, .backupHome(event))
    }

    /// "ADD A BACKUP DEVICE" IS PAIRING: `pair.laptop` opens over the Backup
    /// tab, with its scan and its paste field. The screen reads again when the
    /// pairing closes (`pairLaptopChanged`), so the new device's row is there.
    func addBackupDestination() {
        openPairLaptop()
    }

    /// "Show my 24 words" on the Backup tab: `words.show` opens over it.
    func backupShowWords() {
        openShowWords()
    }

    /// A GATEWAY FORGOTTEN OR ADDED CHANGES THE PINS: the mover must never trust
    /// a certificate this phone no longer pairs with.
    func backupDestinationsChanged() {
        refreshUploadPins()
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

    /// THE SHEET WAS SWIPED AWAY: only pairing is a root sheet now.
    func wordsSwipedAway() {
        if wordsSheet == .pair {
            sendPairLaptop(PairLaptopView.event { $0.dismissed = .init() })
        }
        wordsSheet = nil
    }

    /// Pairing cannot be swiped away while the core is pairing.
    var pairLaptopSwipeable: Bool {
        ((try? Centraid_Screen_V1_PairLaptopState(serializedBytes: pairLaptopState)) ?? .init()).phase != .pairing
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
            if tab == .backup { rereadBackup() }
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
    /// (`vault.rename`), and the header and the roster follow the shelf.
    /// A name that did not take says so on the switcher's status line.
    func renameVault(vaultID: String, name: String) {
        home.renameVault(vaultId: vaultID, name: name) { [weak self] renamed in
            DispatchQueue.main.async {
                // A refusal is Rust's to word (`OutcomeTold.rename_failed`).
                if renamed.boolValue {
                    self?.gatewayStatus = ""
                } else {
                    self?.screens?.sendHome(.outcomeTold(.with { $0.renameFailed = true }))
                }
            }
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
        // The app's front door is the route its Home tile carries.
        guard let route = screens?.homeView?.homeTile(of: app)?.route else { return }
        tab = .home
        open(route)
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
        // EVERY REGISTERED SCREEN: a lookup, not a case (K5).
        default: ports[screen]?.send(event)
        }
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

    /// What the PHONE shows, under any hold this app puts on its own window:
    /// the screen's trait, which `preferredColorScheme` does not override.
    private var phoneDark: Bool {
        let screen = UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.screen }
            .first
        return screen?.traitCollection.userInterfaceStyle == .dark
    }

    /// Tell Home whether the phone itself is dark: what "follow the phone" means.
    func tellPhoneScheme() {
        screens?.sendHome(.phoneSchemeTold(.with { $0.dark = phoneDark }))
    }

    // MARK: Home's facts (the shelf is KMP's, the words are Rust's)

    /// The last bytes told for each fact, so a KMP state that moved something else tells nothing.
    private var lastHomeFacts: [String: Data] = [:]

    private func tellOnce(_ key: String, _ event: Centraid_Core_V1_HomeEvent.OneOf_Kind, _ bytes: Data) {
        guard lastHomeFacts[key] != bytes else { return }
        lastHomeFacts[key] = bytes
        screens?.sendHome(event)
    }

    private static func shellVault(_ vault: Centraid_Screen_V1_VaultLockup) -> Centraid_Core_V1_ShellVault {
        .with {
            $0.vaultID = vault.vaultID
            $0.name = vault.vaultName
            $0.color = vault.color
            $0.originalsWithheld = vault.originalsWithheld
            switch vault.state {
            case .online: $0.state = .online
            case .frozen: $0.state = .frozen
            default: $0.state = .unspecified
            }
        }
    }

    private static func tone(_ tone: Centraid_Screen_V1_BackupLine.Tone) -> Centraid_Core_V1_HomeTone {
        switch tone {
        case .attention: return .attention
        case .urgent: return .urgent
        case .quiet: return .quiet
        default: return .unspecified
        }
    }

    /// Tell Rust's Home the vaults, the backup line and the ribbon the shelf holds.
    func tellHomeFacts() {
        guard let screens, screens.homeInstance != nil else { return }
        let state = (try? Centraid_Screen_V1_HomeState(serializedBytes: homeState)) ?? .init()
        let told = Centraid_Core_V1_HomeEvent.VaultsTold.with {
            $0.none = holdsNoVault == true
            if state.hasVault, !state.vault.vaultID.isEmpty || !state.vault.vaultName.isEmpty {
                $0.vault = Self.shellVault(state.vault)
            }
            $0.vaults = state.vaults.map(Self.shellVault)
        }
        tellOnce("vaults", .vaultsTold(told), (try? told.serializedData()) ?? Data())
        let backup = Centraid_Core_V1_HomeEvent.BackupLineTold.with {
            if state.hasBackupLine {
                $0.line = .with {
                    $0.status = state.backupLine.status
                    $0.tone = Self.tone(state.backupLine.tone)
                    $0.accessibilityLabel = state.backupLine.accessibilityLabel
                }
            }
        }
        tellOnce("backup-line", .backupTold(backup), (try? backup.serializedData()) ?? Data())
        let ribbon = Centraid_Core_V1_HomeEvent.StatusTold.with {
            if state.data.hasStatus {
                let status = state.data.status
                $0.status = .with {
                    switch status.tone {
                    case .attention: $0.tone = .attention
                    case .urgent: $0.tone = .urgent
                    case .quiet: $0.tone = .quiet
                    default: $0.tone = .unspecified
                    }
                    $0.copy = status.copy
                    $0.action = status.action
                    switch status.destination {
                    case .phone: $0.destination = .phone
                    case .notifications: $0.destination = .notifications
                    case .backup: $0.destination = .backup
                    case .none: $0.destination = .none
                    default: $0.destination = .unspecified
                    }
                }
            }
        }
        tellOnce("status", .statusTold(ribbon), (try? ribbon.serializedData()) ?? Data())
    }

    /// Tell Home what a make, a restore or a rename came to, in the shelf's words.
    func tellOutcome(_ sentence: String) {
        let told = Centraid_Core_V1_HomeEvent.OutcomeTold.with { $0.statusLine = sentence }
        tellOnce("outcome", .outcomeTold(told), (try? told.serializedData()) ?? Data())
    }

    /// WHAT HOME ASKED OF THE SHELF (`VaultCommand`): the vault files, their keys and
    /// the settings pages are this shell's; which and when is Rust's.
    func perform(_ command: Centraid_Core_V1_VaultCommand) {
        switch command.kind {
        case let .switchTo(id)?:
            clearStaleGatewayStatus()
            // The shelf re-points; the facts feed then tells Home the new lockup.
            home.switchVault(vaultId: id)
        case .make?: makeVault()
        case .restore?: openRestore()
        case let .forget(id)?: forget(vaultID: id)
        case let .rename(rename)?: renameVault(vaultID: rename.vaultID, name: rename.name)
        case let .open(destination)?:
            // The phone's own grant is changed in Settings (a notification or a
            // low-disk door); the backup place is native until Rust registers a tab.
            if destination == .backup { openBackup() }
            if destination == .phone || destination == .notifications,
                let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url)
            }
        case nil: break
        }
    }

    /// Run one camera-roll pass now (#1025 S6).
    ///
    /// Not a screen event, because it is not a reduction: the pass is a shell
    /// effect with I/O in it, and the states it publishes come BACK as
    /// `BackupChanged` events through the bridge's own runner. A view that sent
    /// an event here would be asking the reducer to do a file read.
    func backUpCameraRoll() {
        photosDevice.backUpNow()
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
        case .rust:
            // Opened on Rust's stack by its host (`openRust`), once per push.
            break
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
