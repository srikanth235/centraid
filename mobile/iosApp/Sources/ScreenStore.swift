import Combine
import Foundation
import Security
import SwiftProtobuf

#if os(iOS)
import Photos
import PhotosUI
import UIKit
#endif

/// Core interface shared by the app and test fakes.
protocol ScreenCore: Sendable {
    func call(_ request: Centraid_Core_V1_Request) async throws -> Centraid_Core_V1_Response
    func call(_ request: Centraid_Core_V1_Request, lane: Core.Lane) async throws -> Centraid_Core_V1_Response
    var updates: AsyncStream<Centraid_Core_V1_ScreenUpdate> { get }
    var roomUpdates: AsyncStream<Centraid_Core_V1_RoomShown> { get }
    var effects: AsyncStream<Centraid_Core_V1_ShellEffect> { get }
    var changes: AsyncStream<Centraid_Core_V1_ChangeEvent> { get }
    var notifyUpdates: AsyncStream<Centraid_Core_V1_ScheduleNotifications> { get }
}

extension ScreenCore {
    var roomUpdates: AsyncStream<Centraid_Core_V1_RoomShown> {
        AsyncStream { $0.finish() }
    }
    var effects: AsyncStream<Centraid_Core_V1_ShellEffect> {
        AsyncStream { $0.finish() }
    }
    var changes: AsyncStream<Centraid_Core_V1_ChangeEvent> {
        AsyncStream { $0.finish() }
    }
    var notifyUpdates: AsyncStream<Centraid_Core_V1_ScheduleNotifications> {
        AsyncStream { $0.finish() }
    }
}

extension Core: ScreenCore {}

/// Holds the latest core navigation and view states, and forwards screen events.
/// Updates with older revisions are ignored; platform effects are answered once
/// through the event channel.
@MainActor
final class ScreenStore: ObservableObject {
    @Published private(set) var navigation: Centraid_Core_V1_Navigation?
    @Published private(set) var views: [UInt64: Centraid_Core_V1_ViewState] = [:]
    /// Instances currently covered by the screenshot privacy shield.
    @Published private(set) var shielded: Set<UInt64> = []

    /// Receives core announcements the shell can act on.
    var onAnnounce: ((String) -> Void)?

    private let core: any ScreenCore
    var notifyCore: any ScreenCore { core }
    typealias NotificationScheduler = @MainActor (Centraid_Core_V1_ScheduleNotifications) async -> Centraid_Core_V1_NotificationsScheduled
    private let scheduleNotifications: NotificationScheduler
    private var startup: Task<Bool, Never>?
    private var closed: Set<UInt64> = []
    /// Instances closed by the core.
    var closedInstances: Set<UInt64> { closed }
    /// Instances opened by this shell, to avoid claiming an entry twice.
    private var claimed: Set<UInt64> = []
    /// Receives routes opened by the core.
    var onOpenRoute: ((Centraid_Core_V1_Route) -> Void)?
    /// Receives Home's appearance setting.
    var onHomeScheme: ((Centraid_Core_V1_HomeScheme) -> Void)?
    /// Called after Home's first view arrives.
    var onHomeAppeared: (() -> Void)?
    /// Called when the core closes screen instances.
    var onClosed: (([UInt64]) -> Void)?
    private var homeTold: UInt64?

    /// Background windows awaiting their matching `PassWindowDone` event.
    private var windowWaiters: [String: CheckedContinuation<Bool, Never>] = [:]
    /// OS notification callbacks wait for their own answer's schedule to be performed.
    private struct NotificationAnswerKey: Hashable {
        let id: String
        let verb: Centraid_Core_V1_NotificationVerb
        let pressID: String
    }
    private var notifyWaiters: [NotificationAnswerKey: [UInt64: CheckedContinuation<Bool, Never>]] = [:]
    private var notifyTokens: UInt64 = 0
    /// Holds UIKit background time while the core runs the background pass.
    #if os(iOS)
    private var backgroundGrace: ForegroundGrace?
    #endif
    /// Per-instance effect queues preserve request order. Long-running effects
    /// return after installing a callback so they do not block later effects.
    private var queues: [UInt64: [Centraid_Core_V1_EffectRequest]] = [:]
    private var running: Set<UInt64> = []
    /// Clipboard writes and clears share one FIFO across screen instances.
    private var clipboardQueue: [Centraid_Core_V1_EffectRequest] = []
    private var clipboardRunning = false

    init(core: any ScreenCore, scheduleNotifications: @escaping NotificationScheduler = ScreenStore.scheduleNotifications) {
        self.core = core
        self.scheduleNotifications = scheduleNotifications
    }

    /// Starts the event readers and shares one initial snapshot across callers.
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

    /// Reports app background/foreground transitions. System prompts do not count
    /// as background transitions.
    func lifecycle(foreground: Bool) {
        #if os(iOS)
        // Keep the app alive until the core finishes its background pass.
        if !foreground, backgroundGrace == nil { backgroundGrace = ForegroundGrace(name: "dev.centraid.pass.background") }
        #endif
        var lifecycle = Centraid_Core_V1_AppLifecycle()
        lifecycle.foreground = foreground
        Task { await request(.lifecycle(lifecycle)) }
    }

    /// Reports a phone or OS fact for the core to process.
    func report(_ fact: Centraid_Core_V1_ShellFact.OneOf_Fact) {
        Task { await reportAndWait(fact) }
    }

    /// Reports a fact and waits for the core response when the caller must keep
    /// an OS wake active until delivery.
    @discardableResult
    func reportAndWait(_ fact: Centraid_Core_V1_ShellFact.OneOf_Fact) async -> Bool {
        var shell = Centraid_Core_V1_ShellFact()
        shell.fact = fact
        return await request(.shellFact(shell))
    }

    /// Waits for the schedule caused by this exact notification answer. `true`
    /// means scheduling completed; it does not claim the underlying write committed.
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
            // Bound this callback if its matching schedule never arrives.
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

    /// Reports a granted background window and waits for its completion.
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

    /// Reports that iOS revoked the background window.
    func windowExpired(_ name: String) {
        windowWaiters.removeValue(forKey: name)?.resume(returning: false)
        var expired = Centraid_Core_V1_WindowExpired()
        expired.window = name
        report(.expired(expired))
    }

    /// Reports locale, time zone, hour cycle, and photo deletion capability.
    func reportEnvironment() {
        var environment = Centraid_Core_V1_Environment()
        environment.locale = Locale.current.identifier
        environment.zone = TimeZone.current.identifier
        environment.platform = "ios"
        environment.libraryDeletes = true
        // The `j` template follows the phone's 12/24-hour setting.
        environment.hourCycle12 = DateFormatter
            .dateFormat(fromTemplate: "j", options: 0, locale: .current)?
            .contains("a") ?? false
        Task { await request(.environment(environment)) }
    }

    /// Releases inactive core state after an OS memory warning.
    func memoryWarning() {
        Task { await request(.memoryWarning(Centraid_Core_V1_MemoryWarning())) }
    }

    /// Returns certificate pins for the active vault, if available.
    func pins() async -> [Centraid_Core_V1_Destination]? {
        var request = Centraid_Core_V1_Request()
        request.kind = .pins(Centraid_Core_V1_PinsRequest())
        guard let response = try? await core.call(request), case let .pins(answer)? = response.kind else { return nil }
        return answer.destinations
    }

    /// Pushes a route and returns the new instance when the core reports it.
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

    /// Reports that a shell-owned screen was popped.
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

    /// Requests a tab selection from the core.
    func selectTab(_ tab: String) {
        var select = Centraid_Core_V1_NavSelectTab()
        select.tab = tab
        navigate(.selectTab(select))
    }

    /// Requests that the core close every page above a tab's root.
    func popToRoot(tab: String) {
        var pop = Centraid_Core_V1_NavPopToRoot()
        pop.tab = tab
        navigate(.popToRoot(pop))
    }

    /// Returns the core's stack for a tab, root first.
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
            // Stop browsing when its screen closes.
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
        // Cancellation must bypass the owner check it ends.
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

    /// Performs an effect and answers by `effect_id`. Callback-based work does
    /// not block later effects; late answers for closed screens are ignored.
    private func perform(_ request: Centraid_Core_V1_EffectRequest) async {
        let done = Centraid_Core_V1_EffectResult.OneOf_Outcome.done(Centraid_Core_V1_EffectDone())
        switch request.effect.kind {
        #if os(iOS)
        case .clipboardSet(let set)?:
            let pasteboard = UIPasteboard.general
            if set.sensitive && set.clearAfterMs_p > 0 {
                // The OS expires local-only pasteboard items; the marker lets Lock
                // clear only a lease this vault still owns after process restart.
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
                // A text-only clear cannot consume another vault's lease.
                answer(request, done)
                return
            case .retireStaleLease:
                // A missing marker means the owned item was replaced; retire metadata only.
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
            // Offer selected originals to the share sheet or photo library.
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
            // Open this app's notification settings.
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
        // Read the device-only and synchronized secret stores.
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
        // Apply the core's background-window schedule.
        case .scheduleWindows(let schedule)?:
            #if os(iOS)
            answer(request, .windowsScheduled(BackgroundPasses.schedule(schedule.windows)))
            #else
            answer(request, .failed(Self.failure(EffectReason.unavailable)))
            #endif
        // Apply the complete notification schedule and report the OS result.
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
            // Keep the screen awake while the requested backup runs.
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
        // Offer the staged export through the system save sheet.
        case .saveFilePath(let save)?:
            FilePerformer.savePath(save) { [weak self] outcome in self?.answer(request, outcome) }
        // Pairing scans a QR code and browses for gateways.
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

    /// Returns camera-library grant status without enumerating photos; Rust owns the walk.
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

    static func chatCardApp(_ card: Centraid_Core_V1_ChatCard) -> String {
        card.app
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
    /// Reports pending background upload counts and handles core upload requests.
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

    /// Stores per-device habits in non-synchronizing Keychain entries.
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
        // Recovery words must not be copied by the system share sheet.
        sheet.excludedActivityTypes = [.copyToPasteboard]
        if !share.subject.isEmpty { sheet.setValue(share.subject, forKey: "subject") }
        sheet.popoverPresentationController?.sourceView = top.view
        top.present(sheet, animated: true)
    }
    #endif
}



