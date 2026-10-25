import SwiftUI

/// `notes.home` — Notes · Notebooks · Journal under one band, with Search as a
/// field over the Notes place and More as a sheet (#1135).
///
/// **THE VIEW DECIDES NOTHING.** The place, the heading, the band, the chip row,
/// the sections, every count and sentence, the sheets and their rows, the
/// confirms and the two forms are on `NotesHomeState`, which Rust makes
/// (`crates/screens`, module `notes`). A tap on the band is an event and swaps
/// the place; a row that opens a page carries its `Route` and a tap hands it to
/// `open`.
struct NotesHomeView: View {
    let state: Centraid_Core_V1_NotesHomeState
    let send: (Centraid_Core_V1_NotesHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onHome: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var denied: Bool {
        if case .denied? = state.content { return true }
        return false
    }

    private var isNotesPlace: Bool { state.place == .notes || state.place == .unspecified }

    var body: some View {
        let chrome = state.chrome
        AppPlace(
            app: "notes",
            title: state.title,
            trailing: addAction,
            search: isNotesPlace && !denied ? searchSlot : nil,
            chips: isNotesPlace ? state.chips.map { chip in
                RoomChip(
                    identifier: "notes-chip-\(chip.key)",
                    label: chip.label,
                    selected: chip.selected,
                    chevron: chip.chevron,
                    spoken: chip.spoken,
                    action: { send(NotesEvents.home { $0.chip = .with { $0.key = chip.key } }) }
                )
            } : [],
            showsBand: !denied && !state.band.isEmpty
        ) {
            AppBand(
                app: "notes",
                tabs: state.band.map { tab in
                    BandView(label: tab.label, event: Data(tab.key.utf8), iconKey: tab.iconKey, selected: tab.current, key: tab.key)
                },
                onSelect: { picked in
                    let key = String(decoding: picked, as: UTF8.self)
                    send(NotesEvents.home { $0.band = .with { $0.key = key } })
                },
                onHome: onHome
            )
        } content: {
            VStack(spacing: 0) {
                if isNotesPlace, state.search.open, case .library? = state.content {
                    searchResults
                } else {
                    ReadStateView(
                        content: readContent,
                        loadingLabel: chrome.loading,
                        onRetry: { send(NotesEvents.home { $0.refreshed = .init() }) }
                    ) { _ in
                        placeContent
                    }
                }
                StatusLineView(status: state.status, identifier: "notes-status-action") {}
            }
        }
        .sheet(isPresented: sheetShown) {
            NotesHomeSheet(state: state, send: send, open: open)
        }
        .sheet(isPresented: Binding(
            get: { state.hasConfirm },
            set: { open in
                guard !open, state.hasConfirm else { return }
                send(NotesEvents.home { $0.dismissed = .init() })
            }
        )) {
            ConfirmSheet(
                state.confirm,
                onConfirm: { send(NotesEvents.home { $0.confirmed = .init() }) },
                onDismiss: { send(NotesEvents.home { $0.dismissed = .init() }) }
            )
        }
        .sheet(isPresented: Binding(
            get: { state.hasForm },
            set: { open in
                guard !open, state.hasForm else { return }
                send(NotesEvents.home { $0.formDismissed = .init() })
            }
        )) {
            NotesNotebookFormSheet(form: state.form, send: send)
        }
        .background {
            Color.clear.sheet(isPresented: Binding(
                get: { state.hasCompose },
                set: { open in
                    guard !open, state.hasCompose else { return }
                    send(NotesEvents.home { $0.composeClosed = .init() })
                }
            )) {
                NotesJournalComposeSheet(compose: state.compose, send: send)
            }
        }
    }

    // MARK: chrome

    /// THE HEADER'S ONE ACTION, per place: a new note, a new notebook, a new entry.
    private var addAction: RoomAction? {
        guard !denied else { return nil }
        switch state.place {
        case .notebooks:
            return RoomAction(iconKey: "Plus", label: state.chrome.newNotebook, identifier: "notes-new-notebook") {
                send(NotesEvents.home { $0.formOpened = .with { $0.notebookID = "" } })
            }
        case .journal:
            return RoomAction(iconKey: "Plus", label: state.chrome.newEntry, identifier: "notes-new-entry") {
                send(NotesEvents.home { $0.newEntry = .init() })
            }
        default:
            guard state.hasNewNote else { return nil }
            return RoomAction(iconKey: "Plus", label: state.chrome.newNote, identifier: "notes-new-note") {
                open(state.newNote)
            }
        }
    }

    private var searchSlot: SearchSlot {
        var field = KitSearchField()
        field.open = state.search.open
        field.term = state.search.term
        field.corrected = state.search.corrected
        return SearchSlot(
            field: field,
            placeholder: state.chrome.searchPlaceholder,
            closeLabel: state.chrome.searchClose,
            onOpen: { send(NotesEvents.home { $0.searchOpened = .init() }) },
            onTerm: { term in send(NotesEvents.home { $0.searchTerm = .with { $0.term = term } }) },
            onClose: { send(NotesEvents.home { $0.searchClosed = .init() }) }
        )
    }

    private var sheetShown: Binding<Bool> {
        Binding(
            get: {
                switch state.sheet {
                case .more, .sort, .rowMenu, .fileInto, .notebookMenu: return !state.hasConfirm
                case .none, .UNRECOGNIZED: return false
                }
            },
            set: { open in
                guard !open, state.sheet != .none else { return }
                send(NotesEvents.home { $0.sheetClosed = .init() })
            }
        )
    }

    // MARK: content

    private var readContent: ScreenContent<Bool> {
        switch state.content {
        case .loading?, nil: return .loading(true)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .gated(denied)
        default: return .data(true)
        }
    }

    @ViewBuilder
    private var placeContent: some View {
        switch state.content {
        case let .library(library)?: NotesLibraryList(library: library, state: state, send: send, open: open)
        case let .notebooks(notebooks)?: notebooksList(notebooks)
        case let .journal(journal)?: journalList(journal)
        default: EmptyView()
        }
    }

    private var searchResults: some View {
        Group {
            if let results = state.search.hasResults ? state.search.results : nil,
               results.rows.isEmpty, state.search.containers.isEmpty {
                EmptyStateView(results.empty)
                if state.search.hasAsk { SearchAskRow(ask: state.search.ask) }
                Spacer(minLength: 0)
            } else {
                ScrollView {
                    VStack(spacing: 0) {
                        // THE NOTEBOOKS WHOSE NAME MATCHED come first (#1097).
                        ForEach(state.search.containers, id: \.id) { container in
                            SearchContainerRow(container: container) { _ in open(container.route) }
                        }
                        LazyVStack(spacing: 0) {
                            ForEach(state.search.results.rows, id: \.noteID) { row in
                                NotesRowView(row: row, menuLabel: "", onTap: { open(row.route) })
                            }
                        }
                        if state.search.hasAsk { SearchAskRow(ask: state.search.ask) }
                    }
                }
                .accessibilityIdentifier("notes-search-results")
            }
        }
    }

    private func notebooksList(_ notebooks: Centraid_Core_V1_NotesNotebooksData) -> some View {
        Group {
            if notebooks.rows.count <= 1, notebooks.hasEmpty {
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(notebooks.rows, id: \.id) { row in notebookRow(row) }
                        EmptyStateView(notebooks.empty, onAction: {
                            send(NotesEvents.home { $0.formOpened = .with { $0.notebookID = "" } })
                        })
                    }
                }
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(notebooks.rows, id: \.id) { row in notebookRow(row) }
                    }
                }
                .refreshable { send(NotesEvents.home { $0.refreshed = .init() }) }
                .accessibilityIdentifier("notes-notebooks")
            }
        }
    }

    private func journalListRow(_ row: Centraid_Core_V1_NotesJournalRow) -> Centraid_Core_V1_ListRow {
        var list = Centraid_Core_V1_ListRow()
        list.id = row.noteID
        list.title = row.title
        list.meta = row.meta
        list.trailing = row.trailing
        list.accessibilityLabel = row.accessibilityLabel
        return list
    }

    private func notebookRow(_ row: Centraid_Core_V1_NotesNotebookRow) -> some View {
        var list = Centraid_Core_V1_ListRow()
        list.id = row.id
        list.title = row.title
        list.trailing = row.count
        list.accessibilityLabel = row.accessibilityLabel
        return HStack(spacing: 0) {
            CentraidRow(list) { send(NotesEvents.home { $0.notebookPicked = .with { $0.id = row.id } }) }
            if row.manageable {
                KitIconKey(
                    iconKey: "MoreHoriz",
                    label: state.chrome.notebookMenuTitle,
                    tint: "textSoft",
                    identifier: "notes-notebook-menu-\(row.id)"
                ) { send(NotesEvents.home { $0.notebookMenu = .with { $0.notebookID = row.id } }) }
                .padding(.trailing, 4)
            }
        }
    }

    private func journalList(_ journal: Centraid_Core_V1_NotesJournalData) -> some View {
        Group {
            if journal.days.isEmpty {
                EmptyStateView(journal.empty)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        if !state.chrome.journalOrigin.isEmpty {
                            Text(state.chrome.journalOrigin)
                                .centraidType("small")
                                .foregroundStyle(Theme.color("textSoft", scheme))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, CentraidGeometry.pageMargin)
                        }
                        ForEach(journal.days, id: \.day) { day in
                            SectionHeader(title: day.head.title, count: day.head.count)
                            ForEach(day.rows, id: \.noteID) { row in
                                CentraidRow(journalListRow(row)) { open(row.route) }
                            }
                        }
                        ShowMoreFooter(
                            visible: journal.truncated,
                            label: journal.windowEndVerb,
                            onMore: { send(NotesEvents.home { $0.windowWidened = .init() }) }
                        )
                    }
                }
                .refreshable { send(NotesEvents.home { $0.refreshed = .init() }) }
                .accessibilityIdentifier("notes-journal")
            }
        }
    }
}

/// `NotesHomeEvent`s, built.
enum NotesEvents {
    static func home(_ build: (inout Centraid_Core_V1_NotesHomeEvent) -> Void) -> Centraid_Core_V1_NotesHomeEvent {
        var event = Centraid_Core_V1_NotesHomeEvent()
        build(&event)
        return event
    }
}

// MARK: - The Notes place's list

private struct NotesLibraryList: View {
    let library: Centraid_Core_V1_NotesLibraryData
    let state: Centraid_Core_V1_NotesHomeState
    let send: (Centraid_Core_V1_NotesHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(spacing: 0) {
            if library.sections.allSatisfy({ $0.rows.isEmpty }) {
                EmptyStateView(library.empty, onAction: { open(state.newNote) })
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
                            if !section.head.title.isEmpty {
                                SectionHeader(title: section.head.title, count: section.head.count)
                            }
                            ForEach(section.rows, id: \.noteID) { row in
                                NotesRowView(
                                    row: row,
                                    menuLabel: state.chrome.rowMenuLabel,
                                    onTap: { open(row.route) },
                                    onMenu: { send(NotesEvents.home { $0.rowMenu = .with { $0.noteID = row.noteID } }) }
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
                                visible: library.canWiden,
                                label: library.windowEndVerb,
                                onMore: { send(NotesEvents.home { $0.windowWidened = .init() }) }
                            )
                        }
                    }
                }
                .refreshable { send(NotesEvents.home { $0.refreshed = .init() }) }
                .accessibilityIdentifier("notes-library")
            }
        }
    }
}

/// ONE NOTE: title, the snippet (with the search's highlighted runs), the
/// meta, a pin mark and the row's menu.
struct NotesRowView: View {
    let row: Centraid_Core_V1_NotesNoteRow
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

// MARK: - Sheets

private struct NotesHomeSheet: View {
    let state: Centraid_Core_V1_NotesHomeState
    let send: (Centraid_Core_V1_NotesHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void

    var body: some View {
        let chrome = state.chrome
        switch state.sheet {
        case .more:
            // MORE IS RUST'S ROWS (Trash): never search, sort or a filter.
            OptionSheet(title: chrome.moreTitle) {
                ForEach(state.moreRows, id: \.key) { row in
                    SheetRow(iconKey: row.iconKey, label: row.label, identifier: "notes-more-\(row.key)") {
                        send(NotesEvents.home { $0.sheetClosed = .init() })
                        open(row.route)
                    }
                }
            }
        case .rowMenu:
            let menu = state.menu
            OptionSheet(title: menu.title) {
                SheetRow(iconKey: "Pin", label: menu.pinLabel, identifier: "notes-menu-pin") {
                    send(NotesEvents.home { $0.pin = .with { $0.noteID = menu.noteID } })
                }
                SheetRow(iconKey: "Folder", label: menu.fileLabel, identifier: "notes-menu-file") {
                    send(NotesEvents.home { $0.fileInto = .with { $0.noteID = menu.noteID } })
                }
                SheetRow(iconKey: "Trash", label: menu.trashLabel, destructive: true, identifier: "notes-menu-trash") {
                    send(NotesEvents.home { $0.trash = .with { $0.noteID = menu.noteID } })
                }
            }
        case .fileInto:
            OptionSheet(title: chrome.fileTitle) {
                ForEach(state.choices, id: \.id) { choice in
                    SheetRow(label: choice.label, selected: choice.selected, identifier: "notes-file-\(choice.id)") {
                        send(NotesEvents.home { $0.notebookChosen = .with { $0.notebookID = choice.id } })
                    }
                }
            }
        case .sort:
            OptionSheet(title: chrome.sortTitle) {
                ForEach(state.choices, id: \.id) { choice in
                    SheetRow(label: choice.label, selected: choice.selected, identifier: "notes-sort-\(choice.id.lowercased())") {
                        send(NotesEvents.home { $0.sort = .with { $0.sort = choice.sort } })
                    }
                }
            }
        case .notebookMenu:
            let menu = state.menu
            OptionSheet(title: menu.title) {
                SheetRow(iconKey: "Edit", label: menu.renameLabel, identifier: "notes-notebook-rename") {
                    send(NotesEvents.home { $0.formOpened = .with { $0.notebookID = menu.noteID } })
                }
                SheetRow(iconKey: "Trash", label: menu.trashLabel, destructive: true, identifier: "notes-notebook-delete") {
                    send(NotesEvents.home { $0.notebookDelete = .with { $0.notebookID = menu.noteID } })
                }
            }
        case .none, .UNRECOGNIZED:
            EmptyView()
        }
    }
}

/// The new / rename notebook sheet.
private struct NotesNotebookFormSheet: View {
    let form: Centraid_Core_V1_NotesNotebookForm
    let send: (Centraid_Core_V1_NotesHomeEvent) -> Void

    @State private var name = ""

    var body: some View {
        SheetRoom(
            title: form.title,
            status: form.status,
            primary: SheetPrimary(label: form.confirmLabel, enabled: form.canConfirm) {
                send(NotesEvents.home { $0.formConfirmed = .init() })
            },
            outlines: [
                SheetOutline(label: form.cancelLabel, identifier: "notes-notebook-cancel") {
                    send(NotesEvents.home { $0.formDismissed = .init() })
                },
            ]
        ) {
            EditableFieldRow(key: "", text: $name, placeholder: form.placeholder, identifier: "notes-notebook-name") { typed in
                guard typed != form.name else { return }
                send(NotesEvents.home { $0.formName = .with { $0.name = typed } })
            }
            .padding(.horizontal, -CentraidGeometry.pageMargin)
        }
        .onAppear { name = form.name }
    }
}

/// The journal's new-entry sheet: a mood, a line, and Save.
private struct NotesJournalComposeSheet: View {
    let compose: Centraid_Core_V1_NotesJournalCompose
    let send: (Centraid_Core_V1_NotesHomeEvent) -> Void

    @State private var mood = ""
    @State private var text = ""
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        SheetRoom(
            title: compose.title,
            status: compose.status,
            primary: compose.canSave
                ? SheetPrimary(label: compose.save) { send(NotesEvents.home { $0.composeSaved = .init() }) }
                : nil,
            titleIdentifier: "notes-journal-compose"
        ) {
            TextField(compose.moodPlaceholder, text: $mood)
                .centraidType("body")
                .foregroundStyle(Theme.color("text", scheme))
                .padding(.vertical, 8)
                .overlay(alignment: .bottom) { KitHairline() }
                .accessibilityLabel(compose.moodPlaceholder)
                .accessibilityIdentifier("notes-journal-mood")
            TextField(compose.textPlaceholder, text: $text, axis: .vertical)
                .centraidType("body")
                .foregroundStyle(Theme.color("text", scheme))
                .padding(.vertical, 8)
                .overlay(alignment: .bottom) { KitHairline() }
                .accessibilityLabel(compose.textPlaceholder)
                .accessibilityIdentifier("notes-journal-text")
        }
        .onAppear {
            mood = compose.mood
            text = compose.text
        }
        .onChange(of: mood) { _, value in edited(value, text) }
        .onChange(of: text) { _, value in edited(mood, value) }
    }

    private func edited(_ mood: String, _ text: String) {
        guard mood != compose.mood || text != compose.text else { return }
        send(NotesEvents.home { $0.composeEdited = .with { $0.mood = mood; $0.text = text } })
    }
}
