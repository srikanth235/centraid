import SwiftUI

/// People's home — People (the roster) and Touch — on the kit (#1029 app port).
///
/// **THE VIEW DECIDES NOTHING.** Every word, chip, count, hue and flag is on
/// `PeopleHomeState`, folded by `PeopleHomeMachine`; this file maps fields to
/// geometry and taps to events. The intents it sends (`PersonPicked`,
/// `AddPersonRequested`, `TrashRequested`, `LogTouchRequested`) are routed by
/// `PeopleScreens`, never here.
struct PeopleHomeView: View {
    let data: Data
    let send: (Data) -> Void
    let onHome: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_PeopleHomeState {
        (try? Centraid_Screen_V1_PeopleHomeState(serializedBytes: data)) ?? .init()
    }

    private var content: ScreenContent<Centraid_Screen_V1_PeopleHomeData> {
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
            app: "people",
            title: chrome.title,
            search: SearchSlot(
                field: state.search,
                placeholder: chrome.searchPlaceholder,
                closeLabel: chrome.searchClose,
                onTerm: { term in send(PeopleEvents.home { $0.searchTerm = .with { $0.term = term } }) },
                onClose: { send(PeopleEvents.home { $0.searchClosed = .init() }) }
            ),
            showsBand: !content.isDenied
        ) {
            if !content.isDenied, !chrome.addPerson.isEmpty {
                Button {
                    send(PeopleEvents.home { $0.addPerson = .init() })
                } label: {
                    CentraidIconView(iconKey: "UserPlus", tint: Theme.color("text", scheme), size: 18)
                        .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(chrome.addPerson)
                .accessibilityIdentifier("people-add-person")
            }
        } band: {
            AppBand(
                app: "people",
                tabs: state.band.map { tab in
                    BandView(
                        label: tab.label,
                        event: PeopleEvents.home { $0.band = .with { $0.key = tab.key } },
                        iconKey: tab.iconKey,
                        selected: tab.current
                    )
                },
                onSelect: send,
                onHome: onHome
            )
        } content: {
            VStack(spacing: 0) {
                if !state.status.isEmpty {
                    PeopleStatusLine(text: state.status)
                }
                if state.search.open {
                    PeopleSearchResults(state: state, send: send)
                } else {
                    ReadStateView(
                        content: content,
                        loadingLabel: chrome.loading,
                        onRetry: { send(PeopleEvents.home { $0.refreshed = .init() }) }
                    ) { home in
                        switch home.surface {
                        case let .roster(roster):
                            PeopleRosterList(roster: roster, send: send)
                        case let .touch(touch):
                            PeopleTouchList(touch: touch, send: send)
                        case .none:
                            RowSkeleton(label: chrome.loading)
                        }
                    }
                }
            }
        }
        .sheet(isPresented: Binding(
            get: { state.sheet == .more },
            set: { open in
                guard !open, state.sheet == .more else { return }
                send(PeopleEvents.home { $0.sheetClosed = .init() })
            }
        )) {
            PeopleMoreSheet(state: state, send: send)
        }
    }
}

/// Encoded People events. Bytes, because the bridge takes Wire's type and this
/// side holds SwiftProtobuf's.
enum PeopleEvents {
    static func home(_ build: (inout Centraid_Screen_V1_PeopleHomeEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_PeopleHomeEvent()
        build(&event)
        return event.encoded
    }

    static func person(_ build: (inout Centraid_Screen_V1_PeoplePersonEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_PeoplePersonEvent()
        build(&event)
        return event.encoded
    }

    static func editor(_ build: (inout Centraid_Screen_V1_PeopleEditorEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_PeopleEditorEvent()
        build(&event)
        return event.encoded
    }
}

// MARK: - Roster

private struct PeopleRosterList: View {
    let roster: Centraid_Screen_V1_PeopleRosterData
    let send: (Data) -> Void

    var body: some View {
        VStack(spacing: 0) {
            PeopleChipStrip(chips: roster.chips, send: send)
            if roster.hasEmpty {
                EmptyStateView(roster.empty, onAction: { send(PeopleEvents.home { $0.addPerson = .init() }) })
                Spacer(minLength: 0)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(roster.rows, id: \.partyID) { row in
                            PeopleRosterRow(row: row, send: send)
                        }
                        if !roster.statusLine.isEmpty {
                            PeopleStatusLine(text: roster.statusLine)
                        }
                    }
                }
                .refreshable { send(PeopleEvents.home { $0.refreshed = .init() }) }
                .accessibilityIdentifier("people-roster")
            }
        }
    }
}

/// THE CHIPS: All · Starred · Due, each a set choice with its count.
private struct PeopleChipStrip: View {
    let chips: [Centraid_Screen_V1_PeopleChip]
    let send: (Data) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(chips, id: \.label) { chip in
                    Button {
                        send(PeopleEvents.home { $0.chip = .with { $0.chip = chip.key } })
                    } label: {
                        HStack(spacing: 4) {
                            Text(chip.label)
                                .centraidType(chip.selected ? "smallStrong" : "small")
                            Text("\(chip.count)")
                                .centraidType("annotLabel")
                                .monospacedDigit()
                                .foregroundStyle(Theme.color("textFaint", scheme))
                        }
                        .foregroundStyle(Theme.color(chip.selected ? "text" : "textSoft", scheme))
                        .padding(.horizontal, 12)
                        .frame(minHeight: 32)
                        .background(Capsule().fill(Theme.color(chip.selected ? "bgSunken" : "bg", scheme)))
                        .overlay(
                            Capsule().strokeBorder(
                                Theme.color(chip.selected ? "lineStrong" : "line", scheme),
                                lineWidth: CentraidGeometry.hairline
                            )
                        )
                        .frame(minHeight: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(chip.accessibilityLabel.isEmpty ? chip.label : chip.accessibilityLabel)
                    .accessibilityAddTraits(chip.selected ? .isSelected : [])
                    .accessibilityIdentifier("people-chip-\(chip.label.lowercased())")
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
        }
    }
}

/// ONE PERSON IN THE ROSTER: avatar, the kit row, and the star.
private struct PeopleRosterRow: View {
    let row: Centraid_Screen_V1_PeopleRow
    let send: (Data) -> Void

    var body: some View {
        HStack(spacing: 0) {
            PeopleAvatarView(avatar: row.avatar)
                .padding(.leading, CentraidGeometry.pageMargin)
            CentraidRow(
                title: row.name,
                meta: [row.role, row.meta].filter { !$0.isEmpty }.joined(separator: " · "),
                chips: row.chips,
                pending: row.starPending,
                accessibility: row.accessibilityLabel,
                identifier: "people-row-\(row.partyID)",
                onTap: { send(PeopleEvents.home { $0.person = .with { $0.partyID = row.partyID; $0.name = row.name } }) }
            )
            PeopleStarButton(
                starred: row.starred,
                label: row.starLabel,
                identifier: "people-star-\(row.partyID)",
                onTap: { send(PeopleEvents.home { $0.star = .with { $0.partyID = row.partyID } }) }
            )
            .padding(.trailing, 8)
        }
    }
}

// MARK: - Touch

private struct PeopleTouchList: View {
    let touch: Centraid_Screen_V1_PeopleTouchData
    let send: (Data) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if touch.hasEmpty {
            EmptyStateView(touch.empty, onAction: { send(PeopleEvents.home { $0.addPerson = .init() }) })
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    tiles
                    SectionHeader(touch.reconnectHead)
                    if touch.reconnect.isEmpty {
                        PeopleStatusLine(text: touch.reconnectEmpty)
                    }
                    ForEach(touch.reconnect, id: \.partyID) { card in
                        HStack(spacing: 0) {
                            PeopleAvatarView(avatar: card.avatar)
                                .padding(.leading, CentraidGeometry.pageMargin)
                            CentraidRow(
                                title: card.name,
                                meta: [card.role, card.detail].filter { !$0.isEmpty }.joined(separator: " · "),
                                accessibility: card.accessibilityLabel,
                                identifier: "people-reconnect-\(card.partyID)",
                                onTap: { send(PeopleEvents.home { $0.person = .with { $0.partyID = card.partyID; $0.name = card.name } }) }
                            )
                            if !card.actionLabel.isEmpty {
                                KitOutlineButton(label: card.actionLabel) {
                                    send(PeopleEvents.home {
                                        $0.logTouch = .with { $0.partyID = card.partyID; $0.name = card.name }
                                    })
                                }
                                .padding(.trailing, CentraidGeometry.pageMargin)
                                .accessibilityIdentifier("people-log-touch-\(card.partyID)")
                            }
                        }
                    }
                    SectionHeader(touch.upcomingHead)
                    if touch.upcoming.isEmpty {
                        PeopleStatusLine(text: touch.upcomingEmpty)
                    }
                    ForEach(touch.upcoming, id: \.dateID) { row in
                        HStack(spacing: 0) {
                            PeopleAvatarView(avatar: row.avatar)
                                .padding(.leading, CentraidGeometry.pageMargin)
                            CentraidRow(
                                title: row.name,
                                meta: [row.label, row.dayLabel].filter { !$0.isEmpty }.joined(separator: " · "),
                                trailing: row.whenLabel,
                                accessibility: row.accessibilityLabel,
                                identifier: "people-upcoming-\(row.dateID)",
                                onTap: { send(PeopleEvents.home { $0.person = .with { $0.partyID = row.partyID; $0.name = row.name } }) }
                            )
                        }
                    }
                    SectionHeader(touch.recentHead)
                    if touch.recent.isEmpty {
                        PeopleStatusLine(text: touch.recentEmpty)
                    }
                    ForEach(touch.recent, id: \.interactionID) { row in
                        HStack(spacing: 0) {
                            PeopleAvatarView(avatar: row.avatar)
                                .padding(.leading, CentraidGeometry.pageMargin)
                            CentraidRow(
                                title: row.name,
                                meta: [row.kindLabel, row.text].filter { !$0.isEmpty }.joined(separator: " · "),
                                trailing: row.whenLabel,
                                accessibility: row.accessibilityLabel,
                                identifier: "people-recent-\(row.interactionID)",
                                onTap: { send(PeopleEvents.home { $0.person = .with { $0.partyID = row.partyID; $0.name = row.name } }) }
                            )
                        }
                    }
                    if !touch.statusLine.isEmpty {
                        PeopleStatusLine(text: touch.statusLine)
                    }
                }
            }
            .refreshable { send(PeopleEvents.home { $0.refreshed = .init() }) }
            .accessibilityIdentifier("people-touch")
        }
    }

    /// THE TILES: a figure over its label; a tappable one lands on People
    /// under the matching chip (the machine's `TilePicked`), the Upcoming one
    /// is a figure and nothing more.
    private var tiles: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
            ForEach(touch.tiles, id: \.key) { tile in
                let face = VStack(alignment: .leading, spacing: 2) {
                    Text("\(tile.count)")
                        .centraidType("title")
                        .monospacedDigit()
                        .foregroundStyle(Theme.color(tile.net ? "net" : "text", scheme))
                    Text(tile.label)
                        .centraidType("annotLabel")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                }
                .padding(12)
                .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                        .strokeBorder(Theme.color("line", scheme), lineWidth: CentraidGeometry.hairline)
                )
                if tile.tappable {
                    Button { send(PeopleEvents.home { $0.tile = .with { $0.key = tile.key } }) } label: { face }
                        .buttonStyle(KitRowPress())
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel(tile.accessibilityLabel)
                        .accessibilityIdentifier("people-tile-\(tile.key)")
                } else {
                    face
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel(tile.accessibilityLabel)
                }
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.top, 8)
    }
}

// MARK: - Search

private struct PeopleSearchResults: View {
    let state: Centraid_Screen_V1_PeopleHomeState
    let send: (Data) -> Void

    var body: some View {
        if state.hasSearchData {
            let results = state.searchData
            if results.hasEmpty {
                EmptyStateView(results.empty)
                Spacer(minLength: 0)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(results.rows, id: \.partyID) { row in
                            PeopleRosterRow(row: row, send: send)
                        }
                    }
                }
                .accessibilityIdentifier("people-search-results")
            }
        } else if state.reading {
            RowSkeleton(label: state.chrome.loading)
        } else {
            Spacer(minLength: 0)
        }
    }
}

// MARK: - More

private struct PeopleMoreSheet: View {
    let state: Centraid_Screen_V1_PeopleHomeState
    let send: (Data) -> Void

    var body: some View {
        let chrome = state.chrome
        OptionSheet(title: chrome.moreTitle) {
            SheetRow(iconKey: "Search", label: chrome.searchLabel, identifier: "people-more-search") {
                send(PeopleEvents.home { $0.sheetClosed = .init() })
                send(PeopleEvents.home { $0.searchOpened = .init() })
            }
            if !state.orderChoices.isEmpty {
                SectionHeader(title: chrome.sortHeading)
                    .padding(.horizontal, -CentraidGeometry.pageMargin)
                ForEach(state.orderChoices, id: \.label) { choice in
                    SheetRow(
                        label: choice.label,
                        selected: choice.selected,
                        identifier: "people-order-\(choice.label.lowercased())"
                    ) {
                        send(PeopleEvents.home { $0.order = .with { $0.order = choice.order } })
                    }
                }
            }
            SheetRow(iconKey: "Trash", label: chrome.trashLabel, identifier: "people-more-trash") {
                send(PeopleEvents.home { $0.sheetClosed = .init() })
                send(PeopleEvents.home { $0.trash = .init() })
            }
        }
    }
}

// MARK: - Shared pieces

/// THE AVATAR: initials on the person's hue. The hue is a colour role the
/// machine chose; an empty one is the soft ground.
struct PeopleAvatarView: View {
    let avatar: Centraid_Screen_V1_PeopleAvatar
    var size: CGFloat = 32

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Text(avatar.initials)
            .centraidType(size > 40 ? "title" : "annotLabelOn")
            .foregroundStyle(Theme.color("text", scheme))
            .frame(width: size, height: size)
            .background(
                Circle().fill(Theme.color(peopleHue(avatar.hueKey, else: "bgSunken"), scheme).opacity(0.28))
            )
            .overlay(
                Circle().strokeBorder(
                    Theme.color(peopleHue(avatar.hueKey, else: "line"), scheme),
                    lineWidth: CentraidGeometry.hairline
                )
            )
            .accessibilityHidden(true)
    }
}

/// The star: a set choice, drawn full when on, spoken by the machine's label.
struct PeopleStarButton: View {
    let starred: Bool
    let label: String
    let identifier: String
    let onTap: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: onTap) {
            CentraidIconView(iconKey: "Star", tint: Theme.color(starred ? "warning" : "textFaint", scheme), size: 18)
                .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(starred ? .isSelected : [])
        .accessibilityIdentifier(identifier)
    }
}

/// A quiet line of the machine's words — a status, an empty rail.
struct PeopleStatusLine: View {
    let text: String

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Text(text)
            .centraidType("small")
            .foregroundStyle(Theme.color("textSoft", scheme))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 8)
    }
}

/// A People hue IS the theme's colour role (`cRose`) — the machine's, drawn
/// as is. Empty, or a role this build's table lacks, draws `fallback`, because
/// `Theme.color` traps on an unknown role and an avatar must never crash.
func peopleHue(_ role: String, else fallback: String) -> String {
    KitHue.role(role) ?? fallback
}
