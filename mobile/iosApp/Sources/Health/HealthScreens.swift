import SwiftUI

import CentraidShared

/// HEALTH, REGISTERED (#1129). Its one line is in `AppRegistry.apps`.
///
/// Four screens, one bridge each, held for the app's life: `health.home` (Today · Trends ·
/// Workouts, More a sheet) and, pushed from it, `health.metric`, `health.workout` and
/// `health.connect`. The Android twin is `screens/health/HealthRoutes.kt`.
///
/// **A ROUTE'S PARAMETER IS ITS SCREEN'S `Opened`, AS THE SHARED SIDE SPELLED IT**
/// (`ScreenOpenings`), wrapped with a nonce unique to the push (`OncePerPush`), and sent through
/// `HealthRouting.opened`, which stamps the phone's facts (`HealthDevices`) on it. **Every Health
/// screen opens once per push**: a pop back onto the home from a metric must not reset the tab
/// the member chose, and Connect must not lose its switches while the OS's sheet is up.
///
/// **INTENTS ARE THE SHELL'S, AND WHERE THEY GO IS SHARED.** A pick, Connect, "Choose what to
/// read" and Connected change nothing on a machine; `routeIntent` hands the event to
/// `HealthRouting.route`, which answers the move. Two intents are the shell's own acts, never
/// moves: `ConnectTapped` asks the OS for exactly `HealthConnectState.chosen`, read only, then
/// tells the vault (`ShellModel.connectHealth`) and reports back to the page; `StopConfirmed`
/// stops reading the store (`ShellModel.stopHealth`).
enum HealthScreens: AppScreens {
    static let appID = AppIds.shared.HEALTH
    /// The machines' `SCREEN_ID`s.
    static let home = HealthHomeMachine.shared.SCREEN_ID
    static let metric = HealthMetricMachine.shared.SCREEN_ID
    static let workout = HealthWorkoutMachine.shared.SCREEN_ID
    static let connect = HealthConnectMachine.shared.SCREEN_ID

    /// Connect's bridge, held so the shell's report (`connected`, `failed`) reaches the page.
    private static let connectBridge = HealthConnectScreenBridge()

    // MARK: - Registration

    @MainActor
    static func register(into shell: ShellModel) {
        let homeBridge = HealthHomeBridge()
        let metricBridge = HealthMetricBridge()
        let workoutBridge = HealthWorkoutBridge()
        shell.register(ScreenPort(
            id: home,
            send: { homeBridge.send(event: $0.kotlin) },
            attach: { homeBridge.attach(session: $0) },
            observe: { onState in homeBridge.observe { onState($0.data) } }
        ))
        shell.register(ScreenPort(
            id: metric,
            send: { metricBridge.send(event: $0.kotlin) },
            attach: { metricBridge.attach(session: $0) },
            observe: { onState in metricBridge.observe { onState($0.data) } }
        ))
        shell.register(ScreenPort(
            id: workout,
            send: { workoutBridge.send(event: $0.kotlin) },
            attach: { workoutBridge.attach(session: $0) },
            observe: { onState in workoutBridge.observe { onState($0.data) } }
        ))
        shell.register(.of(connect, connectBridge))

        let memory = OpenMemory()
        for identifier in [home, metric, workout, connect] {
            shell.route(
                identifier,
                open: { [weak shell] parameter in opened(identifier, parameter, shell, memory) },
                view: { shell, parameter in view(identifier, shell, parameter) }
            )
        }
    }

    /// EVERY OPEN IS THE ROUTE'S OWN `Opened`, stamped with the phone's facts, once per push.
    @MainActor
    private static func opened(_ identifier: String, _ parameter: Data, _ shell: ShellModel?, _ memory: OpenMemory) {
        guard let shell, let route = OncePerPush(decoding: parameter), memory.firstOpen(identifier, route.nonce) else { return }
        shell.send(screen: identifier, event: HealthRouting.shared.opened(screenId: identifier, opened: route.opened.kotlin).data)
    }

    // MARK: - Views

    @MainActor
    private static func view(_ identifier: String, _ shell: ShellModel, _ parameter: Data) -> AnyView {
        let send: (Data) -> Void = { [weak shell] bytes in
            guard let shell else { return }
            // Read before the send: an intent acts on the state the member tapped.
            let before = shell.state(identifier)
            shell.send(screen: identifier, event: bytes)
            routeIntent(identifier, bytes, before, shell)
        }
        let pop: () -> Void = { [weak shell] in
            guard let shell, !shell.path.isEmpty else { return }
            shell.path.removeLast()
        }
        switch identifier {
        case home:
            return AnyView(HealthHomeView(
                data: shell.state(home),
                send: send,
                onHome: { [weak shell] in shell?.path.removeAll() }
            ))
        case metric:
            return AnyView(HealthMetricView(data: shell.state(metric), send: send, onBack: pop))
        case workout:
            return AnyView(HealthWorkoutView(data: shell.state(workout), send: send, onBack: pop))
        case connect:
            return AnyView(HealthConnectView(data: shell.state(connect), send: send, onBack: pop))
        default:
            return AnyView(EmptyView())
        }
    }

    // MARK: - Intents

    /// THE INTENTS, ROUTED BY THE SHARED SIDE (`HealthRouting`), and the shell's two acts.
    @MainActor
    static func routeIntent(_ identifier: String, _ bytes: Data, _ before: Data, _ shell: ShellModel) {
        if identifier == connect,
           let event = try? Centraid_Screen_V1_HealthConnectEvent(serializedBytes: bytes), case .connect? = event.kind,
           let state = try? Centraid_Screen_V1_HealthConnectState(serializedBytes: before), state.canConnect
        {
            shell.connectHealth(state.chosen) { [weak shell] ok in
                guard ok else {
                    connectBridge.failed(sentence: "")
                    return
                }
                connectBridge.connected()
                // CONNECTED IS THE POP BACK (`HealthRouting.connect`), applied only while Connect
                // is still the page on top: a member who left it meanwhile is not moved.
                guard let shell, case .screen(connect, _)? = shell.path.last else { return }
                let report = healthEvent(Centraid_Screen_V1_HealthConnectEvent.self) { $0.connected = .init() }
                shell.apply(HealthRouting.shared.route(screenId: connect, event: report.kotlin, state: shell.state(connect).kotlin))
            }
            return
        }
        if identifier == home,
           let event = try? Centraid_Screen_V1_HealthHomeEvent(serializedBytes: bytes), case .stop? = event.kind
        {
            shell.stopHealth()
            return
        }
        shell.apply(HealthRouting.shared.route(screenId: identifier, event: bytes.kotlin, state: shell.state(identifier).kotlin))
    }

    static func tileRoute(_ tile: Centraid_Screen_V1_HomeTile) -> ShellModel.Route? { .home(of: appID) }

    /// A SCREEN THE SHARED SIDE NAMED (`ScreenOpening`) is pushed in the shape this app's routes
    /// take: its event, as spelled, with a nonce for the push.
    static func present(_ screen: String, _ opened: Data) -> ShellModel.Route {
        .screen(screen, OncePerPush(opened: opened).encoded)
    }
}
