import CentraidShared
import SwiftUI

// THE SHELL'S ONE PLACE THAT DRAWS A SCREEN RUST OWNS (#1135).
//
// A Rust-owned screen has no bridge, no route parameter and no machine on this
// side: a row carries a `Route`, the shell pushes it (`ShellModel.open`), Rust
// opens an instance and keeps its view state, and `ScreenStore` hands that to
// the view below, which switches on `ViewState.kind`. The views add no copy,
// format nothing, count nothing and start no timer; they send `ScreenEvent`s.
//
// INTERIM HOSTING: the shell's `path` still holds the back stack. An entry
// pushed onto it sends `NavPush` (`ShellModel.openRust`), and leaving it by any
// route sends `NavPopped` (`ShellModel.rustPopped`). The shell lane replaces
// this with the stack Rust holds (`ProofStackView`).

enum RustScreens {
    /// The screen id the shared side spells a Rust route under (`ScreenOpening.screenId`);
    /// its event is the encoded `centraid.core.v1.Route`.
    static let id = ScreenIds.shared.RUST_SCREEN
    /// The tab Rust keeps these screens' stack under.
    static let tab = "agenda"
}

/// ONE PUSH OF A RUST ROUTE: the route Rust built and a token unique to the
/// push, so two pushes of the same route are two entries.
struct RustEntry: Hashable {
    let token: Int
    let route: Centraid_Core_V1_Route

    private static let lock = NSLock()
    private static var last = 0

    static func make(_ route: Centraid_Core_V1_Route) -> RustEntry {
        lock.lock()
        defer { lock.unlock() }
        last += 1
        return RustEntry(token: last, route: route)
    }
}

/// A Rust entry on the stack: bare paper until Rust has opened its instance.
struct RustScreenHost: View {
    @ObservedObject var shell: ShellModel
    let entry: RustEntry

    var body: some View {
        Group {
            if let store = shell.screens, let instance = shell.rustInstances[entry.token] {
                RustScreenView(shell: shell, store: store, instance: instance, entry: entry)
            } else {
                BarePaper()
            }
        }
        .task(id: shell.screens != nil) { await shell.openRust(entry) }
    }
}

/// One instance's view state, drawn by its kind.
private struct RustScreenView: View {
    let shell: ShellModel
    @ObservedObject var store: ScreenStore
    let instance: UInt64
    let entry: RustEntry

    /// This entry leaves the stack (a finished screen, a back control).
    private func pop() {
        guard shell.path.last == .rust(entry) else { return }
        shell.path.removeLast()
    }

    var body: some View {
        let open: (Centraid_Core_V1_Route) -> Void = { shell.open($0) }
        switch store.views[instance]?.kind {
        case .agendaHome(let state)?:
            AgendaHomeView(
                state: state,
                send: { store.send(instance, .agendaHome($0)) },
                open: open,
                onHome: { shell.path.removeAll() }
            )
        case .agendaEvent(let state)?:
            AgendaEventView(
                state: state,
                send: { store.send(instance, .agendaEvent($0)) },
                open: open,
                onBack: pop
            )
        case .agendaEditor(let state)?:
            AgendaEditorView(
                state: state,
                send: { store.send(instance, .agendaEditor($0)) },
                onDone: pop
            )
        case .todoList(let state)?:
            TodoListView(
                state: state,
                send: { store.send(instance, .todoList($0)) },
                open: open,
                onBack: pop
            )
        case .todoProject(let state)?:
            TodoProjectView(
                state: state,
                send: { store.send(instance, .todoProject($0)) },
                open: open,
                onBack: pop
            )
        case .todoDetail(let state)?:
            TodoDetailView(
                state: state,
                send: { store.send(instance, .todoDetail($0)) },
                open: open,
                onClose: pop
            )
        case .todoCatchUp(let state)?:
            TodoCatchUpView(
                state: state,
                send: { store.send(instance, .todoCatchUp($0)) },
                open: open,
                onBack: pop
            )
        case .trash(let state)?:
            CoreTrashView(
                state: state,
                send: { store.send(instance, .trash($0)) },
                onBack: pop
            )
        default:
            BarePaper()
        }
    }
}
