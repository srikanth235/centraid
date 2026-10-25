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
// THE STACK: Rust holds one (tab `home`, rooted at Home); the shell's `path` mirrors it. An entry
// pushed onto it sends `NavPush` (`ShellModel.openRust`), and leaving it by any
// route sends `NavPopped` (`ShellModel.rustPopped`). The shell lane replaces
// this with the stack Rust holds (`ProofStackView`).

enum RustScreens {
    /// The screen id the shared side spells a Rust route under (`ScreenOpening.screenId`);
    /// its event is the encoded `centraid.core.v1.Route`.
    static let id = ScreenIds.shared.RUST_SCREEN
    /// The tab Home is the root of. Rust owns the stack: every page, whichever
    /// app's, is pushed on this tab, so back returns to Home.
    static let homeTab = BandPolicy.shared.PLACE_HOME

    /// The tab Rust keeps a route's screens' stack under: always Home's.
    static func tab(for route: Centraid_Core_V1_Route) -> String { homeTab }
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
        // THE 24 WORDS (lane H2): made, typed back and shown again. Each is
        // finished by Rust (`finished`), and the shell pops it.
        case .wordsMake(let state)?:
            VaultWordsView(
                state: state,
                send: { store.send(instance, .wordsMake($0)) },
                onDone: {
                    guard shell.path.last == .rust(entry) else { return }
                    if !state.madeLine.isEmpty { shell.vaultMade(state.madeLine) }
                    pop()
                }
            )
        case .wordsEnter(let state)?:
            WordsEntryView(
                state: state,
                send: { store.send(instance, .wordsEnter($0)) },
                onDone: {
                    guard shell.path.last == .rust(entry) else { return }
                    pop()
                    shell.wordsEnterFinished()
                }
            )
        case .wordsShow(let state)?:
            WordsShowView(
                state: state,
                send: { store.send(instance, .wordsShow($0)) },
                onDone: {
                    guard shell.path.last == .rust(entry) else { return }
                    pop()
                    shell.wordsShowFinished()
                }
            )
        // HOME'S SEARCH (#1135, lane H1): a page pushed over Home.
        case .homeSearch(let state)?:
            ShellSearchView(
                state: state,
                send: { store.send(instance, .homeSearch($0)) },
                open: open,
                onCancel: pop
            )
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
        case .backupHome(let state)?:
            BackupHomeView(
                state: state,
                shell: shell,
                send: { store.send(instance, .backupHome($0)) },
                onAddDestination: { shell.addBackupDestination() },
                onShowWords: { shell.backupShowWords() }
            )
        case .photosHome(let state)?:
            PhotosHomeView(
                state: state,
                send: { store.send(instance, .photosHome($0)) },
                open: open,
                onHome: { shell.path.removeAll() },
                onResume: { store.photos?.opened() }
            )
        case .photosShelf(let state)?:
            PhotoShelfView(
                state: state,
                send: { store.send(instance, .photosShelf($0)) },
                open: open,
                onBack: pop
            )
        case .photosPicker(let state)?:
            PhotoPickerView(
                state: state,
                send: { store.send(instance, .photosPicker($0)) },
                onFinished: pop
            )
        case .photosPlaces(let state)?:
            PlacesView(
                state: state,
                send: { store.send(instance, .photosPlaces($0)) },
                open: open
            )
        case .lockerHome(let state)?:
            LockerHomeView(
                state: state,
                send: { store.send(instance, .lockerHome($0)) },
                sendWall: { store.send(instance, .lockerWall($0)) },
                open: open,
                onWords: { shell.openRekey() },
                onHome: { shell.path.removeAll() }
            )
        case .lockerItem(let state)?:
            LockerItemView(
                state: state,
                send: { store.send(instance, .lockerItem($0)) },
                sendWall: { store.send(instance, .lockerWall($0)) },
                open: open,
                onWords: { shell.openRekey() },
                onBack: pop
            )
        case .lockerEditor(let state)?:
            LockerEditorView(
                state: state,
                send: { store.send(instance, .lockerEditor($0)) },
                sendWall: { store.send(instance, .lockerWall($0)) },
                onWords: { shell.openRekey() },
                onClose: pop
            )
        case .lockerAccess(let state)?:
            LockerAccessView(
                state: state,
                send: { store.send(instance, .lockerAccess($0)) },
                sendWall: { store.send(instance, .lockerWall($0)) },
                onWords: { shell.openRekey() },
                onBack: pop
            )
        case .lockerExport(let state)?:
            LockerExportView(
                state: state,
                send: { store.send(instance, .lockerExport($0)) },
                sendWall: { store.send(instance, .lockerWall($0)) },
                onWords: { shell.openRekey() },
                onBack: pop
            )
        case .lockerImport(let state)?:
            LockerImportView(
                state: state,
                send: { store.send(instance, .lockerImport($0)) },
                sendWall: { store.send(instance, .lockerWall($0)) },
                onWords: { shell.openRekey() },
                onBack: pop
            )
        case .lockerLock(let state)?:
            LockerLockPageView(
                state: state,
                sendWall: { store.send(instance, .lockerWall($0)) },
                onWords: { shell.openRekey() },
                onClose: pop
            )
        case .moneyHome(let state)?:
            MoneyHomeView(
                state: state,
                send: { store.send(instance, .moneyHome($0)) },
                open: open,
                onHome: { shell.path.removeAll() }
            )
        case .moneyTransaction(let state)?:
            MoneyTransactionView(
                state: state,
                send: { store.send(instance, .moneyTransaction($0)) },
                open: open,
                onBack: pop
            )
        case .moneyTarget(let state)?:
            MoneyTargetView(
                state: state,
                send: { store.send(instance, .moneyTarget($0)) },
                open: open,
                onBack: pop
            )
        case .moneyRecurring(let state)?:
            MoneyRecurringView(
                state: state,
                send: { store.send(instance, .moneyRecurring($0)) },
                open: open,
                onBack: pop
            )
        case .moneyAccounts(let state)?:
            MoneyAccountsView(
                state: state,
                send: { store.send(instance, .moneyAccounts($0)) },
                open: open,
                onBack: pop
            )
        case .moneyRules(let state)?:
            MoneyRulesView(
                state: state,
                send: { store.send(instance, .moneyRules($0)) },
                open: open,
                onBack: pop
            )
        case .moneyCategories(let state)?:
            MoneyCategoriesView(
                state: state,
                send: { store.send(instance, .moneyCategories($0)) },
                open: open,
                onBack: pop
            )
        case .moneyImport(let state)?:
            MoneyImportView(
                state: state,
                send: { store.send(instance, .moneyImport($0)) },
                open: open,
                onBack: pop
            )
        case .moneySearch(let state)?:
            MoneySearchView(
                state: state,
                send: { store.send(instance, .moneySearch($0)) },
                open: open,
                onBack: pop
            )
        case .docsDrive(let state)?:
            DocsDriveView(
                state: state,
                send: { store.send(instance, .docsDrive($0)) },
                open: open,
                onBack: pop,
                onHome: { shell.path.removeAll() }
            )
        case .docsDocument(let state)?:
            DocsDocumentView(
                state: state,
                send: { store.send(instance, .docsDocument($0)) },
                open: open,
                onBack: pop
            )
        case .docsVersions(let state)?:
            DocsVersionsView(
                state: state,
                send: { store.send(instance, .docsVersions($0)) },
                onBack: pop
            )
        case .docsEditor(let state)?:
            DocsEditorView(
                state: state,
                send: { store.send(instance, .docsEditor($0)) },
                onClose: pop
            )
        case .healthHome(let state)?:
            HealthHomeView(
                state: state,
                send: { store.send(instance, .healthHome($0)) },
                open: open,
                onHome: { shell.path.removeAll() }
            )
        case .healthMetric(let state)?:
            HealthMetricView(
                state: state,
                send: { store.send(instance, .healthMetric($0)) },
                onBack: pop
            )
        case .healthWorkout(let state)?:
            HealthWorkoutView(
                state: state,
                send: { store.send(instance, .healthWorkout($0)) },
                onBack: pop
            )
        case .healthConnect(let state)?:
            HealthConnectView(
                state: state,
                send: { store.send(instance, .healthConnect($0)) },
                onBack: pop
            )
        case .notesHome(let state)?:
            NotesHomeView(
                state: state,
                send: { store.send(instance, .notesHome($0)) },
                open: open,
                onHome: { shell.path.removeAll() }
            )
        case .notesEditor(let state)?:
            NotesEditorView(
                state: state,
                send: { store.send(instance, .notesEditor($0)) },
                open: open,
                onClose: pop
            )
        case .notesHistory(let state)?:
            NotesHistoryView(
                state: state,
                send: { store.send(instance, .notesHistory($0)) },
                onBack: pop
            )
        case .peopleHome(let state)?:
            PeopleHomeView(
                state: state,
                send: { store.send(instance, .peopleHome($0)) },
                open: open,
                onHome: { shell.path.removeAll() }
            )
        case .peoplePerson(let state)?:
            PeoplePersonView(
                state: state,
                send: { store.send(instance, .peoplePerson($0)) },
                open: open,
                onBack: pop
            )
        case .peopleEditor(let state)?:
            PeopleEditorView(
                state: state,
                send: { store.send(instance, .peopleEditor($0)) },
                onClose: pop
            )
        case .trash(let state)?:
            CoreTrashView(
                state: state,
                send: { store.send(instance, .trash($0)) },
                onBack: pop
            )
        // PAIRING A GATEWAY (#1135).
        case .pairLaptop(let state)?:
            PairLaptopPageView(
                state: state,
                send: { store.send(instance, .pairLaptop($0)) },
                onDone: pop
            )
        // PHOTOS' ONE-PHOTOGRAPH PAGES (#1135).
        case .photosLightbox(let state)?:
            PhotosLightboxView(
                state: state,
                send: { kind in
                    var event = Centraid_Core_V1_PhotosLightboxEvent()
                    event.kind = kind
                    store.send(instance, .photosLightbox(event))
                },
                open: open,
                onClose: pop
            )
        case .photosEditor(let state)?:
            PhotosEditorView(
                state: state,
                send: { kind in
                    var event = Centraid_Core_V1_PhotosEditorEvent()
                    event.kind = kind
                    store.send(instance, .photosEditor(event))
                },
                onClose: pop,
                // A SAVE REPLACES THE EDITOR WITH THE NEW PHOTOGRAPH: it comes off
                // the stack and the lightbox on what the member just made goes on.
                onSaved: { route in
                    pop()
                    shell.open(route)
                }
            )
        case .photosDuplicates(let state)?:
            PhotosDuplicatesView(
                state: state,
                send: { kind in
                    var event = Centraid_Core_V1_PhotosDuplicatesEvent()
                    event.kind = kind
                    store.send(instance, .photosDuplicates(event))
                },
                open: open,
                onBack: pop
            )
        case .photosDuplicateReview(let state)?:
            PhotosDuplicateReviewView(
                state: state,
                send: { kind in
                    var event = Centraid_Core_V1_PhotosDuplicateReviewEvent()
                    event.kind = kind
                    store.send(instance, .photosDuplicateReview(event))
                },
                onBack: pop
            )
        // THE CHAT as a page (#1135, lane I): a search's Ask (`chat.ask`) or a found conversation
        // (`chat.thread`). The tab's root draws the same state through `HomeView`.
        case .chat?:
            ChatPageView(shell: shell, store: store, instance: instance, onBack: pop, open: open)
        // HOME is the root of the `home` tab, drawn by `HomeView`, never pushed.
        default:
            BarePaper()
        }
    }
}

/// A chat page: its own `ChatModel` over this instance, so the page and the tab hold their own
/// thread. Rust waits for the first `opened` (it names the models directory) before it starts.
private struct ChatPageView: View {
    let shell: ShellModel
    let store: ScreenStore
    let instance: UInt64
    let onBack: () -> Void
    let open: (Centraid_Core_V1_Route) -> Void

    @StateObject private var model: ChatModel
    @State private var typing = false

    init(
        shell: ShellModel,
        store: ScreenStore,
        instance: UInt64,
        onBack: @escaping () -> Void,
        open: @escaping (Centraid_Core_V1_Route) -> Void
    ) {
        self.shell = shell
        self.store = store
        self.instance = instance
        self.onBack = onBack
        self.open = open
        _model = StateObject(wrappedValue: ChatModel(page: instance))
    }

    var body: some View {
        ChatView(
            chat: model,
            typing: $typing,
            onOpenRoute: open,
            onSetScope: { model.open(app: $0, vaultName: shell.foregroundVaultName, scopeChosen: true) },
            onBack: onBack
        )
        .onAppear {
            model.attach(store: store)
            if !model.opened { model.open(app: "", vaultName: shell.foregroundVaultName) }
        }
    }
}
