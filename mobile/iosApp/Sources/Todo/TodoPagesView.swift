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

    private func event(_ build: (inout Centraid_Core_V1_TodoListEvent) -> Void) -> Centraid_Core_V1_TodoListEvent {
        var event = Centraid_Core_V1_TodoListEvent()
        build(&event)
        return event
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
        PushedPage(title: state.title, parentTitle: state.chrome.back, onBack: onBack) {
            EmptyView()
        } content: {
            VStack(spacing: 0) {
                ReadStateView(
                    content: content,
                    loadingLabel: state.chrome.loading,
                    onRetry: { send(event { $0.refreshed = .init() }) }
                ) { list in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            TodoCountLine(count: list.countLabel, window: list.windowLabel)
                            if list.groups.isEmpty, list.hasEmpty, !list.empty.headline.isEmpty {
                                EmptyStateView(list.empty.legacy)
                            }
                            ForEach(list.groups, id: \.key) { group in
                                TodoGroupView(
                                    group: group,
                                    onVerb: { _ in },
                                    onCheck: { id in send(event { $0.rowChecked = .with { $0.taskID = id } }) },
                                    onPick: open
                                )
                            }
                            ShowMoreFooter(visible: list.canShowMore, label: state.chrome.showMore) {
                                send(event { $0.nextPage = .init() })
                            }
                        }
                        .padding(.bottom, 16)
                    }
                    .refreshable { send(event { $0.refreshed = .init() }) }
                    .accessibilityIdentifier("tasks-list")
                }
                StatusLineView(status: state.status.legacy, identifier: "tasks-status-action") { send(event { $0.statusActed = .init() }) }
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

    var body: some View {
        PushedPage(title: state.title, parentTitle: state.chrome.back, onBack: onBack) {
            if case let .data(project) = content, project.found {
                HStack(spacing: 4) {
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
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            TodoCountLine(count: project.countLabel, window: "")
                            if project.groups.isEmpty, project.hasEmpty, !project.empty.headline.isEmpty {
                                EmptyStateView(project.empty.legacy)
                            }
                            ForEach(project.groups, id: \.key) { group in
                                TodoGroupView(
                                    group: group,
                                    onVerb: { key in send(event { $0.groupVerb = .with { $0.key = key } }) },
                                    onCheck: { id in send(event { $0.rowChecked = .with { $0.taskID = id } }) },
                                    onPick: open
                                )
                            }
                        }
                        .padding(.bottom, 16)
                    }
                    .refreshable { send(event { $0.refreshed = .init() }) }
                    .scrollDismissesKeyboard(.interactively)
                    .accessibilityIdentifier("tasks-project")
                }
                StatusLineView(status: state.status.legacy, identifier: "tasks-status-action") { send(event { $0.statusActed = .init() }) }
                if !content.isDenied {
                    TodoQuickAddBar(
                        quickAdd: state.quickAdd,
                        placeholder: state.chrome.quickAddPlaceholder,
                        verb: state.chrome.quickAddVerb,
                        onChange: { title in send(event { $0.quickAddChanged = .with { $0.title = title } }) },
                        onSubmit: { send(event { $0.quickAddSubmitted = .init() }) }
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
                                EmptyStateView(catchUp.empty.legacy)
                            }
                            ForEach(catchUp.piles, id: \.key) { pile in
                                SectionHeader(title: pile.title, count: UInt32(pile.meta), verb: pile.verbLabel) {
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
                StatusLineView(status: state.status.legacy, identifier: "tasks-status-action") { send(event { $0.statusActed = .init() }) }
            }
        }
        .sheet(isPresented: Binding(
            get: { state.hasConfirm },
            set: { open in if !open, state.hasConfirm { send(event { $0.dismissed = .init() }) } }
        )) {
            ConfirmSheet(
                state.confirm.legacy,
                cancelLabel: state.chrome.cancel,
                onConfirm: { send(event { $0.confirmed = .init() }) },
                onDismiss: { send(event { $0.dismissed = .init() }) }
            )
        }
    }
}
