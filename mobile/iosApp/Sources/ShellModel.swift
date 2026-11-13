import Combine
import Foundation
import SwiftUI
import UIKit

/// THE PROCESS'S ONE CORE AND THE SHELL OVER IT (#1020, D-1020-E1; #1135).
///
/// The shell opens ONE core over the directory the phone's vaults live in
/// (`{"shelf": dir}`, `CoreConfig::fronting`): the front holds no vault, and the
/// Rust shelf (`crates/screens/src/vault`) opens every vault under it, keys each
/// from the phone's secrets (`SecretBatch`, `SecretStores`), rests, wakes, founds
/// and forgets them, and sends every request about a vault to the vault in front.
/// One `ScreenStore` draws from it and performs every effect it asks for. Nothing
/// here decides: what this class keeps is SwiftUI's half (the stack it mirrors,
/// the switcher mask, the window's scheme) and the platform's facts it reports.
///
/// **`call` never runs here.** Every request goes through `Core`, off the main
/// thread, and the core asserts it is not on the UI thread.
@MainActor
final class ShellModel: ObservableObject {
    /// ONE PER PROCESS, AND REACHABLE WITHOUT A SCENE (#1080).
    ///
    /// A background relaunch (a `BGProcessingTask`, or iOS waking the app to
    /// report finished uploads) may never connect a scene, so the app delegate and
    /// `BackgroundPasses` reach the shell here rather than through SwiftUI's
    /// `@StateObject`, which `CentraidApp` points at this same instance. Two
    /// shells would be two openers of the vault directory, and the second would
    /// be refused every file the first holds.
    static let shared = ShellModel()

    enum Route: Hashable {
        /// A SCREEN RUST OWNS (#1135), drawn from the view state Rust sends
        /// (`RustScreenHost`). Pushing it opens the route on Rust's stack;
        /// popping it reports the pop.
        case rust(RustEntry)
    }

    @Published var path: [Route] = [] {
        didSet {
            if path != oldValue {
                importLineMoved()
                rustPopped(from: oldValue)
                // BACK FROM A ROW OPENED IN THE CHAT goes back to the chat, not to Home: the push
                // selects Home's stack in Rust, so the place the member left is put back once the
                // stack is empty again.
                if path.isEmpty, !oldValue.isEmpty, returnsToChat {
                    returnsToChat = false
                    screens?.selectTab(RustScreens.chatTab)
                }
            }
        }
    }

    /// A SCREEN THE ROUTE SAYS IS A SHEET (`Route.sheet`): Money's target, Photos' picker. It is
    /// presented over whatever page opened it and never joins `path`; Rust still holds it on its
    /// stack, so closing it by any road (its X, a swipe down, `finished`) reports the pop.
    @Published var sheet: RustEntry? {
        didSet {
            if sheet != oldValue { sheetClosed(oldValue) }
        }
    }

    /// A page was opened while the Chat place showed: the stack's last pop returns there.
    private var returnsToChat = false

    /// THE SCREEN RUNTIME'S STORE, once the core is open. Every view draws from it.
    @Published private(set) var screens: ScreenStore?
    /// THE VAULT FILE IS DAMAGED (`CENTRAID_VAULT_DAMAGED` at open): no core exists, so the root
    /// draws `VaultDamagedView` in place of bare paper. Set once, at launch.
    @Published private(set) var vaultDamaged = false
    /// A restore reopen succeeded and Home has yet to be told to enter the restore entry.
    private var restoreAsked = false
    /// The instance Rust opened for each Rust entry on `path`, by entry token.
    @Published private(set) var rustInstances: [Int: UInt64] = [:]
    private var rustOpening: Set<Int> = []
    /// THE SWITCHER MASK: painted on `.background`, so the snapshot iOS keeps
    /// for the app switcher shows no rows (`CentraidApp`).
    @Published var masked = false

    func mask() { masked = true }

    func unmask() { masked = false }

    /// THE PLACES OF THE BAND, as Rust selects them (`Navigation.selected_tab`).
    enum Tab: Hashable {
        case home, chat, backup
    }

    /// Which place the band's root shows: Rust's selection.
    var tab: Tab {
        switch screens?.navigation?.selectedTab {
        case RustScreens.chatTab?: return .chat
        case RustScreens.backupTab?: return .backup
        default: return .home
        }
    }

    /// THE ON-DEVICE CHAT, with its own observable (see `ChatModel`): a state
    /// per streamed token must not re-evaluate Home.
    let chat = ChatModel()

    /// The app the member last had open and has not yet carried into Chat. The
    /// next time the tab opens on an empty thread it is the scope, so asking
    /// "what is due" right after Tasks is about Tasks.
    private var lastVisitedApp = ""
    /// The scope the chat is in now, so a tab switch re-opens the same thread.
    private var chatScope = ""

    /// THE SCHEME THE WINDOW IS HELD TO, or nil to follow the phone: Home's
    /// `scheme` (R-CHROME-7), which Rust keeps in the Keychain.
    @Published var preferredScheme: ColorScheme?
    /// Bumped on each open of the Backup place: `BackupHomeView` scrolls to its top.
    @Published var backupScrollTop = 0
    /// iOS's own contact picker is up: People's import met limited access (iOS 18).
    @Published var contactAccessPickerShown = false
    /// THE MADE VAULT'S LINE THE MEMBER PUT AWAY (its summary): the close key, its
    /// action, or the member's next move once the work is done. Rust words the line.
    @Published private(set) var importLinePutAway = ""

    func putImportLineAway(_ summary: String) { importLinePutAway = summary }

    /// The member moved: a settled line has been read, and goes. A running import
    /// keeps its line, since the work it describes is not done.
    private func importLineMoved() {
        guard let line = screens?.madeLine, line.finished, !line.summary.isEmpty else { return }
        importLinePutAway = line.summary
    }

    /// REOPEN FOR RESTORE: the single place the core's `restoreDamaged` key is sent. The damaged
    /// screen's button calls it: open again over the same shelf with the key, and on success attach
    /// the core and let Home enter the Rust restore entry. If the open fails again the damaged
    /// screen stays.
    func reopenForRestore() {
        let directory = Self.vaultDirectory
        var configuration = Core.Configuration(shelf: directory, devSeed: Self.devSeedHex)
        configuration.restoreDamaged = true
        Task.detached(priority: .userInitiated) {
            do {
                let core = try Core.open(configuration)
                VaultFileProtection.secure(directory: directory)
                await MainActor.run {
                    let model = ShellModel.shared
                    model.restoreAsked = true
                    model.vaultDamaged = false
                    model.attach(core)
                }
            } catch {
                NSLog("centraid: the reopen for restore did not open: %@", String(describing: error))
            }
        }
    }

    /// THE LINK AND THE CHARGER, reported to the pass scheduler (`PassFacts.swift`).
    private let links = LinkReporter()
    private var enteredBackground: NotificationObservation?
    private var memoryWarning: NotificationObservation?
    private var environmentChanges: [NotificationObservation] = []

    init() {
        // **NOTHING UNDER THIS DIRECTORY GOES INTO iCLOUD BACKUP** (#1029, F5).
        // Once before the core opens, so the directory itself carries the
        // attribute, once after, so what the core just made carries it too, and
        // again on the way to the background: iOS does not inherit
        // `isExcludedFromBackup`, so each item needs it in its own right
        // (`VaultFileProtection` names every one, R-1029-8).
        let directory = Self.vaultDirectory
        VaultFileProtection.secure(directory: directory)
        let configuration = Core.Configuration(shelf: directory, devSeed: Self.devSeedHex)
        Task.detached(priority: .userInitiated) {
            do {
                let core = try Core.open(configuration)
                VaultFileProtection.secure(directory: directory)
                await MainActor.run { ShellModel.shared.attach(core) }
            } catch Core.Failure.vaultDamaged {
                NSLog("centraid: the vault is damaged")
                await MainActor.run { ShellModel.shared.vaultDamaged = true }
            } catch {
                // The screen stays on its ground; nothing here can word it.
                NSLog("centraid: the core did not open: %@", String(describing: error))
            }
        }
        enteredBackground = NotificationObservation(NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { _ in
            VaultFileProtection.secure(directory: directory)
        })
        // THE OS ASKING FOR MEMORY BACK IS THE ONLY THING THAT CLOSES A VAULT'S
        // CORE (#1025 S7-13, ruling F): the shelf closes every core but the one
        // in front, and a rested vault reopens on its next use.
        memoryWarning = NotificationObservation(NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.screens?.memoryWarning() }
        })
        // THE ZONE OR THE CLOCK CHANGED UNDER A RUNNING APP (#1185): Rust re-arms the
        // reminders from the environment it is told, so tell it again. `TimeZone.current`
        // caches the zone it first read, so the cache is dropped before the report.
        environmentChanges = [
            NSNotification.Name.NSSystemTimeZoneDidChange,
            UIApplication.significantTimeChangeNotification,
        ].map { name in
            NotificationObservation(NotificationCenter.default.addObserver(
                forName: name,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    NSTimeZone.resetSystemTimeZone()
                    self?.screens?.reportEnvironment()
                }
            })
        }
    }

    /// WHERE THIS DEVICE'S VAULTS LIVE. Documents and not Caches: a vault is the
    /// member's data, and the one directory iOS promises not to evict is this one.
    /// The DIRECTORY is the roster (one directory per vault), and Rust reads it.
    static var vaultDirectory: String {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].path
    }

    /// THE DEMO VAULT'S SEED, HANDED TO A DEBUG BUILD AT LAUNCH (#1047 W2).
    ///
    /// `mobile/scripts/demo-vault.sh ios` relaunches the app with
    /// `SIMCTL_CHILD_CENTRAID_DEV_SEED` set to what `seed-demo-vault` printed; the
    /// shelf stores it where a real seed lives (`devSeed`). A release build
    /// compiles `nil` here and carries nothing of the demo's.
    static var devSeedHex: String? {
        #if DEBUG
        ProcessInfo.processInfo.environment["CENTRAID_DEV_SEED"]
        #else
        nil
        #endif
    }

    // MARK: The store

    /// THE CORE IS OPEN: one store over it, and every road from the platform to
    /// Rust attached to it.
    private func attach(_ core: Core) {
        let store = ScreenStore(core: core)
        store.onOpenRoute = { [weak self] route in self?.open(route) }
        store.onHomeScheme = { [weak self] scheme in
            let held: ColorScheme?
            switch scheme {
            case .light: held = .light
            case .dark: held = .dark
            default: held = nil
            }
            if self?.preferredScheme != held { self?.preferredScheme = held }
        }
        store.onHomeAppeared = { [weak self] in
            self?.tellPhoneScheme()
            if self?.restoreAsked == true {
                self?.restoreAsked = false
                self?.screens?.sendHome(.restore(.init()))
            }
        }
        store.onClosed = { [weak self] instances in self?.rustClosed(instances) }
        store.onContactsLimited = { [weak self] in self?.contactAccessPickerShown = true }
        store.linkReading = { [weak self] in self?.links.reading ?? Centraid_Core_V1_LinkReading() }
        store.onAnnounce = { [weak self] topic in
            // A GATEWAY WAS PAIRED (`pair.laptop`): the mover must hold its certificate.
            if topic == "backup.destinations" { self?.refreshUploadPins() }
        }
        screens = store
        // THE PASS SCHEDULER'S ROADS (`passes`): a granted window and what the OS
        // uploaded reach Rust as facts through the store, and the link is reported
        // from the first reading.
        BackgroundPasses.store = store
        UploadSettlement.shared.attach(ScreenUploadSink(store))
        links.start(store)
        chat.attach(store: store)
        Task {
            store.reportEnvironment()
            await store.start()
            storeStarted = true
            let queued = queuedFacts
            queuedFacts = []
            for fact in queued { store.report(fact) }
            refreshUploadPins()
            // PRESSES THAT NEVER REACHED THE CORE (the app was suspended mid-press) go now, after the
            // store is up and not holding it: each waits for Rust's answer.
            await Notifications.drain(store)
        }
    }

    // MARK: Facts from outside the app

    /// FACTS THE PLATFORM REPORTED BEFORE THE STORE WAS UP (#1173). An App Intent can
    /// launch the app and run `perform()` before the core is open; the fact waits here
    /// and is delivered, in order, once the store has started.
    private var queuedFacts: [Centraid_Core_V1_ShellFact.OneOf_Fact] = []
    private var storeStarted = false

    /// Report a fact from outside a view (an App Intent): straight to Rust through the
    /// store when it is running, queued until it is when it is not.
    func reportWhenReady(_ fact: Centraid_Core_V1_ShellFact.OneOf_Fact) {
        if storeStarted, let screens {
            screens.report(fact)
        } else {
            queuedFacts.append(fact)
        }
    }

    /// Push a route Rust built onto the shell's stack (a row's `route`).
    func open(_ route: Centraid_Core_V1_Route) {
        if route.sheet {
            // ON THE STACK OF THE PLACE THE MEMBER IS IN, so Chat stays under its sheet.
            let place: String
            switch tab {
            case .chat: place = RustScreens.chatTab
            case .backup: place = RustScreens.backupTab
            case .home: place = RustScreens.homeTab
            }
            sheet = RustEntry.make(route, tab: place)
            return
        }
        if path.isEmpty { returnsToChat = tab == .chat }
        path.append(.rust(RustEntry.make(route)))
    }

    /// Open a Rust entry's route on Rust's stack, once, and remember its instance.
    func openRust(_ entry: RustEntry) async {
        guard let screens, rustInstances[entry.token] == nil, !rustOpening.contains(entry.token) else { return }
        rustOpening.insert(entry.token)
        defer { rustOpening.remove(entry.token) }
        guard let instance = await screens.open(tab: entry.tab, route: entry.route) else { return }
        // Popped while the push was in flight: Rust is told at once.
        guard path.contains(.rust(entry)) || sheet == entry else {
            screens.popped(tab: entry.tab, instance: instance)
            return
        }
        rustInstances[entry.token] = instance
    }

    /// THE APPS' HOME CONTROL: every page above Home's root goes. The path empties (SwiftUI's own
    /// stack, which `rustPopped` reports as `NavPopped` for the lowest entry) and Rust is told the
    /// move itself, as Compose tells it: `NavPopToRoot` closes whatever is left above the root.
    func popToRoot() {
        sheet = nil
        guard !path.isEmpty else { return }
        returnsToChat = false
        path.removeAll()
        screens?.popToRoot(tab: RustScreens.homeTab)
    }

    /// RUST CLOSED INSTANCES: the pages drawing them leave `path`. A closed instance has no view
    /// state left to draw, so the entry would stay as bare paper over Home (the vault just made
    /// closes its own page this way). Rust already dropped them, so it is not told `NavPopped`.
    private func rustClosed(_ instances: [UInt64]) {
        let gone = Set(instances)
        if let open = sheet, let instance = rustInstances[open.token], gone.contains(instance) {
            rustInstances[open.token] = nil
            sheet = nil
        }
        let entries = path.compactMap { route -> RustEntry? in
            if case let .rust(entry) = route, let instance = rustInstances[entry.token], gone.contains(instance) {
                return entry
            }
            return nil
        }
        guard !entries.isEmpty else { return }
        for entry in entries { rustInstances[entry.token] = nil }
        path.removeAll { route in
            if case let .rust(entry) = route { return entries.contains(entry) }
            return false
        }
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
        screens.popped(tab: RustScreens.homeTab, instance: instance)
    }

    /// The sheet left (its X, a swipe down, `finished`, Home): Rust drops its instance.
    private func sheetClosed(_ old: RustEntry?) {
        guard let old else { return }
        rustOpening.remove(old.token)
        guard let instance = rustInstances[old.token] else { return }
        rustInstances[old.token] = nil
        screens?.popped(tab: old.tab, instance: instance)
    }

    /// Tell a route it is on screen: the chat's scope follows the app last open.
    func opened(_ route: Route) {
        guard let app = ChatRouting.app(of: route), app != RustScreens.chatTab else { return }
        lastVisitedApp = app
    }

    /// `words.show` finished: "I'VE SAVED IT" quiets the recovery key's warning
    /// (R-ONBOARD-10), so the Backup place reads again.
    func wordsShowFinished() {
        guard let screens, let backup = screens.entries(of: RustScreens.backupTab).first?.instance else { return }
        var event = Centraid_Core_V1_BackupHomeEvent()
        event.retry = .init()
        screens.send(backup, .backupHome(event))
    }

    // MARK: The band

    /// A press on a place of the band: Rust selects it. Chat opens scoped to the
    /// app the member last had open, but only onto an empty thread; pressed again
    /// while it shows, it only shuts the drawer.
    func select(place: String) {
        importLineMoved()
        returnsToChat = false
        switch place {
        case RustScreens.chatTab:
            if tab == .chat {
                chat.toggleDrawer(false)
                return
            }
            screens?.selectTab(place)
            if !lastVisitedApp.isEmpty, chat.state.messages.isEmpty { chatScope = lastVisitedApp }
            lastVisitedApp = ""
            chat.open(app: chatScope, vaultName: foregroundVaultName)
        case RustScreens.backupTab:
            // EVERY OPEN STARTS AT THE TOP, and the place pressed again scrolls back there.
            backupScrollTop += 1
            chat.toggleDrawer(false)
            screens?.selectTab(place)
        default:
            // Chat keeps its thread, but not an open drawer.
            chat.toggleDrawer(false)
            screens?.selectTab(place)
        }
    }

    /// The foreground vault's name, for the chat's header.
    var foregroundVaultName: String {
        screens?.homeView?.bar.vault.name ?? ""
    }

    /// THE COMPOSER'S SCOPE MENU: the chat opens on `app`, or on every app when
    /// it is empty. A different scope starts a new thread.
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
    }

    // MARK: Lifecycle

    /// THE APP CAME FORWARD OR LEFT: Rust hears it (the Locker relocks on leaving,
    /// the pass service decides what coming back is worth, the follow coordinator
    /// follows every phone store the member connected), and the photo library is
    /// watched while the app is in view.
    func lifecycle(foreground: Bool) {
        guard let screens else { return }
        if foreground {
            screens.reportEnvironment()
            tellPhoneScheme()
        }
        screens.lifecycle(foreground: foreground)
        #if os(iOS)
        if foreground { LibraryWatcher.shared.registerIfAllowed() }
        #endif
    }

    /// What the PHONE shows, under any hold this app puts on its own window.
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

    // MARK: The background mover's pins (#1080 §2, A11)

    /// Re-read the pinned certificates from the core and keep them where a cold
    /// background launch can read them (`UploadPins`): when the core opens, when a
    /// pairing lands and when a gateway is forgotten — the moments the core's
    /// answer to `pins` changes. A refusal keeps the pins as they were.
    func refreshUploadPins() {
        guard let screens else { return }
        Task {
            guard let destinations = await screens.pins() else { return }
            var table: [String: UploadPins.Pin] = [:]
            for destination in destinations {
                table[destination.gatewayID] = UploadPins.Pin(
                    certificate: destination.certDer,
                    hosts: destination.addrs.map { UploadPins.host(of: $0) }
                )
            }
            BackgroundUploader.shared.pins.replace(with: table)
        }
    }
}
