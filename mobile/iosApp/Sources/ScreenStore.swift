import Combine
import Contacts
import EventKit
import Foundation
import Security
import SwiftProtobuf

#if os(iOS)
import Photos
import PhotosUI
import UIKit
#endif

/// WHAT THE STORE TALKS TO: the core (`Core`), or a test's stand-in for it.
protocol ScreenCore: Sendable {
    func call(_ request: Centraid_Core_V1_Request) async throws -> Centraid_Core_V1_Response
    /// The same call on a lane of its own (`Core.Lane`): the stage door's bytes.
    func call(_ request: Centraid_Core_V1_Request, lane: Core.Lane) async throws -> Centraid_Core_V1_Response
    var updates: AsyncStream<Centraid_Core_V1_ScreenUpdate> { get }
}

extension Core: ScreenCore {}

/// WHAT SWIFTUI DRAWS FROM (#1135, lane C2): the latest navigation and the
/// latest view state of every open screen, exactly as Rust made them.
///
/// The store keeps no copy of its own and decides nothing. It forwards events,
/// applies updates (dropping any older than what it holds — each view and each
/// navigation carries a revision, so a push that overtakes a response is not
/// undone by it), and performs the platform work Rust asks for, answering each
/// effect with an event. A screen is a `ViewState` whichever screen made it.
@MainActor
final class ScreenStore: ObservableObject {
    @Published private(set) var navigation: Centraid_Core_V1_Navigation?
    @Published private(set) var views: [UInt64: Centraid_Core_V1_ViewState] = [:]
    /// THE SCREENS RUST SHIELDED (`ScreenshotShield`): `RustScreenView` draws an instance in
    /// `WordsShield` while its id is here. Dropped when the screen closes.
    @Published private(set) var shielded: Set<UInt64> = []

    /// Told when Rust announces something the shell may act on (a gateway paired).
    var onAnnounce: ((String) -> Void)?

    private let core: any ScreenCore
    private var closed: Set<UInt64> = []
    /// Instances this shell opened with `open`, so two opens never claim one entry.
    private var claimed: Set<UInt64> = []
    /// The phone stores being watched (`PhoneWatch`), each under the effect that asked.
    private var watches: [UInt64: (instance: UInt64, source: Centraid_Core_V1_ImportSource)] = [:]
    private var storeObservers: [NSObjectProtocol] = []
    /// OPEN A PAGE NOW, wherever the member is (`OpenRoute`): the shell pushes the
    /// route as it pushes a tapped row's route. Set by `ShellModel`.
    var onOpenRoute: ((Centraid_Core_V1_Route) -> Void)?
    /// Home's `scheme` moved (the member's light/dark choice, which Rust keeps).
    var onHomeScheme: ((Centraid_Core_V1_HomeScheme) -> Void)?
    /// Home's first view arrived: the shell tells it the phone's scheme.
    var onHomeAppeared: (() -> Void)?
    private var homeTold: UInt64?
    /// An import over iOS's limited contact access: the shell raises the system's picker.
    var onContactsLimited: (() -> Void)?
    /// THE LINK NOW, for the camera roll's `LinkRead` (`LinkReporter.reading`).
    var linkReading: (() -> Centraid_Core_V1_LinkReading)?

    /// THE PASS SCHEDULER'S WINDOWS (`passes` in Rust): a granted background window waits
    /// here, by name, for `PassWindowDone`, which carries the answer `setTaskCompleted` takes.
    private var windowWaiters: [String: CheckedContinuation<Bool, Never>] = [:]
    /// The UIKit grace held while the app leaves the screen and Rust runs its pass; released
    /// on `PassWindowDone` for the background entry (or by iOS taking it back).
    #if os(iOS)
    private var backgroundGrace: ForegroundGrace?
    #endif
    /// EACH SCREEN'S EFFECTS, PERFORMED IN THE ORDER IT ASKED (`docs/screens.md`, phone
    /// imports): a service tells its answers apart by what they answer, so a cursor write that is
    /// answered after the wait behind it would be taken for the wait. One queue per instance; an
    /// effect that answers more than once and for long (a model download, a browse, a pick)
    /// answers through its own callback and does not hold the queue.
    private var queues: [UInt64: [Centraid_Core_V1_EffectRequest]] = [:]
    private var running: Set<UInt64> = []
    /// The `words.make` instances whose made vault the made-vault imports were told of.
    private var madeTold: Set<UInt64> = []

    init(core: any ScreenCore) {
        self.core = core
        #if os(iOS)
        // THE PHOTO LIBRARY CHANGED while the app is in view: a nudge to the camera roll.
        LibraryWatcher.shared.onChange = { [weak self] in
            var event = Centraid_Core_V1_ImportsCameraRollEvent()
            event.libraryChanged = .init()
            self?.sendRoot(RustScreens.cameraRollTab, .importsCameraRoll(event))
        }
        LibraryWatcher.shared.registerIfAllowed()
        #endif
    }

    /// Apply the core's pushed updates for as long as it lives, then open the
    /// tabs' roots. Call once.
    func start() async {
        Task { [core] in
            for await update in core.updates { await self.apply(update) }
        }
        await request(.snapshot(Centraid_Core_V1_SnapshotRequest()))
    }

    /// Send an event to one screen instance.
    func send(_ instance: UInt64, _ event: Centraid_Core_V1_ScreenEvent.OneOf_Kind) {
        var inner = Centraid_Core_V1_ScreenEvent()
        inner.kind = event
        var outer = Centraid_Core_V1_InstanceEvent()
        outer.instance = instance
        outer.event = inner
        Task { await request(.send(outer)) }
    }

    /// Report a tap on a link or a back-swipe; Rust moves the stack.
    func navigate(_ event: Centraid_Core_V1_NavEvent.OneOf_Kind) {
        var nav = Centraid_Core_V1_NavEvent()
        nav.kind = event
        Task { await request(.nav(nav)) }
    }

    /// The app left or came back to the foreground; Rust tells every open screen
    /// (a Locker relocks the instant it leaves). `.background` only, never
    /// `.inactive`, which a system prompt causes.
    func lifecycle(foreground: Bool) {
        #if os(iOS)
        // LEAVING THE SCREEN RUNS A PASS UNDER THE PLATFORM'S GRACE (Rust asks for it): hold the
        // UIKit background task until Rust says that pass ended (`PassWindowDone`).
        if !foreground, backgroundGrace == nil { backgroundGrace = ForegroundGrace(name: "dev.centraid.pass.background") }
        #endif
        var lifecycle = Centraid_Core_V1_AppLifecycle()
        lifecycle.foreground = foreground
        Task { await request(.lifecycle(lifecycle)) }
    }

    /// Report a fact about the phone (the link, a granted window, an upload the OS finished);
    /// the pass scheduler in Rust decides what it means.
    func report(_ fact: Centraid_Core_V1_ShellFact.OneOf_Fact) {
        var shell = Centraid_Core_V1_ShellFact()
        shell.fact = fact
        Task { await request(.shellFact(shell)) }
    }

    /// A BACKGROUND WINDOW THE OS GRANTED: tell Rust, then wait for the pass it runs to end.
    /// Answers whether every held vault's spool emptied (what `setTaskCompleted(success:)` takes).
    func windowGranted(_ name: String, budgetMs: UInt64) async -> Bool {
        await withCheckedContinuation { continuation in
            windowWaiters[name]?.resume(returning: false)
            windowWaiters[name] = continuation
            var granted = Centraid_Core_V1_WindowGranted()
            granted.window = name
            granted.deadlineMs = budgetMs
            report(.window(granted))
        }
    }

    /// iOS took the window back: forget it, so the next grant is not mistaken for this one.
    func windowExpired(_ name: String) {
        windowWaiters.removeValue(forKey: name)?.resume(returning: false)
        var expired = Centraid_Core_V1_WindowExpired()
        expired.window = name
        report(.expired(expired))
    }

    /// Report the device's locale, zone and OS, and that Photos deletes from the
    /// library behind its own confirmation; Rust formats from them and offers
    /// "Free up space" only where the platform can.
    func reportEnvironment() {
        var environment = Centraid_Core_V1_Environment()
        environment.locale = Locale.current.identifier
        environment.zone = TimeZone.current.identifier
        environment.platform = "ios"
        environment.libraryDeletes = true
        Task { await request(.environment(environment)) }
    }

    /// THE OS WANTS ITS MEMORY BACK: the shelf closes every vault's core but the one in front.
    func memoryWarning() {
        Task { await request(.memoryWarning(Centraid_Core_V1_MemoryWarning())) }
    }

    /// THE CERTIFICATES THE BACKGROUND MOVER PINS: the core's `pins`, read from the ledger of
    /// the vault in front; nil when it would not answer.
    func pins() async -> [Centraid_Core_V1_Destination]? {
        var request = Centraid_Core_V1_Request()
        request.kind = .pins(Centraid_Core_V1_PinsRequest())
        guard let response = try? await core.call(request), case let .pins(answer)? = response.kind else { return nil }
        return answer.destinations
    }

    /// Send `event` to the root of `tab`: the phone imports' hidden tabs, which the shell
    /// tells only what the platform alone knows.
    func sendRoot(_ tab: String, _ event: Centraid_Core_V1_ScreenEvent.OneOf_Kind) {
        guard let root = entries(of: tab).first?.instance else { return }
        send(root, event)
    }

    /// THE MADE VAULT'S ONE LINE (`imports.made`, the root of its hidden tab): what came in,
    /// and the app it opens. Nil before it has a view.
    var madeLine: Centraid_Core_V1_ImportsMadeState? {
        guard let root = entries(of: RustScreens.madeTab).first?.instance,
            case let .importsMade(state)? = views[root]?.kind
        else { return nil }
        return state
    }

    /// Push a route onto a tab and answer the instance Rust opened for it, or
    /// nil when the push was not answered. The shell remembers the instance:
    /// it draws that instance's view and reports its pop (`popped`).
    func open(tab: String, route: Centraid_Core_V1_Route) async -> UInt64? {
        let before = Set(entries(of: tab).map(\.instance))
        var push = Centraid_Core_V1_NavPush()
        push.tab = tab
        push.route = route
        var nav = Centraid_Core_V1_NavEvent()
        nav.kind = .push(push)
        await request(.nav(nav))
        let opened = entries(of: tab).last { !before.contains($0.instance) && !claimed.contains($0.instance) }?.instance
        if let opened { claimed.insert(opened) }
        return opened
    }

    /// The shell popped a screen it opened (a back control or a swipe); Rust drops it.
    func popped(tab: String, instance: UInt64) {
        claimed.remove(instance)
        var popped = Centraid_Core_V1_NavPopped()
        popped.tab = tab
        popped.instance = instance
        navigate(.popped(popped))
    }

    /// HOME'S INSTANCE: the root of the `home` tab.
    var homeInstance: UInt64? { entries(of: RustScreens.homeTab).first?.instance }

    /// Home's latest state, once it has been drawn.
    var homeView: Centraid_Core_V1_HomeState? {
        homeInstance.flatMap { views[$0] }?.homeState
    }

    /// Send an event to Home.
    func sendHome(_ kind: Centraid_Core_V1_HomeEvent.OneOf_Kind) {
        guard let instance = homeInstance else { return }
        var event = Centraid_Core_V1_HomeEvent()
        event.kind = kind
        send(instance, .home(event))
    }

    /// A band press: Rust selects the tab and the shell hears the new navigation.
    func selectTab(_ tab: String) {
        var select = Centraid_Core_V1_NavSelectTab()
        select.tab = tab
        navigate(.selectTab(select))
    }

    /// Every page above the tab's root goes (the apps' Home control): Rust closes them in one move.
    func popToRoot(tab: String) {
        var pop = Centraid_Core_V1_NavPopToRoot()
        pop.tab = tab
        navigate(.popToRoot(pop))
    }

    /// A tab's stack, root first, as Rust holds it.
    func entries(of tab: String) -> [Centraid_Core_V1_StackEntry] {
        navigation?.tabs.first { $0.tab == tab }?.entries ?? []
    }

    private func request(_ kind: Centraid_Core_V1_ScreenRequest.OneOf_Kind) async {
        var screen = Centraid_Core_V1_ScreenRequest()
        screen.kind = kind
        var request = Centraid_Core_V1_Request()
        request.kind = .screen(screen)
        guard let response = try? await core.call(request),
            case .screen(let answer)? = response.kind
        else { return }
        apply(answer.update)
    }

    private func apply(_ update: Centraid_Core_V1_ScreenUpdate) {
        if update.hasNavigation, update.navigation.revision >= (navigation?.revision ?? 0) {
            navigation = update.navigation
        }
        for id in update.closed {
            closed.insert(id)
            views[id] = nil
            queues[id] = nil
            shielded.remove(id)
            // A BROWSE LASTS AS LONG AS THE SCREEN THAT ASKED FOR IT.
            GatewayBrowsing.shared.stop(id)
        }
        for view in update.views
        where !closed.contains(view.instance) && view.revision > (views[view.instance]?.revision ?? 0) {
            views[view.instance] = view
            if let home = view.homeState {
                onHomeScheme?(home.scheme)
                if homeTold != view.instance {
                    homeTold = view.instance
                    onHomeAppeared?()
                }
            }
            // A VAULT WAS JUST MADE: the made-vault imports hear it (the photo prompt, then
            // the contacts, the calendar and the reminders, each its own ask).
            if case let .wordsMake(make)? = view.kind, make.finished, !make.madeLine.isEmpty,
                madeTold.insert(view.instance).inserted
            {
                var made = Centraid_Core_V1_ImportsMadeEvent()
                made.made = .with { $0.reminders = true }
                sendRoot(RustScreens.madeTab, .importsMade(made))
            }
        }
        for effect in update.effects { enqueue(effect) }
    }

    /// Queue `request` behind what its screen asked before, and run the queue.
    private func enqueue(_ request: Centraid_Core_V1_EffectRequest) {
        queues[request.instance, default: []].append(request)
        drain(request.instance)
    }

    private func drain(_ instance: UInt64) {
        guard !running.contains(instance), var queue = queues[instance], !queue.isEmpty else { return }
        let next = queue.removeFirst()
        queues[instance] = queue
        running.insert(instance)
        Task {
            await perform(next)
            running.remove(instance)
            drain(instance)
        }
    }

    // MARK: - effects

    /// Perform what Rust asked and answer it by `effect_id`. Returns once the one answer is
    /// given; an effect that answers later, or more than once, answers through its own callback
    /// and returns at once, so its screen's next effect is not held behind a member's pick. A
    /// screen popped meanwhile tolerates a late answer.
    private func perform(_ request: Centraid_Core_V1_EffectRequest) async {
        let done = Centraid_Core_V1_EffectResult.OneOf_Outcome.done(Centraid_Core_V1_EffectDone())
        switch request.effect.kind {
        #if os(iOS)
        case .clipboardSet(let set)?:
            if set.sensitive && set.clearAfterMs_p > 0 {
                // THE OS KEEPS THE DEADLINE: a pasteboard item expires on its own, so a killed app
                // cannot leave a secret behind, and `localOnly` keeps it off Universal Clipboard.
                UIPasteboard.general.setItems(
                    [["public.utf8-plain-text": set.text]],
                    options: [
                        .expirationDate: Date(timeIntervalSinceNow: Double(set.clearAfterMs_p) / 1000),
                        .localOnly: true,
                    ]
                )
            } else {
                UIPasteboard.general.string = set.text
            }
            answer(request, done)
        case .clipboardClear(let clear)?:
            // Only what the core put there: never clear something the member copied since.
            if UIPasteboard.general.string == clear.expectedText { UIPasteboard.general.string = "" }
            answer(request, done)
        case .haptic(let haptic)?:
            Self.play(haptic.kind)
            answer(request, done)
        case .share(let share)?:
            Self.present(share)
            answer(request, done)
        case .openURL(let link)?:
            if let url = URL(string: link.url) {
                UIApplication.shared.open(url, options: [:], completionHandler: nil)
                answer(request, done)
            } else {
                answer(request, .failed(Self.failure("not a URL")))
            }
        case .exportOriginals(let export)?:
            // THE ORIGINALS OF A PICK, to the share sheet or this phone's photos.
            answer(request, await ShelfCopyExport.run(export, core: core))
        case .openMap(let map)?:
            var components = URLComponents(string: "https://maps.apple.com/")
            components?.queryItems = [URLQueryItem(name: "q", value: map.query)]
            if let url = components?.url {
                UIApplication.shared.open(url, options: [:], completionHandler: nil)
                answer(request, done)
            } else {
                answer(request, .failed(Self.failure("not an address")))
            }
        case .cameraRoll(let roll)?:
            answer(request, Self.cameraRoll(roll))
        // THE PHONE IMPORTS (#1135, `imports`): the library, its link, its stage and its
        // derivatives; the folders; the reminders. Every decision is Rust's.
        case .libraryPermission(let permission)?:
            var read = Centraid_Core_V1_LibraryPermissionRead()
            read.permission = permission.ask ? await PhoneLibrary.requestPermission() : PhoneLibrary.permission()
            answer(request, .libraryPermissionRead(read))
        case .rollPage(let page)?:
            let paged = await Task.detached(priority: .utility) {
                await PhoneLibrary.page(cursor: page.cursor, limit: Int(page.limit))
            }.value
            answer(request, .rollPaged(paged))
        case .libraryStage(let stage)?:
            answer(request, .libraryStaged(await PhoneLibrary.stage(stage, core: core)))
        case .libraryDerivatives(let derivatives)?:
            await PhoneLibrary.derivatives(derivatives, core: core)
            answer(request, done)
        case .libraryDelete(let delete)?:
            answer(request, .libraryDeleted(await PhotoLibraryDeleter.delete(delete)))
        #endif
        case .linkRead?:
            answer(request, .linkReading(linkReading?() ?? Self.unknownLink))
        case .foldersRead(let read)?:
            let listing = await Task.detached(priority: .utility) { FolderReader.list(read) }.value
            answer(request, .foldersListing(listing))
        case .stageFolderFile(let file)?:
            answer(request, .folderFileStaged(await FolderReader.stage(file, core: core)))
        case .remindersRead(let read)?:
            answer(request, await PhoneReminders.snapshot(read))
        // THE VAULT'S SECRETS (lane H2): the device-only and synchronised stores, and
        // whether the synchronised one would carry a key to another device.
        case .secrets(let batch)?:
            answer(request, .secrets(SecretStores.run(batch)))
        case .syncedProbe?:
            answer(request, .syncedStatus(SecretStores.probe()))
        case .keychain(let operation)?:
            answer(request, Self.keychain(operation))
        case .backgroundProbe?:
            #if os(iOS)
            if let registered = BackgroundPasses.registered {
                var status = Centraid_Core_V1_BackgroundStatus()
                status.registered = registered
                answer(request, .backgroundStatus(status))
            } else {
                answer(request, .failed(Self.failure("this shell has not registered its background windows")))
            }
            #else
            answer(request, .failed(Self.failure("no background windows on this platform")))
            #endif
        // THE PASS SCHEDULER (#1135, `passes`): Rust decides which windows exist, when a pass ran
        // and what the OS carries; this performs and answers.
        case .scheduleWindows(let schedule)?:
            #if os(iOS)
            answer(request, .windowsScheduled(BackgroundPasses.schedule(schedule.windows)))
            #else
            answer(request, .failed(Self.failure("no background windows on this platform")))
            #endif
        case .passWindowDone(let finished)?:
            #if os(iOS)
            if finished.window == "entered-background" {
                backgroundGrace?.end()
                backgroundGrace = nil
            }
            windowWaiters.removeValue(forKey: finished.window)?.resume(returning: finished.drained)
            #endif
            answer(request, .passNoted(Centraid_Core_V1_PassNoted()))
        case .longRun(let run)?:
            // "Back up now" keeps the screen awake while it runs; the OS suspends a locked phone.
            #if os(iOS)
            UIApplication.shared.isIdleTimerDisabled = run.start
            #endif
            answer(request, .passNoted(Centraid_Core_V1_PassNoted()))
        case .uploads(let uploads)?:
            #if os(iOS)
            answer(request, Self.uploadsOp(uploads))
            #else
            answer(request, .failed(Self.failure("the OS carries no uploads on this platform")))
            #endif
        case .ownerCheck(let check)?:
            answer(request, await OwnerCheckPerformer.run(check))
        case .announce(let note)?:
            onAnnounce?(note.topic)
            answer(request, done)
        #if os(iOS)
        case .pickBytes(let pick)?:
            FilePerformer.pick(pick) { [weak self] outcome in self?.answer(request, outcome) }
        case .saveFile(let save)?:
            FilePerformer.save(save) { [weak self] outcome in self?.answer(request, outcome) }
        // PAIRING (#1135): read one QR code, and browse the network for gateways.
        case .scanCode(let scan)?:
            PairScan.run(scan) { [weak self] outcome in self?.answer(request, outcome) }
        #endif
        case .browseGateways(let browse)?:
            GatewayBrowsing.shared.perform(request.instance, browse) { [weak self] outcome in
                self?.answer(request, outcome)
            }
        case .calendarRead(let read)?:
            answer(request, await PhoneCalendar.snapshot(read))
        case .contactsRead(let read)?:
            answer(request, await PhoneContacts.snapshot(read))
            if read.askPermission, PhoneContacts.limited { onContactsLimited?() }
        case .phoneWatch(let watch)?:
            self.watch(request, watch)
        // PHOTOS' ONE-PHOTOGRAPH PAGES (#1135): the camera the original's header
        // names, and the editor's pixel work.
        case .readCamera(let read)?:
            answer(request, await PhotoEffects.camera(read))
        #if os(iOS)
        case .renderEdit(let render)?:
            answer(request, await PhotoEffects.renderEdit(render, core: core))
        #endif
        // HEALTH'S STORE (#1135): read over the window Rust placed, for the types it names.
        case .healthRead(let read)?:
            answer(request, await HealthKitReader.snapshot(read))
        case .openRoute(let open)?:
            onOpenRoute?(open.route)
            answer(request, done)
        case .vaultCommand(let command)?:
            // THE SHELF IS RUST'S: only the platform's own doors reach a shell (Settings, for a
            // notification grant or a low disk).
            #if os(iOS)
            if case let .open(destination)? = command.kind, destination == .phone || destination == .notifications,
                let url = URL(string: UIApplication.openSettingsURLString)
            {
                UIApplication.shared.open(url, options: [:], completionHandler: nil)
            }
            #endif
            answer(request, done)
        // DOCS' FILES (#1135): the file picker and scanner (answered more than once under
        // one effect: progress, then the file), and the folder picker.
        case .pickFile(let pick)?:
            DocsFiles.shared.pick(pick.kind, core: core) { outcome in
                Task { @MainActor [weak self] in self?.answer(request, outcome) }
            }
        case .followFolder?:
            DocsFollow.shared.request { outcome in
                Task { @MainActor [weak self] in self?.answer(request, outcome) }
            }
        case .stopFollowing(let stop)?:
            DocsFollow.shared.stop(stop.origin) { outcome in answer(request, outcome) }
        // THE MODEL'S (OR THE PHOTO READER'S) DOWNLOAD: the shell owns the transfer, and the chat
        // hears progress and the end as events (`ChatModel`).
        case .modelDownload(let download)?:
            ChatModelDownloader.shared.start(ChatAsset(download))
            answer(request, done)
        // THE CAPTURE SHIELD, per screen: the host wraps the instance's content in `WordsShield`
        // while it holds one. No screen asks today (Locker shields through its own `secure`).
        case .screenshotShield(let shield)?:
            if shield.on { shielded.insert(request.instance) } else { shielded.remove(request.instance) }
            answer(request, done)
        #if os(iOS)
        case .pickLibraryPhoto?:
            LibraryPhotoPerformer.pick { [weak self] outcome in self?.answer(request, outcome) }
        #endif
        default:
            // Platform work this build does not perform: say so, by value.
            answer(request, .failed(Self.failure("not performed by this shell")))
        }
    }

    /// A link the platform has not described yet: expensive, which Rust reads as "wait".
    private static var unknownLink: Centraid_Core_V1_LinkReading {
        var reading = Centraid_Core_V1_LinkReading()
        reading.platformRefused = true
        return reading
    }

    /// THE PLATFORM'S OWN PHOTO PAGES: Settings, and iOS's limited selection. The prompt and a
    /// walk are the camera roll's, in Rust.
    private static func cameraRoll(_ roll: Centraid_Core_V1_CameraRoll) -> Centraid_Core_V1_EffectResult.OneOf_Outcome {
        #if os(iOS)
        switch roll.action {
        case .openSettings:
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url, options: [:], completionHandler: nil) }
        case .manageSelection:
            let scene = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first { $0.activationState == .foregroundActive }
            if let root = scene?.keyWindow?.rootViewController {
                PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: root)
            }
        default:
            return .failed(failure("no camera roll action"))
        }
        #endif
        return .done(Centraid_Core_V1_EffectDone())
    }

    private func answer(_ request: Centraid_Core_V1_EffectRequest, _ outcome: Centraid_Core_V1_EffectResult.OneOf_Outcome) {
        var result = Centraid_Core_V1_EffectResult()
        result.effectID = request.effectID
        result.outcome = outcome
        send(request.instance, .effectResult(result))
    }

    static func failure(_ reason: String, denied: Bool = false, cancelled: Bool = false) -> Centraid_Core_V1_EffectFailed {
        var failed = Centraid_Core_V1_EffectFailed()
        failed.reason = reason
        failed.denied = denied
        failed.cancelled = cancelled
        return failed
    }

    /// START OR STOP WATCHING A PHONE STORE. While on, each change of the store
    /// is answered under the one `effect_id` that asked, as `PhoneChanged`.
    private func watch(_ request: Centraid_Core_V1_EffectRequest, _ watch: Centraid_Core_V1_PhoneWatch) {
        if watch.on {
            watches[request.effectID] = (request.instance, watch.source)
            observeStores()
        } else {
            watches = watches.filter { $0.value.instance != request.instance || $0.value.source != watch.source }
            answer(request, .done(Centraid_Core_V1_EffectDone()))
        }
    }

    /// One observer per store the OS announces changes of, installed on the first watch.
    private func observeStores() {
        guard storeObservers.isEmpty else { return }
        // EventKit posts only for a store that is alive.
        _ = PhoneCalendar.watcher
        let center = NotificationCenter.default
        storeObservers = [
            center.addObserver(forName: .EKEventStoreChanged, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.storeChanged(.calendar)
                    self?.storeChanged(.reminders)
                }
            },
            center.addObserver(forName: .CNContactStoreDidChange, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.storeChanged(.contacts) }
            },
        ]
    }

    private func storeChanged(_ source: Centraid_Core_V1_ImportSource) {
        for (effectID, watch) in watches where watch.source == source {
            var changed = Centraid_Core_V1_PhoneChanged()
            changed.source = source
            var result = Centraid_Core_V1_EffectResult()
            result.effectID = effectID
            result.outcome = .phoneChanged(changed)
            send(watch.instance, .effectResult(result))
        }
    }

    #if os(iOS)
    /// THE OS-OWNED UPLOADS (iOS's background URLSession): how many tasks it holds, the whole
    /// requests Rust handed off, and letting go of all of them.
    private static func uploadsOp(_ op: Centraid_Core_V1_UploadsOp) -> Centraid_Core_V1_EffectResult.OneOf_Outcome {
        switch op.op {
        case .pending?:
            var state = Centraid_Core_V1_UploadsState()
            state.pending = UInt32(clamping: BackgroundUploader.shared.pendingCount)
            return .uploadsState(state)
        case .enqueue(let batch)?:
            BackgroundUploader.shared.enqueue(parts: batch.parts)
            return .passNoted(Centraid_Core_V1_PassNoted())
        case .cancelAll?:
            BackgroundUploader.shared.cancelEverything()
            return .passNoted(Centraid_Core_V1_PassNoted())
        case nil:
            return .failed(failure("no uploads operation"))
        }
    }
    #endif

    /// THE KEYCHAIN, for per-device habits that must stay off the vault. One
    /// generic-password item per key, readable after first unlock, never synced.
    private static func keychain(_ operation: Centraid_Core_V1_KeychainOp) -> Centraid_Core_V1_EffectResult.OneOf_Outcome {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "dev.centraid.screens",
            kSecAttrAccount as String: operation.key,
        ]
        switch operation.op {
        case .get:
            var read = query
            read[kSecReturnData as String] = true
            read[kSecMatchLimit as String] = kSecMatchLimitOne
            var item: CFTypeRef?
            let status = SecItemCopyMatching(read as CFDictionary, &item)
            var value = Centraid_Core_V1_KeychainValue()
            if status == errSecSuccess, let data = item as? Data {
                value.found = true
                value.value = data
            }
            return .keychain(value)
        case .set:
            SecItemDelete(query as CFDictionary)
            var add = query
            add[kSecValueData as String] = operation.value
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let status = SecItemAdd(add as CFDictionary, nil)
            return status == errSecSuccess ? .done(Centraid_Core_V1_EffectDone()) : .failed(failure("keychain \(status)"))
        case .delete:
            SecItemDelete(query as CFDictionary)
            return .done(Centraid_Core_V1_EffectDone())
        default:
            return .failed(failure("unknown keychain operation"))
        }
    }

    #if os(iOS)
    private static func play(_ kind: Centraid_Core_V1_HapticKind) {
        switch kind {
        case .success: UINotificationFeedbackGenerator().notificationOccurred(.success)
        case .warning: UINotificationFeedbackGenerator().notificationOccurred(.warning)
        case .error: UINotificationFeedbackGenerator().notificationOccurred(.error)
        default: UISelectionFeedbackGenerator().selectionChanged()
        }
    }

    /// The OS share sheet over the frontmost screen: the text, then the link.
    private static func present(_ share: Centraid_Core_V1_Share) {
        var items: [Any] = []
        if !share.text.isEmpty { items.append(share.text) }
        if let url = URL(string: share.url), !share.url.isEmpty { items.append(url) }
        guard !items.isEmpty,
            let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
            var top = scene.windows.first(where: \.isKeyWindow)?.rootViewController
        else { return }
        while let next = top.presentedViewController { top = next }
        let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
        if !share.subject.isEmpty { sheet.setValue(share.subject, forKey: "subject") }
        sheet.popoverPresentationController?.sourceView = top.view
        top.present(sheet, animated: true)
    }
    #endif
}


extension Centraid_Core_V1_HomeState {
    /// An app's tile, whose `route` is the app's front door.
    func homeTile(of app: String) -> Centraid_Core_V1_HomeTile? {
        guard case let .data(data)? = content else { return nil }
        return data.tiles.first { $0.appID == app }
    }
}
