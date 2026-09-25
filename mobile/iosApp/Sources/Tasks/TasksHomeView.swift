import SwiftUI

/// Tasks' home place — Today · Upcoming · Inbox · Projects, More a sheet
/// (#1029 port), on the kit.
///
/// **THE VIEW DECIDES NOTHING.** `TasksHomeState` carries the band, every
/// word, every row, the empty sentence, the quick add's landing words and the
/// status line; this file lays them out and forwards events. `AppPlace` owns
/// the header, the search slot and the band; `ReadStateView` owns loading,
/// failure and the denied gate (no band, no quick add while denied).
struct TasksHomeView: View {
    let data: Data
    let send: (Data) -> Void
    let onHome: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_TasksHomeState {
        (try? Centraid_Screen_V1_TasksHomeState(serializedBytes: data)) ?? .init()
    }

    private func event(_ build: (inout Centraid_Screen_V1_TasksHomeEvent) -> Void) -> Data {
        tasksEvent(Centraid_Screen_V1_TasksHomeEvent.self, build)
    }

    var body: some View {
        let state = state
        let content = state.readContent
        let chrome = state.chrome
        AppPlace(
            app: "tasks",
            title: chrome.title,
            search: SearchSlot(
                field: state.search,
                placeholder: chrome.searchPlaceholder,
                closeLabel: chrome.searchClose,
                onTerm: { term in send(event { $0.searchTerm = .with { $0.term = term } }) },
                onClose: { send(event { $0.searchClosed = .init() }) }
            ),
            showsBand: !content.isDenied && !state.band.isEmpty
        ) {
            if !content.isDenied, !state.search.open {
                Button {
                    send(event { $0.searchOpened = .init() })
                } label: {
                    CentraidIconView(iconKey: "Search", tint: Theme.color("textSoft", scheme), size: 18)
                        .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(chrome.searchLabel)
                .accessibilityIdentifier("tasks-search-open")
            }
        } band: {
            AppBand(
                app: "tasks",
                tabs: state.band.map { tab in
                    BandView(
                        label: tab.label,
                        event: event { $0.band = .with { $0.key = tab.key } },
                        iconKey: tab.iconKey,
                        selected: tab.current
                    )
                },
                onSelect: send,
                onHome: onHome
            )
        } content: {
            VStack(spacing: 0) {
                ReadStateView(
                    content: content,
                    loadingLabel: chrome.loading,
                    onRetry: { send(event { $0.refreshed = .init() }) }
                ) { home in
                    homeList(home, chrome: chrome)
                }
                StatusLineView(status: state.status, identifier: "tasks-status-action") { send(event { $0.statusActed = .init() }) }
                if !content.isDenied {
                    TasksQuickAddBar(
                        quickAdd: state.quickAdd,
                        placeholder: chrome.quickAddPlaceholder,
                        verb: chrome.quickAddVerb,
                        onChange: { title in send(event { $0.quickAddChanged = .with { $0.title = title } }) },
                        onSubmit: { send(event { $0.quickAddSubmitted = .init() }) }
                    )
                }
            }
        }
        .sheet(isPresented: sheetBinding(state, .more)) {
            OptionSheet(title: chrome.moreTitle) {
                ForEach(state.moreRows, id: \.key) { row in
                    SheetRow(
                        iconKey: row.iconKey,
                        label: row.label,
                        selected: row.selected,
                        identifier: "tasks-more-\(row.key)"
                    ) { send(event { $0.moreRow = .with { $0.key = row.key } }) }
                    .disabled(!row.enabled)
                }
            }
        }
        .sheet(isPresented: sheetBinding(state, .reads)) {
            SheetRoom(title: chrome.readsTitle) {
                VStack(spacing: 0) {
                    ForEach(Array(chrome.readsFacts.enumerated()), id: \.offset) { _, fact in
                        FieldRow(key: fact.label, value: fact.detail)
                    }
                }
            }
        }
        .sheet(isPresented: sheetBinding(state, .file)) {
            OptionSheet(title: chrome.fileTitle) {
                ForEach(state.fileChoices, id: \.key) { choice in
                    SheetRow(
                        iconKey: choice.iconKey,
                        label: choice.label,
                        selected: choice.selected,
                        identifier: "tasks-file-\(choice.key)"
                    ) { send(event { $0.fileChosen = .with { $0.key = choice.key } }) }
                    .padding(.leading, choice.indented ? 24 : 0)
                    .disabled(!choice.enabled)
                }
            }
        }
        .sheet(isPresented: sheetBinding(state, .newProject)) {
            SheetRoom(
                title: chrome.newProjectTitle,
                primary: state.newProjectCanSubmit
                    ? SheetPrimary(label: chrome.newProjectVerb) { send(event { $0.newProjectSubmitted = .init() }) }
                    : nil
            ) {
                MachineTextField(
                    placeholder: chrome.newProjectPlaceholder,
                    value: state.newProjectName,
                    focusOnAppear: true,
                    onEdit: { name in send(event { $0.newProjectName = .with { $0.name = name } }) }
                )
                .centraidType("body")
                .accessibilityLabel(chrome.newProjectPlaceholder)
                .accessibilityIdentifier("tasks-new-project-field")
            }
        }
    }

    @ViewBuilder
    private func homeList(_ home: Centraid_Screen_V1_TasksHomeData, chrome: Centraid_Screen_V1_TasksChrome) -> some View {
        let nothing = home.groups.isEmpty && home.projects.isEmpty
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if home.hasNotice {
                    noticeView(home.notice)
                }
                TasksCountLine(count: home.countLabel, window: home.windowLabel)
                if nothing, !home.empty.headline.isEmpty {
                    EmptyStateView(home.empty, onAction: { send(event { $0.emptyActed = .init() }) })
                }
                ForEach(home.groups, id: \.key) { group in
                    TasksGroupView(
                        group: group,
                        onVerb: { key in send(event { $0.groupVerb = .with { $0.key = key } }) },
                        onCheck: { id in send(event { $0.rowChecked = .with { $0.taskID = id } }) },
                        onPick: { id in send(event { $0.rowPicked = .with { $0.taskID = id } }) },
                        fileVerb: chrome.fileVerb,
                        onFile: { id in send(event { $0.fileRequested = .with { $0.taskID = id } }) }
                    )
                }
                ForEach(home.projects, id: \.key) { group in
                    SectionHeader(title: group.title, count: UInt32(group.rows.count))
                    ForEach(group.rows, id: \.id) { row in
                        CentraidRow(
                            title: row.title,
                            meta: row.meta,
                            trailing: row.trailing,
                            trailingTone: StatusChipView.ink(row.trailingTone, neutral: "text"),
                            chips: row.chips,
                            hueKey: row.hueKey.isEmpty ? "" : AgendaHue.role(row.hueKey),
                            dimmed: row.dimmed,
                            pending: row.pending,
                            accessibility: row.accessibilityLabel,
                            identifier: "tasks-project-\(row.id)"
                        ) { send(event { $0.projectPicked = .with { $0.projectID = row.id } }) }
                    }
                }
                ShowMoreFooter(visible: home.canShowMore, label: chrome.showMore) {
                    send(event { $0.nextPage = .init() })
                }
            }
            .padding(.bottom, 16)
        }
        .refreshable { send(event { $0.refreshed = .init() }) }
        .accessibilityIdentifier("tasks-home-list")
    }

    private func noticeView(_ notice: Centraid_Screen_V1_TasksNotice) -> some View {
        HStack(spacing: 8) {
            Text(notice.sentence)
                .centraidType("small")
                .foregroundStyle(Theme.color("textSoft", scheme))
                .frame(maxWidth: .infinity, alignment: .leading)
            if !notice.verbLabel.isEmpty {
                KitOutlineButton(label: notice.verbLabel) { send(event { $0.noticeActed = .init() }) }
                    .accessibilityIdentifier("tasks-notice-verb")
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
        .background(Theme.color("bgSunken", scheme))
    }

    /// READ from the state, WRITTEN as an event: a swiped-away sheet tells the
    /// machine, and the machine closes it.
    private func sheetBinding(
        _ state: Centraid_Screen_V1_TasksHomeState,
        _ sheet: Centraid_Screen_V1_TasksHomeState.Sheet
    ) -> Binding<Bool> {
        Binding(
            get: { state.sheet == sheet },
            set: { open in
                guard !open, state.sheet == sheet else { return }
                send(event { $0.sheetClosed = .init() })
            }
        )
    }
}
