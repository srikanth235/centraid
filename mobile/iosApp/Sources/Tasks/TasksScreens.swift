import SwiftProtobuf
import SwiftUI

#if canImport(CentraidShared)
import CentraidShared
#endif

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
/// reads the event the view just forwarded and pushes the destination.
enum TasksScreens: AppScreens {
    static let appID = "tasks"
    /// The machines' `SCREEN_ID`s.
    static let home = "tasks.home"
    static let list = "tasks.list"
    static let project = "tasks.project"
    static let detail = "tasks.detail"
    static let catchUp = "tasks.catch_up"
    static let trash = "tasks.trash"

    static var homeRoute: ShellModel.Route {
        .screen(home, tasksEvent(Centraid_Screen_V1_TasksHomeEvent.self) { $0.opened = .with { $0.destination = .today } })
    }

    static func listRoute(_ view: Centraid_Screen_V1_TasksListState.View) -> ShellModel.Route {
        .screen(list, tasksEvent(Centraid_Screen_V1_TasksListEvent.self) { $0.opened = .with { $0.view = view } })
    }

    static func projectRoute(_ projectIdentifier: String, title: String) -> ShellModel.Route {
        .screen(project, tasksEvent(Centraid_Screen_V1_TasksProjectEvent.self) {
            $0.opened = .with {
                $0.projectID = projectIdentifier
                $0.title = title
            }
        })
    }

    static func detailRoute(_ taskIdentifier: String) -> ShellModel.Route {
        .screen(detail, tasksEvent(Centraid_Screen_V1_TasksDetailEvent.self) { $0.opened = .with { $0.taskID = taskIdentifier } })
    }

    static var catchUpRoute: ShellModel.Route {
        .screen(catchUp, tasksEvent(Centraid_Screen_V1_TasksCatchUpEvent.self) { $0.opened = .init() })
    }

    static var trashRoute: ShellModel.Route {
        .screen(trash, TrashListView.event { $0.opened = .init() })
    }

    /// The home as `openQuickAdd` left it: its route's `open` sends nothing,
    /// because the bridge was already opened — and a pop back onto it must
    /// not seed the words a second time.
    private static let quickAddParameter = Data("quick-add".utf8)

    #if canImport(CentraidShared)
    @MainActor private static var homeBridge: TasksHomeBridge?
    #endif

    /// NOTES' "SEND TO TASKS": Tasks' home on the Inbox with `text` in a
    /// focused quick add (`TasksHomeBridge.openQuickAdd`), pushed.
    @MainActor
    static func openQuickAdd(_ text: String, _ shell: ShellModel) {
        #if canImport(CentraidShared)
        homeBridge?.openQuickAdd(text: text)
        #endif
        shell.path.append(.screen(home, quickAddParameter))
    }

    @MainActor
    static func register(into shell: ShellModel) {
        #if canImport(CentraidShared)
        // The no-argument constructors mint `add_task`'s ids in Kotlin, so the
        // row the member sees is the row the vault keeps.
        let homeBridge = TasksHomeBridge()
        Self.homeBridge = homeBridge
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
        #endif

        // EVERY OPEN IS THE ROUTE'S OWN `Opened`.
        for identifier in [home, list, project, detail, catchUp, trash] {
            shell.route(
                identifier,
                open: { [weak shell] parameter in
                    if identifier == home, parameter == quickAddParameter { return }
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
                onHome: { [weak shell] in shell?.path.removeAll() }
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

    @MainActor
    private static func homeState(_ shell: ShellModel) -> Centraid_Screen_V1_TasksHomeState {
        (try? Centraid_Screen_V1_TasksHomeState(serializedBytes: shell.state(home))) ?? .init()
    }

    /// THE INTENTS, ROUTED.
    @MainActor
    static func routeIntent(_ identifier: String, _ bytes: Data, _ shell: ShellModel) {
        switch identifier {
        case home:
            guard let event = try? Centraid_Screen_V1_TasksHomeEvent(serializedBytes: bytes) else { return }
            switch event.kind {
            case let .rowPicked(picked): shell.path.append(detailRoute(picked.taskID))
            case let .projectPicked(picked):
                var title = ""
                if case let .data(data)? = homeState(shell).content {
                    title = data.projects.flatMap(\.rows).first { $0.id == picked.projectID }?.title ?? ""
                }
                shell.path.append(projectRoute(picked.projectID, title: title))
            case let .moreRow(row):
                switch row.key {
                case "anytime": shell.path.append(listRoute(.anytime))
                case "all": shell.path.append(listRoute(.all))
                case "logbook": shell.path.append(listRoute(.logbook))
                case "reminders": shell.path.append(listRoute(.reminders))
                case "catch_up": shell.path.append(catchUpRoute)
                case "trash": shell.path.append(trashRoute)
                default: break // `search` and `reads` are the machine's.
                }
            case let .groupVerb(verb) where verb.key == "catch_up":
                shell.path.append(catchUpRoute)
            case .noticeActed:
                if case let .data(data)? = homeState(shell).content, data.notice.verbKey == "catch_up" {
                    shell.path.append(catchUpRoute)
                }
            default: break
            }
        case list:
            if case let .rowPicked(picked)? = (try? Centraid_Screen_V1_TasksListEvent(serializedBytes: bytes))?.kind {
                shell.path.append(detailRoute(picked.taskID))
            }
        case project:
            if case let .rowPicked(picked)? = (try? Centraid_Screen_V1_TasksProjectEvent(serializedBytes: bytes))?.kind {
                shell.path.append(detailRoute(picked.taskID))
            }
        case catchUp:
            if case let .rowPicked(picked)? = (try? Centraid_Screen_V1_TasksCatchUpEvent(serializedBytes: bytes))?.kind {
                shell.path.append(detailRoute(picked.taskID))
            }
        case detail:
            guard let event = try? Centraid_Screen_V1_TasksDetailEvent(serializedBytes: bytes) else { return }
            switch event.kind {
            case let .subtaskPicked(picked): shell.path.append(detailRoute(picked.taskID))
            case .parentPicked:
                let state = (try? Centraid_Screen_V1_TasksDetailState(serializedBytes: shell.state(detail))) ?? .init()
                if case let .data(data)? = state.content, !data.parentTaskID.isEmpty {
                    shell.path.append(detailRoute(data.parentTaskID))
                }
            default: break
            }
        default: break
        }
    }

    static func tileRoute(_ tile: Centraid_Screen_V1_HomeTile) -> ShellModel.Route? { homeRoute }
}

/// One Tasks event, encoded — the bytes every bridge takes.
func tasksEvent<Event: SwiftProtobuf.Message>(_ type: Event.Type, _ build: (inout Event) -> Void) -> Data {
    var event = Event()
    build(&event)
    return event.encoded
}
