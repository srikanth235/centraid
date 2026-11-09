import SwiftUI

// AGENDA'S TO-DO PAGES (#1135): one list parameterised by view (Anytime,
// All, Logbook, Reminders), one project, and Catch up. Each is a
// `PushedPage` with back to the named parent, its content through
// `ReadStateView`, rows through `TodoRowView`, and the one status line. A row
// that opens a page hands its `route` to `open`.

/// `agenda.todo_list`.
struct TodoListView: View {
    let state: Centraid_Core_V1_TodoListState
    let send: (Centraid_Core_V1_TodoListEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onBack: () -> Void
    @Environment(\.colorScheme) private var scheme

    private func event(_ build: (inout Centraid_Core_V1_TodoListEvent) -> Void) -> Centraid_Core_V1_TodoListEvent {
        var event = Centraid_Core_V1_TodoListEvent()
        build(&event)
        return event
    }

    /// The large title's colour: the smart list's own, as Rust names it; nil for a view with none.
    private var heading: Color? {
        state.colorKey.isEmpty ? nil : AgendaPalette.token(state.colorKey)
    }

    private var content: ScreenContent<Centraid_Core_V1_TodoListData> {
        switch state.content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .gated(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }

    var body: some View {
        // THE TITLE IS THE PAGE'S OWN, LARGE, IN THE SMART LIST'S COLOUR (#1173): the bar
        // carries the back chevron and the plus, and no small title.
        PushedPage(title: state.title, parentTitle: state.chrome.back, onBack: onBack, titleColor: heading, titleIdentifier: "tasks-list-title") {
            if state.hasAddRoute, !state.addLabel.isEmpty {
                RoomTrailing(
                    action: RoomAction(iconKey: "Plus", label: state.addLabel, identifier: "tasks-list-add") {
                        open(state.addRoute)
                    },
                    app: "agenda"
                )
            }
        } content: {
            VStack(spacing: 0) {
                ReadStateView(
                    content: content,
                    loadingLabel: state.chrome.loading,
                    onRetry: { send(event { $0.refreshed = .init() }) }
                ) { list in
                    // A LIST, so a row can be swiped (#1173): each task is a row of its own.
                    List {
                            if !list.subtitle.isEmpty {
                                Text(list.subtitle)
                                    .centraidType("small")
                                    .foregroundStyle(Theme.color("textSoft", scheme))
                                    .padding(.horizontal, CentraidGeometry.pageMargin)
                                    .todoPlainRow()
                            }
                            if !list.countLabel.isEmpty || !list.windowLabel.isEmpty {
                                TodoCountLine(count: list.countLabel, window: list.windowLabel)
                                    .todoPlainRow()
                            }
                            if list.groups.isEmpty, list.hasEmpty, !list.empty.headline.isEmpty {
                                EmptyStateView(list.empty)
                                    .todoPlainRow()
                            }
                            ForEach(list.groups, id: \.key) { group in
                                TodoGroupView(
                                    group: group,
                                    onVerb: { key in send(event { $0.groupVerb = .with { $0.key = key } }) },
                                    onCheck: { id in send(event { $0.rowChecked = .with { $0.taskID = id } }) },
                                    onPick: open,
                                    chrome: state.chrome,
                                    onFlag: { id, on in send(event { $0.rowFlagged = .with { $0.taskID = id; $0.flagged = on } }) },
                                    onDelete: { id in send(event { $0.rowDeleted = .with { $0.taskID = id } }) },
                                    inList: true
                                )
                            }
                            if list.canShowMore {
                                ShowMoreFooter(visible: list.canShowMore, label: state.chrome.showMore) {
                                    send(event { $0.nextPage = .init() })
                                }
                                .todoPlainRow()
                            }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                    .environment(\.defaultMinListRowHeight, 0)
                    .refreshable { send(event { $0.refreshed = .init() }) }
                    .accessibilityIdentifier("tasks-list")
                }
                StatusLineView(status: state.status, identifier: "tasks-status-action") { send(event { $0.statusActed = .init() }) }
            }
        }
    }
}

/// `agenda.project`: its unsectioned work, then every section, each with its
/// "Add task" verb pointing the quick add at it; "Add section" and "Rename" are
/// sheets.
struct TodoProjectView: View {
    let state: Centraid_Core_V1_TodoProjectState
    let send: (Centraid_Core_V1_TodoProjectEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onBack: () -> Void

    @Environment(\.colorScheme) private var scheme

    private func event(_ build: (inout Centraid_Core_V1_TodoProjectEvent) -> Void) -> Centraid_Core_V1_TodoProjectEvent {
        var event = Centraid_Core_V1_TodoProjectEvent()
        build(&event)
        return event
    }

    private var content: ScreenContent<Centraid_Core_V1_TodoProjectData> {
        switch state.content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .gated(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }

    /// "2 completed · Show · Clear", and the rows while shown.
    @ViewBuilder
    private func completedSummary(_ completed: Centraid_Core_V1_TodoCompleted) -> some View {
        HStack(spacing: 12) {
            Text(completed.countLabel)
                .centraidType("small")
                .foregroundStyle(Theme.color("textSoft", scheme))
            Spacer(minLength: 0)
            KitLink(label: completed.shown ? state.chrome.hideCompletedVerb : state.chrome.showCompletedVerb, identifier: "tasks-completed-toggle") {
                send(event { $0.completedToggled = .init() })
            }
            KitLink(label: state.chrome.clearCompletedVerb_p, identifier: "tasks-completed-clear") {
                send(event { $0.completedCleared = .init() })
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 12)
        .todoPlainRow()
        ForEach(completed.rows, id: \.taskID) { row in
            TodoRowView(
                row: row,
                onCheck: { id in send(event { $0.rowChecked = .with { $0.taskID = id } }) },
                onPick: open,
                chrome: state.chrome,
                onFlag: { id, on in send(event { $0.rowFlagged = .with { $0.taskID = id; $0.flagged = on } }) },
                onDelete: { id in send(event { $0.rowDeleted = .with { $0.taskID = id } }) }
            )
            .todoPlainRow()
        }
    }

    var body: some View {
        // THE TITLE, in the list's colour with its own icon, is inline in the top row (round 9).
        PushedPage(
            title: state.title,
            parentTitle: state.chrome.back,
            onBack: onBack,
            titleColor: { if case let .data(p) = content { return AgendaPalette.list(p.listColorKey) } else { return nil } }(),
            titleIcon: { if case let .data(p) = content { return p.iconKey } else { return "" } }()
        ) {
            if case let .data(project) = content, project.found {
                HStack(spacing: 4) {
                    // "EDIT LIST" (#1173 wave 2): name, colour and icon in one sheet.
                    if !project.styleLabel.isEmpty {
                        ToolbarVerb(label: project.styleLabel, identifier: "tasks-project-edit") {
                            send(event { $0.styleRequested = .init() })
                        }
                    }
                    if !project.renameLabel.isEmpty {
                        ToolbarVerb(label: project.renameLabel, identifier: "tasks-rename-project") {
                            send(event { $0.rename = .init() })
                        }
                    }
                    if !project.addSectionLabel.isEmpty {
                        ToolbarVerb(label: project.addSectionLabel, identifier: "tasks-add-section") {
                            send(event { $0.addSection = .init() })
                        }
                    }
                }
            }
        } content: {
            VStack(spacing: 0) {
                ReadStateView(
                    content: content,
                    loadingLabel: state.chrome.loading,
                    onRetry: { send(event { $0.refreshed = .init() }) }
                ) { project in
                    // A LIST, so a row can be swiped (#1173): each task is a row of its own.
                    List {
                            if !project.countLabel.isEmpty {
                                TodoCountLine(count: project.countLabel, window: "")
                                    .todoPlainRow()
                            }
                            if project.groups.isEmpty, project.hasEmpty, !project.empty.headline.isEmpty {
                                EmptyStateView(project.empty)
                                    .todoPlainRow()
                            }
                            ForEach(project.groups, id: \.key) { group in
                                TodoGroupView(
                                    group: group,
                                    onVerb: { key in send(event { $0.groupVerb = .with { $0.key = key } }) },
                                    onCheck: { id in send(event { $0.rowChecked = .with { $0.taskID = id } }) },
                                    onPick: open,
                                    chrome: state.chrome,
                                    onFlag: { id, on in send(event { $0.rowFlagged = .with { $0.taskID = id; $0.flagged = on } }) },
                                    onDelete: { id in send(event { $0.rowDeleted = .with { $0.taskID = id } }) },
                                    onMove: { moved, before in send(event { $0.rowMoved = .with { $0.taskID = moved; $0.beforeID = before } }) },
                                    inList: true
                                )
                            }
                            if project.hasCompleted, project.completed.count > 0 {
                                completedSummary(project.completed)
                            }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                    .environment(\.defaultMinListRowHeight, 0)
                    .refreshable { send(event { $0.refreshed = .init() }) }
                    .scrollDismissesKeyboard(.interactively)
                    .accessibilityIdentifier("tasks-project")
                }
                StatusLineView(status: state.status, identifier: "tasks-status-action") { send(event { $0.statusActed = .init() }) }
                if !content.isDenied {
                    TodoQuickAddBar(
                        quickAdd: state.quickAdd,
                        placeholder: state.chrome.newReminder,
                        verb: state.chrome.quickAddVerb,
                        onChange: { title in send(event { $0.quickAddChanged = .with { $0.title = title } }) },
                        onSubmit: { send(event { $0.quickAddSubmitted = .init() }) },
                        onDismissChip: { send(event { $0.quickAddChipDismissed = .init() }) },
                        // THE KEYBOARD TOOLBAR (#1173).
                        onTool: { key in send(event { $0.quickTool = .with { $0.key = key } }) },
                        onDue: { key in send(event { $0.quickDue = .with { $0.key = key } }) },
                        onTag: { text in send(event { $0.quickTag = .with { $0.text = text } }) }
                    )
                }
            }
        }
        .sheet(isPresented: Binding(
            get: { state.sheet == .addSection },
            set: { open in if !open, state.sheet == .addSection { send(event { $0.sheetClosed = .init() }) } }
        )) {
            SheetRoom(
                title: state.chrome.addSectionTitle,
                primary: state.newSectionCanSubmit
                    ? SheetPrimary(label: state.chrome.addSectionVerb) { send(event { $0.sectionSubmitted = .init() }) }
                    : nil
            ) {
                MachineTextField(
                    placeholder: state.chrome.addSectionPlaceholder,
                    value: state.newSectionName,
                    focusOnAppear: true,
                    onEdit: { name in send(event { $0.sectionName = .with { $0.name = name } }) }
                )
                .centraidType("body")
                .accessibilityLabel(state.chrome.addSectionPlaceholder)
                .accessibilityIdentifier("tasks-new-section-field")
            }
        }
        // THE STYLE SHEET: "Edit list".
        .sheet(isPresented: Binding(
            get: { state.sheet == .style },
            set: { open in if !open, state.sheet == .style { send(event { $0.sheetClosed = .init() }) } }
        )) {
            AgendaStyleSheetView(
                style: state.style,
                onName: { name in send(event { $0.styleName = .with { $0.name = name } }) },
                onColor: { key in send(event { $0.styleColor = .with { $0.key = key } }) },
                onIcon: { key in send(event { $0.styleIcon = .with { $0.key = key } }) },
                onSubmit: { send(event { $0.styleSubmitted = .init() }) },
                onCancel: { send(event { $0.sheetClosed = .init() }) }
            )
        }
        .sheet(isPresented: Binding(
            get: { state.sheet == .rename },
            set: { open in if !open, state.sheet == .rename { send(event { $0.sheetClosed = .init() }) } }
        )) {
            if case let .data(project) = content {
                SheetRoom(
                    title: project.renameTitle,
                    primary: state.renameCanSubmit
                        ? SheetPrimary(label: project.renameVerb) { send(event { $0.renameSubmitted = .init() }) }
                        : nil
                ) {
                    MachineTextField(
                        placeholder: project.renamePlaceholder,
                        value: state.renameName,
                        focusOnAppear: true,
                        onEdit: { name in send(event { $0.renameName = .with { $0.name = name } }) }
                    )
                    .centraidType("body")
                    .accessibilityLabel(project.renamePlaceholder)
                    .accessibilityIdentifier("tasks-rename-field")
                }
            }
        }
    }
}

/// `agenda.catch_up`: the three piles, one "Complete all" each, confirmed.
struct TodoCatchUpView: View {
    let state: Centraid_Core_V1_TodoCatchUpState
    let send: (Centraid_Core_V1_TodoCatchUpEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onBack: () -> Void

    @Environment(\.colorScheme) private var scheme

    private func event(_ build: (inout Centraid_Core_V1_TodoCatchUpEvent) -> Void) -> Centraid_Core_V1_TodoCatchUpEvent {
        var event = Centraid_Core_V1_TodoCatchUpEvent()
        build(&event)
        return event
    }

    private var content: ScreenContent<Centraid_Core_V1_TodoCatchUpData> {
        switch state.content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .gated(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }

    var body: some View {
        PushedPage(title: state.chrome.title, parentTitle: state.chrome.back, onBack: onBack) {
            EmptyView()
        } content: {
            VStack(spacing: 0) {
                ReadStateView(
                    content: content,
                    loadingLabel: state.chrome.loading,
                    onRetry: { send(event { $0.refreshed = .init() }) }
                ) { catchUp in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            if !catchUp.head.isEmpty {
                                Text(catchUp.head)
                                    .centraidType("small")
                                    .foregroundStyle(Theme.color("textSoft", scheme))
                                    .padding(.horizontal, CentraidGeometry.pageMargin)
                                    .padding(.top, 8)
                            }
                            if catchUp.piles.isEmpty, catchUp.hasEmpty, !catchUp.empty.headline.isEmpty {
                                EmptyStateView(catchUp.empty)
                            }
                            ForEach(catchUp.piles, id: \.key) { pile in
                                SectionHeader(title: pile.title, count: UInt32(pile.meta), verb: pile.verbLabel, sentenceCase: true) {
                                    send(event { $0.completeAll = .with { $0.pile = pile.key } })
                                }
                                // A count rides in the head; any other meta is its own line.
                                if !pile.meta.isEmpty, UInt32(pile.meta) == nil {
                                    Text(pile.meta)
                                        .centraidType("annotLabel")
                                        .foregroundStyle(Theme.color("textFaint", scheme))
                                        .padding(.horizontal, CentraidGeometry.pageMargin)
                                }
                                ForEach(pile.rows, id: \.taskID) { row in
                                    TodoRowView(
                                        row: row,
                                        onCheck: { id in send(event { $0.rowChecked = .with { $0.taskID = id } }) },
                                        onPick: open
                                    )
                                }
                            }
                        }
                        .padding(.bottom, 16)
                    }
                    .refreshable { send(event { $0.refreshed = .init() }) }
                    .accessibilityIdentifier("tasks-catch-up")
                }
                StatusLineView(status: state.status, identifier: "tasks-status-action") { send(event { $0.statusActed = .init() }) }
            }
        }
        .sheet(isPresented: Binding(
            get: { state.hasConfirm },
            set: { open in if !open, state.hasConfirm { send(event { $0.dismissed = .init() }) } }
        )) {
            ConfirmSheet(
                state.confirm,
                cancelLabel: state.chrome.cancel,
                onConfirm: { send(event { $0.confirmed = .init() }) },
                onDismiss: { send(event { $0.dismissed = .init() }) }
            )
        }
    }
}
