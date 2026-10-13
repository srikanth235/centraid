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
struct AgendaHomeView: View {
    let data: Data
    let send: (Data) -> Void
    let onHome: () -> Void

    @Environment(\.colorScheme) private var scheme
    /// The shell's import door, nil where it offers none (and inside an example).
    @Environment(\.importFromPhone) private var importFromPhone

    private var state: Centraid_Screen_V1_AgendaHomeState {
        (try? Centraid_Screen_V1_AgendaHomeState(serializedBytes: data)) ?? .init()
    }

    var body: some View {
        let state = state
        let content = readContent(state)
        AppPlace(
            app: "agenda",
            title: state.chrome.title,
            trailing: newEventAction(state, denied: content.isDenied),
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
            showsBand: !content.isDenied && !state.band.isEmpty
        ) {
            AppBand(
                app: "agenda",
                tabs: state.band.map { tab in
                    BandView(
                        label: tab.label,
                        event: AgendaEvents.make { $0.band = .with { $0.key = tab.key } },
                        iconKey: tab.iconKey,
                        selected: tab.current
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
            }
        }
        .sheet(isPresented: sheetBinding(state, .more)) {
            AgendaMoreSheet(state: state, send: send)
        }
        .sheet(isPresented: sheetBinding(state, .reads)) {
            AgendaReadsSheet(chrome: state.chrome)
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

    /// THE HEADER'S ONE ACTION (R-CHROME-1): the Plus glyph, spoken as the
    /// state's "New event". None on the gate, which can make nothing.
    private func newEventAction(
        _ state: Centraid_Screen_V1_AgendaHomeState,
        denied: Bool
    ) -> RoomAction? {
        guard !state.chrome.newEvent.isEmpty, !denied else { return nil }
        return RoomAction(iconKey: "Plus", label: state.chrome.newEvent, identifier: "agenda-new-event") {
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
        if home.empty != .none, home.empty != .unspecified {
            // WHERE THE PHONE HOLDS A CALENDAR, ITS IMPORT IS DAY ONE'S
            // ACTION (the kit's empty state draws it); "New event" stays in
            // the header.
            EmptyStateView(emptyState(home), onAction: { send(AgendaEvents.make { $0.newEvent = .init() }) })
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
                LazyVStack(alignment: .leading, spacing: 0) {
                    // NO EVENT OF THE MEMBER'S YET, only marks (due tasks,
                    // birthdays): the phone's calendar is offered quietly above
                    // them, at the point of use.
                    if !ShellWords.importLabel(home.importSource).isEmpty, let importFromPhone {
                        KitOutlineButton(label: ShellWords.importLabel(home.importSource)) {
                            importFromPhone(home.importSource)
                        }
                        .accessibilityIdentifier("agenda-import")
                        .padding(.horizontal, CentraidGeometry.pageMargin)
                        .padding(.vertical, 8)
                    }
                    ForEach(home.days, id: \.day) { section in
                        AgendaSectionView(section: section, chrome: chrome, send: send)
                            .id(section.day)
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

    /// Where the state says to land — a day, or that day's now line.
    private func land(_ proxy: ScrollViewProxy) {
        let target = home.landing.nowLine ? "now-\(home.landing.day)" : home.landing.day
        guard !home.landing.day.isEmpty else { return }
        proxy.scrollTo(target, anchor: .top)
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
                        case let .nowLine(now):
                            AgendaNowLineView(now: now).id("now-\(section.day)")
                        case .none:
                            EmptyView()
                        }
                    }
                    if section.dueCount > 0 {
                        dueShelf
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

    private var dueShelf: some View {
        VStack(alignment: .leading, spacing: 4) {
            KitLink(label: section.dueLabel, dense: true, identifier: "agenda-due-\(section.day)") {
                send(AgendaEvents.make { $0.dueToggled = .with { $0.day = section.day } })
            }
            .accessibilityLabel(chrome.shelfLabel.isEmpty ? section.dueLabel : "\(section.dueLabel), \(chrome.shelfLabel)")
            if section.dueOpen {
                ForEach(section.due, id: \.taskID) { task in
                    Text(task.title)
                        .centraidType("annotLabel")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                        .padding(.leading, 8)
                }
            }
        }
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
