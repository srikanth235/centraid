import SwiftUI

/// `people.home` — People (the roster) and Touch under one band, with Search a
/// field over the destination and More a sheet (#1135).
///
/// **THE VIEW DECIDES NOTHING.** The destination, the band, the chip row and its
/// sort chip, every row's words, hue, star and route, the tiles, the rails, the
/// sheets and every empty sentence are on `PeopleHomeState`, which Rust makes
/// (`crates/screens`, module `people`). A tap on the band is an event and swaps
/// the destination; a row that opens a page carries its `Route` and a tap hands
/// it to `open`.
struct PeopleHomeView: View {
    let state: Centraid_Core_V1_PeopleHomeState
    let send: (Centraid_Core_V1_PeopleHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onHome: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var denied: Bool {
        if case .denied? = state.content { return true }
        return false
    }

    var body: some View {
        let chrome = state.chrome
        AppPlace(
            app: "people",
            title: state.title,
            trailing: denied || chrome.addPerson.isEmpty ? nil : RoomAction(
                iconKey: "Plus",
                label: chrome.addPerson,
                identifier: "people-add-person",
                action: { if state.hasAddPerson { open(state.addPerson) } }
            ),
            search: denied ? nil : searchSlot,
            chips: chips,
            showsBand: !denied && !state.band.isEmpty
        ) {
            AppBand(
                app: "people",
                tabs: state.band.map { tab in
                    BandView(label: tab.label, event: Data(tab.key.utf8), iconKey: tab.iconKey, selected: tab.current, key: tab.key)
                },
                onSelect: { picked in
                    let key = String(decoding: picked, as: UTF8.self)
                    send(PeopleEvents.home { $0.band = .with { $0.key = key } })
                },
                onHome: onHome
            )
        } content: {
            VStack(spacing: 0) {
                if state.hasStatus, !state.status.sentence.isEmpty {
                    PeopleStatusLine(text: state.status.sentence)
                }
                if state.search.open, state.search.hasResults {
                    searchResults
                } else {
                    ReadStateView(
                        content: readContent,
                        loadingLabel: chrome.loading,
                        onRetry: { send(PeopleEvents.home { $0.refreshed = .init() }) }
                    ) { _ in
                        surface
                    }
                }
            }
        }
        .sheet(isPresented: Binding(
            get: { state.sheet == .more || state.sheet == .order },
            set: { shown in
                guard !shown, state.sheet != .none else { return }
                send(PeopleEvents.home { $0.sheetClosed = .init() })
            }
        )) {
            PeopleHomeSheet(state: state, send: send, open: open)
        }
    }

    // MARK: chrome

    private var searchSlot: SearchSlot {
        var field = KitSearchField()
        field.open = state.search.open
        field.term = state.search.term
        field.corrected = state.search.corrected
        return SearchSlot(
            field: field,
            placeholder: state.chrome.searchPlaceholder,
            closeLabel: state.chrome.searchClose,
            onOpen: { send(PeopleEvents.home { $0.searchOpened = .init() }) },
            onTerm: { term in send(PeopleEvents.home { $0.searchTerm = .with { $0.term = term } }) },
            onClose: { send(PeopleEvents.home { $0.searchClosed = .init() }) }
        )
    }

    /// THE CHIP ROW (R-CHROME-3): Rust's filters with their counts, then its
    /// sort chip, last, whose tap opens the order sheet.
    private var chips: [RoomChip] {
        var out = state.chips.map { chip in
            RoomChip(
                identifier: "people-chip-\(chip.label.lowercased())",
                label: chip.label,
                count: chip.count > 0 ? "\(chip.count)" : "",
                selected: chip.selected,
                spoken: chip.accessibilityLabel,
                action: { send(PeopleEvents.home { $0.chip = .with { $0.chip = chip.key } }) }
            )
        }
        if state.hasSortChip {
            out.append(RoomChip(
                identifier: "people-chip-sort",
                label: state.sortChip.label,
                chevron: true,
                spoken: state.sortChip.spoken,
                action: { send(PeopleEvents.home { $0.sheetOpened = .with { $0.sheet = .order } }) }
            ))
        }
        return out
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
    private var surface: some View {
        switch state.content {
        case let .roster(roster)?:
            PeopleRosterList(roster: roster, importLabel: state.chrome.importContacts, send: send, open: open)
        case let .touch(touch)?:
            PeopleTouchList(touch: touch, importLabel: state.chrome.importContacts, send: send, open: open)
        default: EmptyView()
        }
    }

    private var searchResults: some View {
        let results = state.search.results
        return Group {
            if results.hasEmpty {
                EmptyStateView(results.empty)
                if state.search.hasAsk { SearchAskRow(ask: state.search.ask) }
                Spacer(minLength: 0)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(results.rows, id: \.partyID) { row in
                            PeopleRosterRowView(row: row, send: send, open: open)
                        }
                        if state.search.hasAsk { SearchAskRow(ask: state.search.ask) }
                    }
                }
                .accessibilityIdentifier("people-search-results")
            }
        }
    }
}

/// `PeopleHomeEvent`s, built.
enum PeopleEvents {
    static func home(_ build: (inout Centraid_Core_V1_PeopleHomeEvent) -> Void) -> Centraid_Core_V1_PeopleHomeEvent {
        var event = Centraid_Core_V1_PeopleHomeEvent()
        build(&event)
        return event
    }

    static func person(_ build: (inout Centraid_Core_V1_PeoplePersonEvent) -> Void) -> Centraid_Core_V1_PeoplePersonEvent {
        var event = Centraid_Core_V1_PeoplePersonEvent()
        build(&event)
        return event
    }

    static func editor(_ build: (inout Centraid_Core_V1_PeopleEditorEvent) -> Void) -> Centraid_Core_V1_PeopleEditorEvent {
        var event = Centraid_Core_V1_PeopleEditorEvent()
        build(&event)
        return event
    }
}

// MARK: - Roster

private struct PeopleRosterList: View {
    let roster: Centraid_Core_V1_PeopleRosterData
    let importLabel: String
    let send: (Centraid_Core_V1_PeopleHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void

    var body: some View {
        VStack(spacing: 0) {
            if roster.hasEmpty {
                // WHERE THE PHONE HOLDS CONTACTS, ITS IMPORT IS DAY ONE'S ACTION, sent to Rust as
                // `ImportContactsTapped`; "Add person" stays in the header.
                let offersImport = roster.empty.importSource == .contacts
                EmptyStateView(roster.empty)
                if offersImport {
                    PeopleImportButton(label: importLabel, send: send)
                }
                Spacer(minLength: 0)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(roster.rows, id: \.partyID) { row in
                            PeopleRosterRowView(row: row, send: send, open: open)
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

/// THE PHONE'S CONTACTS, ASKED FOR: the verb is People's, the tap is Rust's
/// (`ImportContactsTapped`; Rust asks this shell to read the address book through
/// the `ContactsRead` effect).
private struct PeopleImportButton: View {
    let label: String
    let send: (Centraid_Core_V1_PeopleHomeEvent) -> Void

    var body: some View {
        KitOutlineButton(label: label) {
            send(PeopleEvents.home { $0.importContacts = .init() })
        }
        .accessibilityIdentifier("kit-empty-import")
        .padding(.top, 4)
    }
}

/// ONE PERSON IN A LIST: avatar, the kit row, and the star.
private struct PeopleRosterRowView: View {
    let row: Centraid_Core_V1_PeopleRow
    let send: (Centraid_Core_V1_PeopleHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void

    var body: some View {
        HStack(spacing: 0) {
            PeopleAvatarView(avatar: row.avatar)
                .padding(.leading, CentraidGeometry.pageMargin)
            CentraidRow(
                title: row.name,
                meta: [row.role, row.meta].filter { !$0.isEmpty }.joined(separator: " · "),
                chips: row.chips,
                accessibility: row.accessibilityLabel,
                identifier: "people-row-\(row.partyID)",
                onTap: { open(row.route) }
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
    let touch: Centraid_Core_V1_PeopleTouchData
    let importLabel: String
    let send: (Centraid_Core_V1_PeopleHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if touch.hasEmpty {
            let offersImport = touch.empty.importSource == .contacts
            EmptyStateView(touch.empty)
            if offersImport {
                PeopleImportButton(label: importLabel, send: send)
            }
            Spacer(minLength: 0)
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    tiles
                    SectionHeader(title: touch.reconnectHead.title, count: touch.reconnectHead.count)
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
                                onTap: { open(card.route) }
                            )
                            if !card.actionLabel.isEmpty {
                                KitOutlineButton(label: card.actionLabel) { open(card.logRoute) }
                                    .padding(.trailing, CentraidGeometry.pageMargin)
                                    .accessibilityIdentifier("people-log-touch-\(card.partyID)")
                            }
                        }
                    }
                    SectionHeader(title: touch.upcomingHead.title, count: touch.upcomingHead.count)
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
                                onTap: { open(row.route) }
                            )
                        }
                    }
                    SectionHeader(title: touch.recentHead.title)
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
                                onTap: { open(row.route) }
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
    /// under the matching chip (`TilePicked`), the Upcoming one is a figure and
    /// nothing more.
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

// MARK: - Sheets

/// More (Rust's rows: Trash — never search, sort or a filter) and the sort
/// chip's order sheet.
private struct PeopleHomeSheet: View {
    let state: Centraid_Core_V1_PeopleHomeState
    let send: (Centraid_Core_V1_PeopleHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void

    var body: some View {
        let chrome = state.chrome
        if state.sheet == .order {
            OptionSheet(title: chrome.sortHeading) {
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
        } else {
            OptionSheet(title: chrome.moreTitle) {
                ForEach(state.moreRows, id: \.key) { row in
                    SheetRow(iconKey: row.iconKey, label: row.label, identifier: "people-more-\(row.key)") {
                        send(PeopleEvents.home { $0.sheetClosed = .init() })
                        open(row.route)
                    }
                }
            }
        }
    }
}

// MARK: - Shared pieces

/// THE AVATAR: initials on the person's hue. The hue is a colour role Rust
/// chose; an empty one is the soft ground.
struct PeopleAvatarView: View {
    let avatar: Centraid_Core_V1_PeopleAvatar
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

/// The star: a set choice, drawn full when on, spoken by Rust's label.
struct PeopleStarButton: View {
    let starred: Bool
    let label: String
    let identifier: String
    let onTap: () -> Void

    var body: some View {
        KitIconKey(
            iconKey: "Star",
            label: label,
            tint: starred ? "warning" : "textFaint",
            identifier: identifier,
            action: onTap
        )
        .accessibilityAddTraits(starred ? .isSelected : [])
    }
}

/// A quiet line of Rust's words — a status, an empty rail.
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

/// A People hue IS the theme's colour role (`cRose`) — Rust's, drawn as is.
/// Empty, or a role this build's table lacks, draws `fallback`, because
/// `Theme.color` traps on an unknown role and an avatar must never crash.
func peopleHue(_ role: String, else fallback: String) -> String {
    KitHue.role(role) ?? fallback
}
