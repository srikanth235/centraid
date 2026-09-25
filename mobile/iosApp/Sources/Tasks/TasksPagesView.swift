import SwiftUI

// TASKS' PUSHED PAGES (#1029 port): one list parameterised by view (Anytime,
// All, Logbook, Reminders), one project, and Catch up. Each is a
// `PushedPage` with back to the named parent, its content through
// `ReadStateView`, rows through `TasksRowView`, and the one status line.

/// `tasks.list`.
struct TasksListView: View {
    let data: Data
    let send: (Data) -> Void
    let onBack: () -> Void

    private func event(_ build: (inout Centraid_Screen_V1_TasksListEvent) -> Void) -> Data {
        tasksEvent(Centraid_Screen_V1_TasksListEvent.self, build)
    }

    var body: some View {
        let state = (try? Centraid_Screen_V1_TasksListState(serializedBytes: data)) ?? .init()
        PushedPage(title: state.title, parentTitle: state.chrome.back, onBack: onBack) {
            EmptyView()
        } content: {
            VStack(spacing: 0) {
                ReadStateView(
                    content: state.readContent,
                    loadingLabel: state.chrome.loading,
                    onRetry: { send(event { $0.refreshed = .init() }) }
                ) { list in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            TasksCountLine(count: list.countLabel, window: list.windowLabel)
                            if list.groups.isEmpty, !list.empty.headline.isEmpty {
                                EmptyStateView(list.empty)
                            }
                            ForEach(list.groups, id: \.key) { group in
                                TasksGroupView(
                                    group: group,
                                    onVerb: { _ in },
                                    onCheck: { id in send(event { $0.rowChecked = .with { $0.taskID = id } }) },
                                    onPick: { id in send(event { $0.rowPicked = .with { $0.taskID = id } }) }
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
                StatusLineView(status: state.status, identifier: "tasks-status-action") { send(event { $0.statusActed = .init() }) }
            }
        }
    }
}

/// `tasks.project`: its unsectioned work, then every section, each with its
/// "Add task" verb pointing the quick add at it; "Add section" is a sheet.
struct TasksProjectView: View {
    let data: Data
    let send: (Data) -> Void
    let onBack: () -> Void

    @Environment(\.colorScheme) private var scheme

    private func event(_ build: (inout Centraid_Screen_V1_TasksProjectEvent) -> Void) -> Data {
        tasksEvent(Centraid_Screen_V1_TasksProjectEvent.self, build)
    }

    var body: some View {
        let state = (try? Centraid_Screen_V1_TasksProjectState(serializedBytes: data)) ?? .init()
        let content = state.readContent
        PushedPage(title: state.title, parentTitle: state.chrome.back, onBack: onBack) {
            if case let .data(project) = content, project.found, !project.addSectionLabel.isEmpty {
                Button {
                    send(event { $0.addSection = .init() })
                } label: {
                    Text(project.addSectionLabel)
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color("link", scheme))
                        .frame(minHeight: CentraidGeometry.targetMinCoarse)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("tasks-add-section")
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
                            TasksCountLine(count: project.countLabel, window: "")
                            if project.groups.isEmpty, !project.empty.headline.isEmpty {
                                EmptyStateView(project.empty)
                            }
                            ForEach(project.groups, id: \.key) { group in
                                TasksGroupView(
                                    group: group,
                                    onVerb: { key in send(event { $0.groupVerb = .with { $0.key = key } }) },
                                    onCheck: { id in send(event { $0.rowChecked = .with { $0.taskID = id } }) },
                                    onPick: { id in send(event { $0.rowPicked = .with { $0.taskID = id } }) }
                                )
                            }
                        }
                        .padding(.bottom, 16)
                    }
                    .refreshable { send(event { $0.refreshed = .init() }) }
                    .accessibilityIdentifier("tasks-project")
                }
                StatusLineView(status: state.status, identifier: "tasks-status-action") { send(event { $0.statusActed = .init() }) }
                if !content.isDenied {
                    TasksQuickAddBar(
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
    }
}

/// `tasks.catch_up`: the three piles, one "Complete all" each, confirmed.
struct TasksCatchUpView: View {
    let data: Data
    let send: (Data) -> Void
    let onBack: () -> Void

    @Environment(\.colorScheme) private var scheme

    private func event(_ build: (inout Centraid_Screen_V1_TasksCatchUpEvent) -> Void) -> Data {
        tasksEvent(Centraid_Screen_V1_TasksCatchUpEvent.self, build)
    }

    var body: some View {
        let state = (try? Centraid_Screen_V1_TasksCatchUpState(serializedBytes: data)) ?? .init()
        PushedPage(title: state.chrome.title, parentTitle: state.chrome.back, onBack: onBack) {
            EmptyView()
        } content: {
            VStack(spacing: 0) {
                ReadStateView(
                    content: state.readContent,
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
                            if catchUp.piles.isEmpty, !catchUp.empty.headline.isEmpty {
                                EmptyStateView(catchUp.empty)
                            }
                            ForEach(catchUp.piles, id: \.key) { pile in
                                SectionHeader(title: pile.title, count: UInt32(pile.meta), verb: pile.verbEnabled ? pile.verbLabel : "") {
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
                                    TasksRowView(
                                        row: row,
                                        onCheck: { id in send(event { $0.rowChecked = .with { $0.taskID = id } }) },
                                        onPick: { id in send(event { $0.rowPicked = .with { $0.taskID = id } }) }
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
