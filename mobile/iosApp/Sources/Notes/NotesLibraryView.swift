import SwiftUI

/// Notes' library — the Notes place of the band — on the kit (#1029 app port).
///
/// **THE VIEW DECIDES NOTHING.** Pinned-first sections, the heading, the chip
/// row (the notebook, Pinned, the tags, the sort last), More's rows, the
/// window's end, the row menu, the file-into and sort choices, the confirm and
/// every word are on `NotesLibraryState`, folded by `NotesLibraryMachine`. The
/// intents (`NewNoteRequested`, `NotePicked`, `MoreRowPicked`, a band tap on
/// another place) are routed by `NotesScreens`.
struct NotesLibraryView: View {
    let data: Data
    let send: (Data) -> Void
    let onHome: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_NotesLibraryState {
        (try? Centraid_Screen_V1_NotesLibraryState(serializedBytes: data)) ?? .init()
    }

    private var content: ScreenContent<Centraid_Screen_V1_NotesLibraryData> {
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
        AppPlace(
            app: "notes",
            // THE HEADING IS THE TITLE — "Notes", a notebook's name, or
            // "Unfiled" — as on Android; drawn again under the bar it said
            // "Notes" twice.
            title: state.heading.isEmpty ? chrome.title : state.heading,
            trailing: content.isDenied || chrome.newNote.isEmpty ? nil : RoomAction(
                iconKey: "Plus",
                label: chrome.newNote,
                identifier: "notes-new-note",
                action: { send(NotesEvents.library { $0.newNote = .init() }) }
            ),
            search: SearchSlot(
                field: state.search,
                placeholder: chrome.searchPlaceholder,
                closeLabel: chrome.searchClose,
                onOpen: { send(NotesEvents.library { $0.searchOpened = .init() }) },
                onTerm: { term in send(NotesEvents.library { $0.searchTerm = .with { $0.term = term } }) },
                onClose: { send(NotesEvents.library { $0.searchClosed = .init() }) }
            ),
            // ONE CHIP ROW, the machine's: filters first, the sort last.
            chips: state.chips.map { chip in
                RoomChip(
                    identifier: "notes-chip-\(chip.key)",
                    label: chip.label,
                    selected: chip.selected,
                    chevron: chip.chevron,
                    spoken: chip.spoken,
                    action: { send(NotesEvents.library { $0.chip = .with { $0.key = chip.key } }) }
                )
            },
            showsBand: !content.isDenied
        ) {
            NotesBandView(tabs: state.band, event: { key in NotesEvents.library { $0.band = .with { $0.key = key } } }, send: send, onHome: onHome)
        } content: {
            VStack(spacing: 0) {
                if state.search.open {
                    NotesSearchResultsView(results: state.results, loading: chrome.loading, send: send)
                } else {
                    ReadStateView(
                        content: content,
                        loadingLabel: chrome.loading,
                        onRetry: { send(NotesEvents.library { $0.refreshed = .init() }) }
                    ) { library in
                        NotesLibraryList(library: library, state: state, send: send)
                    }
                }
            }
        }
        .sheet(isPresented: Binding(
            get: { Self.sheetShown(state) && !state.hasConfirm },
            set: { open in
                guard !open, Self.sheetShown(state) else { return }
                send(NotesEvents.library { $0.sheetClosed = .init() })
            }
        )) {
            NotesLibrarySheet(state: state, send: send)
        }
        .sheet(isPresented: Binding(
            get: { state.hasConfirm },
            set: { open in
                guard !open, state.hasConfirm else { return }
                send(NotesEvents.library { $0.dismissed = .init() })
            }
        )) {
            ConfirmSheet(
                state.confirm,
                onConfirm: { send(NotesEvents.library { $0.confirmed = .init() }) },
                onDismiss: { send(NotesEvents.library { $0.dismissed = .init() }) }
            )
        }
    }

    private static func sheetShown(_ state: Centraid_Screen_V1_NotesLibraryState) -> Bool {
        switch state.sheet {
        case .more, .rowMenu, .fileInto, .sort: return true
        case .none, .unspecified, .UNRECOGNIZED: return false
        }
    }
}

/// Encoded Notes events, one maker per screen.
enum NotesEvents {
    static func library(_ build: (inout Centraid_Screen_V1_NotesLibraryEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_NotesLibraryEvent()
        build(&event)
        return event.encoded
    }

    static func notebooks(_ build: (inout Centraid_Screen_V1_NotesNotebooksEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_NotesNotebooksEvent()
        build(&event)
        return event.encoded
    }

    static func journal(_ build: (inout Centraid_Screen_V1_NotesJournalEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_NotesJournalEvent()
        build(&event)
        return event.encoded
    }

    static func history(_ build: (inout Centraid_Screen_V1_NotesHistoryEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_NotesHistoryEvent()
        build(&event)
        return event.encoded
    }

    static func picker(_ build: (inout Centraid_Screen_V1_NotesLinkPickerEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_NotesLinkPickerEvent()
        build(&event)
        return event.encoded
    }
}

/// NOTES' BAND, as the three places share it (`NotesBand.tabs`). More is an
/// ordinary tab, last, because the machine lists it; its tap opens that
/// place's More sheet (R-CHROME-4).
struct NotesBandView: View {
    let tabs: [Centraid_Screen_V1_NotesBandTab]
    let event: (String) -> Data
    let send: (Data) -> Void
    let onHome: () -> Void

    var body: some View {
        AppBand(
            app: "notes",
            tabs: tabs.map { tab in
                BandView(label: tab.label, event: event(tab.key), iconKey: tab.iconKey, selected: tab.current)
            },
            onSelect: send,
            onHome: onHome
        )
    }
}

// MARK: - List

private struct NotesLibraryList: View {
    let library: Centraid_Screen_V1_NotesLibraryData
    let state: Centraid_Screen_V1_NotesLibraryState
    let send: (Data) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(spacing: 0) {
            if library.sections.allSatisfy({ $0.rows.isEmpty }) {
                EmptyStateView(library.empty, onAction: { send(NotesEvents.library { $0.newNote = .init() }) })
                Spacer(minLength: 0)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        if !library.countLabel.isEmpty {
                            Text(library.countLabel)
                                .centraidType("annotLabel")
                                .foregroundStyle(Theme.color("textFaint", scheme))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, CentraidGeometry.pageMargin)
                                .padding(.top, 4)
                        }
                        ForEach(Array(library.sections.enumerated()), id: \.offset) { _, section in
                            if !section.head.title.isEmpty { SectionHeader(section.head) }
                            ForEach(section.rows, id: \.noteID) { row in
                                NotesRowView(
                                    row: row,
                                    menuLabel: state.chrome.rowMenuLabel,
                                    onTap: {
                                        send(NotesEvents.library { $0.notePicked = .with { $0.noteID = row.noteID; $0.title = row.title } })
                                    },
                                    onMenu: { send(NotesEvents.library { $0.rowMenu = .with { $0.noteID = row.noteID } }) }
                                )
                            }
                        }
                        if library.truncated {
                            if !library.windowEndLabel.isEmpty {
                                Text(library.windowEndLabel)
                                    .centraidType("small")
                                    .foregroundStyle(Theme.color("textSoft", scheme))
                                    .padding(.top, 12)
                            }
                            ShowMoreFooter(
                                visible: true,
                                loading: state.firstPagePending,
                                label: library.windowEndVerb,
                                onMore: { send(NotesEvents.library { $0.windowWidened = .init() }) }
                            )
                        }
                    }
                }
                .refreshable { send(NotesEvents.library { $0.refreshed = .init() }) }
                .accessibilityIdentifier("notes-library")
            }
        }
    }
}

/// ONE NOTE: title, the snippet (with the search's highlighted runs), the
/// meta, a pin mark and the row's menu.
struct NotesRowView: View {
    let row: Centraid_Screen_V1_NotesNoteRow
    var menuLabel: String = ""
    let onTap: () -> Void
    var onMenu: (() -> Void)? = nil

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 0) {
            Button(action: onTap) {
                HStack(alignment: .top, spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            if row.pinned {
                                CentraidIconView(iconKey: "Pin", tint: Theme.color("textSoft", scheme), size: 12)
                            }
                            Text(row.title)
                                .centraidType("smallStrong")
                                .foregroundStyle(Theme.color("text", scheme))
                                .lineLimit(1)
                        }
                        snippet
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                            .lineLimit(2)
                        if !row.meta.isEmpty {
                            Text(row.meta)
                                .centraidType("annotLabel")
                                .foregroundStyle(Theme.color("textFaint", scheme))
                                .lineLimit(1)
                        }
                    }
                    Spacer(minLength: 8)
                    if !row.checkLabel.isEmpty {
                        Text(row.checkLabel)
                            .centraidType("annotLabel")
                            .monospacedDigit()
                            .foregroundStyle(Theme.color("textSoft", scheme))
                    }
                }
                .padding(.leading, CentraidGeometry.pageMargin)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(KitRowPress())
            .accessibilityElement(children: .combine)
            .accessibilityLabel(row.accessibilityLabel.isEmpty ? row.title : row.accessibilityLabel)
            .accessibilityIdentifier("notes-row-\(row.noteID)")
            if let onMenu {
                KitIconKey(
                    iconKey: "MoreHoriz",
                    label: menuLabel,
                    tint: "textSoft",
                    identifier: "notes-row-menu-\(row.noteID)",
                    action: onMenu
                )
                .padding(.trailing, 4)
            }
        }
        .overlay(alignment: .bottom) { KitHairline() }
    }

    /// The snippet, its highlighted runs in full ink.
    private var snippet: Text {
        if row.snippetRuns.isEmpty { return Text(row.snippet) }
        return row.snippetRuns.reduce(Text("")) { text, run in
            text + (run.highlighted
                ? Text(run.text).bold().foregroundColor(Theme.color("text", scheme))
                : Text(run.text))
        }
    }
}

private struct NotesSearchResultsView: View {
    let results: Centraid_Screen_V1_NotesSearchResults
    let loading: String
    let send: (Data) -> Void

    var body: some View {
        if results.loading, results.rows.isEmpty {
            RowSkeleton(label: loading)
        } else if results.rows.isEmpty {
            EmptyStateView(results.empty)
            Spacer(minLength: 0)
        } else {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(results.rows, id: \.noteID) { row in
                        NotesRowView(row: row, onTap: {
                            send(NotesEvents.library { $0.notePicked = .with { $0.noteID = row.noteID; $0.title = row.title } })
                        })
                    }
                }
            }
            .accessibilityIdentifier("notes-search-results")
        }
    }
}

// MARK: - Sheets

private struct NotesLibrarySheet: View {
    let state: Centraid_Screen_V1_NotesLibraryState
    let send: (Data) -> Void

    var body: some View {
        let chrome = state.chrome
        switch state.sheet {
        case .more:
            // MORE IS THE MACHINE'S ROWS (Trash): never search, sort or a filter.
            OptionSheet(title: chrome.moreTitle) {
                ForEach(state.moreRows, id: \.key) { row in
                    SheetRow(iconKey: row.iconKey, label: row.label, identifier: "notes-more-\(row.key)") {
                        send(NotesEvents.library { $0.moreRow = .with { $0.key = row.key } })
                    }
                }
            }
        case .rowMenu:
            let menu = state.menu
            OptionSheet(title: menu.title) {
                SheetRow(iconKey: "Pin", label: menu.pinLabel, identifier: "notes-menu-pin") {
                    send(NotesEvents.library { $0.pin = .with { $0.noteID = menu.noteID } })
                }
                SheetRow(iconKey: "Folder", label: menu.fileLabel, identifier: "notes-menu-file") {
                    send(NotesEvents.library { $0.file = .with { $0.noteID = menu.noteID } })
                }
                SheetRow(iconKey: "Trash", label: menu.trashLabel, destructive: true, identifier: "notes-menu-trash") {
                    send(NotesEvents.library { $0.trash = .with { $0.noteID = menu.noteID } })
                }
            }
        case .fileInto:
            OptionSheet(title: chrome.fileTitle) {
                ForEach(state.choices, id: \.id) { choice in
                    SheetRow(label: choice.label, selected: choice.selected, identifier: "notes-file-\(choice.id)") {
                        send(NotesEvents.library { $0.notebookChosen = .with { $0.notebookID = choice.id } })
                    }
                }
            }
        case .sort:
            OptionSheet(title: chrome.sortTitle) {
                ForEach(state.choices, id: \.id) { choice in
                    SheetRow(label: choice.label, selected: choice.selected, identifier: "notes-sort-\(choice.id.lowercased())") {
                        send(NotesEvents.library { $0.sort = .with { $0.sort = choice.sort } })
                    }
                }
            }
        case .none, .unspecified, .UNRECOGNIZED:
            EmptyView()
        }
    }
}
