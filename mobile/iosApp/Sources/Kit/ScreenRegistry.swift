import Foundation
import SwiftUI

#if canImport(CentraidShared)
import CentraidShared
#endif

// THE SHELL REGISTRY (K5; shared-constructs §5).
//
// Before this, every screen cost three edits to `ShellModel` — a
// `@Published var xState`, a `private let x = XBridge()`, a `case "x":` in
// `send` — plus a `Route` case, a branch in `CentraidApp`'s destination switch
// and a branch in `opened`. Six app ports each making those edits to the same
// two files is the collision `docs/multi-agent.md` sizes lanes around.
//
// Now an app has ONE file, `Sources/<App>/<App>Screens.swift`, conforming to
// `AppScreens`, and ONE line in `AppRegistry.apps`. Its `register(into:)`
// hands the shell a `ScreenPort` per bridge (bytes in and out, attach,
// departed) and a `ScreenRoute` per pushed screen (how to open it, what to
// draw). The shell keys both on the machine's `SCREEN_ID` — the same constant
// its `ReadPage` effects carry — and routes with `Route.screen(id, param)`.

/// One app's screens. A port conforms once, in its own folder.
protocol AppScreens {
    /// The app's catalog id — what a Home tile names.
    static var appID: String { get }
    /// Hand the shell this app's ports and routes.
    @MainActor static func register(into shell: ShellModel)
    /// Where this app's Home tile leads, or nowhere (`nil` is honest: a tap
    /// that stays put beats a blank cover).
    static func tileRoute(_ tile: Centraid_Screen_V1_HomeTile) -> ShellModel.Route?
}

/// THE ONE LIST. A port adds exactly one line here.
enum AppRegistry {
    static let apps: [any AppScreens.Type] = [
        TallyScreens.self,
        NotesScreens.self,
        AgendaScreens.self,
        TasksScreens.self,
        PeopleScreens.self,
        DocsScreens.self,
    ]

    static func tileRoute(_ tile: Centraid_Screen_V1_HomeTile) -> ShellModel.Route? {
        apps.first { $0.appID == tile.appID }?.tileRoute(tile)
    }
}

/// How a registered screen opens and what it draws.
///
/// `open` is sent the route's parameter bytes on every appearance — a screen
/// reads because it was OPENED, never because it was built. `view` draws it
/// from the shell (for `state(id)` and `send`) and the same parameter.
struct ScreenRoute {
    let open: (Data) -> Void
    let view: @MainActor (ShellModel, Data) -> AnyView
}

#if canImport(CentraidShared)
/// ONE BRIDGE, AS THE SHELL SEES IT: bytes in, bytes out, attach, departed.
///
/// Closures rather than the Kotlin class, so a bridge that predates the kit
/// (`AgendaBridge`, the Photos ones) registers exactly like a
/// `ScreenBridge` subclass does.
struct ScreenPort {
    let id: String
    let send: (Data) -> Void
    let attach: (HomeSession) -> Void
    let observe: (@escaping (Data) -> Void) -> Void
    /// The member left the screen; the bridge lives on (`ScreenBridge.departed`
    /// sends the machine's `Left`, which is the autosave flush).
    var departed: () -> Void = {}

    /// A kit `ScreenBridge` subclass — `NotesBridge`, `PeopleHomeBridge`, and
    /// every port's bridge (Tally's speak the same verbs through
    /// `TallyScreenBridge`; see `ScreenPort.tally`).
    static func of<S: AnyObject, E: AnyObject>(_ id: String, _ bridge: ScreenBridge<S, E>) -> ScreenPort {
        ScreenPort(
            id: id,
            send: { bridge.send(event: $0.kotlin) },
            attach: { bridge.attach(session: $0) },
            observe: { onState in bridge.observe { onState($0.data) } },
            departed: { bridge.departed() }
        )
    }
}
#endif

extension ShellModel {
    /// A registered screen's last state, or empty bytes — which every decoder
    /// reads as LOADING, never as an empty vault.
    func state(_ id: String) -> Data { states[id] ?? Data() }

    /// A registered screen's view for a route.
    func routeView(_ id: String, _ parameter: Data) -> AnyView {
        routes[id]?.view(self, parameter) ?? AnyView(EmptyView())
    }

    func route(_ id: String, open: @escaping (Data) -> Void, view: @escaping @MainActor (ShellModel, Data) -> AnyView) {
        routes[id] = ScreenRoute(open: open, view: view)
    }

    /// The member left a registered screen without closing its bridge.
    func departed(_ id: String) {
        #if canImport(CentraidShared)
        ports[id]?.departed()
        #endif
    }

    #if canImport(CentraidShared)
    /// Take a port: observe it into `states`, and attach it if the session is
    /// already open.
    func register(_ port: ScreenPort) {
        ports[port.id] = port
        port.observe { [weak self] bytes in self?.states[port.id] = bytes }
        if let session { port.attach(session) }
    }
    #endif
}

/// A REGISTERED SCREEN ON THE STACK. Its own `@ObservedObject`, so a state
/// arriving for this screen redraws it wherever SwiftUI hosts the destination.
struct RegisteredScreen: View {
    @ObservedObject var shell: ShellModel
    let identifier: String
    let parameter: Data

    var body: some View { shell.routeView(identifier, parameter) }
}
