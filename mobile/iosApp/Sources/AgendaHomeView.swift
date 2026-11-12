import SwiftUI

/// Agenda's home screen, in SwiftUI (#1046 wave 3).
///
/// **THE VIEW DECIDES NOTHING.** Every word, flag, hue key and label drawn here
/// is on `AgendaHomeState`, which Rust makes (`crates/screens`, module
/// `agenda`); this file maps fields to geometry and taps to events. A string
/// literal below is a bug: the words come through the state's `chrome`. A row
/// that opens a page carries its `Route`, and a tap hands it to `open`.
///
/// The kit's page state draws the read (#1185): loading, failure, the gate, an empty list and data
/// under its note. The gate draws no band, because a gate with tabs under it would offer doors
/// the member cannot open.
///
/// **FIVE PLACES, ONE LIST EACH (#1128).** Day and Schedule draw a dated task as
/// a row of its day, its round box checking it off in place; To-do draws the
/// Inbox and then the projects, with the quick-add bar the Plus opens on the
/// keyboard. Which of those the data holds is the state's (`home.todo`), not a
/// branch on the destination.
struct AgendaHomeView: View {
    let state: Centraid_Core_V1_AgendaHomeState
    let send: (Centraid_Core_V1_AgendaHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onHome: () -> Void

    @Environment(\.colorScheme) private var scheme
    /// The quick add holds the keyboard: the band is put away while it does
    /// (as an editor's is, product-intuition/references/design-behaviour.md § Rooms), so the bar sits on the
    /// keyboard and not behind it, and a scroll or the Done key lets it go.
    @State private var quickAddTyping = false

    var body: some View {
        // The gate has no band, search or add.
        let denied = isDenied(state)
        // THE SHARED HEADER (Day, Week and Reminders) stands in the bar; Reminders keeps its title under it.
        let header = state.hasCalendarHeader && state.calendarHeader.shown ? state.calendarHeader : nil
        let eventCountText = eventCountLabel(state)
        AppPlace(
            app: state.appKey,
            title: header?.title.isEmpty == false ? header?.title ?? "" : state.chrome.title,
            trailing: addAction(state, denied: denied),
            // SEARCH IS THE BAND'S TRAILING KEY (R-CHROME-2); a tap opens the field
            // through Rust, at the foot. None on the gate, which has nothing to search.
            search: denied ? nil : SearchSlot(
                field: searchField(state),
                placeholder: state.chrome.searchPlaceholder,
                closeLabel: state.chrome.searchClose,
                onOpen: { send(AgendaEvents.make { $0.searchOpened = .init() }) },
                onTerm: { term in send(AgendaEvents.make { $0.searchTerm = .with { $0.term = term } }) },
                onClose: { send(AgendaEvents.make { $0.searchClosed = .init() }) }
            ),
            filter: filter,
            subtitle: toolbarSubtitle(state, eventCountText),
            bar: header.map { header in
                PlaceBar(
                    leading: AnyView(AgendaMonthChip(header: header, send: send)),
                    actions: AnyView(AgendaLayoutKey(header: header, send: send)),
                    showsTitle: !header.title.isEmpty
                )
            },
            showsBand: !denied && !state.band.isEmpty && !quickAddTyping
        ) {
            AppBand(
                app: state.appKey,
                tabs: state.band.map { tab in
                    BandView(
                        label: tab.label,
                        event: Data(tab.key.utf8),
                        iconKey: tab.iconKey,
                        selected: tab.current,
                        key: tab.key
                    )
                },
                onSelect: { picked in
                    let key = String(decoding: picked, as: UTF8.self)
                    send(AgendaEvents.make { $0.band = .with { $0.key = key } })
                },
                onHome: onHome
            )
        } content: {
            VStack(spacing: 0) {
                // ONE CONTROL ROW (#1173): the view menu, then ‹ › at the end. The period and its
                // event count are the header's subtitle, so nothing here repeats them.
                if !state.calendarViews.isEmpty {
                    AgendaViewMenu(
                        views: state.calendarViews,
                        label: state.calendarViewLabel,
                        month: monthGrid(state),
                        pick: { destination in
                            send(AgendaEvents.make { $0.destination = .with { $0.destination = destination } })
                        },
                        pickStyle: { style in
                            send(AgendaEvents.make { $0.monthStyle = .with { $0.style = style } })
                        },
                        trailing: state.toolbar.shown ? AnyView(
                            AgendaStepper(chrome: state.chrome, stepsPeriod: stepsPeriod(state), send: send)
                        ) : nil
                    )
                } else if state.toolbar.shown {
                    AgendaStepper(chrome: state.chrome, stepsPeriod: stepsPeriod(state), send: send)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                        .padding(.horizontal, CentraidGeometry.pageMargin)
                }
                Group {
                    PageReadStateView(
                        page: state.page,
                        loadingLabel: state.chrome.loading,
                        onRetry: { send(AgendaEvents.make { $0.refreshed = .init() }) },
                        onEmptyAction: offersImport(state) ? nil : { if state.hasNewEvent { open(state.newEvent) } },
                        emptyExtra: { AnyView(emptyUnder(state)) }
                    ) {
                        if case let .data(home)? = state.content {
                            homeContent(home, state: state)
                        }
                    }
                }
                // THE FLOATING TODAY KEY, bottom-leading above the band, while the anchor is not today.
                .overlay(alignment: .bottomLeading) {
                    if let header {
                        if header.todayShown, !denied {
                            AgendaTodayButton(label: header.todayLabel, send: send)
                        }
                    } else if state.toolbar.shown, !state.toolbar.atToday, !denied {
                        AgendaTodayButton(label: state.chrome.today, send: send)
                    }
                }
                StatusLineView(status: state.status, identifier: "agenda-status-action") {
                    send(AgendaEvents.make { $0.statusActed = .init() })
                }
                if !denied {
                    TodoQuickAddBar(
                        quickAdd: state.quickAdd,
                        placeholder: state.chrome.tasks.quickAddPlaceholder,
                        verb: state.chrome.tasks.quickAddVerb,
                        onChange: { title in send(AgendaEvents.make { $0.quickAddChanged = .with { $0.title = title } }) },
                        onSubmit: { send(AgendaEvents.make { $0.quickAddSubmitted = .init() }) },
                        onDismissChip: { send(AgendaEvents.make { $0.quickAddChipDismissed = .init() }) },
                        onFocusChange: { typing in
                            quickAddTyping = typing
                            // THE KEYBOARD LEFT: Rust puts an empty bar away.
                            if !typing { send(AgendaEvents.make { $0.quickAddClosed = .init() }) }
                        },
                        fieldIdentifier: "agenda-quick-add",
                        verbIdentifier: "agenda-quick-add-verb",
                        // THE KEYBOARD TOOLBAR (#1173).
                        onTool: { key in send(AgendaEvents.make { $0.quickTool = .with { $0.key = key } }) },
                        onDue: { key in send(AgendaEvents.make { $0.quickDue = .with { $0.key = key } }) },
                        onTag: { text in send(AgendaEvents.make { $0.quickTag = .with { $0.text = text } }) },
                        onLink: { link in send(AgendaEvents.make { $0.quickLink = link }) },
                        onStagedRemove: { key in send(AgendaEvents.make { $0.quickStagedRemoved = .with { $0.key = key } }) }
                    )
                }
            }
        }
        .sheet(isPresented: sheetBinding(state, .more)) {
            AgendaMoreSheet(state: state, send: send, open: open)
        }
        .sheet(isPresented: sheetBinding(state, .reads)) {
            AgendaReadsSheet(chrome: state.chrome)
        }
        // THE REMINDERS IMPORT (iOS): the option and the verb, opened from More. The verb asks the
        // one import (`imports.made`) to read the phone's Reminders; its outcome is the import line's.
        .sheet(isPresented: sheetBinding(state, .importReminders)) {
            AgendaImportRemindersSheet(
                sheet: state.importReminders,
                onToggle: { send(AgendaEvents.make { $0.importRemindersCompleted = .init() }) },
                onImport: { send(AgendaEvents.make { $0.importRemindersSubmitted = .init() }) }
            )
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
        // THE STYLE SHEET, one for the new list, the new calendar and an edited calendar.
        .sheet(isPresented: Binding(
            get: { [.newProject, .newCalendar, .editCalendar].contains(state.sheet) },
            set: { open in
                if !open, [.newProject, .newCalendar, .editCalendar].contains(state.sheet) {
                    send(AgendaEvents.make { $0.sheetClosed = .init() })
                }
            }
        )) {
            AgendaStyleSheetView(
                style: state.style,
                appKey: state.appKey,
                onName: { name in send(AgendaEvents.make { $0.styleName = .with { $0.name = name } }) },
                onColor: { key in send(AgendaEvents.make { $0.styleColor = .with { $0.key = key } }) },
                onIcon: { key in send(AgendaEvents.make { $0.styleIcon = .with { $0.key = key } }) },
                onSubmit: { send(AgendaEvents.make { $0.styleSubmitted = .init() }) },
                onCancel: { send(AgendaEvents.make { $0.sheetClosed = .init() }) },
                onTrash: { send(AgendaEvents.make { $0.styleTrashed = .init() }) }
            )
        }
        // THE STOP CONFIRM (#1185): the kit's sheet in Rust's own sentences, the same as Health's and People's.
        .sheet(isPresented: Binding(
            get: { state.hasStop },
            set: { shown in
                guard !shown, state.hasStop else { return }
                send(AgendaEvents.make { $0.stopDismissed = .init() })
            }
        )) {
            ConfirmSheet(
                state.stop,
                onConfirm: { send(AgendaEvents.make { $0.stopConfirmed = .init() }) },
                onDismiss: { send(AgendaEvents.make { $0.stopDismissed = .init() }) }
            )
        }
        // THE SHEETS WEAR AGENDA'S BLUE (the boards' Create, Save and Import reminders): the accent
        // is set on the screen that presents them, so a sheet's ink button no longer falls back to
        // the shell's teal.
        .environment(\.appAccent, AppAccent(state.appKey))
        // NO IDENTIFIER ON THE WHOLE SCREEN: one set here replaces every
        // descendant's, and the flows tap `agenda-band-*`, `agenda-row-*`.
    }

    /// THE REMINDERS "FILTER AND SORT" FUNNEL (`Main.dc.html`): Rust's menu, drawn only when it is
    /// on the state (the Reminders place). A pick or the clear row is an event.
    private var filter: FilterSlot? {
        guard state.hasFilterMenu else { return nil }
        return FilterSlot(
            menu: state.filterMenu,
            onPick: { section, option in
                send(AgendaEvents.make {
                    $0.filterMenuPicked = .with {
                        $0.sectionKey = section
                        $0.optionKey = option
                    }
                })
            },
            onClear: { send(AgendaEvents.make { $0.filterMenuCleared = .init() }) }
        )
    }

    /// The vault refused Agenda: the page's gate.
    private func isDenied(_ state: Centraid_Core_V1_AgendaHomeState) -> Bool {
        if case .refused? = state.page.state { return true }
        return false
    }

    /// Whether the empty page offers the phone's calendar import, which Rust names on the empty state.
    private func offersImport(_ state: Centraid_Core_V1_AgendaHomeState) -> Bool {
        if case let .empty(empty)? = state.page.state { return empty.importSource == .calendar }
        return false
    }

    /// WHAT THE EMPTY PAGE DRAWS UNDER ITS WORDS: where the phone holds a calendar, its import is day one's
    /// action (sent to Rust as `ImportRequested`; "Add" stays in the header), and a search that found
    /// nothing gets the Ask row.
    @ViewBuilder
    private func emptyUnder(_ state: Centraid_Core_V1_AgendaHomeState) -> some View {
        if offersImport(state) {
            CalendarImportButton(label: state.importLabel, identifier: "kit-empty-import", send: send)
        }
        if state.hasSearchAskRow { SearchAskRow(ask: state.searchAskRow) }
    }

    /// THE HEADER'S SUBTITLE (HeaderSubtitle): the period, then how many events it holds.
    private func toolbarSubtitle(_ state: Centraid_Core_V1_AgendaHomeState, _ count: String) -> SubtitleSlot? {
        guard state.toolbar.shown else { return nil }
        let words = [state.toolbar.rangeLabel, count].filter { !$0.isEmpty }.joined(separator: " \u{00B7} ")
        return SubtitleSlot(subtitle: .with { $0.label = words; $0.spoken = words })
    }

    /// THE APP BAR'S WORDS FOR THE EVENTS DRAWN ("3 events"): Rust's `event_count_label`, which
    /// the data arm carries and the toolbar above it does not, so it is read here and handed
    /// down. Empty on every other branch, and while the data holds no events.
    private func eventCountLabel(_ state: Centraid_Core_V1_AgendaHomeState) -> String {
        if case let .data(home)? = state.content { return home.eventCountLabel }
        return ""
    }

    /// THE HEADER'S ONE ACTION (R-CHROME-1), per place: the Plus glyph, spoken
    /// as the state's `add_label` ("Add", "Add task" on To-do). What a
    /// tap sends is the state's flag: To-do opens the quick-add bar on the
    /// keyboard, every other place the add sheet. None on the gate, which can
    /// make nothing, and on To-do while the bar cannot be drawn.
    private func addAction(
        _ state: Centraid_Core_V1_AgendaHomeState,
        denied: Bool
    ) -> RoomAction? {
        guard !state.addLabel.isEmpty, !denied else { return nil }
        if state.addOpensQuickAdd {
            guard state.quickAdd.shown else { return nil }
            return RoomAction(iconKey: "Plus", label: state.addLabel, identifier: "agenda-add-task") {
                send(AgendaEvents.make { $0.quickAddOpened = .init() })
            }
        }
        // THE ADD SHEET is a page: the state carries its route (absent while denied).
        guard state.hasNewEvent else { return nil }
        return RoomAction(iconKey: "Plus", label: state.addLabel, identifier: "agenda-new-event") {
            open(state.newEvent)
        }
    }

    /// Rust's search flag and term, as the kit's field state.
    private func searchField(_ state: Centraid_Core_V1_AgendaHomeState) -> KitSearchField {
        var field = KitSearchField()
        field.open = state.searchOpen
        field.term = state.searchTerm
        field.corrected = state.searchCorrected
        // Rust's `search_corrected` is the finished sentence, so the field says it as it is.
        field.correctedLabel = state.searchCorrected
        return field
    }

    /// The Month the data holds, for the view menu's second group (Grid and List).
    private func monthGrid(_ state: Centraid_Core_V1_AgendaHomeState) -> Centraid_Core_V1_AgendaMonthGrid? {
        if case let .data(home)? = state.content, home.hasMonth { return home.month }
        return nil
    }

    /// MONTH AND YEAR STEP BY THEIR OWN PERIOD (`PeriodStepped`); the lists by days. Day and Week
    /// have no day bar: they page by swipe.
    private func stepsPeriod(_ state: Centraid_Core_V1_AgendaHomeState) -> Bool {
        switch state.calendarViews.first(where: { $0.current })?.destination {
        case .month?, .year?: return true
        default: return false
        }
    }

    @ViewBuilder
    private func homeContent(
        _ home: Centraid_Core_V1_AgendaHomeData,
        state: Centraid_Core_V1_AgendaHomeState
    ) -> some View {
        if home.hasTodo {
            AgendaTodoList(home: home, state: state, send: send, open: open)
        } else if home.hasTimeGrid {
            // DAY AND WEEK: the hour grid, under the week strip on Day.
            AgendaTimeGridView(home: home, header: state.calendarHeader, send: send, open: open)
        } else if home.hasMonth {
            AgendaMonthView(home: home, chrome: state.chrome, send: send, open: open)
        } else if home.hasYear {
            AgendaYearView(year: home.year, send: send)
        } else {
            AgendaList(
                home: home,
                chrome: state.chrome,
                ask: state.hasSearchAskRow ? state.searchAskRow : nil,
                send: send,
                open: open
            )
        }
    }

    /// READ from the state, WRITTEN as an event — a sheet the member swiped
    /// away tells Rust, and Rust is what closes it.
    private func sheetBinding(
        _ state: Centraid_Core_V1_AgendaHomeState,
        _ sheet: Centraid_Core_V1_AgendaHomeState.Sheet
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

/// `AgendaHomeEvent`s, built.
enum AgendaEvents {
    static func make(_ build: (inout Centraid_Core_V1_AgendaHomeEvent) -> Void) -> Centraid_Core_V1_AgendaHomeEvent {
        var event = Centraid_Core_V1_AgendaHomeEvent()
        build(&event)
        return event
    }
}

/// THE PHONE CALENDAR'S IMPORT: the verb is the app's, the tap is Rust's
/// (`ImportRequested`; Rust asks this shell to read the calendar through the
/// `CalendarRead` effect).
private struct CalendarImportButton: View {
    /// Rust's words (`import_label`, "Import calendar").
    let label: String
    let identifier: String
    let send: (Centraid_Core_V1_AgendaHomeEvent) -> Void

    var body: some View {
        KitOutlineButton(label: label) {
            send(AgendaEvents.make { $0.importRequested = .init() })
        }
        .accessibilityIdentifier(identifier)
        .padding(.top, 4)
    }
}

// MARK: - Toolbar

/// The ‹ › of Month, Year and the lists, stepping a period or a day. Today is the floating key
/// (`AgendaTodayButton`); the range and the count are the header's subtitle.
private struct AgendaStepper: View {
    let chrome: Centraid_Core_V1_AgendaChrome
    /// Week, Month and Year step a whole period (`PeriodStepped`); the rest step a day.
    let stepsPeriod: Bool
    let send: (Centraid_Core_V1_AgendaHomeEvent) -> Void

    var body: some View {
        KitStepper(
            previousLabel: chrome.previousDay,
            nextLabel: chrome.nextDay,
            previousIdentifier: "agenda-previous-day",
            nextIdentifier: "agenda-next-day",
            onPrevious: { step(-1) },
            onNext: { step(1) }
        )
    }

    private func step(_ by: Int32) {
        if stepsPeriod {
            send(AgendaEvents.make { $0.periodStepped = .with { $0.by = by } })
        } else {
            send(AgendaEvents.make { $0.dayStepped = .with { $0.days = by } })
        }
    }
}

// MARK: - The list

private struct AgendaList: View {
    let home: Centraid_Core_V1_AgendaHomeData
    let chrome: Centraid_Core_V1_AgendaChrome
    /// The search's Ask row, closing the answer (#1135); nil off a search.
    let ask: Centraid_Core_V1_SearchAsk?
    let send: (Centraid_Core_V1_AgendaHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void

    var body: some View {
        ScrollViewReader { proxy in
            // A LIST, so a task row can be swiped (#1173): each task is a row of its own, the
            // events and the day heads plain rows beside them.
            List {
                Group {
                    // THE PROJECTS WHOSE NAME A SEARCH MATCHED come first (Q-1128-1), as Notes
                    // and Docs draw theirs.
                    AgendaSearchContainers(containers: home.containers, open: open)
                    // NO EVENT OF THE MEMBER'S YET, only marks (due tasks, birthdays): the
                    // phone's calendar is offered quietly above them, at the point of use.
                    if home.importSource == .calendar {
                        CalendarImportButton(label: home.importLabel, identifier: "agenda-import", send: send)
                            .padding(.horizontal, CentraidGeometry.pageMargin)
                            .padding(.vertical, 8)
                    }
                }
                .todoPlainRow()
                AgendaLeadBlocks(home: home, chrome: chrome, send: send, open: open)
                ForEach(home.days, id: \.day) { section in
                    AgendaSectionView(section: section, chrome: chrome, send: send, open: open, inList: true)
                }
                Group {
                    if let ask { SearchAskRow(ask: ask) }
                    Color.clear.frame(height: 16)
                }
                .todoPlainRow()
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, 0)
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
/// tap pushing the container's `route` — the project page To-do's project row
/// opens. Nothing without a term.
private struct AgendaSearchContainers: View {
    let containers: [Centraid_Core_V1_SearchContainer]
    let open: (Centraid_Core_V1_Route) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(containers, id: \.id) { container in
                SearchContainerRow(container: container) { _ in open(container.route) }
            }
        }
    }
}

/// What leads the day list: the absence notice, then the Overdue group, then a
/// search's task hits — each only when the state sends it (R-1128-3, R-1128-4).
private struct AgendaLeadBlocks: View {
    let home: Centraid_Core_V1_AgendaHomeData
    let chrome: Centraid_Core_V1_AgendaChrome
    let send: (Centraid_Core_V1_AgendaHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void

    var body: some View {
        // THE NOTICE'S VERB AND THE OVERDUE GROUP'S push Catch up, whose route the data carries.
        if home.hasNotice {
            AgendaNoticeView(notice: home.notice) { if home.hasCatchUp { open(home.catchUp) } }
                .todoPlainRow()
        }
        if home.hasOverdue {
            AgendaTaskGroup(group: home.overdue, chrome: chrome, send: send, open: open, catchUp: home.hasCatchUp ? home.catchUp : nil, inList: true)
        }
        ForEach(home.taskHits, id: \.key) { group in
            AgendaTaskGroup(group: group, chrome: chrome, send: send, open: open, catchUp: nil, inList: true)
        }
    }
}

/// A task group drawn full width: the Overdue head (its verb pushes `catchUp`)
/// and a search's task hits.
private struct AgendaTaskGroup: View {
    let group: Centraid_Core_V1_TodoRowGroup
    let chrome: Centraid_Core_V1_AgendaChrome
    let send: (Centraid_Core_V1_AgendaHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let catchUp: Centraid_Core_V1_Route?
    /// Drawn as rows of a `List`, so a swipe lands on one task.
    var inList = false

    var body: some View {
        TodoGroupView(
            group: group,
            onVerb: { _ in if let catchUp { open(catchUp) } },
            onCheck: { id in send(AgendaEvents.make { $0.taskChecked = .with { $0.taskID = id } }) },
            onPick: open,
            fileVerb: chrome.tasks.fileVerb,
            onFile: { id in send(AgendaEvents.make { $0.fileRequested = .with { $0.taskID = id } }) },
            identifierPrefix: "agenda-task-row",
            chrome: chrome.tasks,
            onFlag: { id, on in send(AgendaEvents.make { $0.taskFlagged = .with { $0.taskID = id; $0.flagged = on } }) },
            onDelete: { id in send(AgendaEvents.make { $0.taskDeleted = .with { $0.taskID = id } }) },
            inList: inList
        )
    }
}

/// The absence notice: one sentence and at most one verb (pushing Catch up).
private struct AgendaNoticeView: View {
    let notice: Centraid_Core_V1_TodoNotice
    let onVerb: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 8) {
            Text(notice.sentence)
                .centraidType("small")
                .foregroundStyle(Theme.color("textSoft", scheme))
                .frame(maxWidth: .infinity, alignment: .leading)
            if !notice.verbLabel.isEmpty {
                KitOutlineButton(label: notice.verbLabel, action: onVerb)
                    .accessibilityIdentifier("agenda-notice-verb")
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
        .background(Theme.color("bgSunken", scheme))
    }
}

// MARK: - To-do

/// REMINDERS' HOME: the smart-list cards, then My Lists (the Inbox first, then the lists by
/// area), then the new-list verb at the foot. No task is drawn here: a task is opened from its list.
private struct AgendaTodoList: View {
    let home: Centraid_Core_V1_AgendaHomeData
    let state: Centraid_Core_V1_AgendaHomeState
    let send: (Centraid_Core_V1_AgendaHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let todo = home.todo
        let chrome = state.chrome
        // A LIST, so a task row can be swiped (#1173): each task is a row of its own.
        List {
            Group {
                // THE REMINDERS HOME (#1173): the smart-list cards, then My Lists.
                AgendaSmartListGrid(lists: todo.smartLists, open: open)
                if !todo.countLabel.isEmpty || !todo.windowLabel.isEmpty {
                    TodoCountLine(count: todo.countLabel, window: todo.windowLabel)
                }
                if !todo.empty.headline.isEmpty {
                    EmptyStateView(todo.empty, onAction: { send(AgendaEvents.make { $0.todoEmptyActed = .init() }) })
                }
            }
            .todoPlainRow()
            ForEach(todo.groups, id: \.key) { group in
                AgendaTaskGroup(group: group, chrome: chrome, send: send, open: open, catchUp: nil, inList: true)
            }
            Group {
                if !todo.myListsTitle.isEmpty, !todo.projects.isEmpty {
                    Text(todo.myListsTitle)
                        .kitType(.section)
                        .foregroundStyle(Theme.color("text", scheme))
                        .padding(.horizontal, CentraidGeometry.pageMargin)
                        .padding(.top, 12)
                        .accessibilityAddTraits(.isHeader)
                }
                ForEach(todo.projects, id: \.key) { group in
                    if !group.title.isEmpty {
                        SectionHeader(title: group.title, count: UInt32(group.rows.count))
                    }
                    ForEach(group.rows, id: \.row.id) { project in
                        let row = project.row
                        Button { open(project.route) } label: {
                            HStack(spacing: 12) {
                                AgendaListMark(
                                    colorKey: project.listColorKey,
                                    iconKey: project.iconKey,
                                    fallback: Theme.color("textFaint", scheme)
                                )
                                Text(row.title)
                                    .centraidType("body")
                                    .foregroundStyle(Theme.color("text", scheme))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                Text(project.count)
                                    .centraidType("body")
                                    .foregroundStyle(Theme.color("textSoft", scheme))
                            }
                            .padding(.horizontal, CentraidGeometry.pageMargin)
                            .frame(minHeight: CentraidGeometry.targetMinCoarse)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(KitRowPress())
                        .accessibilityLabel(row.accessibilityLabel)
                        .accessibilityIdentifier("agenda-project-\(row.id)")
                    }
                }
                if todo.canShowMore {
                    ShowMoreFooter(visible: todo.canShowMore, label: chrome.tasks.showMore) {
                        send(AgendaEvents.make { $0.nextPage = .init() })
                    }
                }
                if !todo.newProjectLabel.isEmpty {
                    HStack {
                        KitLink(label: todo.addListLabel.isEmpty ? todo.newProjectLabel : todo.addListLabel, identifier: "agenda-new-project") {
                            send(AgendaEvents.make { $0.sheetOpened = .with { $0.sheet = .newProject } })
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .padding(.top, 12)
                }
            }
            .todoPlainRow()
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .environment(\.defaultMinListRowHeight, 0)
        .refreshable { send(AgendaEvents.make { $0.refreshed = .init() }) }
        .scrollDismissesKeyboard(.interactively)
        .accessibilityIdentifier("agenda-todo-list")
    }
}

struct AgendaSectionView: View {
    let section: Centraid_Core_V1_AgendaDaySection
    let chrome: Centraid_Core_V1_AgendaChrome
    let send: (Centraid_Core_V1_AgendaHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    /// Drawn as rows of a `List` (Agenda's Day and Schedule), so a swipe lands on one task; the
    /// Month's list below its grid keeps the stack.
    var inList = false
    @Environment(\.colorScheme) private var scheme

    /// The date column's width and the gap to the rows beside it.
    private static let dateWidth: CGFloat = 44
    private static let dateGap: CGFloat = 8

    var body: some View {
        if inList {
            listRows
        } else {
            stack
        }
    }

    /// THE SECTION AS LIST ROWS: the head (month heading and rule, the section's id), the ribbon,
    /// then each item its own row. The date column is drawn by the section's first row, in the gutter
    /// every row keeps, so it still stands beside the items and a swipe moves one row only.
    @ViewBuilder
    private var listRows: some View {
        let margin = CentraidGeometry.pageMargin
        let gutter = Self.dateWidth + Self.dateGap
        VStack(alignment: .leading, spacing: 0) {
            if section.hasMonthHeading {
                Text(section.monthHeading)
                    .centraidType("eyebrow")
                    .foregroundStyle(Theme.color("textFaint", scheme))
                    .padding(.horizontal, margin)
                    .padding(.top, 24)
                    .padding(.bottom, 8)
                    .accessibilityAddTraits(.isHeader)
            }
            Rectangle()
                .fill(Surface.line)
                .frame(height: CentraidGeometry.hairline)
        }
        .id(section.day)
        .todoPlainRow()
        if section.hasRibbon {
            ribbon
                .padding(.leading, gutter)
                .overlay(alignment: .topLeading) { dateColumn.padding(.top, 8) }
                .padding(.horizontal, margin)
                .padding(.top, 8)
                .todoPlainRow()
        }
        if section.items.isEmpty && !section.hasRibbon {
            // A day with nothing on it still shows its date.
            Color.clear
                .frame(height: Self.dateWidth)
                .padding(.leading, gutter)
                .overlay(alignment: .topLeading) { dateColumn }
                .padding(.horizontal, margin)
                .padding(.vertical, 8)
                .todoPlainRow()
        }
        ForEach(Array(section.items.enumerated()), id: \.offset) { index, item in
            let lead: AnyView? = index == 0 && !section.hasRibbon ? AnyView(dateColumn) : nil
            switch item.kind {
            case let .event(row):
                AgendaEventRowView(row: row, open: open)
                    .padding(.leading, gutter)
                    .overlay(alignment: .topLeading) { if let lead { lead.padding(.top, 8) } }
                    .padding(.horizontal, margin)
                    .todoPlainRow()
            case let .task(row):
                // A DATED TASK IS A ROW OF ITS DAY (R-1128-2): the round box checks it off in
                // place, a tap opens it, a swipe flags or deletes it.
                taskRow(row, gutter: gutter, lead: lead)
                    .listRowInsets(EdgeInsets(top: 0, leading: margin, bottom: 0, trailing: margin))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            case let .nowLine(now):
                AgendaNowLineView(now: now)
                    .id("now-\(section.day)")
                    .padding(.leading, gutter)
                    .overlay(alignment: .topLeading) { if let lead { lead.padding(.top, 8) } }
                    .padding(.horizontal, margin)
                    .todoPlainRow()
            case .none:
                EmptyView()
            }
        }
    }

    private func taskRow(_ row: Centraid_Core_V1_TodoRow, gutter: CGFloat, lead: AnyView?) -> some View {
        TodoRowView(
            row: row,
            onCheck: { id in send(AgendaEvents.make { $0.taskChecked = .with { $0.taskID = id } }) },
            onPick: open,
            fileVerb: chrome.tasks.fileVerb,
            onFile: { id in send(AgendaEvents.make { $0.fileRequested = .with { $0.taskID = id } }) },
            embedded: true,
            identifierPrefix: "agenda-task-row",
            chrome: chrome.tasks,
            onFlag: { id, on in send(AgendaEvents.make { $0.taskFlagged = .with { $0.taskID = id; $0.flagged = on } }) },
            onDelete: { id in send(AgendaEvents.make { $0.taskDeleted = .with { $0.taskID = id } }) },
            gutter: gutter,
            gutterContent: lead
        )
    }

    private var stack: some View {
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
                .fill(Surface.line)
                .frame(height: CentraidGeometry.hairline)
            HStack(alignment: .top, spacing: Self.dateGap) {
                dateColumn
                VStack(alignment: .leading, spacing: 0) {
                    if section.hasRibbon {
                        ribbon
                    }
                    ForEach(Array(section.items.enumerated()), id: \.offset) { _, item in
                        switch item.kind {
                        case let .event(row):
                            AgendaEventRowView(row: row, open: open)
                        case let .task(row):
                            // A DATED TASK IS A ROW OF ITS DAY (R-1128-2): the
                            // round box checks it off in place, a tap opens it.
                            TodoRowView(
                                row: row,
                                onCheck: { id in send(AgendaEvents.make { $0.taskChecked = .with { $0.taskID = id } }) },
                                onPick: open,
                                fileVerb: chrome.tasks.fileVerb,
                                onFile: { id in send(AgendaEvents.make { $0.fileRequested = .with { $0.taskID = id } }) },
                                embedded: true,
                                identifierPrefix: "agenda-task-row",
                                chrome: chrome.tasks,
                                onFlag: { id, on in send(AgendaEvents.make { $0.taskFlagged = .with { $0.taskID = id; $0.flagged = on } }) },
                                onDelete: { id in send(AgendaEvents.make { $0.taskDeleted = .with { $0.taskID = id } }) }
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
        .frame(width: Self.dateWidth)
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
    let row: Centraid_Core_V1_AgendaEventRow
    let open: (Centraid_Core_V1_Route) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        // THE ROW CARRIES ITS PAGE: this occurrence, drawn under the section's day.
        Button {
            open(row.route)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(row.timeLabel)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color(row.isPast ? "textFaint" : "textSoft", scheme))
                    .frame(width: 52, alignment: .leading)
                VStack(alignment: .leading, spacing: 0) {
                    Text(row.title)
                        .centraidType("body")
                        .foregroundStyle(Theme.color(row.isPast ? "textFaint" : "text", scheme))
                        .lineLimit(2)
                    // A search hit whose words only an earlier version of the event held
                    // (#1185): the row says so and opens Earlier versions.
                    if !row.earlierLabel.isEmpty {
                        Text(row.earlierLabel)
                            .centraidType("annotLabel")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if !row.statusLabel.isEmpty {
                    let tone = "textSoft"
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
                    .fill(agendaHue(row.calendarHueKey, scheme))
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
    let now: Centraid_Core_V1_AgendaNowLine
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
    let state: Centraid_Core_V1_AgendaHomeState
    let send: (Centraid_Core_V1_AgendaHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    @Environment(\.colorScheme) private var scheme

    /// A calendar row that wears a list colour draws its icon in the leading mark, so the
    /// row itself names no icon; every other row keeps the icon the core sent.
    private func sheetIcon(of row: Centraid_Core_V1_AgendaMoreRow) -> String {
        row.colorKey.isEmpty ? row.iconKey : String()
    }

    /// A `SheetRoom` of `SheetRow`s — what `OptionSheet` draws — with the
    /// title carrying the sheet's id, so the rows keep their own. THE ROWS ARE
    /// RUST'S (`more_rows`), the same list Android draws: a calendar row is a
    /// toggle with its hue dot, and every tap sends the row's key; a place's
    /// row then pushes its `route`.
    var body: some View {
        SheetRoom(title: state.chrome.moreTitle, titleIdentifier: "agenda-more-sheet", fit: true) {
            VStack(spacing: 0) {
                ForEach(state.moreRows, id: \.key) { row in
                    if !row.section.isEmpty {
                        SectionHeader(title: row.section)
                    }
                    HStack(spacing: 8) {
                        // A CALENDAR WEARS THE ONE LIST PALETTE and its own icon; an events
                        // calendar with no list colour keeps its hue dot.
                        if !row.colorKey.isEmpty {
                            AgendaListMark(colorKey: row.colorKey, iconKey: row.iconKey)
                                .padding(.leading, 12)
                        } else if !row.hueKey.isEmpty {
                            Circle()
                                .fill(agendaHue(row.hueKey, scheme))
                                .frame(width: 8, height: 8)
                        }
                        SheetRow(
                            iconKey: sheetIcon(of: row),
                            label: row.label,
                            detail: row.toggle ? "" : row.meta,
                            selected: row.toggle && row.on,
                            identifier: "agenda-more-\(row.key)"
                        ) {
                            send(AgendaEvents.make { $0.moreRow = .with { $0.key = row.key } })
                            if row.hasRoute { open(row.route) }
                        }
                        .accessibilityLabel(row.spoken.isEmpty ? row.label : row.spoken)
                        // A CALENDAR'S EDIT CONTROL (rename, colour, icon): icon-only, so it is labelled.
                        if !row.editLabel.isEmpty {
                            let calendarID = String(row.key.dropFirst("calendar-".count))
                            Button {
                                send(AgendaEvents.make { $0.calendarEdit = .with { $0.calendarID = calendarID } })
                            } label: {
                                CentraidIconView(iconKey: "Pencil", tint: Theme.color("textSoft", scheme), size: 18)
                                    .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(row.editLabel)
                            .accessibilityIdentifier("agenda-calendar-edit-\(calendarID)")
                        }
                    }
                }
            }
            .sheetRowGroup()
        }
    }
}

/// THE IMPORT REMINDERS SHEET: one switch ("Include completed reminders", off until turned on) and
/// the one verb. Both words are Rust's (`ImportsMadeState`'s); the switch's state is the core's and a
/// flip is an event; the verb is `SheetRoom`'s one ink button.
private struct AgendaImportRemindersSheet: View {
    let sheet: Centraid_Core_V1_AgendaImportRemindersSheet
    let onToggle: () -> Void
    let onImport: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        SheetRoom(
            title: sheet.title,
            primary: SheetPrimary(
                label: sheet.importLabel,
                identifier: "agenda-import-reminders-go",
                action: onImport
            ),
            titleIdentifier: "agenda-import-reminders-sheet"
        ) {
            Toggle(isOn: Binding(
                get: { sheet.completedOn },
                set: { _ in onToggle() }
            )) {
                Text(sheet.completedLabel)
                    .centraidType("body")
                    .foregroundStyle(Theme.color("text", scheme))
            }
            .kitToggle()
            // THE BOARD'S CARD ROW: the switch sits on a plate of its own.
            .padding(.horizontal, 16)
            .frame(minHeight: CentraidGeometry.targetMinCoarse)
            .sheetCardGround()
            .accessibilityIdentifier("agenda-import-reminders-completed")
        }
        // THE BOARD'S COMPACT SHEET: title, the switch and the verb, no more.
        .presentationDetents([.height(230)])
    }
}

private struct AgendaReadsSheet: View {
    let chrome: Centraid_Core_V1_AgendaChrome

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
