import Combine
import Contacts
import EventKit
import Foundation
import Security
import SwiftProtobuf

#if os(iOS)
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

    init(core: any ScreenCore) {
        self.core = core
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

    /// Report the device's locale and zone; Rust formats from them.
    func reportEnvironment() {
        var environment = Centraid_Core_V1_Environment()
        environment.locale = Locale.current.identifier
        environment.zone = TimeZone.current.identifier
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
        }
        for view in update.views
        where !closed.contains(view.instance) && view.revision > (views[view.instance]?.revision ?? 0) {
            views[view.instance] = view
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
            UIPasteboard.general.string = set.text
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
        case .keychain(let operation)?:
            answer(request, Self.keychain(operation))
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

    private func answer(_ request: Centraid_Core_V1_EffectRequest, _ outcome: Centraid_Core_V1_EffectResult.OneOf_Outcome) {
        var result = Centraid_Core_V1_EffectResult()
        result.effectID = request.effectID
        result.outcome = outcome
        send(request.instance, .effectResult(result))
    }

    private static func failure(_ reason: String, denied: Bool = false) -> Centraid_Core_V1_EffectFailed {
        var failed = Centraid_Core_V1_EffectFailed()
        failed.reason = reason
        failed.denied = denied
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
