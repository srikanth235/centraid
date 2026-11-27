import Combine
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
    func call(_ request: Centraid_Core_V1_Request, lane: Core.Lane) async throws -> Centraid_Core_V1_Response
    var updates: AsyncStream<Centraid_Core_V1_ScreenUpdate> { get }
    var roomUpdates: AsyncStream<Centraid_Core_V1_RoomShown> { get }
    var notifyUpdates: AsyncStream<Centraid_Core_V1_ScheduleNotifications> { get }
}

extension ScreenCore {
    var roomUpdates: AsyncStream<Centraid_Core_V1_RoomShown> {
        AsyncStream { $0.finish() }
    }
    var notifyUpdates: AsyncStream<Centraid_Core_V1_ScheduleNotifications> {
        AsyncStream { $0.finish() }
    }
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
    var notifyCore: any ScreenCore { core }
    typealias NotificationScheduler = @MainActor (Centraid_Core_V1_ScheduleNotifications) async -> Centraid_Core_V1_NotificationsScheduled
    private let scheduleNotifications: NotificationScheduler
    private var startup: Task<Bool, Never>?
    private var closed: Set<UInt64> = []
    /// The instances the core has closed (a closed one has no view left to draw).
    var closedInstances: Set<UInt64> { closed }
    /// Instances this shell opened with `open`, so two opens never claim one entry.
    private var claimed: Set<UInt64> = []
    /// OPEN A PAGE NOW, wherever the member is (`OpenRoute`): the shell pushes the
    /// route as it pushes a tapped row's route. Set by `ShellModel`.
    var onOpenRoute: ((Centraid_Core_V1_Route) -> Void)?
    /// Home's `scheme` moved (the member's light/dark choice, which Rust keeps).
    var onHomeScheme: ((Centraid_Core_V1_HomeScheme) -> Void)?
    /// Home's first view arrived: the shell tells it the phone's scheme.
    var onHomeAppeared: (() -> Void)?
    /// Rust closed these instances (a screen finished itself, or the stacks were rebuilt
    /// under it): the shell takes their pages off its path.
    var onClosed: (([UInt64]) -> Void)?
    private var homeTold: UInt64?

    /// THE PASS SCHEDULER'S WINDOWS (`passes` in Rust): a granted background window waits
    /// here, by name, for `PassWindowDone`, which carries the answer `setTaskCompleted` takes.
    private var windowWaiters: [String: CheckedContinuation<Bool, Never>] = [:]
    /// Each OS callback waits for its exact answer's terminal schedule to be performed.
    /// Startup/refresh schedules and another button never release it.
    private struct NotificationAnswerKey: Hashable {
        let id: String
        let verb: Centraid_Core_V1_NotificationVerb
        let pressID: String
    }
    private var notifyWaiters: [NotificationAnswerKey: [UInt64: CheckedContinuation<Bool, Never>]] = [:]
    private var notifyTokens: UInt64 = 0
    /// The UIKit grace held while the app leaves the screen and Rust runs its pass; released
    /// on `PassWindowDone` for the background entry (or by iOS taking it back).
    #if os(iOS)
    private var backgroundGrace: ForegroundGrace?
    #endif
    /// EACH SCREEN'S EFFECTS, PERFORMED IN THE ORDER IT ASKED (phone
    /// imports): a service tells its answers apart by what they answer, so a cursor write that is
    /// answered after the wait behind it would be taken for the wait. One queue per instance; an
    /// effect that answers more than once and for long (a model download, a browse, a pick)
    /// answers through its own callback and does not hold the queue.
    private var queues: [UInt64: [Centraid_Core_V1_EffectRequest]] = [:]
    private var running: Set<UInt64> = []
    /// Clipboard writes and clears are one shell-wide FIFO across screen instances.
    private var clipboardQueue: [Centraid_Core_V1_EffectRequest] = []
    private var clipboardRunning = false

    init(core: any ScreenCore, scheduleNotifications: @escaping NotificationScheduler = ScreenStore.scheduleNotifications) {
        self.core = core
        self.scheduleNotifications = scheduleNotifications
    }

    /// One event reader and first snapshot, shared by every startup caller. A cold
    /// callback may use the store only after this snapshot actually succeeded.
    @discardableResult
    func start() async -> Bool {
        if let startup { return await startup.value }
        let work = Task {
            Task { [core] in
                for await update in core.updates { self.apply(update) }
            }
            #if os(iOS)
            Task { [core] in
                for await schedule in core.notifyUpdates {
                    if Task.isCancelled { break }
                    await Notifications.applyScheduleAndReport(schedule, core: core)
                }
            }
            #endif
            NotificationStartupTrace.mark(.snapshotStarted)
            let ready = await request(.snapshot(Centraid_Core_V1_SnapshotRequest()))
            NotificationStartupTrace.mark(.snapshotCompleted, succeeded: ready)
            return ready
        }
        startup = work
        return await work.value
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
        Task { await reportAndWait(fact) }
    }

    /// Report a fact and wait until the core has answered it — used when the
    /// caller must hold an OS wake (such as a background upload completion
    /// handler) until Rust has received the fact.
    @discardableResult
    func reportAndWait(_ fact: Centraid_Core_V1_ShellFact.OneOf_Fact) async -> Bool {
        var shell = Centraid_Core_V1_ShellFact()
        shell.fact = fact
        return await request(.shellFact(shell))
    }

    /// A notification button or tap stays alive until Rust marks this exact answer
    /// terminal and its resulting OS schedule has actually been performed. True
    /// means that matching performance finished; false is the existing expiry,
    /// never a claim that the task write committed.
    @discardableResult
    func answerNotification(id: String, verb: Centraid_Core_V1_NotificationVerb, pressID: String = "") async -> Bool {
        var answered = Centraid_Core_V1_NotificationAnswered()
        answered.notificationID = id
        answered.verb = verb
        answered.pressID = pressID
        var shell = Centraid_Core_V1_ShellFact()
        shell.fact = .notificationAnswered(answered)
        let key = NotificationAnswerKey(id: id, verb: verb, pressID: pressID)
        notifyTokens += 1
        let token = notifyTokens
        return await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            notifyWaiters[key, default: [:]][token] = continuation
            NotificationStartupTrace.mark(.answerWaitRegistered, count: notifyWaiters.count)
            Task {
                NotificationStartupTrace.mark(.notificationFactStarted)
                let answered = await request(.shellFact(shell))
                NotificationStartupTrace.mark(.notificationFactCompleted, succeeded: answered)
            }
            // Existing OS callback grace: only this callback is released if its
            // performer never arrives. No unrelated refresh can acknowledge it.
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 8_000_000_000)
                self?.notifyPerformed(key: key, token: token)
            }
        }
    }

    private func notifyPerformed(key: NotificationAnswerKey, token: UInt64) {
        guard let continuation = notifyWaiters[key]?.removeValue(forKey: token) else { return }
        if notifyWaiters[key]?.isEmpty == true { notifyWaiters.removeValue(forKey: key) }
        NotificationStartupTrace.mark(.callbackExpired)
        continuation.resume(returning: false)
    }

    private func notifyPerformed(_ answers: [Centraid_Core_V1_NotificationAnswered]) {
        for answer in answers {
            let key = NotificationAnswerKey(id: answer.notificationID, verb: answer.verb, pressID: answer.pressID)
            let waiting = notifyWaiters.removeValue(forKey: key)
            if let waiting {
                NotificationStartupTrace.mark(.matchingAnswerPerformed, count: waiting.count)
            }
            waiting?.values.forEach { $0.resume(returning: true) }
        }
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

    /// Report the device's locale, zone, OS and 12 or 24 hour setting, and that
    /// Photos deletes from the library behind its own confirmation; Rust formats
    /// from them and offers "Free up space" only where the platform can.
    func reportEnvironment() {
        var environment = Centraid_Core_V1_Environment()
        environment.locale = Locale.current.identifier
        environment.zone = TimeZone.current.identifier
        environment.platform = "ios"
        environment.libraryDeletes = true
        // The "j" template resolves to the phone's own hour cycle: "h a" (12-hour)
        // carries an AM/PM marker, "HH" does not.
        environment.hourCycle12 = DateFormatter
            .dateFormat(fromTemplate: "j", options: 0, locale: .current)?
            .contains("a") ?? false
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

    var homeInstance: UInt64? { entries(of: RustScreens.homeTab).first?.instance }

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

    @discardableResult
    private func request(_ kind: Centraid_Core_V1_ScreenRequest.OneOf_Kind) async -> Bool {
        var screen = Centraid_Core_V1_ScreenRequest()
        screen.kind = kind
        var request = Centraid_Core_V1_Request()
        request.kind = .screen(screen)
        guard let response = try? await core.call(request),
            case .screen(let answer)? = response.kind
        else { return false }
        apply(answer.update)
        return true
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
        if !update.closed.isEmpty { onClosed?(update.closed) }
        for view in update.views
        where !closed.contains(view.instance) && view.revision > (views[view.instance]?.revision ?? 0) {
            views[view.instance] = view
        }
        for effect in update.effects { enqueue(effect) }
    }

    /// Queue `request` behind what its screen asked before, and run the queue.
    private func enqueue(_ request: Centraid_Core_V1_EffectRequest) {
        // A WITHDRAWN PROMPT JUMPS THE QUEUE: it exists to end the owner check the queue is
        // waiting on, so it cannot wait behind it.
        if case .ownerCheck(let check)? = request.effect.kind, check.cancel {
            Task { await perform(request) }
            return
        }
        switch request.effect.kind {
        case .clipboardSet(_)?, .clipboardClear(_)?, .clipboardClearOwned(_)?:
            clipboardQueue.append(request)
            drainClipboard()
            return
        default:
            break
        }
        queues[request.instance, default: []].append(request)
        drain(request.instance)
    }

    private func drainClipboard() {
        guard !clipboardRunning, !clipboardQueue.isEmpty else { return }
        let next = clipboardQueue.removeFirst()
        clipboardRunning = true
        Task {
            await perform(next)
            clipboardRunning = false
            drainClipboard()
        }
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

    private static func scheduleNotifications(_ schedule: Centraid_Core_V1_ScheduleNotifications) async -> Centraid_Core_V1_NotificationsScheduled {
        #if os(iOS)
        return await Notifications.schedule(schedule)
        #else
        return .init()
        #endif
    }

    /// Perform what Rust asked and answer it by `effect_id`. Returns once the one answer is
    /// given; an effect that answers later, or more than once, answers through its own callback
    /// and returns at once, so its screen's next effect is not held behind a member's pick. A
    /// screen popped meanwhile tolerates a late answer.
    private func perform(_ request: Centraid_Core_V1_EffectRequest) async {
        let done = Centraid_Core_V1_EffectResult.OneOf_Outcome.done(Centraid_Core_V1_EffectDone())
        switch request.effect.kind {
        #if os(iOS)
        case .clipboardSet(let set)?:
            let pasteboard = UIPasteboard.general
            if set.sensitive && set.clearAfterMs_p > 0 {
                // THE OS KEEPS THE DEADLINE: a local-only pasteboard item expires on its own. The
                // shell persists only its vault, opaque item marker and expiry before answering
                // Copy. Lock after process restart checks the marker type before reading its token.
                let expiresAt = Date(timeIntervalSinceNow: Double(set.clearAfterMs_p) / 1000)
                var item: [String: Any] = ["public.utf8-plain-text": set.text]
                if !set.ownerVaultID.isEmpty {
                    let token = UUID().uuidString
                    do {
                        try LockerClipboardLeaseStore.record(
                            vaultID: set.ownerVaultID,
                            token: token,
                            text: set.text,
                            expiresAt: expiresAt
                        )
                    } catch {
                        answer(
                            request,
                            .failed(Self.failure(EffectReason.ofWrite(error, otherwise: EffectReason.unwritable)))
                        )
                        return
                    }
                    item[LockerClipboardLeaseStore.markerType] = Data(token.utf8)
                } else {
                    LockerClipboardLeaseStore.remove()
                }
                pasteboard.setItems(
                    [item],
                    options: [
                        .expirationDate: expiresAt,
                        .localOnly: true,
                    ]
                )
            } else {
                pasteboard.string = set.text
                LockerClipboardLeaseStore.remove()
            }
            answer(request, done)
        case .clipboardClear(let clear)?:
            let pasteboard = UIPasteboard.general
            let hasLockerLease = LockerClipboardLeaseStore.load() != nil
            let hasLockerMarker = hasLockerLease
                && pasteboard.contains(pasteboardTypes: [LockerClipboardLeaseStore.markerType])
            switch LockerClipboardLeaseStore.legacyClearAction(
                leasePresent: hasLockerLease,
                markerPresent: hasLockerMarker
            ) {
            case .keepOwnedLease:
                // A text-only clear cannot spend a vault-owned clipboard lease.
                answer(request, done)
                return
            case .retireStaleLease:
                // Missing marker proves the old owned item was replaced. Retire only metadata;
                // never read the unrelated clipboard to satisfy this legacy clear.
                LockerClipboardLeaseStore.remove()
                answer(request, done)
                return
            case .inspectUnownedText:
                if pasteboard.string == clear.expectedText { pasteboard.string = "" }
                answer(request, done)
            }
        case .clipboardClearOwned(let clear)?:
            let pasteboard = UIPasteboard.general
            _ = LockerClipboardLeaseStore.clearOwned(
                vaultID: clear.vaultID,
                markerPresent: {
                    pasteboard.contains(pasteboardTypes: [LockerClipboardLeaseStore.markerType])
                },
                readMarkerToken: {
                    pasteboard.data(forPasteboardType: LockerClipboardLeaseStore.markerType)
                        .flatMap { String(data: $0, encoding: .utf8) }
                },
                readContentDigest: {
                    pasteboard.string.map(LockerClipboardLeaseStore.digest)
                },
                clearPasteboard: { pasteboard.items = [] }
            )
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
                answer(request, .failed(Self.failure(EffectReason.unsupported)))
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
                answer(request, .failed(Self.failure(EffectReason.unsupported)))
            }
        case .cameraRoll(let roll)?:
            answer(request, Self.cameraRoll(roll))
        case .openNotificationSettings?:
            // THE APP'S PAGE in Settings, where its notifications are switched.
            #if os(iOS)
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url, options: [:], completionHandler: nil)
            }
            #endif
            answer(request, done)
        case .rollPage(let page)?:
            _ = await Task.detached(priority: .utility) {
                await PhoneLibrary.page(cursor: page.cursor, limit: Int(page.limit))
            }.value
            answer(request, done)
        case .libraryStage(let stage)?:
            _ = await PhoneLibrary.stage(stage, core: core)
            answer(request, done)
        case .libraryDerivatives(let derivatives)?:
            await PhoneLibrary.derivatives(derivatives, core: core)
            answer(request, done)
        #endif
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
                answer(request, .failed(Self.failure(EffectReason.noWindow)))
            }
            #else
            answer(request, .failed(Self.failure(EffectReason.unavailable)))
            #endif
        // THE PASS SCHEDULER (#1135, `passes`): Rust decides which windows exist, when a pass ran
        // and what the OS carries; this performs and answers.
        case .scheduleWindows(let schedule)?:
            #if os(iOS)
            answer(request, .windowsScheduled(BackgroundPasses.schedule(schedule.windows)))
            #else
            answer(request, .failed(Self.failure(EffectReason.unavailable)))
            #endif
        // NOTIFICATIONS (#1173, `agenda.notify`): Rust sends the whole desired set; this makes the
        // OS hold it and answers the permission and the count.
        case .scheduleNotifications(let schedule)?:
            #if os(iOS)
            NotificationStartupTrace.mark(.notificationScheduleStarted, count: schedule.completedAnswers.count)
            answer(request, .notificationsScheduled(await scheduleNotifications(schedule)))
            NotificationStartupTrace.mark(.notificationScheduleCompleted, count: schedule.completedAnswers.count)
            notifyPerformed(schedule.completedAnswers)
            #else
            answer(request, .failed(Self.failure(EffectReason.unavailable)))
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
            answer(request, .failed(Self.failure(EffectReason.unavailable)))
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
        // A STREAMED EXPORT: the file the core staged, offered to the same save sheet.
        case .saveFilePath(let save)?:
            FilePerformer.savePath(save) { [weak self] outcome in self?.answer(request, outcome) }
        // PAIRING (#1135): read one QR code, and browse the network for gateways.
        case .scanCode(let scan)?:
            PairScan.run(scan) { [weak self] outcome in self?.answer(request, outcome) }
        #endif
        case .browseGateways(let browse)?:
            GatewayBrowsing.shared.perform(request.instance, browse) { [weak self] outcome in
                self?.answer(request, outcome)
            }
        case .openRoute(let open)?:
            onOpenRoute?(open.route)
            answer(request, done)
        case .vaultCommand(let command)?:
            switch command.kind {
            case .make(let make)?:
                if make { sendHome(.make(.init())) }
            case .restore(let restore)?:
                if restore { sendHome(.restore(.init())) }
            case .open(let destination)?:
                #if os(iOS)
                if destination == .phone || destination == .notifications,
                   let url = URL(string: UIApplication.openSettingsURLString)
                {
                    UIApplication.shared.open(url, options: [:], completionHandler: nil)
                }
                #endif
            case nil:
                break
            }
            answer(request, done)
        case .pickFile?:
            answer(request, .failed(Self.failure(EffectReason.unsupported)))
        case .modelDownload(let download)?:
            ChatModelDownloader.shared.start(ChatAsset(download))
            answer(request, done)
        case .deleteModelFile(let gone)?:
            if !gone.fileName.isEmpty, !gone.fileName.contains("/"), !gone.fileName.contains("..") {
                try? FileManager.default.removeItem(
                    at: URL(fileURLWithPath: gone.modelsDir).appendingPathComponent(gone.fileName))
            }
            answer(request, done)
        case .screenshotShield(let shield)?:
            if shield.on { shielded.insert(request.instance) } else { shielded.remove(request.instance) }
            answer(request, done)
        default:
            answer(request, .failed(Self.failure(EffectReason.unsupported)))
        }
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
            return .failed(failure(EffectReason.unsupported))
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

    static func failure(
        _ reason: String,
        denied: Bool = false,
        cancelled: Bool = false,
        restricted: Bool = false,
        limited: Bool = false
    ) -> Centraid_Core_V1_EffectFailed {
        var failed = Centraid_Core_V1_EffectFailed()
        failed.reason = reason
        failed.denied = denied
        failed.cancelled = cancelled
        failed.restricted = restricted
        failed.limited = limited
        return failed
    }

    static func isResting(_ vault: Centraid_Core_V1_HeldVault) -> Bool {
        vault.resting
    }

    static func confirmedCount(_ line: Centraid_Core_V1_BackupLine) -> UInt64 {
        line.confirmed
    }

    static func statusTimestampMs(_ status: Centraid_Core_V1_ShellBackupStatus) -> Int64 {
        status.nowMs
    }

    static func changedTables(_ changed: Centraid_Core_V1_DataChanged) -> [String] {
        changed.tables
    }

    static func isHoldingsLoaded(_ holdings: Centraid_Core_V1_Holdings) -> Bool {
        holdings.loaded
    }

    static func chatCardEntity(_ card: Centraid_Core_V1_ChatCard) -> String {
        card.entity
    }

    static func wordsMadeLine(_ state: Centraid_Core_V1_WordsMakeState) -> String {
        state.madeLine
    }

    static func originalsWithheld(_ vault: Centraid_Core_V1_ShellVault) -> UInt32 {
        vault.originalsWithheld
    }

    static func searchChromeLabels(_ chrome: Centraid_Core_V1_HomeSearchChrome) -> (scope: String, close: String, loading: String) {
        (chrome.scopeLabel, chrome.closeLabel, chrome.loading)
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
            return .failed(failure(EffectReason.unsupported))
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
            return status == errSecSuccess ? .done(Centraid_Core_V1_EffectDone()) : .failed(failure(EffectReason.failed))
        case .delete:
            SecItemDelete(query as CFDictionary)
            return .done(Centraid_Core_V1_EffectDone())
        default:
            return .failed(failure(EffectReason.unsupported))
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
        // THE WORDS NEVER REACH THE CLIPBOARD (#1202): this sheet carries the recovery words ("Save a
        // copy"), so its own Copy action is left off; Notes, Files and Mail stay.
        sheet.excludedActivityTypes = [.copyToPasteboard]
        if !share.subject.isEmpty { sheet.setValue(share.subject, forKey: "subject") }
        sheet.popoverPresentationController?.sourceView = top.view
        top.present(sheet, animated: true)
    }
    #endif
}



