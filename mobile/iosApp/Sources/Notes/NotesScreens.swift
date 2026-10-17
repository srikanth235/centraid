import SwiftUI

import CentraidShared

/// NOTES, REGISTERED (K5; #1029 app port). Its one line is in `AppRegistry.apps`.
///
/// **EVERY ROUTE'S PARAMETER IS ITS SCREEN'S OWN `Opened` EVENT, ENCODED** —
/// the editor's note id and `is_new`, the library's notebook filter, the
/// history's note — so the push and the open are one spelling.
///
/// **INTENTS ARE THE SHELL'S, AND WHERE THEY GO IS SHARED.** A band tap, a
/// note, a notebook, More's Trash, History and Send to Tasks change nothing in
/// their machines; each view's `send` hands the event it just forwarded to
/// `NotesRouting.route`, which answers the move (Android applies the same one)
/// and `ShellModel.apply` makes it. Notes · Notebooks · Journal are three
/// screen ids under one band, so a place change swaps the top of the stack and
/// back never walks through the places a member happened to tap.
///
/// Every bridge lives for the whole app, so leaving the editor is
/// `departed()` — the machine's `Left`, which flushes unsaved words — and never
/// `leave()`.
enum NotesScreens: AppScreens {
    static let appID = AppIds.shared.NOTES
    /// The machines' `SCREEN_ID`s.
    static let editor = NotesEditorMachine.shared.SCREEN_ID
    static let library = NotesLibraryMachine.shared.SCREEN_ID
    static let notebooks = NotesNotebooksMachine.shared.SCREEN_ID
    static let journal = NotesJournalMachine.shared.SCREEN_ID
    static let history = NotesHistoryMachine.shared.SCREEN_ID
    static let trash = NotesTrashKt.NotesTrashMachine.screenId
    static let linkTargets = NotesLinkPickerMachine.shared.SCREEN_ID

    @MainActor
    static func register(into shell: ShellModel) {
        shell.register(.of(editor, NotesBridge()))
        shell.register(.of(library, NotesLibraryBridge()))
        shell.register(.of(notebooks, NotesNotebooksBridge()))
        shell.register(.of(journal, NotesJournalBridge()))
        shell.register(.of(history, NotesHistoryBridge()))
        shell.register(.of(trash, NotesTrashBridge()))
        shell.register(.of(linkTargets, NotesLinkPickerBridge()))

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
                        shell.apply(NotesRouting.shared.route(screenId: editor, event: bytes.kotlin, state: shell.state(editor).kotlin))
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
                        shell.apply(NotesRouting.shared.route(screenId: library, event: bytes.kotlin, state: shell.state(library).kotlin))
                    },
                    onHome: { [weak shell] in shell?.path.removeAll() },
                    openContainer: { [weak shell] in shell?.openRow($0, parent: $1) }
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
                        shell.apply(NotesRouting.shared.route(screenId: notebooks, event: bytes.kotlin, state: shell.state(notebooks).kotlin))
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
                        shell.apply(NotesRouting.shared.route(screenId: journal, event: bytes.kotlin, state: shell.state(journal).kotlin))
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

    /// WHERE THE TILE LEADS: the shared `NotesRouting.tile` — the tile's own
    /// note, a new note on an empty vault, nowhere while the read is out.
    static func tileRoute(_ tile: Centraid_Screen_V1_HomeTile) -> ShellModel.Route? {
        NotesRouting.shared.tileOpening(tile: tile.encoded.kotlin).map { .opening($0) }
    }

    /// DONE: a pop onto the Notes screen under the editor, else the library in
    /// its place (`NotesRouting.close`).
    @MainActor
    private static func closeEditor(_ shell: ShellModel?) {
        guard let shell, !shell.path.isEmpty else { return }
        shell.apply(NotesRouting.shared.closeMove(below: shell.screenBelowTop))
    }

    @MainActor
    private static func pop(_ shell: ShellModel?) {
        guard let shell, !shell.path.isEmpty else { return }
        shell.path.removeLast()
    }
}
