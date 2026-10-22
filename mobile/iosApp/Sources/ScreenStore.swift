import Foundation
import SwiftProtobuf

#if os(iOS)
import UIKit
#endif

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

    private let core: Core
    private var closed: Set<UInt64> = []

    init(core: Core) {
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

    private func perform(_ request: Centraid_Core_V1_EffectRequest) {
        var result = Centraid_Core_V1_EffectResult()
        result.effectID = request.effectID
        switch request.effect.kind {
        #if os(iOS)
        case .clipboardSet(let set)?:
            UIPasteboard.general.string = set.text
            result.outcome = .done(Centraid_Core_V1_EffectDone())
        case .clipboardClear(let clear)?:
            // Only what the core put there: never clear something the member copied since.
            if UIPasteboard.general.string == clear.expectedText { UIPasteboard.general.string = "" }
            result.outcome = .done(Centraid_Core_V1_EffectDone())
        case .haptic(let haptic)?:
            Self.play(haptic.kind)
            result.outcome = .done(Centraid_Core_V1_EffectDone())
        #endif
        default:
            // Platform work this build does not perform yet: say so, by value.
            var failed = Centraid_Core_V1_EffectFailed()
            failed.reason = "not performed by this shell"
            result.outcome = .failed(failed)
        }
        send(request.instance, .effectResult(result))
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
    #endif
}
