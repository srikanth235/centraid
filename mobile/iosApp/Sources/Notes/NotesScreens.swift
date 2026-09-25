import SwiftUI

#if canImport(CentraidShared)
import CentraidShared
#endif

/// NOTES, REGISTERED (K5; #1029 app port). Its one line is in `AppRegistry.apps`.
///
/// **EVERY ROUTE'S PARAMETER IS ITS SCREEN'S OWN `Opened` EVENT, ENCODED** —
/// the editor's note id and `is_new`, the library's notebook filter, the
/// history's note — so the push and the open are one spelling.
///
/// **THE BAND PLACES SWAP IN PLACE.** Notes · Notebooks · Journal are three
/// screen ids; a tap on another place replaces the top of the stack
/// (`NavStack.withNotesPlace` on the shared side), so back never walks through
/// the tabs a member happened to tap.
///
/// Every bridge lives for the whole app, so leaving the editor is
/// `departed()` — the machine's `Left`, which flushes unsaved words — and never
/// `leave()`.
enum NotesScreens: AppScreens {
    static let appID = "notes"
    /// `NotesEditorMachine.SCREEN_ID`.
    static let editor = "notes.editor"
    static let library = "notes.library"
    static let notebooks = "notes.notebooks"
    static let journal = "notes.journal"
    static let history = "notes.history"
    static let trash = "notes.trash"
    static let linkTargets = "notes.link_targets"

    private static let places: Set<String> = [library, notebooks, journal]

    static func editorRoute(_ noteIdentifier: String, isNew: Bool = false) -> ShellModel.Route {
        .screen(editor, Centraid_Screen_V1_NotesEditorEvent.with {
            $0.opened = .with {
                $0.noteID = noteIdentifier
                $0.isNew = isNew
            }
        }.encoded)
    }

    static func libraryRoute(notebookID: String = "", notebookName: String = "", unfiledOnly: Bool = false) -> ShellModel.Route {
        .screen(library, Centraid_Screen_V1_NotesLibraryEvent.with {
            $0.opened = .with {
                $0.notebookID = notebookID
                $0.notebookName = notebookName
                $0.unfiledOnly = unfiledOnly
            }
        }.encoded)
    }

    static var notebooksRoute: ShellModel.Route {
        .screen(notebooks, Centraid_Screen_V1_NotesNotebooksEvent.with { $0.opened = .init() }.encoded)
    }

    static var journalRoute: ShellModel.Route {
        .screen(journal, Centraid_Screen_V1_NotesJournalEvent.with { $0.opened = .init() }.encoded)
    }

    static func historyRoute(_ noteIdentifier: String, title: String) -> ShellModel.Route {
        .screen(history, Centraid_Screen_V1_NotesHistoryEvent.with {
            $0.opened = .with {
                $0.noteID = noteIdentifier
                $0.noteTitle = title
            }
        }.encoded)
    }

    /// A new note under an id minted on this phone — `NotesRouting.mintNoteId`.
    static func newNoteRoute() -> ShellModel.Route {
        #if canImport(CentraidShared)
        return editorRoute(NotesRouting.shared.mintNoteId(), isNew: true)
        #else
        return editorRoute(UUID().uuidString.lowercased(), isNew: true)
        #endif
    }

    @MainActor
    static func register(into shell: ShellModel) {
        #if canImport(CentraidShared)
        shell.register(.of(editor, NotesBridge()))
        shell.register(.of(library, NotesLibraryBridge()))
        shell.register(.of(notebooks, NotesNotebooksBridge()))
        shell.register(.of(journal, NotesJournalBridge()))
        shell.register(.of(history, NotesHistoryBridge()))
        shell.register(.of(trash, NotesTrashBridge()))
        shell.register(.of(linkTargets, NotesLinkPickerBridge()))
        #endif

        shell.route(
            editor,
            open: { [weak shell] parameter in shell?.send(screen: editor, event: parameter) },
            view: { shell, parameter in
                AnyView(NotesEditorView(
                    data: shell.state(editor),
                    picker: shell.state(linkTargets),
                    opened: parameter,
                    send: { [weak shell] bytes in
                        guard let shell else { return }
                        shell.send(screen: editor, event: bytes)
                        routeEditor(bytes, shell)
                    },
                    sendPicker: { [weak shell] in shell?.send(screen: linkTargets, event: $0) },
                    onClose: { [weak shell] in closeEditor(shell) },
                    onDeparted: { [weak shell] in shell?.departed(editor) }
                ))
            }
        )

        shell.route(
            library,
            open: { [weak shell] parameter in shell?.send(screen: library, event: parameter) },
            view: { shell, _ in
                AnyView(NotesLibraryView(
                    data: shell.state(library),
                    send: { [weak shell] bytes in
                        guard let shell else { return }
                        shell.send(screen: library, event: bytes)
                        routeLibrary(bytes, shell)
                    },
                    onHome: { [weak shell] in shell?.path.removeAll() }
                ))
            }
        )

        shell.route(
            notebooks,
            open: { [weak shell] parameter in shell?.send(screen: notebooks, event: parameter) },
            view: { shell, _ in
                AnyView(NotesNotebooksView(
                    data: shell.state(notebooks),
                    send: { [weak shell] bytes in
                        guard let shell else { return }
                        shell.send(screen: notebooks, event: bytes)
                        routeNotebooks(bytes, shell)
                    },
                    onHome: { [weak shell] in shell?.path.removeAll() }
                ))
            }
        )

        shell.route(
            journal,
            open: { [weak shell] parameter in shell?.send(screen: journal, event: parameter) },
            view: { shell, _ in
                AnyView(NotesJournalView(
                    data: shell.state(journal),
                    send: { [weak shell] bytes in
                        guard let shell else { return }
                        shell.send(screen: journal, event: bytes)
                        routeJournal(bytes, shell)
                    },
                    onHome: { [weak shell] in shell?.path.removeAll() }
                ))
            }
        )

        shell.route(
            history,
            open: { [weak shell] parameter in shell?.send(screen: history, event: parameter) },
            view: { shell, _ in
                AnyView(NotesHistoryView(
                    data: shell.state(history),
                    send: { [weak shell] in shell?.send(screen: history, event: $0) },
                    onBack: { [weak shell] in pop(shell) }
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
                    send: { [weak shell] in shell?.send(screen: trash, event: $0) },
                    onBack: { [weak shell] in pop(shell) }
                ))
            }
        )
    }

    /// WHERE THE TILE LEADS: the shared `NotesRouting.target` — the tile's
    /// own note, a new note on an empty vault, nowhere while the read is out.
    static func tileRoute(_ tile: Centraid_Screen_V1_HomeTile) -> ShellModel.Route? {
        #if canImport(CentraidShared)
        guard let kotlinTile = HomeTile.companion.ADAPTER.decode(bytes: tile.encoded.kotlin) else { return nil }
        let target = NotesRouting.shared.target(tile: kotlinTile, mint: { NotesRouting.shared.mintNoteId() })
        if let existing = target as? NotesTargetExisting {
            return editorRoute(existing.noteId)
        }
        if let fresh = target as? NotesTargetNew {
            return editorRoute(fresh.noteId, isNew: true)
        }
        return nil
        #else
        return nil
        #endif
    }

    // MARK: - Intents

    /// A BAND TAP ON ANOTHER PLACE: swap the top of the stack in place.
    @MainActor
    private static func swapPlace(_ key: String, _ shell: ShellModel) {
        let route: ShellModel.Route
        switch key {
        case "notes": route = libraryRoute()
        case "notebooks": route = notebooksRoute
        case "journal": route = journalRoute
        default: return
        }
        if case let .screen(current, _)? = shell.path.last, places.contains(current) {
            if case let .screen(next, _) = route, next == current { return }
            shell.path[shell.path.count - 1] = route
        } else {
            shell.path.append(route)
        }
    }

    @MainActor
    private static func routeLibrary(_ bytes: Data, _ shell: ShellModel) {
        guard let event = try? Centraid_Screen_V1_NotesLibraryEvent(serializedBytes: bytes) else { return }
        switch event.kind {
        case let .band(band):
            swapPlace(band.key, shell)
        case .newNote:
            shell.path.append(newNoteRoute())
        case let .notePicked(picked):
            shell.path.append(editorRoute(picked.noteID))
        case .trashOpened:
            shell.path.append(.screen(trash, Data()))
        default:
            break
        }
    }

    @MainActor
    private static func routeNotebooks(_ bytes: Data, _ shell: ShellModel) {
        guard let event = try? Centraid_Screen_V1_NotesNotebooksEvent(serializedBytes: bytes) else { return }
        switch event.kind {
        case let .band(band):
            swapPlace(band.key, shell)
        case let .notebookPicked(picked):
            // The library, filtered to the notebook — a band place, swapped in.
            let route = libraryRoute(notebookID: picked.id, notebookName: picked.name)
            if case let .screen(current, _)? = shell.path.last, places.contains(current) {
                shell.path[shell.path.count - 1] = route
            } else {
                shell.path.append(route)
            }
        case .trashOpened:
            shell.path.append(.screen(trash, Data()))
        default:
            break
        }
    }

    @MainActor
    private static func routeJournal(_ bytes: Data, _ shell: ShellModel) {
        guard let event = try? Centraid_Screen_V1_NotesJournalEvent(serializedBytes: bytes) else { return }
        switch event.kind {
        case let .band(band):
            swapPlace(band.key, shell)
        case let .entryPicked(picked):
            shell.path.append(editorRoute(picked.noteID))
        case .newEntry:
            // TODO(intent): `NewEntryRequested{day}` — Notes has no command
            // that writes a journal marker for a day, so this opens a new
            // note and the day is not carried (notes-report "Needs from core").
            shell.path.append(newNoteRoute())
        case .trashOpened:
            shell.path.append(.screen(trash, Data()))
        default:
            break
        }
    }

    @MainActor
    private static func routeEditor(_ bytes: Data, _ shell: ShellModel) {
        guard let event = try? Centraid_Screen_V1_NotesEditorEvent(serializedBytes: bytes) else { return }
        let state = (try? Centraid_Screen_V1_NotesEditorState(serializedBytes: shell.state(editor))) ?? .init()
        switch event.kind {
        case .history:
            guard state.chrome.historyEnabled, !state.noteID.isEmpty else { return }
            let title: String = {
                if case let .draft(draft) = state.content { return draft.title }
                return ""
            }()
            shell.path.append(historyRoute(state.noteID, title: title))
        case let .sendToTasks(sent):
            // THE WORDS WAIT IN TASKS' QUICK ADD, focused on the Inbox;
            // nothing is written until the member adds them.
            TasksScreens.openQuickAdd(sent.text, shell)
        default:
            break
        }
    }

    /// DONE LANDS IN NOTES. An editor opened from Home (the tile, the first
    /// move) has no Notes place under it, and the tile's route is the note
    /// itself (`NotesRouting.target`) — so Done swaps the editor for the
    /// library rather than popping to Home, which is the only way the band's
    /// places are reachable from a Home-opened note. Opened from a Notes
    /// screen, Done is a plain pop.
    @MainActor
    private static func closeEditor(_ shell: ShellModel?) {
        guard let shell, !shell.path.isEmpty else { return }
        let below = shell.path.dropLast().last
        if case let .screen(id, _)? = below, id.hasPrefix("notes.") {
            shell.path.removeLast()
        } else {
            shell.path[shell.path.count - 1] = libraryRoute()
        }
    }

    @MainActor
    private static func pop(_ shell: ShellModel?) {
        guard let shell, !shell.path.isEmpty else { return }
        shell.path.removeLast()
    }
}
