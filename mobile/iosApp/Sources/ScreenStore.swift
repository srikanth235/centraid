import Combine
import Contacts
import EventKit
import CentraidShared
import Foundation
import Security
import SwiftProtobuf

#if os(iOS)
import Photos
import PhotosUI
import UIKit
#endif

/// WHAT THE STORE TALKS TO: the core, or whatever carries its bytes (`Core`).
protocol ScreenCore: Sendable {
    func call(_ request: Centraid_Core_V1_Request) async throws -> Centraid_Core_V1_Response
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

    /// Told when Rust announces something the shell may act on (`locker.unlocked`).
    var onAnnounce: ((String) -> Void)?
    /// WHETHER THE PLATFORM TOOK A BACKGROUND WINDOW, as the session last registered
    /// it (`BackgroundProbe`); nil before it says. Asking registers nothing.
    var backgroundRegistered: (() -> Bool?)?

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
    /// An import over iOS's limited contact access: the shell raises the system's picker.
    var onContactsLimited: (() -> Void)?

    /// THE CAMERA ROLL AND THE PHOTOS DEVICE (#1135, lane D): the roll, the free-up
    /// flow and an original back from the gateway are the shell's, not a screen's.
    /// Rust asks for them as effects and learns the grant and each pass's progress
    /// as events, which this forwards to every Photos home that is open.
    var photos: PhotosDevice? {
        didSet { if photos != nil, oldValue == nil { observePhotos() } }
    }
    /// THE PASS SCHEDULER'S WINDOWS (`passes` in Rust): a granted background window waits
    /// here, by name, for `PassWindowDone`, which carries the answer `setTaskCompleted` takes.
    private var windowWaiters: [String: CheckedContinuation<Bool, Never>] = [:]
    /// The UIKit grace held while the app leaves the screen and Rust runs its pass; released
    /// on `PassWindowDone` for the background entry (or by iOS taking it back).
    #if os(iOS)
    private var backgroundGrace: ForegroundGrace?
    #endif
    /// What the roll last said (the grant, the pass), replayed to a Photos home
    /// that opens after it said so.
    private var rollEvents: [Int: Centraid_Core_V1_PhotosHomeEvent] = [:]
    private var rollTold: Set<UInt64> = []

    init(core: any ScreenCore) {
        self.core = core
    }

    private func observePhotos() {
        photos?.observe { [weak self] bytes in
            guard let event = try? Centraid_Core_V1_PhotosHomeEvent(serializedBytes: bytes.data) else { return }
            Task { @MainActor in self?.rollSaid(event) }
        }
    }

    /// The roll said something: keep it, and tell every Photos home on screen.
    private func rollSaid(_ event: Centraid_Core_V1_PhotosHomeEvent) {
        rollEvents[event.permissionKey] = event
        for instance in views.keys where views[instance]?.isPhotosHome == true {
            send(instance, .photosHome(event))
        }
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

    /// Report the device's locale, zone and OS; Rust formats from them.
    func reportEnvironment() {
        var environment = Centraid_Core_V1_Environment()
        environment.locale = Locale.current.identifier
        environment.zone = TimeZone.current.identifier
        environment.platform = "ios"
        Task { await request(.environment(environment)) }
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
            // A BROWSE LASTS AS LONG AS THE SCREEN THAT ASKED FOR IT.
            GatewayBrowsing.shared.stop(id)
        }
        for view in update.views
        where !closed.contains(view.instance) && view.revision > (views[view.instance]?.revision ?? 0) {
            views[view.instance] = view
            // A PHOTOS HOME THAT OPENS AFTER THE ROLL SPOKE is told what it said.
            if view.isPhotosHome, rollTold.insert(view.instance).inserted {
                for event in rollEvents.values { send(view.instance, .photosHome(event)) }
            }
        }
        for effect in update.effects { perform(effect) }
    }

    // MARK: - effects

    /// Perform what Rust asked and answer it by `effect_id`. An answer may come
    /// later (a calendar read); a screen popped meanwhile tolerates it.
    private func perform(_ request: Centraid_Core_V1_EffectRequest) {
        switch request.effect.kind {
        #if os(iOS)
        case .clipboardSet(let set)?:
            if set.sensitive && set.clearAfterMs > 0 {
                // THE OS KEEPS THE DEADLINE: a pasteboard item expires on its own, so a killed app
                // cannot leave a secret behind, and `localOnly` keeps it off Universal Clipboard.
                UIPasteboard.general.setItems(
                    [["public.utf8-plain-text": set.text]],
                    options: [
                        .expirationDate: Date(timeIntervalSinceNow: Double(set.clearAfterMs) / 1000),
                        .localOnly: true,
                    ]
                )
            } else {
                UIPasteboard.general.string = set.text
            }
            answer(request, .done(Centraid_Core_V1_EffectDone()))
        case .clipboardClear(let clear)?:
            // Only what the core put there: never clear something the member copied since.
            if UIPasteboard.general.string == clear.expectedText { UIPasteboard.general.string = "" }
            answer(request, .done(Centraid_Core_V1_EffectDone()))
        case .haptic(let haptic)?:
            Self.play(haptic.kind)
            answer(request, .done(Centraid_Core_V1_EffectDone()))
        case .share(let share)?:
            Self.present(share)
            answer(request, .done(Centraid_Core_V1_EffectDone()))
        case .openURL(let link)?:
            if let url = URL(string: link.url) {
                UIApplication.shared.open(url)
                answer(request, .done(Centraid_Core_V1_EffectDone()))
            } else {
                answer(request, .failed(Self.failure("not a URL")))
            }
        case .exportOriginals(let export)?:
            // THE ORIGINALS OF A PICK, to the share sheet or this phone's photos.
            Task { [core] in
                let outcome = await ShelfCopyExport.run(export, core: core)
                answer(request, outcome)
            }
        case .openMap(let map)?:
            var components = URLComponents(string: "https://maps.apple.com/")
            components?.queryItems = [URLQueryItem(name: "q", value: map.query)]
            if let url = components?.url {
                UIApplication.shared.open(url)
                answer(request, .done(Centraid_Core_V1_EffectDone()))
            } else {
                answer(request, .failed(Self.failure("not an address")))
            }
        #endif
        case .cameraRoll(let roll)?:
            answer(request, performCameraRoll(roll))
        case .freeUpSpace(let space)?:
            guard let photos else {
                answer(request, .failed(Self.failure("this shell has no photos device")))
                return
            }
            photos.freeUp(free: space.action == .free) { [weak self] bytes in
                guard let facts = try? Centraid_Core_V1_FreeUpFacts(serializedBytes: bytes.data) else { return }
                Task { @MainActor in self?.answer(request, .freeUpFacts(facts)) }
            }
        case .fetchOriginal(let fetch)?:
            guard let photos else {
                answer(request, .failed(Self.failure("this shell has no photos device")))
                return
            }
            photos.fetchOriginal(contentHash: fetch.contentHash) { [weak self] bytes in
                guard let fetched = try? Centraid_Core_V1_OriginalFetched(serializedBytes: bytes.data) else { return }
                Task { @MainActor in self?.answer(request, .originalFetched(fetched)) }
            }
        // THE VAULT'S SECRETS (lane H2): the device-only and synchronised stores, and
        // whether the synchronised one would carry a key to another device.
        case .secrets(let batch)?:
            answer(request, .secrets(SecretStores.run(batch)))
        case .syncedProbe?:
            answer(request, .syncedStatus(SecretStores.probe()))
        case .keychain(let operation)?:
            answer(request, Self.keychain(operation))
        case .backgroundProbe?:
            if let registered = backgroundRegistered?() {
                var status = Centraid_Core_V1_BackgroundStatus()
                status.registered = registered
                answer(request, .backgroundStatus(status))
            } else {
                answer(request, .failed(Self.failure("this shell has not registered its background windows")))
            }
        // THE PASS SCHEDULER (#1135, `passes`): Rust decides which windows exist, when a pass ran
        // and what the OS carries; this performs and answers.
        case .scheduleWindows(let schedule)?:
            #if os(iOS)
            answer(request, .windowsScheduled(BackgroundPasses.schedule(schedule.windows)))
            #else
            answer(request, .failed(Self.failure("no background windows on this platform")))
            #endif
        case .passWindowDone(let done)?:
            #if os(iOS)
            if done.window == "entered-background" {
                backgroundGrace?.end()
                backgroundGrace = nil
            }
            windowWaiters.removeValue(forKey: done.window)?.resume(returning: done.drained)
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
        case .streamFromLibrary?:
            // The roll's second stream is the camera roll's (lane I); a shell that has none lands nothing.
            answer(request, .failed(Self.failure("not performed by this shell")))
        case .ownerCheck(let check)?:
            Task {
                let outcome = await OwnerCheckPerformer.run(check)
                answer(request, outcome)
            }
        case .announce(let note)?:
            onAnnounce?(note.topic)
            answer(request, .done(Centraid_Core_V1_EffectDone()))
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
            Task {
                let outcome = await PhoneCalendar.snapshot(read)
                answer(request, outcome)
            }
        case .contactsRead(let read)?:
            Task {
                let outcome = await PhoneContacts.snapshot(read)
                answer(request, outcome)
                if read.askPermission, PhoneContacts.limited { onContactsLimited?() }
            }
        case .phoneWatch(let watch)?:
            self.watch(request, watch)
        // PHOTOS' ONE-PHOTOGRAPH PAGES (#1135): the camera the original's header
        // names, and the editor's pixel work.
        case .readCamera(let read)?:
            Task { answer(request, await PhotoEffects.camera(read)) }
        #if os(iOS)
        case .renderEdit(let render)?:
            Task { answer(request, await PhotoEffects.renderEdit(render, core: core)) }
        #endif
        // HEALTH'S STORE (#1135): read over the window Rust placed, for the types it names.
        case .healthRead(let read)?:
            Task {
                let outcome = await HealthKitReader.snapshot(read)
                answer(request, outcome)
            }
        case .openRoute(let open)?:
            onOpenRoute?(open.route)
            answer(request, .done(Centraid_Core_V1_EffectDone()))
        // DOCS' FILES (#1135): the file picker and scanner (answered more than once under
        // one effect: progress, then the file), and the folder picker.
        case .pickFile(let pick)?:
            DocsFiles.shared.pick(pick.kind) { outcome in
                Task { @MainActor [weak self] in self?.answer(request, outcome) }
            }
        case .followFolder?:
            DocsFollow.shared.request { outcome in
                Task { @MainActor [weak self] in self?.answer(request, outcome) }
            }
        case .stopFollowing(let stop)?:
            DocsFollow.shared.stop(stop.origin) { outcome in
                Task { @MainActor [weak self] in self?.answer(request, outcome) }
            }
        default:
            // Platform work this build does not perform yet: say so, by value.
            answer(request, .failed(Self.failure("not performed by this shell")))
        }
    }

    /// WHAT A SCREEN ASKED OF THE CAMERA ROLL. The prompt and a pass are the
    /// device's (`PhotosDevice`); Settings and iOS's limited selection are this
    /// app's own pages, which only the platform can open.
    private func performCameraRoll(_ roll: Centraid_Core_V1_CameraRoll) -> Centraid_Core_V1_EffectResult.OneOf_Outcome {
        #if os(iOS)
        switch roll.action {
        case .askPermission:
            photos?.perform(action: PhotosDevice.Companion.shared.ACTION_ASK_PERMISSION)
        case .importNow:
            photos?.perform(action: PhotosDevice.Companion.shared.ACTION_IMPORT_NOW)
        case .openSettings:
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        case .manageSelection:
            let scene = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first { $0.activationState == .foregroundActive }
            if let root = scene?.keyWindow?.rootViewController {
                PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: root)
            }
        default:
            return .failed(Self.failure("no camera roll action"))
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


extension Centraid_Core_V1_ViewState {
    /// Whether this is a Photos home, the screen the camera roll talks to.
    var isPhotosHome: Bool {
        if case .photosHome? = kind { return true }
        return false
    }
}

extension Centraid_Core_V1_PhotosHomeEvent {
    /// Which of the roll's two facts this event carries, so the latest of each is kept.
    var permissionKey: Int {
        if case .permission? = kind { return 0 }
        return 1
    }
}
