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

    private var state: Centraid_Screen_V1_AgendaHomeState {
        (try? Centraid_Screen_V1_AgendaHomeState(serializedBytes: data)) ?? .init()
    }

    var body: some View {
        let state = state
        VStack(spacing: 0) {
            if state.searchOpen {
                AgendaSearchField(state: state, send: send)
            }
            if state.toolbar.shown {
                AgendaToolbarView(toolbar: state.toolbar, chrome: state.chrome, send: send)
            }
            content(state)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Theme.color("bg", scheme).ignoresSafeArea())
        .navigationTitle(state.chrome.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !state.chrome.newEvent.isEmpty, !isDenied(state) {
                ToolbarItem(placement: .primaryAction) {
                    Button(state.chrome.newEvent) {
                        send(AgendaEvents.make { $0.newEvent = .init() })
                    }
                    .accessibilityIdentifier("agenda-new-event")
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !isDenied(state), !state.band.isEmpty {
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
                .background(Theme.color("bg", scheme).ignoresSafeArea(edges: .bottom))
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

    @ViewBuilder
    private func content(_ state: Centraid_Screen_V1_AgendaHomeState) -> some View {
        switch state.content {
        case .loading, .none:
            AgendaSkeleton(label: state.chrome.loading)
        case let .failure(failure):
            AgendaMessage(
                title: failure.sentence,
                detail: failure.remedy,
                action: state.chrome.retry,
                onAction: { send(AgendaEvents.make { $0.refreshed = .init() }) }
            )
            .accessibilityIdentifier("agenda-failure")
        case let .denied(denied):
            AgendaMessage(title: denied.title, detail: denied.body, action: "", onAction: {})
                .accessibilityIdentifier("agenda-denied")
        case let .data(home):
            if home.empty != .none, home.empty != .unspecified {
                AgendaMessage(
                    title: home.emptyTitle,
                    detail: home.emptyBody,
                    action: home.emptyAction,
                    onAction: { send(AgendaEvents.make { $0.newEvent = .init() }) }
                )
                .accessibilityIdentifier("agenda-empty")
            } else {
                AgendaList(home: home, chrome: state.chrome, send: send)
            }
        }
    }

    private func isDenied(_ state: Centraid_Screen_V1_AgendaHomeState) -> Bool {
        if case .denied = state.content { return true }
        return false
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
                step("ChevronLeft", chrome.previousDay, -1, "agenda-previous-day")
                step("ChevronRight", chrome.nextDay, 1, "agenda-next-day")
                if !toolbar.atToday {
                    Button {
                        send(AgendaEvents.make { $0.today = .init() })
                    } label: {
                        Text(chrome.today)
                            .centraidType("smallStrong")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                            .padding(.horizontal, 12)
                            .frame(minHeight: 36)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("agenda-today")
                }
                Spacer(minLength: 0)
                Text(toolbar.monthLabel)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textFaint", scheme))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    private func step(_ icon: String, _ label: String, _ days: Int32, _ identifier: String) -> some View {
        Button {
            send(AgendaEvents.make { $0.dayStepped = .with { $0.days = days } })
        } label: {
            CentraidIconView(iconKey: icon, tint: Theme.color("text", scheme), size: 16)
                .frame(width: 36, height: 36)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.radius("sm", scheme))
                        .strokeBorder(Theme.color("line", scheme), lineWidth: CentraidGeometry.hairline)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }
}

// MARK: - Search

private struct AgendaSearchField: View {
    let state: Centraid_Screen_V1_AgendaHomeState
    let send: (Data) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 8) {
            CentraidIconView(iconKey: "Search", tint: Theme.color("textFaint", scheme), size: 16)
            MachineTextField(
                placeholder: state.chrome.searchPlaceholder,
                value: state.searchTerm,
                focusOnAppear: true,
                onEdit: { term in send(AgendaEvents.make { $0.searchTerm = .with { $0.term = term } }) }
            )
            .centraidType("body")
            .submitLabel(.search)
            .autocorrectionDisabled()
            .accessibilityLabel(state.chrome.searchLabel)
            .accessibilityIdentifier("agenda-search-field")
            Button {
                send(AgendaEvents.make { $0.searchClosed = .init() })
            } label: {
                CentraidIconView(iconKey: "X", tint: Theme.color("textSoft", scheme), size: 16)
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(state.chrome.searchClose)
            .accessibilityIdentifier("agenda-search-close")
        }
        .padding(.horizontal, 12)
        .background(Theme.color("bgSunken", scheme))
        .clipShape(RoundedRectangle(cornerRadius: Theme.radius("md", scheme)))
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }
}

// MARK: - The list

private struct AgendaList: View {
    let home: Centraid_Screen_V1_AgendaHomeData
    let chrome: Centraid_Screen_V1_AgendaChrome
    let send: (Data) -> Void

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
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
                    .padding(.horizontal, 16)
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
            .padding(.horizontal, 16)
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
            Button {
                send(AgendaEvents.make { $0.dueToggled = .with { $0.day = section.day } })
            } label: {
                Text(section.dueLabel)
                    .centraidType("annotLabelOn")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .frame(minHeight: 32)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(chrome.shelfLabel.isEmpty ? section.dueLabel : "\(section.dueLabel), \(chrome.shelfLabel)")
            .accessibilityIdentifier("agenda-due-\(section.day)")
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
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .frame(width: 52, alignment: .leading)
                Text(row.title)
                    .centraidType("body")
                    .foregroundStyle(Theme.color("text", scheme))
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
            .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
            .overlay(alignment: .leading) {
                Rectangle()
                    .fill(Theme.color(AgendaHue.role(row.calendarHueKey), scheme))
                    .frame(width: 2)
                    .padding(.vertical, 6)
            }
            .opacity(row.isPast ? 0.55 : 1)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("agenda-row-\(row.rowKey)")
    }
}

/// A calendar hue key (`slate`, `forest`…) is the `c<Hue>` colour role.
enum AgendaHue {
    static func role(_ key: String) -> String {
        let role = "c" + key.prefix(1).uppercased() + key.dropFirst()
        return centraidColorRoles.contains(role) ? role : "cSlate"
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

// MARK: - States

/// Skeleton rows, not a spinner: the shape of what is coming.
private struct AgendaSkeleton: View {
    let label: String
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(0..<5, id: \.self) { index in
                HStack(spacing: 8) {
                    RoundedRectangle(cornerRadius: Theme.radius("sm", scheme))
                        .fill(Theme.color("skel", scheme))
                        .frame(width: 44, height: 28)
                    RoundedRectangle(cornerRadius: Theme.radius("sm", scheme))
                        .fill(Theme.color("skel", scheme))
                        .frame(height: 16)
                        .frame(maxWidth: index.isMultiple(of: 2) ? .infinity : 200, alignment: .leading)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityIdentifier("agenda-loading")
    }
}

/// One sentence, its detail, and at most one action — failure, denied and
/// the four empties all draw through here, each with the state's own words.
private struct AgendaMessage: View {
    let title: String
    let detail: String
    let action: String
    let onAction: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .centraidType("bodyStrong")
                .foregroundStyle(Theme.color("text", scheme))
            if !detail.isEmpty {
                Text(detail)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
            if !action.isEmpty {
                Button(action: onAction) {
                    Text(action)
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color("text", scheme))
                        .padding(.horizontal, 12)
                        .frame(minHeight: 36)
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.radius("sm", scheme))
                                .strokeBorder(Theme.color("line", scheme), lineWidth: CentraidGeometry.hairline)
                        )
                }
                .buttonStyle(.plain)
                .padding(.top, 4)
                .accessibilityIdentifier("agenda-message-action")
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - Sheets

private struct AgendaMoreSheet: View {
    let state: Centraid_Screen_V1_AgendaHomeState
    let send: (Data) -> Void
    @Environment(\.colorScheme) private var scheme

    private var calendars: [Centraid_Screen_V1_AgendaCalendarChoice] {
        if case let .data(home) = state.content { return home.calendars }
        return []
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(calendars, id: \.calendarID) { calendar in
                        Button {
                            send(AgendaEvents.make {
                                $0.calendarToggled = .with { $0.calendarID = calendar.calendarID }
                            })
                        } label: {
                            HStack(spacing: 8) {
                                Circle()
                                    .fill(Theme.color(AgendaHue.role(calendar.hueKey), scheme))
                                    .frame(width: 8, height: 8)
                                Text(calendar.name)
                                    .centraidType("body")
                                    .foregroundStyle(Theme.color(calendar.hidden ? "textFaint" : "text", scheme))
                                Spacer(minLength: 0)
                                Text(calendar.stateLabel)
                                    .centraidType("annotLabel")
                                    .foregroundStyle(Theme.color("textSoft", scheme))
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("agenda-calendar-\(calendar.calendarID)")
                    }
                } header: {
                    Text(state.chrome.calendarsHeading).centraidType("eyebrow")
                }
                Section {
                    Button {
                        send(AgendaEvents.make { $0.sheetOpened = .with { $0.sheet = .reads } })
                    } label: {
                        Text(state.chrome.readsTitle)
                            .centraidType("body")
                            .foregroundStyle(Theme.color("text", scheme))
                    }
                    .accessibilityIdentifier("agenda-more-reads")
                }
            }
            .navigationTitle(state.chrome.moreTitle)
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("agenda-more-sheet")
    }
}

private struct AgendaReadsSheet: View {
    let chrome: Centraid_Screen_V1_AgendaChrome
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        NavigationStack {
            List(Array(chrome.readsFacts.enumerated()), id: \.offset) { _, fact in
                VStack(alignment: .leading, spacing: 2) {
                    Text(fact.label)
                        .centraidType("eyebrow")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                    Text(fact.detail)
                        .centraidType("body")
                        .foregroundStyle(Theme.color("text", scheme))
                }
                .accessibilityElement(children: .combine)
            }
            .navigationTitle(chrome.readsTitle)
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("agenda-reads-sheet")
    }
}
