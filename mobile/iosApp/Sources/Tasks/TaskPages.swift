import SwiftProtobuf
import SwiftUI

import CentraidShared

/// THE TASK PAGES, HOSTED BY AGENDA (#1128, R-1128-5). Tasks is a vault domain
/// and a write app id, not an app a member launches: it has no tile, no home
/// and no `AppScreens` line. Its pushed pages — a list (Anytime, Logbook,
/// Reminders), a project, Catch up, one task and the Trash — keep their
/// machines, bridges and `tasks.*` screen ids, and `AgendaScreens.register`
/// registers them here; their back control reads "Agenda".
///
/// **A ROUTE'S PARAMETER IS ITS SCREEN'S `Opened` EVENT, ENCODED.** Every page
/// opens on an event that names what it shows (a view, a project, a task), so
/// the route carries those bytes and `open` sends them — the shell never
/// re-spells a parameter the proto already spells. A pop back onto a page
/// re-sends its own `Opened` (`CentraidApp`'s `.task`), which is also what puts
/// a detail back on ITS task after a subtask's detail was on top: the bridges
/// live for the whole app, one per screen.
///
/// **INTENTS ARE THE SHELL'S.** A machine that emits `RowPicked`,
/// `SubtaskPicked` or `ParentPicked` changes nothing; `routeIntent` hands the
/// event the view just forwarded to `AgendaRouting` (the shared side decides
/// WHICH page, for Android too) and pushes what it answers.
enum TaskPages {
    /// The machines' `SCREEN_ID`s.
    static let list = TasksListMachine.shared.SCREEN_ID
    static let project = TasksProjectMachine.shared.SCREEN_ID
    static let detail = TasksDetailMachine.shared.SCREEN_ID
    static let catchUp = TasksCatchUpMachine.shared.SCREEN_ID
    static let trash = TasksTrashMachine.shared.machine.screenId

    /// Every `tasks.` screen id is Agenda's to present (`AppScreens.screenPrefixes`).
    static let screenPrefix = "tasks."

    @MainActor
    static func register(into shell: ShellModel) {
        // The no-argument constructors mint `add_task`'s ids in Kotlin, so the
        // row the member sees is the row the vault keeps.
        let listBridge = TasksListBridge()
        let projectBridge = TasksProjectBridge()
        let detailBridge = TasksDetailBridge()
        let catchUpBridge = TasksCatchUpBridge()
        shell.register(ScreenPort(
            id: list,
            send: { listBridge.send(event: $0.kotlin) },
            attach: { listBridge.attach(session: $0) },
            observe: { onState in listBridge.observe { onState($0.data) } },
            departed: { listBridge.departed() }
        ))
        shell.register(ScreenPort(
            id: project,
            send: { projectBridge.send(event: $0.kotlin) },
            attach: { projectBridge.attach(session: $0) },
            observe: { onState in projectBridge.observe { onState($0.data) } },
            departed: { projectBridge.departed() }
        ))
        shell.register(ScreenPort(
            id: detail,
            send: { detailBridge.send(event: $0.kotlin) },
            attach: { detailBridge.attach(session: $0) },
            observe: { onState in detailBridge.observe { onState($0.data) } },
            departed: { detailBridge.departed() }
        ))
        shell.register(ScreenPort(
            id: catchUp,
            send: { catchUpBridge.send(event: $0.kotlin) },
            attach: { catchUpBridge.attach(session: $0) },
            observe: { onState in catchUpBridge.observe { onState($0.data) } },
            departed: { catchUpBridge.departed() }
        ))
        shell.register(.of(trash, TasksTrashBridge()))

        for identifier in [list, project, detail, catchUp, trash] {
            shell.route(
                identifier,
                open: { [weak shell] parameter in shell?.send(screen: identifier, event: parameter) },
                view: { shell, parameter in view(identifier, shell, parameter) }
            )
        }
    }

    @MainActor
    private static func view(_ identifier: String, _ shell: ShellModel, _ parameter: Data) -> AnyView {
        let send: (Data) -> Void = { [weak shell] bytes in
            guard let shell else { return }
            shell.send(screen: identifier, event: bytes)
            routeIntent(identifier, bytes, shell)
        }
        let pop: () -> Void = { [weak shell] in
            guard let shell, !shell.path.isEmpty else { return }
            shell.path.removeLast()
        }
        switch identifier {
        case list:
            return AnyView(TasksListView(data: shell.state(list), send: send, onBack: pop))
        case project:
            return AnyView(TasksProjectView(data: shell.state(project), send: send, onBack: pop))
        case catchUp:
            return AnyView(TasksCatchUpView(data: shell.state(catchUp), send: send, onBack: pop))
        case detail:
            let opened = (try? Centraid_Screen_V1_TasksDetailEvent(serializedBytes: parameter))?.opened.taskID ?? ""
            return AnyView(TasksDetailView(
                data: shell.state(detail),
                taskIdentifier: opened,
                send: send,
                onClose: pop,
                onDeparted: { [weak shell] in shell?.departed(detail) }
            ))
        case trash:
            return AnyView(TrashListView(
                data: shell.state(trash),
                send: send,
                onBack: pop
            ))
        default:
            return AnyView(EmptyView())
        }
    }

    /// THE INTENTS, ROUTED BY THE SHARED SIDE (`AgendaRouting.route`): which
    /// page an event opens is decided once, for both shells, from the event
    /// the view just forwarded and the screen's own state. This only pushes it.
    @MainActor
    static func routeIntent(_ identifier: String, _ bytes: Data, _ shell: ShellModel) {
        shell.apply(AgendaRouting.shared.route(
            screenId: identifier,
            event: bytes.kotlin,
            state: shell.state(identifier).kotlin
        ))
    }
}

/// One task-page event, encoded — the bytes every bridge takes.
func tasksEvent<Event: SwiftProtobuf.Message>(_ type: Event.Type, _ build: (inout Event) -> Void) -> Data {
    var event = Event()
    build(&event)
    return event.encoded
}
