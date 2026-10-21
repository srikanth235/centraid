import SwiftUI

/// Agenda's home screen, in SwiftUI (#1046 wave 3).
///
/// **THE VIEW DECIDES NOTHING.** Every word, flag, hue key and label drawn here
/// is on `AgendaHomeState`, which `AgendaHomeMachine` in `CentraidShared`
/// folds; this file maps fields to geometry and taps to events. A string
/// literal below is a bug: the words come from `copy/agenda.json` through the
/// state's `chrome`.
///
/// Four content branches, never two — loading, failure, denied, data — and the
/// denied branch draws no band, because a gate with tabs under it would offer
/// doors the member cannot open.
///
/// **FIVE PLACES, ONE LIST EACH (#1128).** Day and Schedule draw a dated task as
/// a row of its day, its round box checking it off in place; To-do draws the
/// Inbox and then the projects, with the quick-add bar the Plus opens on the
/// keyboard. Which of those the data holds is the state's (`home.todo`), not a
/// branch on the destination.
struct AgendaHomeView: View {
    let data: Data
    let send: (Data) -> Void
    let onHome: () -> Void

    @Environment(\.colorScheme) private var scheme
    /// The shell's import door, nil where it offers none (and inside an example).
    @Environment(\.importFromPhone) private var importFromPhone
    /// The quick add holds the keyboard: the band is put away while it does
    /// (as an editor's is, DESIGN.md "The seven rooms"), so the bar sits on the
    /// keyboard and not behind it, and a scroll or the Done key lets it go.
    @State private var quickAddTyping = false

    private var state: Centraid_Screen_V1_AgendaHomeState {
        (try? Centraid_Screen_V1_AgendaHomeState(serializedBytes: data)) ?? .init()
    }

    var body: some View {
        let state = state
        let content = readContent(state)
        AppPlace(
            app: "agenda",
            title: state.chrome.title,
            trailing: addAction(state, denied: content.isDenied),
            // SEARCH IS THE BAR UNDER THE TITLE (R-CHROME-2), above the day
            // bar; a tap opens the field through the machine. None on the
            // gate, which has nothing to search.
            search: content.isDenied ? nil : SearchSlot(
                field: searchField(state),
                placeholder: state.chrome.searchPlaceholder,
                closeLabel: state.chrome.searchClose,
                onOpen: { send(AgendaEvents.make { $0.searchOpened = .init() }) },
                onTerm: { term in send(AgendaEvents.make { $0.searchTerm = .with { $0.term = term } }) },
                onClose: { send(AgendaEvents.make { $0.searchClosed = .init() }) }
            ),
            showsBand: !content.isDenied && !state.band.isEmpty && !quickAddTyping
        ) {
            AppBand(
                app: "agenda",
                tabs: state.band.map { tab in
                    BandView(
                        label: tab.label,
                        event: AgendaEvents.make { $0.band = .with { $0.key = tab.key } },
                        iconKey: tab.iconKey,
                        selected: tab.current,
                        key: tab.key
                    )
                },
                onSelect: send,
                onHome: onHome
            )
        } content: {
            VStack(spacing: 0) {
                if state.toolbar.shown {
                    AgendaToolbarView(toolbar: state.toolbar, chrome: state.chrome, send: send)
                }
                ReadStateView(
                    content: content,
                    loadingLabel: state.chrome.loading,
                    onRetry: { send(AgendaEvents.make { $0.refreshed = .init() }) }
                ) { home in
                    homeContent(home, state: state)
                }
                StatusLineView(status: state.status, identifier: "agenda-status-action") {
                    send(AgendaEvents.make { $0.statusActed = .init() })
                }
                if !content.isDenied {
                    TasksQuickAddBar(
                        quickAdd: state.quickAdd,
                        placeholder: state.chrome.tasks.quickAddPlaceholder,
                        verb: state.chrome.tasks.quickAddVerb,
                        onChange: { title in send(AgendaEvents.make { $0.quickAddChanged = .with { $0.title = title } }) },
                        onSubmit: { send(AgendaEvents.make { $0.quickAddSubmitted = .init() }) },
                        onFocusChange: { typing in
                            quickAddTyping = typing
                            // THE KEYBOARD LEFT: the machine puts an empty bar away.
                            if !typing { send(AgendaEvents.make { $0.quickAddClosed = .init() }) }
                        },
                        fieldIdentifier: "agenda-quick-add",
                        verbIdentifier: "agenda-quick-add-verb"
                    )
                }
            }
        }
        .sheet(isPresented: sheetBinding(state, .more)) {
            AgendaMoreSheet(state: state, send: send)
        }
        .sheet(isPresented: sheetBinding(state, .reads)) {
            AgendaReadsSheet(chrome: state.chrome)
        }
        .sheet(isPresented: sheetBinding(state, .file)) {
            OptionSheet(title: state.chrome.tasks.fileTitle) {
                ForEach(state.fileChoices, id: \.key) { choice in
                    SheetRow(
                        iconKey: choice.iconKey,
                        label: choice.label,
                        selected: choice.selected,
                        identifier: "agenda-file-\(choice.key)"
                    ) { send(AgendaEvents.make { $0.fileChosen = .with { $0.key = choice.key } }) }
                    .padding(.leading, choice.indented ? 24 : 0)
                    .disabled(!choice.enabled)
                }
            }
        }
        .sheet(isPresented: sheetBinding(state, .newProject)) {
            SheetRoom(
                title: state.chrome.tasks.newProjectTitle,
                primary: state.newProjectCanSubmit
                    ? SheetPrimary(label: state.chrome.tasks.newProjectVerb) {
                        send(AgendaEvents.make { $0.newProjectSubmitted = .init() })
                    }
                    : nil
            ) {
                MachineTextField(
                    placeholder: state.chrome.tasks.newProjectPlaceholder,
                    value: state.newProjectName,
                    focusOnAppear: true,
                    onEdit: { name in send(AgendaEvents.make { $0.newProjectName = .with { $0.name = name } }) }
                )
                .centraidType("body")
                .accessibilityLabel(state.chrome.tasks.newProjectPlaceholder)
                .accessibilityIdentifier("tasks-new-project-field")
            }
        }
        // NO IDENTIFIER ON THE WHOLE SCREEN: one set here replaces every
        // descendant's, and the flows tap `agenda-band-*`, `agenda-row-*`.
    }

    /// The state's four content branches as the kit's one read shape.
    private func readContent(
        _ state: Centraid_Screen_V1_AgendaHomeState
    ) -> ScreenContent<Centraid_Screen_V1_AgendaHomeData> {
        switch state.content {
        case .loading, .none: return .loading(true)
        case let .failure(failure): return .failed(failure)
        case let .denied(denied): return .denied(denied)
        case let .data(home): return .data(home)
        }
    }

    /// THE HEADER'S ONE ACTION (R-CHROME-1), per place: the Plus glyph, spoken
    /// as the state's `add_label` ("Add", "Add task" on To-do). What a
    /// tap sends is the state's flag: To-do opens the quick-add bar on the
    /// keyboard, every other place the add sheet. None on the gate, which can
    /// make nothing, and on To-do while the bar cannot be drawn.
    private func addAction(
        _ state: Centraid_Screen_V1_AgendaHomeState,
        denied: Bool
    ) -> RoomAction? {
        guard !state.addLabel.isEmpty, !denied else { return nil }
        if state.addOpensQuickAdd {
            guard state.quickAdd.shown else { return nil }
            return RoomAction(iconKey: "Plus", label: state.addLabel, identifier: "agenda-add-task") {
                send(AgendaEvents.make { $0.quickAddOpened = .init() })
            }
        }
        return RoomAction(iconKey: "Plus", label: state.addLabel, identifier: "agenda-new-event") {
            send(AgendaEvents.make { $0.newEvent = .init() })
        }
    }

    /// The machine's search flag and term, as the kit's field state.
    private func searchField(_ state: Centraid_Screen_V1_AgendaHomeState) -> Centraid_Screen_V1_SearchField {
        var field = Centraid_Screen_V1_SearchField()
        field.open = state.searchOpen
        field.term = state.searchTerm
        field.corrected = state.searchCorrected
        return field
    }

    /// The day-one empty's words and import door, as the kit's message.
    private func emptyState(_ home: Centraid_Screen_V1_AgendaHomeData) -> Centraid_Screen_V1_EmptyState {
        var empty = Centraid_Screen_V1_EmptyState()
        empty.headline = home.emptyTitle
        empty.body = home.emptyBody
        empty.actionLabel = home.emptyAction
        empty.importSource = home.importSource
        return empty
    }

    @ViewBuilder
    private func homeContent(
        _ home: Centraid_Screen_V1_AgendaHomeData,
        state: Centraid_Screen_V1_AgendaHomeState
    ) -> some View {
        if home.hasTodo {
            AgendaTodoList(home: home, state: state, send: send)
        } else if home.empty != .none, home.empty != .unspecified {
            if home.empty == .noMatch {
                // A SEARCH THAT FOUND NOTHING: the kit's one no-match state, with Ask (#1097).
                SearchEmptyView(emptyState(home), ask: state.searchAsk)
            } else {
                // WHERE THE PHONE HOLDS A CALENDAR, ITS IMPORT IS DAY ONE'S
                // ACTION (the kit's empty state draws it); "Add" stays in
                // the header.
                //
                // A DAY THAT HOLDS OVERDUE WORK OR THE ABSENCE NOTICE sends no
                // empty sentence, so it is drawn by the list above.
                EmptyStateView(emptyState(home), onAction: { send(AgendaEvents.make { $0.newEvent = .init() }) })
            }
        } else {
            AgendaList(home: home, chrome: state.chrome, send: send)
        }
    }

    /// READ from the state, WRITTEN as an event — a sheet the member swiped
    /// away tells the machine, and the machine is what closes it.
    private func sheetBinding(
        _ state: Centraid_Screen_V1_AgendaHomeState,
        _ sheet: Centraid_Screen_V1_AgendaHomeState.Sheet
    ) -> Binding<Bool> {
        Binding(
            get: { state.sheet == sheet },
            set: { open in
                guard !open, state.sheet == sheet else { return }
                send(AgendaEvents.make { $0.sheetClosed = .init() })
            }
        )
    }
}

/// Encoded `AgendaHomeEvent`s. Bytes, because the bridge takes Wire's type and
/// this side holds SwiftProtobuf's.
enum AgendaEvents {
    static func make(_ build: (inout Centraid_Screen_V1_AgendaHomeEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_AgendaHomeEvent()
        build(&event)
        return (try? event.serializedData()) ?? Data()
    }
}

// MARK: - Toolbar

/// The day bar: range label, ‹ ›, and Today — hidden when the state says the
/// anchor is already today.
private struct AgendaToolbarView: View {
    let toolbar: Centraid_Screen_V1_AgendaToolbar
    let chrome: Centraid_Screen_V1_AgendaChrome
    let send: (Data) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(toolbar.rangeLabel)
                .centraidType("title")
                .foregroundStyle(Theme.color("text", scheme))
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityAddTraits(.isHeader)
            HStack(spacing: 8) {
                KitStepper(
                    previousLabel: chrome.previousDay,
                    nextLabel: chrome.nextDay,
                    previousIdentifier: "agenda-previous-day",
                    nextIdentifier: "agenda-next-day",
                    onPrevious: { send(AgendaEvents.make { $0.dayStepped = .with { $0.days = -1 } }) },
                    onNext: { send(AgendaEvents.make { $0.dayStepped = .with { $0.days = 1 } }) }
                )
                if !toolbar.atToday {
                    KitLink(label: chrome.today, identifier: "agenda-today") {
                        send(AgendaEvents.make { $0.today = .init() })
                    }
                }
                Spacer(minLength: 0)
                Text(toolbar.monthLabel)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textFaint", scheme))
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
    }
}

// MARK: - The list

private struct AgendaList: View {
    let home: Centraid_Screen_V1_AgendaHomeData
    let chrome: Centraid_Screen_V1_AgendaChrome
    let send: (Data) -> Void
    /// The shell's import door, nil where it offers none (and inside an example).
    @Environment(\.importFromPhone) private var importFromPhone

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    // THE PROJECTS WHOSE NAME A SEARCH MATCHED come first (Q-1128-1), in a plain
                    // stack above the lazy one, as Notes and Docs draw theirs.
                    AgendaSearchContainers(containers: home.containers, send: send)
                    LazyVStack(alignment: .leading, spacing: 0) {
                        // NO EVENT OF THE MEMBER'S YET, only marks (due tasks,
                        // birthdays): the phone's calendar is offered quietly above
                        // them, at the point of use.
                        if !importLabel(home.importSource).isEmpty, let importFromPhone {
                            KitOutlineButton(label: importLabel(home.importSource)) {
                                importFromPhone(home.importSource)
                            }
                            .accessibilityIdentifier("agenda-import")
                            .padding(.horizontal, CentraidGeometry.pageMargin)
                            .padding(.vertical, 8)
                        }
                        AgendaLeadBlocks(home: home, chrome: chrome, send: send)
                        ForEach(home.days, id: \.day) { section in
                            AgendaSectionView(section: section, chrome: chrome, send: send)
                                .id(section.day)
                        }
                    }
                }
                .padding(.bottom, 16)
            }
            .refreshable { send(AgendaEvents.make { $0.refreshed = .init() }) }
            .onAppear { land(proxy) }
            .onChange(of: home.landing.day) { _, _ in land(proxy) }
        }
        .accessibilityIdentifier("agenda-list")
    }

    /// Where the state says to land — a day, or that day's now line — except
    /// that landing never scrolls PAST the blocks above the days (the notice,
    /// the Overdue group, a search's project containers and task hits): when
    /// the landing day is the first one drawn, the list stays at its top.
    private func land(_ proxy: ScrollViewProxy) {
        guard !home.landing.day.isEmpty else { return }
        let blocksAbove = home.hasNotice || home.hasOverdue || !home.taskHits.isEmpty || !home.containers.isEmpty
        if blocksAbove, home.landing.day == home.days.first?.day { return }
        let target = home.landing.nowLine ? "now-\(home.landing.day)" : home.landing.day
        proxy.scrollTo(target, anchor: .top)
    }
}

/// A SEARCH'S PROJECT CONTAINERS (Q-1128-1): the kit's one container row, each
/// tap `ProjectPicked` with the container's id — `AgendaRouting` opens the
/// project page, as it does for To-do's project row. Nothing without a term.
private struct AgendaSearchContainers: View {
    let containers: [Centraid_Screen_V1_SearchContainer]
    let send: (Data) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(containers, id: \.id) { container in
                SearchContainerRow(container: container) { _ in
                    send(AgendaEvents.make { $0.projectPicked = .with { $0.projectID = container.id } })
                }
            }
        }
    }
}

/// What leads the day list: the absence notice, then the Overdue group, then a
/// search's task hits — each only when the state sends it (R-1128-3, R-1128-4).
private struct AgendaLeadBlocks: View {
    let home: Centraid_Screen_V1_AgendaHomeData
    let chrome: Centraid_Screen_V1_AgendaChrome
    let send: (Data) -> Void

    var body: some View {
        if home.hasNotice {
            AgendaNoticeView(notice: home.notice, send: send)
        }
        if home.hasOverdue {
            AgendaTaskGroup(group: home.overdue, chrome: chrome, send: send)
        }
        ForEach(home.taskHits, id: \.key) { group in
            AgendaTaskGroup(group: group, chrome: chrome, send: send)
        }
    }
}

/// A task group drawn full width: the Overdue head (its verb sends `GroupVerb`)
/// and a search's task hits.
private struct AgendaTaskGroup: View {
    let group: Centraid_Screen_V1_TasksRowGroup
    let chrome: Centraid_Screen_V1_AgendaChrome
    let send: (Data) -> Void

    var body: some View {
        TasksGroupView(
            group: group,
            onVerb: { key in send(AgendaEvents.make { $0.groupVerb = .with { $0.key = key } }) },
            onCheck: { id in send(AgendaEvents.make { $0.taskChecked = .with { $0.taskID = id } }) },
            onPick: { id in send(AgendaEvents.make { $0.taskPicked = .with { $0.taskID = id } }) },
            fileVerb: chrome.tasks.fileVerb,
            onFile: { id in send(AgendaEvents.make { $0.fileRequested = .with { $0.taskID = id } }) },
            identifierPrefix: "agenda-task-row"
        )
    }
}

/// The absence notice: one sentence and at most one verb (`NoticeActed`).
private struct AgendaNoticeView: View {
    let notice: Centraid_Screen_V1_TasksNotice
    let send: (Data) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 8) {
            Text(notice.sentence)
                .centraidType("small")
                .foregroundStyle(Theme.color("textSoft", scheme))
                .frame(maxWidth: .infinity, alignment: .leading)
            if !notice.verbLabel.isEmpty {
                KitOutlineButton(label: notice.verbLabel) { send(AgendaEvents.make { $0.noticeActed = .init() }) }
                    .accessibilityIdentifier("agenda-notice-verb")
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
        .background(Theme.color("bgSunken", scheme))
    }
}

// MARK: - To-do

/// THE TO-DO PLACE: the Inbox's groups, then the projects by area, then the
/// new-project verb at the foot — whatever the list holds.
private struct AgendaTodoList: View {
    let home: Centraid_Screen_V1_AgendaHomeData
    let state: Centraid_Screen_V1_AgendaHomeState
    let send: (Data) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let todo = home.todo
        let chrome = state.chrome
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                TasksCountLine(count: todo.countLabel, window: todo.windowLabel)
                if !todo.empty.headline.isEmpty {
                    EmptyStateView(todo.empty, onAction: { send(AgendaEvents.make { $0.todoEmptyActed = .init() }) })
                }
                ForEach(todo.groups, id: \.key) { group in
                    AgendaTaskGroup(group: group, chrome: chrome, send: send)
                }
                ForEach(todo.projects, id: \.key) { group in
                    SectionHeader(title: group.title, count: UInt32(group.rows.count))
                    ForEach(group.rows, id: \.id) { row in
                        CentraidRow(
                            title: row.title,
                            meta: row.meta,
                            trailing: row.trailing,
                            trailingTone: StatusChipView.ink(row.trailingTone, neutral: "text"),
                            chips: row.chips,
                            hueKey: row.hueKey.isEmpty ? "" : (KitHue.role(row.hueKey) ?? "cSlate"),
                            dimmed: row.dimmed,
                            pending: row.pending,
                            accessibility: row.accessibilityLabel,
                            identifier: "agenda-project-\(row.id)"
                        ) { send(AgendaEvents.make { $0.projectPicked = .with { $0.projectID = row.id } }) }
                    }
                }
                ShowMoreFooter(visible: todo.canShowMore, label: chrome.tasks.showMore) {
                    send(AgendaEvents.make { $0.nextPage = .init() })
                }
                if !todo.newProjectLabel.isEmpty {
                    HStack {
                        KitLink(label: todo.newProjectLabel, identifier: "agenda-new-project") {
                            send(AgendaEvents.make { $0.sheetOpened = .with { $0.sheet = .newProject } })
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .padding(.top, 12)
                }
            }
            .padding(.bottom, 16)
        }
        .refreshable { send(AgendaEvents.make { $0.refreshed = .init() }) }
        .scrollDismissesKeyboard(.interactively)
        .accessibilityIdentifier("agenda-todo-list")
    }
}

private struct AgendaSectionView: View {
    let section: Centraid_Screen_V1_AgendaDaySection
    let chrome: Centraid_Screen_V1_AgendaChrome
    let send: (Data) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if section.hasMonthHeading {
                Text(section.monthHeading)
                    .centraidType("eyebrow")
                    .foregroundStyle(Theme.color("textFaint", scheme))
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .padding(.top, 24)
                    .padding(.bottom, 8)
                    .accessibilityAddTraits(.isHeader)
            }
            Rectangle()
                .fill(Theme.color("line", scheme))
                .frame(height: CentraidGeometry.hairline)
            HStack(alignment: .top, spacing: 8) {
                dateColumn
                VStack(alignment: .leading, spacing: 0) {
                    if section.hasRibbon {
                        ribbon
                    }
                    ForEach(Array(section.items.enumerated()), id: \.offset) { _, item in
                        switch item.kind {
                        case let .event(row):
                            AgendaEventRowView(row: row, day: section.day, send: send)
                        case let .task(row):
                            // A DATED TASK IS A ROW OF ITS DAY (R-1128-2): the
                            // round box checks it off in place, a tap opens it.
                            TasksRowView(
                                row: row,
                                onCheck: { id in send(AgendaEvents.make { $0.taskChecked = .with { $0.taskID = id } }) },
                                onPick: { id in send(AgendaEvents.make { $0.taskPicked = .with { $0.taskID = id } }) },
                                fileVerb: chrome.tasks.fileVerb,
                                onFile: { id in send(AgendaEvents.make { $0.fileRequested = .with { $0.taskID = id } }) },
                                embedded: true,
                                identifierPrefix: "agenda-task-row"
                            )
                        case let .nowLine(now):
                            AgendaNowLineView(now: now).id("now-\(section.day)")
                        case .none:
                            EmptyView()
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 8)
        }
    }

    private var dateColumn: some View {
        VStack(spacing: 0) {
            Text(section.dayNumber)
                .centraidType(section.isToday ? "title" : "smallStrong")
                .foregroundStyle(
                    Theme.color(
                        section.isToday ? "onAccent" : (section.isPast ? "textFaint" : "text"),
                        scheme
                    )
                )
                .padding(.horizontal, section.isToday ? 6 : 0)
                .background {
                    if section.isToday {
                        Capsule().fill(Theme.color("accent", scheme))
                    }
                }
            Text(section.weekdayShort)
                .centraidType("eyebrow")
                .foregroundStyle(Theme.color(section.isPast ? "textFaint" : "textSoft", scheme))
        }
        .frame(width: 44)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(section.heading)
        .accessibilityAddTraits(.isHeader)
    }

    private var ribbon: some View {
        Text(section.ribbon)
            .centraidType("annotLabel")
            .foregroundStyle(Theme.color("textSoft", scheme))
            .padding(.leading, 8)
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .leading) {
                Rectangle()
                    .stroke(Theme.color("line", scheme), style: StrokeStyle(lineWidth: 2, dash: [2, 3]))
                    .frame(width: 2)
            }
            .accessibilityIdentifier("agenda-ribbon-\(section.day)")
    }

}

private struct AgendaEventRowView: View {
    let row: Centraid_Screen_V1_AgendaEventRow
    /// The section's day the row is drawn under — the detail's read window.
    let day: String
    let send: (Data) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button {
            send(AgendaEvents.make {
                $0.eventPicked = .with {
                    $0.eventID = row.eventID
                    $0.instanceKey = row.instanceKey
                    if row.hasOriginalStartLocal { $0.originalStartLocal = row.originalStartLocal }
                    $0.day = day
                }
            })
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(row.timeLabel)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color(row.isPast ? "textFaint" : "textSoft", scheme))
                    .frame(width: 52, alignment: .leading)
                Text(row.title)
                    .centraidType("body")
                    .foregroundStyle(Theme.color(row.isPast ? "textFaint" : "text", scheme))
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if !row.statusLabel.isEmpty {
                    let tone = row.status == .cancelAsked ? "net" : "textSoft"
                    Text(row.statusLabel)
                        .centraidType("annotLabel")
                        .foregroundStyle(Theme.color(tone, scheme))
                        .padding(.horizontal, 6)
                        .overlay(
                            Capsule().strokeBorder(Theme.color(tone, scheme), lineWidth: CentraidGeometry.hairline)
                        )
                }
            }
            .padding(.leading, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
            .overlay(alignment: .leading) {
                Rectangle()
                    .fill(Theme.color(KitHue.role(row.calendarHueKey) ?? "cSlate", scheme))
                    .frame(width: 2)
                    .padding(.vertical, 6)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("agenda-row-\(row.rowKey)")
    }
}

private struct AgendaNowLineView: View {
    let now: Centraid_Screen_V1_AgendaNowLine
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 6) {
            Text(now.label)
                .centraidType("annotLabelOn")
                .foregroundStyle(Theme.color("net", scheme))
                .frame(width: 52, alignment: .leading)
            Circle().fill(Theme.color("net", scheme)).frame(width: 6, height: 6)
            Rectangle().fill(Theme.color("net", scheme)).frame(height: 1)
        }
        .padding(.leading, 10)
        .padding(.vertical, 2)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(now.accessibilityLabel)
        .accessibilityIdentifier("agenda-now-line")
    }
}

// MARK: - Sheets

private struct AgendaMoreSheet: View {
    let state: Centraid_Screen_V1_AgendaHomeState
    let send: (Data) -> Void
    @Environment(\.colorScheme) private var scheme

    /// A `SheetRoom` of `SheetRow`s — what `OptionSheet` draws — with the
    /// title carrying the sheet's id, so the rows keep their own. THE ROWS ARE
    /// THE MACHINE'S (`more_rows`), the same list Android draws: a calendar
    /// row is a toggle with its hue dot, and every tap sends the row's key.
    var body: some View {
        SheetRoom(title: state.chrome.moreTitle, titleIdentifier: "agenda-more-sheet") {
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(state.moreRows, id: \.key) { row in
                        if !row.section.isEmpty {
                            SectionHeader(title: row.section)
                        }
                        HStack(spacing: 8) {
                            if !row.hueKey.isEmpty {
                                Circle()
                                    .fill(Theme.color(KitHue.role(row.hueKey) ?? "cSlate", scheme))
                                    .frame(width: 8, height: 8)
                            }
                            SheetRow(
                                iconKey: row.iconKey,
                                label: row.label,
                                selected: row.toggle && row.on,
                                identifier: "agenda-more-\(row.key)"
                            ) {
                                send(AgendaEvents.make { $0.moreRow = .with { $0.key = row.key } })
                            }
                            .accessibilityLabel(row.spoken.isEmpty ? row.label : row.spoken)
                        }
                    }
                }
            }
        }
    }
}

private struct AgendaReadsSheet: View {
    let chrome: Centraid_Screen_V1_AgendaChrome

    var body: some View {
        SheetRoom(title: chrome.readsTitle, titleIdentifier: "agenda-reads-sheet") {
            VStack(spacing: 0) {
                ForEach(Array(chrome.readsFacts.enumerated()), id: \.offset) { _, fact in
                    FieldRow(key: fact.label, value: fact.detail)
                }
            }
        }
    }
}
