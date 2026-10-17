import SwiftUI

import CentraidShared

/// AGENDA, REGISTERED (K5; #1046 waves 4 and 5). Its bridges predate the kit's
/// `ScreenBridge`, so each port is spelled out closure by closure — the
/// registry takes either.
///
/// **ONE `AgendaMarks` FOR ALL THREE BRIDGES.** The session's held writes live
/// there: the home draws "pending" and "cancellation asked" from it, and a
/// write refused after its screen was left comes back as the detail's parked
/// card. Three marks would be three memories of one write.
///
/// **A ROUTE'S PARAMETER IS ITS SCREEN'S `Opened` EVENT, ENCODED**, so `open`
/// sends it as it stands — the occurrence's ids and day for the detail, the
/// mode and day (and ids, on an edit) for the editor.
///
/// **INTENTS ARE THE SHELL'S, AND WHERE THEY GO IS SHARED.** `EventPicked`
/// pushes the detail, `NewEventRequested` the editor on the home's anchor day,
/// and the detail's `ActionPicked{edit}` the editor on that occurrence — each
/// answered by `AgendaRouting.route` (Android pushes the same page).
enum AgendaScreens: AppScreens {
    static let appID = AppIds.shared.AGENDA
    /// The machines' `SCREEN_ID`s.
    static let home = AgendaHomeMachine.shared.SCREEN_ID
    static let detail = AgendaEventMachine.shared.SCREEN_ID
    static let editor = AgendaEditorMachine.shared.SCREEN_ID

    @MainActor
    static func register(into shell: ShellModel) {
        let marks = AgendaMarks()
        let homeBridge = AgendaBridge(marks: marks)
        let detailBridge = AgendaEventBridge(marks: marks)
        let editorBridge = AgendaEditorBridge(marks: marks)
        shell.register(ScreenPort(
            id: home,
            send: { homeBridge.send(event: $0.kotlin) },
            attach: { homeBridge.attach(session: $0) },
            observe: { onState in homeBridge.observe { onState($0.data) } }
        ))
        shell.register(ScreenPort(
            id: detail,
            send: { detailBridge.send(event: $0.kotlin) },
            attach: { detailBridge.attach(session: $0) },
            observe: { onState in detailBridge.observe { onState($0.data) } },
            departed: { detailBridge.departed() }
        ))
        shell.register(ScreenPort(
            id: editor,
            send: { editorBridge.send(event: $0.kotlin) },
            attach: { editorBridge.attach(session: $0) },
            observe: { onState in editorBridge.observe { onState($0.data) } },
            departed: { editorBridge.departed() }
        ))
        shell.route(
            home,
            // EVERY OPEN LANDS ON TODAY, on Day — `AgendaBridge.open`'s event,
            // sent as bytes because a Kotlin enum default does not cross into
            // Swift.
            open: { [weak shell] _ in
                shell?.send(screen: home, event: AgendaEvents.make { $0.opened = .with { $0.destination = .day } })
            },
            view: { shell, _ in
                AnyView(AgendaHomeView(
                    data: shell.state(home),
                    send: { [weak shell] bytes in
                        guard let shell else { return }
                        shell.send(screen: home, event: bytes)
                        shell.apply(AgendaRouting.shared.route(screenId: home, event: bytes.kotlin, state: shell.state(home).kotlin))
                    },
                    onHome: { [weak shell] in shell?.path.removeAll() }
                ))
            }
        )
        shell.route(
            detail,
            open: { [weak shell] parameter in shell?.send(screen: detail, event: parameter) },
            view: { shell, _ in
                AnyView(AgendaEventView(
                    data: shell.state(detail),
                    send: { [weak shell] bytes in
                        guard let shell else { return }
                        shell.send(screen: detail, event: bytes)
                        shell.apply(AgendaRouting.shared.route(screenId: detail, event: bytes.kotlin, state: shell.state(detail).kotlin))
                    },
                    onBack: { [weak shell] in pop(shell) }
                ))
            }
        )
        shell.route(
            editor,
            open: { [weak shell] parameter in shell?.send(screen: editor, event: parameter) },
            view: { shell, parameter in
                AnyView(AgendaEditorView(
                    data: shell.state(editor),
                    opened: parameter,
                    send: { [weak shell] in shell?.send(screen: editor, event: $0) },
                    onDone: { [weak shell] in pop(shell) }
                ))
            }
        )
    }

    @MainActor
    private static func pop(_ shell: ShellModel?) {
        guard let shell, !shell.path.isEmpty else { return }
        shell.path.removeLast()
    }

    static func tileRoute(_ tile: Centraid_Screen_V1_HomeTile) -> ShellModel.Route? { .home(of: appID) }
}
