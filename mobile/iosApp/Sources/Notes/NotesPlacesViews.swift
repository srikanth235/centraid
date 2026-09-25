import SwiftUI

// NOTES' OTHER PLACES AND PAGES (#1029 app port): Notebooks and Journal (band
// places, `AppPlace`), History (a `PushedPage` from the editor) and the
// powerbox (a sheet the editor's machine opens). Every word is the state's.

// MARK: - Notebooks

struct NotesNotebooksView: View {
    let data: Data
    let send: (Data) -> Void
    let onHome: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_NotesNotebooksState {
        (try? Centraid_Screen_V1_NotesNotebooksState(serializedBytes: data)) ?? .init()
    }

    private var content: ScreenContent<Centraid_Screen_V1_NotesNotebooksData> {
        switch state.content {
        case let .loading(loading): return .loading(loading.firstLoad)
        case let .failure(failure): return .failed(failure)
        case let .denied(denied): return .denied(denied)
        case let .data(data): return .data(data)
        case .none: return .loading(true)
        }
    }

    var body: some View {
        let state = state
        let content = content
        let chrome = state.chrome
        AppPlace(app: "notes", title: chrome.title, showsBand: !content.isDenied) {
            if !content.isDenied, !chrome.newNotebook.isEmpty {
                Button {
                    send(NotesEvents.notebooks { $0.createOpened = .init() })
                } label: {
                    CentraidIconView(iconKey: "FolderPlus", tint: Theme.color("text", scheme), size: 18)
                        .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(chrome.newNotebook)
                .accessibilityIdentifier("notes-new-notebook")
            }
        } band: {
            NotesBandView(tabs: state.band, event: { key in NotesEvents.notebooks { $0.band = .with { $0.key = key } } }, send: send, onHome: onHome)
        } content: {
            ReadStateView(
                content: content,
                loadingLabel: chrome.loading,
                onRetry: { send(NotesEvents.notebooks { $0.refreshed = .init() }) }
            ) { notebooks in
                if notebooks.rows.isEmpty {
                    EmptyStateView(notebooks.empty, onAction: { send(NotesEvents.notebooks { $0.createOpened = .init() }) })
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(notebooks.rows, id: \.id) { row in
                                CentraidRow(row) {
                                    send(NotesEvents.notebooks { $0.notebookPicked = .with { $0.id = row.id; $0.name = row.title } })
                                }
                            }
                        }
                    }
                    .refreshable { send(NotesEvents.notebooks { $0.refreshed = .init() }) }
                    .accessibilityIdentifier("notes-notebooks")
                }
            }
        }
        .sheet(isPresented: Binding(
            get: { state.creating },
            set: { open in
                guard !open, state.creating else { return }
                send(NotesEvents.notebooks { $0.createDismissed = .init() })
            }
        )) {
            NotesCreateNotebookSheet(state: state, send: send)
        }
        .sheet(isPresented: Binding(
            get: { state.moreOpen && !state.creating },
            set: { open in
                guard !open, state.moreOpen else { return }
                send(NotesEvents.notebooks { $0.moreClosed = .init() })
            }
        )) {
            OptionSheet(title: chrome.moreTitle) {
                SheetRow(iconKey: "Trash", label: state.trashLabel, identifier: "notes-more-trash") {
                    send(NotesEvents.notebooks { $0.moreClosed = .init() })
                    send(NotesEvents.notebooks { $0.trashOpened = .init() })
                }
            }
        }
    }
}

private struct NotesCreateNotebookSheet: View {
    let state: Centraid_Screen_V1_NotesNotebooksState
    let send: (Data) -> Void

    @State private var name = ""
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let chrome = state.chrome
        SheetRoom(
            title: chrome.newNotebook,
            status: state.write.hasFailure ? state.write.failure.sentence : "",
            primary: SheetPrimary(label: chrome.create) {
                guard state.createEnabled else { return }
                send(NotesEvents.notebooks { $0.createConfirmed = .init() })
            }
        ) {
            EditableFieldRow(key: "", text: $name, placeholder: chrome.namePlaceholder, identifier: "notes-notebook-name") { typed in
                guard typed != state.draftName else { return }
                send(NotesEvents.notebooks { $0.name = .with { $0.name = typed } })
            }
            .padding(.horizontal, -CentraidGeometry.pageMargin)
            Button {
                send(NotesEvents.notebooks { $0.createDismissed = .init() })
            } label: {
                Text(chrome.cancel)
                    .centraidType("labelOn")
                    .foregroundStyle(Theme.color("text", scheme))
                    .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("notes-notebook-cancel")
        }
        .onAppear { name = state.draftName }
    }
}

// MARK: - Journal

struct NotesJournalView: View {
    let data: Data
    let send: (Data) -> Void
    let onHome: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_NotesJournalState {
        (try? Centraid_Screen_V1_NotesJournalState(serializedBytes: data)) ?? .init()
    }

    private var content: ScreenContent<Centraid_Screen_V1_NotesJournalData> {
        switch state.content {
        case let .loading(loading): return .loading(loading.firstLoad)
        case let .failure(failure): return .failed(failure)
        case let .denied(denied): return .denied(denied)
        case let .data(data): return .data(data)
        case .none: return .loading(true)
        }
    }

    var body: some View {
        let state = state
        let content = content
        let chrome = state.chrome
        let today: String = {
            if case let .data(data) = state.content { return data.today }
            return ""
        }()
        AppPlace(app: "notes", title: chrome.title, showsBand: !content.isDenied) {
            if !content.isDenied, !chrome.newEntry.isEmpty {
                Button {
                    send(NotesEvents.journal { $0.newEntry = .with { $0.day = today } })
                } label: {
                    CentraidIconView(iconKey: "Plus", tint: Theme.color("text", scheme), size: 18)
                        .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(chrome.newEntry)
                .accessibilityIdentifier("notes-new-entry")
            }
        } band: {
            NotesBandView(tabs: state.band, event: { key in NotesEvents.journal { $0.band = .with { $0.key = key } } }, send: send, onHome: onHome)
        } content: {
            ReadStateView(
                content: content,
                loadingLabel: chrome.loading,
                onRetry: { send(NotesEvents.journal { $0.refreshed = .init() }) }
            ) { journal in
                if journal.days.isEmpty {
                    EmptyStateView(journal.empty, onAction: { send(NotesEvents.journal { $0.newEntry = .with { $0.day = journal.today } }) })
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            if !chrome.origin.isEmpty {
                                Text(chrome.origin)
                                    .centraidType("small")
                                    .foregroundStyle(Theme.color("textSoft", scheme))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, CentraidGeometry.pageMargin)
                            }
                            ForEach(journal.days, id: \.day) { day in
                                SectionHeader(day.head)
                                ForEach(day.rows, id: \.id) { row in
                                    CentraidRow(row) {
                                        send(NotesEvents.journal { $0.entryPicked = .with { $0.noteID = row.id; $0.title = row.title } })
                                    }
                                }
                            }
                            ShowMoreFooter(
                                visible: journal.truncated,
                                label: journal.windowEndVerb,
                                onMore: { send(NotesEvents.journal { $0.windowWidened = .init() }) }
                            )
                        }
                    }
                    .refreshable { send(NotesEvents.journal { $0.refreshed = .init() }) }
                    .accessibilityIdentifier("notes-journal")
                }
            }
        }
        .sheet(isPresented: Binding(
            get: { state.moreOpen },
            set: { open in
                guard !open, state.moreOpen else { return }
                send(NotesEvents.journal { $0.moreClosed = .init() })
            }
        )) {
            OptionSheet(title: chrome.moreTitle) {
                SheetRow(iconKey: "Trash", label: state.trashLabel, identifier: "notes-more-trash") {
                    send(NotesEvents.journal { $0.moreClosed = .init() })
                    send(NotesEvents.journal { $0.trashOpened = .init() })
                }
            }
        }
    }
}

// MARK: - History

struct NotesHistoryView: View {
    let data: Data
    let send: (Data) -> Void
    let onBack: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_NotesHistoryState {
        (try? Centraid_Screen_V1_NotesHistoryState(serializedBytes: data)) ?? .init()
    }

    private var content: ScreenContent<Centraid_Screen_V1_NotesHistoryData> {
        switch state.content {
        case let .loading(loading): return .loading(loading.firstLoad)
        case let .failure(failure): return .failed(failure)
        case let .denied(denied): return .denied(denied)
        case let .data(data): return .data(data)
        case .none: return .loading(true)
        }
    }

    var body: some View {
        let state = state
        let chrome = state.chrome
        PushedPage(title: chrome.title, parentTitle: state.noteTitle.isEmpty ? chrome.close : state.noteTitle, onBack: onBack) {
            EmptyView()
        } content: {
            VStack(spacing: 0) {
                if state.write.hasFailure {
                    PeopleStatusLine(text: state.write.failure.sentence)
                }
                ReadStateView(
                    content: content,
                    loadingLabel: chrome.loading,
                    onRetry: { send(NotesEvents.history { $0.refreshed = .init() }) }
                ) { history in
                    if history.rows.isEmpty {
                        EmptyStateView(history.empty)
                    } else {
                        ScrollView {
                            LazyVStack(spacing: 0) {
                                ForEach(history.rows, id: \.contentID) { row in
                                    HStack(spacing: 0) {
                                        CentraidRow(
                                            title: row.label,
                                            meta: row.preview,
                                            dimmed: row.current,
                                            pending: state.restoringContentID == row.contentID,
                                            accessibility: row.accessibilityLabel,
                                            identifier: "notes-version-\(row.contentID)"
                                        )
                                        if !row.current, !row.restoreLabel.isEmpty {
                                            Button {
                                                send(NotesEvents.history { $0.restore = .with { $0.contentID = row.contentID } })
                                            } label: {
                                                Text(row.restoreLabel)
                                                    .centraidType("annotLabelOn")
                                                    .foregroundStyle(Theme.color("link", scheme))
                                                    .frame(minWidth: CentraidGeometry.targetMinCoarse, minHeight: CentraidGeometry.targetMinCoarse)
                                                    .contentShape(Rectangle())
                                            }
                                            .buttonStyle(.plain)
                                            .disabled(!state.restoringContentID.isEmpty)
                                            .accessibilityIdentifier("notes-restore-\(row.contentID)")
                                            .padding(.trailing, 8)
                                        }
                                    }
                                }
                            }
                        }
                        .refreshable { send(NotesEvents.history { $0.refreshed = .init() }) }
                        .accessibilityIdentifier("notes-history")
                    }
                }
            }
        }
    }
}

// MARK: - The powerbox

/// THE LINK PICKER: a sheet over the editor, its own machine
/// (`notes.link_targets`) for the term and the grouped targets. A pick is
/// handed to the editor (`LinkPicked`), which splices `[[title]]`.
struct NotesLinkPickerView: View {
    let data: Data
    let send: (Data) -> Void
    let onPick: (Centraid_Screen_V1_NotesLinkTargetRow) -> Void
    let onClose: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_NotesLinkPickerState {
        (try? Centraid_Screen_V1_NotesLinkPickerState(serializedBytes: data)) ?? .init()
    }

    private var content: ScreenContent<Centraid_Screen_V1_NotesLinkPickerData> {
        switch state.content {
        case let .loading(loading): return .loading(loading.firstLoad)
        case let .failure(failure): return .failed(failure)
        case let .denied(denied): return .denied(denied)
        case let .data(data): return .data(data)
        case .none: return .loading(true)
        }
    }

    var body: some View {
        let state = state
        let chrome = state.chrome
        SheetRoom(title: chrome.title, status: chrome.foot) {
            CentraidSearchField(
                field: Centraid_Screen_V1_SearchField.with {
                    $0.open = true
                    $0.term = state.term
                },
                placeholder: chrome.searchPlaceholder,
                closeLabel: chrome.close,
                identifier: "notes-link-search",
                onTerm: { term in send(NotesEvents.picker { $0.term = .with { $0.term = term } }) },
                onClose: onClose
            )
            ReadStateView(
                content: content,
                skeleton: { RowSkeleton(rows: 4, label: chrome.loading) },
                onRetry: { send(NotesEvents.picker { $0.opened = .with { $0.term = state.term } }) }
            ) { picker in
                if picker.domains.allSatisfy({ $0.rows.isEmpty }) {
                    EmptyStateView(picker.empty)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(Array(picker.domains.enumerated()), id: \.offset) { _, domain in
                                SectionHeader(domain.head)
                                    .padding(.horizontal, -CentraidGeometry.pageMargin)
                                ForEach(domain.rows, id: \.id) { row in
                                    CentraidRow(
                                        title: row.title,
                                        meta: row.subtitle,
                                        accessibility: row.accessibilityLabel,
                                        identifier: "notes-link-\(row.id)",
                                        onTap: {
                                            send(NotesEvents.picker { $0.picked = .with { $0.target = row } })
                                            onPick(row)
                                        }
                                    )
                                    .padding(.horizontal, -CentraidGeometry.pageMargin)
                                }
                            }
                        }
                    }
                }
            }
        }
        .onAppear { send(NotesEvents.picker { $0.opened = .with { $0.term = "" } }) }
    }
}
