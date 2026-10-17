import SwiftProtobuf
import SwiftUI

import CentraidShared

/// TASKS, REGISTERED (#1029 app port; K5). Its one line is in `AppRegistry.apps`.
///
/// **A ROUTE'S PARAMETER IS ITS SCREEN'S `Opened` EVENT, ENCODED.** Every Tasks
/// screen opens on an event that names what it shows (a view, a project, a
/// task), so the route carries those bytes and `open` sends them — the shell
/// never re-spells a parameter the proto already spells. A pop back onto a
/// screen re-sends its own `Opened` (`CentraidApp`'s `.task`), which is also
/// what puts a detail back on ITS task after a subtask's detail was on top: the
/// five bridges live for the whole app, one per screen.
///
/// **INTENTS ARE THE SHELL'S.** A machine that emits `RowPicked`,
/// `ProjectPicked`, a More row, a Catch-up verb, `SubtaskPicked` or
/// `ParentPicked` changes nothing (or only closes its sheet); `routeIntent`
/// hands the event the view just forwarded to `TasksRouting` (the shared side
/// decides WHICH page, for Android too) and pushes what it answers.
enum TasksScreens: AppScreens {
    static let appID = AppIds.shared.TASKS
    /// The machines' `SCREEN_ID`s.
    static let home = TasksHomeMachine.shared.SCREEN_ID
    static let list = TasksListMachine.shared.SCREEN_ID
    static let project = TasksProjectMachine.shared.SCREEN_ID
    static let detail = TasksDetailMachine.shared.SCREEN_ID
    static let catchUp = TasksCatchUpMachine.shared.SCREEN_ID
    static let trash = TasksTrashMachine.shared.machine.screenId

    @MainActor
    static func register(into shell: ShellModel) {
        // The no-argument constructors mint `add_task`'s ids in Kotlin, so the
        // row the member sees is the row the vault keeps.
        let homeBridge = TasksHomeBridge()
        let listBridge = TasksListBridge()
        let projectBridge = TasksProjectBridge()
        let detailBridge = TasksDetailBridge()
        let catchUpBridge = TasksCatchUpBridge()
        shell.register(ScreenPort(
            id: home,
            send: { homeBridge.send(event: $0.kotlin) },
            attach: { homeBridge.attach(session: $0) },
            observe: { onState in homeBridge.observe { onState($0.data) } },
            departed: { homeBridge.departed() }
        ))
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

        // EVERY OPEN IS THE ROUTE'S OWN `Opened` — the home with words for its
        // quick add once per push (`present`), so a pop back onto it does not
        // seed them a second time.
        let memory = OpenMemory()
        for identifier in [home, list, project, detail, catchUp, trash] {
            shell.route(
                identifier,
                open: { [weak shell] parameter in
                    if let once = OncePerPush(decoding: parameter) {
                        if memory.firstOpen(identifier, once.nonce) { shell?.send(screen: identifier, event: once.opened) }
                        return
                    }
                    shell?.send(screen: identifier, event: parameter)
                },
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
        case home:
            return AnyView(TasksHomeView(
                data: shell.state(home),
                send: send,
                onHome: { [weak shell] in shell?.path.removeAll() },
                openContainer: { [weak shell] in shell?.openRow($0, parent: $1) }
            ))
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

    /// THE INTENTS, ROUTED BY THE SHARED SIDE (`TasksRouting`): which page an
    /// event opens is decided once, for both shells, from the event the view
    /// just forwarded and the screen's own state. This only pushes it.
    @MainActor
    static func routeIntent(_ identifier: String, _ bytes: Data, _ shell: ShellModel) {
        guard let opening = TasksRouting.shared.route(
            screenId: identifier,
            event: bytes.kotlin,
            state: shell.state(identifier).kotlin
        ) else { return }
        shell.path.append(.opening(opening))
    }

    static func tileRoute(_ tile: Centraid_Screen_V1_HomeTile) -> ShellModel.Route? { .home(of: appID) }

    /// NOTES' "SEND TO TASKS" lands here: the home on the Inbox with words in a
    /// focused quick add (`TasksHomeEvent.Opened.quick_add_title`), opened once
    /// per push. Every other screen is pushed on its event as it stands.
    static func present(_ screen: String, _ opened: Data) -> ShellModel.Route {
        if screen == home,
           let event = try? Centraid_Screen_V1_TasksHomeEvent(serializedBytes: opened),
           !event.opened.quickAddTitle.isEmpty {
            return .screen(home, OncePerPush(opened: opened).encoded)
        }
        return .screen(screen, opened)
    }
}

/// One Tasks event, encoded — the bytes every bridge takes.
func tasksEvent<Event: SwiftProtobuf.Message>(_ type: Event.Type, _ build: (inout Event) -> Void) -> Data {
    var event = Event()
    build(&event)
    return event.encoded
}
