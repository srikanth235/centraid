import SwiftUI

#if canImport(CentraidShared)
import CentraidShared
#endif

/// TALLY, REGISTERED (K5; #1046). Its one line is in `AppRegistry.apps`.
///
/// Ten screens, one bridge each, keyed on the machines' `SCREEN_ID`s. A route's
/// parameter is the screen's own `Opened` event, encoded, so the `open` sent on
/// every appearance is the exact event the machine takes — except the editor
/// and settle-up, whose bridges mint the sitting's token on open and are called
/// directly.
///
/// **INTENTS ARE THE SHELL'S.** The machines change nothing on `FriendPicked`,
/// `GroupPicked`, `ExpensePicked`, `AddExpense`, `SettleUp`, `EditTapped` or a
/// More row; each view forwards the event and then pushes the route this file
/// builds, through the `push` closure the registry hands it.
enum TallyScreens: AppScreens {
    static let appID = "tally"

    static let home = "tally.home"
    static let group = "tally.group"
    static let friend = "tally.friend"
    static let expense = "tally.expense"
    static let editor = "tally.editor"
    static let settleUp = "tally.settle_up"
    static let recurring = "tally.recurring"
    static let spending = "tally.spending"
    static let search = "tally.search"
    static let trash = "tally.trash"
    /// `TallyExportMachine.SCREEN_ID`.
    static let export = "tally.export"

    #if canImport(CentraidShared)
    /// The export's bridge, held so the root can install its save seam.
    static let exportBridge = TallyExportBridge()
    #endif

    // MARK: Routes

    static let homeRoute = ShellModel.Route.screen(
        home,
        Centraid_Screen_V1_TallyHomeEvent.with { $0.opened = .with { $0.destination = .balances } }.encoded
    )

    // `parent` is the PUSHING page's own title: the pushed page's back
    // control says it (`chrome.back`, #1047). Empty: "Tally".

    static func groupRoute(_ groupID: String, _ title: String = "", parent: String = "") -> ShellModel.Route {
        .screen(group, Centraid_Screen_V1_TallyGroupEvent.with {
            $0.opened = .with { $0.groupID = groupID; $0.title = title; $0.parent = parent }
        }.encoded)
    }

    static func friendRoute(_ partyID: String, _ title: String = "", parent: String = "") -> ShellModel.Route {
        .screen(friend, Centraid_Screen_V1_TallyFriendEvent.with {
            $0.opened = .with { $0.partyID = partyID; $0.title = title; $0.parent = parent }
        }.encoded)
    }

    static func expenseRoute(_ expenseID: String, parent: String = "") -> ShellModel.Route {
        .screen(expense, Centraid_Screen_V1_TallyExpenseEvent.with {
            $0.opened = .with { $0.expenseID = expenseID; $0.parent = parent }
        }.encoded)
    }

    /// Add (preset with a group or a friend) or edit. The token is the bridge's.
    static func addRoute(groupID: String = "", partyID: String = "") -> ShellModel.Route {
        .screen(editor, Centraid_Screen_V1_TallyEditorEvent.Opened.with {
            $0.mode = .add
            $0.groupID = groupID
            $0.partyID = partyID
        }.encoded)
    }

    static func editRoute(_ expenseID: String) -> ShellModel.Route {
        .screen(editor, Centraid_Screen_V1_TallyEditorEvent.Opened.with {
            $0.mode = .edit
            $0.expenseID = expenseID
        }.encoded)
    }

    /// `parent` is the pushing page's title, which settle-up's back says.
    static func settleUpRoute(_ groupID: String = "", parent: String = "") -> ShellModel.Route {
        .screen(settleUp, Centraid_Screen_V1_TallySettleUpEvent.Opened.with {
            $0.groupID = groupID
            $0.parent = parent
        }.encoded)
    }

    /// A group's ledger as a file; `groupID` empty picks none.
    static func exportRoute(_ groupID: String = "", parent: String = "") -> ShellModel.Route {
        .screen(export, Centraid_Screen_V1_TallyExportEvent.Opened.with {
            $0.groupID = groupID
            $0.parent = parent
        }.encoded)
    }

    static let recurringRoute = ShellModel.Route.screen(
        recurring, Centraid_Screen_V1_TallyRecurringEvent.with { $0.opened = .init() }.encoded
    )
    static let spendingRoute = ShellModel.Route.screen(
        spending, Centraid_Screen_V1_TallySpendingEvent.with { $0.opened = .init() }.encoded
    )
    static let searchRoute = ShellModel.Route.screen(
        search, Centraid_Screen_V1_TallySearchEvent.with { $0.opened = .init() }.encoded
    )

    /// The trash names its own title and back words (`TrashListState`).
    static let trashRoute = ShellModel.Route.screen(trash, Data())

    // MARK: Registration

    @MainActor
    static func register(into shell: ShellModel) {
        #if canImport(CentraidShared)
        let editorBridge = TallyEditorBridge()
        let settleBridge = TallySettleUpBridge()
        shell.register(.tally(home, TallyHomeBridge()))
        shell.register(.tally(group, TallyGroupBridge()))
        shell.register(.tally(friend, TallyFriendBridge()))
        shell.register(.tally(expense, TallyExpenseBridge()))
        shell.register(.tally(editor, editorBridge))
        shell.register(.tally(settleUp, settleBridge))
        shell.register(.tally(recurring, TallyRecurringBridge()))
        shell.register(.tally(spending, TallySpendingBridge()))
        shell.register(.tally(search, TallySearchBridge()))
        shell.register(.of(trash, TallyTrashBridge()))
        shell.register(.tally(export, exportBridge))
        #endif

        func push(_ shell: ShellModel?) -> (ShellModel.Route) -> Void {
            { [weak shell] route in shell?.path.append(route) }
        }
        func pop(_ shell: ShellModel?) -> () -> Void {
            { [weak shell] in
                guard let shell, !shell.path.isEmpty else { return }
                shell.path.removeLast()
            }
        }
        func sender(_ shell: ShellModel?, _ id: String) -> (Data) -> Void {
            { [weak shell] in shell?.send(screen: id, event: $0) }
        }

        // THE HOME RE-OPENS ON THE TAB IT WAS LEFT ON: a pop back from a
        // friend lands on Balances only if Balances was where the member was.
        shell.route(
            home,
            open: { [weak shell] parameter in
                guard let shell else { return }
                let held = (try? Centraid_Screen_V1_TallyHomeState(serializedBytes: shell.state(home))) ?? .init()
                var event = (try? Centraid_Screen_V1_TallyHomeEvent(serializedBytes: parameter)) ?? .init()
                if held.destination != .unspecified { event.opened.destination = held.destination }
                shell.send(screen: home, event: event.encoded)
            },
            view: { shell, _ in
                AnyView(TallyHomeView(
                    data: shell.state(home),
                    send: sender(shell, home),
                    push: push(shell),
                    onHome: { [weak shell] in shell?.path.removeAll() }
                ))
            }
        )
        let pages: [(String, @MainActor (ShellModel) -> AnyView)] = [
            (group, { (shell: ShellModel) in AnyView(TallyGroupView(data: shell.state(group), send: sender(shell, group), push: push(shell), onBack: pop(shell))) }),
            (friend, { (shell: ShellModel) in AnyView(TallyFriendView(data: shell.state(friend), send: sender(shell, friend), push: push(shell), onBack: pop(shell))) }),
            (expense, { (shell: ShellModel) in AnyView(TallyExpenseView(data: shell.state(expense), send: sender(shell, expense), push: push(shell), onBack: pop(shell))) }),
            (recurring, { (shell: ShellModel) in AnyView(TallyRecurringView(data: shell.state(recurring), send: sender(shell, recurring), onBack: pop(shell))) }),
            (spending, { (shell: ShellModel) in AnyView(TallySpendingView(data: shell.state(spending), send: sender(shell, spending), onBack: pop(shell))) }),
            (search, { (shell: ShellModel) in AnyView(TallySearchView(data: shell.state(search), send: sender(shell, search), push: push(shell), onBack: pop(shell))) }),
        ]
        for (id, view) in pages {
            shell.route(
                id,
                open: { [weak shell] parameter in shell?.send(screen: id, event: parameter) },
                view: { shell, _ in view(shell) }
            )
        }

        shell.route(
            editor,
            open: { parameter in
                #if canImport(CentraidShared)
                let opened = (try? Centraid_Screen_V1_TallyEditorEvent.Opened(serializedBytes: parameter)) ?? .init()
                if opened.mode == .edit {
                    editorBridge.openEdit(expenseId: opened.expenseID)
                } else {
                    editorBridge.openAdd(groupId: opened.groupID, partyId: opened.partyID)
                }
                #endif
            },
            view: { shell, _ in
                AnyView(TallyEditorView(
                    data: shell.state(editor),
                    send: sender(shell, editor),
                    onDone: pop(shell),
                    onDeparted: { [weak shell] in shell?.departed(editor) }
                ))
            }
        )
        shell.route(
            settleUp,
            open: { parameter in
                #if canImport(CentraidShared)
                let opened = (try? Centraid_Screen_V1_TallySettleUpEvent.Opened(serializedBytes: parameter)) ?? .init()
                settleBridge.open(groupId: opened.groupID, parent: opened.parent)
                #endif
            },
            view: { shell, _ in
                AnyView(TallySettleUpView(
                    data: shell.state(settleUp),
                    send: sender(shell, settleUp),
                    onBack: pop(shell),
                    onDeparted: { [weak shell] in shell?.departed(settleUp) }
                ))
            }
        )
        shell.route(
            export,
            open: { parameter in
                #if canImport(CentraidShared)
                let opened = (try? Centraid_Screen_V1_TallyExportEvent.Opened(serializedBytes: parameter)) ?? .init()
                exportBridge.open(groupId: opened.groupID, parent: opened.parent)
                #endif
            },
            view: { shell, _ in
                AnyView(TallyExportView(
                    data: shell.state(export),
                    send: sender(shell, export),
                    onSave: {
                        #if canImport(CentraidShared)
                        exportBridge.save()
                        #endif
                    },
                    onBack: pop(shell)
                ))
            }
        )
        shell.route(
            trash,
            open: { [weak shell] _ in
                shell?.send(screen: trash, event: TrashListView.event { $0.opened = .init() })
            },
            view: { shell, _ in
                AnyView(TrashListView(
                    data: shell.state(trash),
                    send: sender(shell, trash),
                    onBack: pop(shell)
                ))
            }
        )
    }

    /// The back words of the two lenses whose state carries no detail chrome
    /// (spending, search): the app they were pushed from, as the home names
    /// itself. Every other page reads `TallyDetailChrome.back`.
    static func tileRoute(_ tile: Centraid_Screen_V1_HomeTile) -> ShellModel.Route? { homeRoute }

    /// THE EXPORT'S SAVE SEAM, at the root (`TallyExportRoot`).
    @MainActor
    static func global(_ shell: ShellModel) -> AnyView? { AnyView(TallyExportRoot()) }
}

#if canImport(CentraidShared)
extension ScreenPort {
    /// A Tally bridge: `TallyScreenBridge` holds Tally's own held state rather
    /// than subclassing the kit's `ScreenBridge`, and speaks the same four verbs.
    static func tally<S: AnyObject, E: AnyObject>(_ id: String, _ bridge: TallyScreenBridge<S, E>) -> ScreenPort {
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
