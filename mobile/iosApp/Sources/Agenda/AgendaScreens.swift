import SwiftUI

#if canImport(CentraidShared)
import CentraidShared
#endif

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
/// **INTENTS ARE THE SHELL'S.** `EventPicked` pushes the detail,
/// `NewEventRequested` the editor on the home's anchor day, and the detail's
/// `ActionPicked{edit}` the editor on that occurrence.
enum AgendaScreens: AppScreens {
    static let appID = "agenda"
    static let home = "agenda.home"
    static let detail = "agenda.event"
    static let editor = "agenda.editor"
    static let homeRoute = ShellModel.Route.screen(home, Data())

    static func detailRoute(eventID: String, instanceKey: String, originalStartLocal: String?, day: String) -> ShellModel.Route {
        .screen(detail, tasksEvent(Centraid_Screen_V1_AgendaEventEvent.self) {
            $0.opened = .with {
                $0.eventID = eventID
                $0.instanceKey = instanceKey
                if let originalStartLocal { $0.originalStartLocal = originalStartLocal }
                $0.day = day
            }
        })
    }

    /// A new event on `day` (the home's anchor; empty is the core's today).
    static func newEventRoute(day: String) -> ShellModel.Route {
        .screen(editor, tasksEvent(Centraid_Screen_V1_AgendaEditorEvent.self) {
            $0.opened = .with {
                $0.mode = .create
                $0.day = day
            }
        })
    }

    static func editRoute(eventID: String, instanceKey: String, originalStartLocal: String?, day: String) -> ShellModel.Route {
        .screen(editor, tasksEvent(Centraid_Screen_V1_AgendaEditorEvent.self) {
            $0.opened = .with {
                $0.mode = .edit
                $0.eventID = eventID
                $0.instanceKey = instanceKey
                if let originalStartLocal { $0.originalStartLocal = originalStartLocal }
                $0.day = day
            }
        })
    }

    @MainActor
    static func register(into shell: ShellModel) {
        #if canImport(CentraidShared)
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
        #endif
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
                        routeHomeIntent(bytes, shell)
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
                        routeDetailIntent(bytes, shell)
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

    @MainActor
    private static func routeHomeIntent(_ bytes: Data, _ shell: ShellModel) {
        guard let event = try? Centraid_Screen_V1_AgendaHomeEvent(serializedBytes: bytes) else { return }
        switch event.kind {
        case let .eventPicked(picked):
            shell.path.append(detailRoute(
                eventID: picked.eventID,
                instanceKey: picked.instanceKey,
                originalStartLocal: picked.hasOriginalStartLocal ? picked.originalStartLocal : nil,
                day: picked.day
            ))
        case .newEvent:
            let state = (try? Centraid_Screen_V1_AgendaHomeState(serializedBytes: shell.state(home))) ?? .init()
            shell.path.append(newEventRoute(day: state.anchorDay))
        default:
            break
        }
    }

    @MainActor
    private static func routeDetailIntent(_ bytes: Data, _ shell: ShellModel) {
        guard case let .action(action)? = (try? Centraid_Screen_V1_AgendaEventEvent(serializedBytes: bytes))?.kind,
              action.key == "edit" else { return }
        let state = (try? Centraid_Screen_V1_AgendaEventState(serializedBytes: shell.state(detail))) ?? .init()
        shell.path.append(editRoute(
            eventID: state.eventID,
            instanceKey: state.instanceKey,
            originalStartLocal: state.hasOriginalStartLocal ? state.originalStartLocal : nil,
            day: state.day
        ))
    }

    static func tileRoute(_ tile: Centraid_Screen_V1_HomeTile) -> ShellModel.Route? { homeRoute }
}
