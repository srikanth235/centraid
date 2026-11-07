import SwiftUI

/// `people.home` — People (the roster) and Touch under one band, with Search a
/// field over the destination and More a sheet (#1135).
///
/// **THE VIEW DECIDES NOTHING.** The destination, the band, the header's filter
/// menu (the filters with their counts, then the order), every row's words, hue,
/// star and route, the tiles, the rails, the sheet and every empty sentence are
/// on `PeopleHomeState`, which Rust makes
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
            filter: filter,
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
            get: { state.sheet == .more },
            set: { shown in
                guard !shown, state.sheet != .unspecified else { return }
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
        // Rust's `corrected` here is the finished sentence, so the field says it as it is.
        field.correctedLabel = state.search.corrected
        return SearchSlot(
            field: field,
            placeholder: state.chrome.searchPlaceholder,
            closeLabel: state.chrome.searchClose,
            onOpen: { send(PeopleEvents.home { $0.searchOpened = .init() }) },
            onTerm: { term in send(PeopleEvents.home { $0.searchTerm = .with { $0.term = term } }) },
            onClose: { send(PeopleEvents.home { $0.searchClosed = .init() }) }
        )
    }

    /// THE HEADER'S FILTER BUTTON (R-CHROME-3): Rust's menu, the roster's filters with their
    /// counts and then its order. A pick or the clear row is an event; which is checked, and
    /// whether the funnel is lit, is on the state.
    private var filter: FilterSlot? {
        guard state.hasFilterMenu else { return nil }
        return FilterSlot(
            menu: state.filterMenu,
            onPick: { section, option in
                send(PeopleEvents.home {
                    $0.filterMenuPicked = .with {
                        $0.sectionKey = section
                        $0.optionKey = option
                    }
                })
            },
            onClear: { send(PeopleEvents.home { $0.filterMenuCleared = .init() }) }
        )
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

/// THE ROSTER (#1173): My card, the reconnect line, then the people. Under the Name order the
/// people are A to Z in sections (a letter pinned as it scrolls) with the index beside them; under
/// any other they are one flat list. Rust sent the sections, the index and where each letter jumps
/// to; this only draws them and scrolls.
private struct PeopleRosterList: View {
    let roster: Centraid_Core_V1_PeopleRosterData
    let importLabel: String
    let send: (Centraid_Core_V1_PeopleHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void

    @Environment(\.isLargestText) private var largestText

    private static func anchor(_ key: String) -> String { "people-section-\(key)" }

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
                ScrollViewReader { proxy in
                    ZStack(alignment: .trailing) {
                        list
                        if !roster.index.isEmpty, !largestText {
                            PeopleIndexRail(letters: roster.index) { key in
                                proxy.scrollTo(Self.anchor(key), anchor: .top)
                            }
                        }
                    }
                }
            }
        }
    }

    private var list: some View {
        ScrollView {
            LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                if roster.hasMyCard {
                    PeopleMyCardRow(card: roster.myCard, open: open)
                }
                if roster.hasReconnect {
                    PeopleReconnectLine(line: roster.reconnect) {
                        send(PeopleEvents.home { $0.band = .with { $0.key = "touch" } })
                    }
                }
                ForEach(roster.rows, id: \.partyID) { row in
                    PeopleRosterRowView(row: row, send: send, open: open)
                }
                ForEach(roster.sections, id: \.key) { section in
                    Section {
                        ForEach(section.rows, id: \.partyID) { row in
                            PeopleRosterRowView(row: row, send: send, open: open)
                        }
                    } header: {
                        PeopleSectionLetter(title: section.title)
                            .id(Self.anchor(section.key))
                    }
                }
                if !roster.statusLine.isEmpty {
                    Text(roster.statusLine)
                        .kitType(.meta)
                        .foregroundStyle(Surface.meta)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, CentraidGeometry.pageMargin)
                        .padding(.vertical, 12)
                }
            }
            // The index sits over the trailing edge: the rows give it its own gutter.
            .padding(.trailing, roster.index.isEmpty || largestText ? 0 : 18)
        }
        .refreshable { send(PeopleEvents.home { $0.refreshed = .init() }) }
        .accessibilityIdentifier("people-roster")
    }
}

/// A SECTION'S LETTER: 13 semibold in the quiet ink on the page, pinned while its people scroll.
private struct PeopleSectionLetter: View {
    let title: String

    var body: some View {
        Text(title)
            .kitType(.meta)
            .fontWeight(.semibold)
            .foregroundStyle(Surface.meta)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.top, 10)
            .padding(.bottom, 4)
            .background(Surface.page)
            .accessibilityAddTraits(.isHeader)
    }
}

/// THE INDEX: every letter in the app's colour, the ones with nobody dim, a touch or a drag along
/// it jumping to the letter's section. A screen reader steps through the letters and activates one.
private struct PeopleIndexRail: View {
    let letters: [Centraid_Core_V1_PeopleIndexLetter]
    let jump: (String) -> Void

    @Environment(\.appAccent) private var accent
    @State private var current: String?
    @ScaledMetric(relativeTo: .caption2) private var cell: CGFloat = 15

    var body: some View {
        VStack(spacing: 0) {
            ForEach(letters, id: \.letter) { letter in
                Text(letter.letter)
                    .kitType(.badge)
                    .foregroundStyle(accent.text.opacity(letter.hasRows_p ? 1 : 0.4))
                    .frame(width: 18, height: cell)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(letter.accessibilityLabel)
                    .accessibilityAddTraits(.isButton)
                    .accessibilityAction { jump(letter.sectionKey) }
            }
        }
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { drag in
                    let at = min(max(Int(drag.location.y / cell), 0), letters.count - 1)
                    let letter = letters[at]
                    guard current != letter.letter else { return }
                    current = letter.letter
                    jump(letter.sectionKey)
                }
                .onEnded { _ in current = nil }
        )
        .padding(.trailing, 2)
        .accessibilityIdentifier("people-index")
    }
}

/// MY CARD: the owner's own card above the list, 52pt avatar, name, and the words "My card".
private struct PeopleMyCardRow: View {
    let card: Centraid_Core_V1_PeopleMyCard
    let open: (Centraid_Core_V1_Route) -> Void

    var body: some View {
        Button { open(card.route) } label: {
            HStack(spacing: 12) {
                PeopleAvatarView(avatar: card.avatar, size: 52)
                VStack(alignment: .leading, spacing: 2) {
                    Text(card.name)
                        .kitType(.row)
                        .fontWeight(.semibold)
                        .foregroundStyle(Surface.ink)
                    Text(card.label)
                        .kitType(.meta)
                        .foregroundStyle(Surface.meta)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .bottom) {
                Rectangle().fill(Surface.line).frame(height: CentraidGeometry.hairline)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(card.accessibilityLabel)
        .accessibilityIdentifier("people-my-card")
    }
}

/// THE RECONNECT LINE: who is overdue, in a pale pill in the app's colour; a tap is the band's
/// Touch.
private struct PeopleReconnectLine: View {
    let line: Centraid_Core_V1_PeopleReconnectLine
    let onTap: () -> Void

    @Environment(\.appAccent) private var accent
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                CentraidIconView(iconKey: "Activity", tint: accent.text, size: 20)
                Text(line.text)
                    .kitType(.row)
                    .foregroundStyle(Surface.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(line.actionLabel)
                    .kitType(.row)
                    .fontWeight(.semibold)
                    .foregroundStyle(accent.text)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(
                accent.wash(dark: scheme == .dark),
                in: RoundedRectangle(cornerRadius: Theme.radius("md", scheme), style: .continuous)
            )
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 8)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(line.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("people-reconnect-line")
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

/// ONE PERSON IN A LIST: avatar, name over role · last touch, and the star. A reminder ("Birthday ·
/// in 5 days") is a word at the end of the meta line in the app's colour; a state ("Overdue") is the
/// badge at the trailing edge.
private struct PeopleRosterRowView: View {
    let row: Centraid_Core_V1_PeopleRow
    let send: (Centraid_Core_V1_PeopleHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void

    @Environment(\.appAccent) private var accent

    private func isReminder(_ chip: Centraid_Core_V1_StatusChip) -> Bool {
        switch chip.tone {
        case .neutral, .unspecified, .UNRECOGNIZED: return true
        default: return false
        }
    }

    private var meta: Text {
        var line = Text([row.role, row.meta].filter { !$0.isEmpty }.joined(separator: " · "))
        for chip in row.chips where isReminder(chip) {
            line = line + Text(" · ") + Text(chip.label).foregroundStyle(accent.text)
        }
        return line
    }

    var body: some View {
        HStack(spacing: 0) {
            Button { open(row.route) } label: {
                HStack(spacing: 12) {
                    PeopleAvatarView(avatar: row.avatar, size: 40)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.name)
                            .kitType(.row)
                            .foregroundStyle(Surface.ink)
                            .lineLimit(1)
                        meta
                            .kitType(.meta)
                            .foregroundStyle(Surface.meta)
                            .lineLimit(2)
                    }
                    Spacer(minLength: 8)
                    ForEach(Array(row.chips.filter { !isReminder($0) }.enumerated()), id: \.offset) { _, chip in
                        StatusChipView(chip)
                    }
                }
                .padding(.leading, CentraidGeometry.pageMargin)
                .padding(.trailing, 4)
                .padding(.vertical, 8)
                .frame(minHeight: CentraidGeometry.targetMinCoarse)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(alignment: .bottom) {
                    Rectangle()
                        .fill(Surface.line)
                        .frame(height: CentraidGeometry.hairline)
                        .padding(.leading, CentraidGeometry.pageMargin + 52)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(KitRowPress())
            .accessibilityElement(children: .combine)
            .accessibilityLabel(row.accessibilityLabel)
            .accessibilityIdentifier("people-row-\(row.partyID)")
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

/// More: Rust's rows (Trash — never search, sort or a filter).
private struct PeopleHomeSheet: View {
    let state: Centraid_Core_V1_PeopleHomeState
    let send: (Centraid_Core_V1_PeopleHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void

    var body: some View {
        OptionSheet(title: state.chrome.moreTitle) {
            ForEach(state.moreRows, id: \.key) { row in
                SheetRow(iconKey: row.iconKey, label: row.label, identifier: "people-more-\(row.key)") {
                    send(PeopleEvents.home { $0.sheetClosed = .init() })
                    open(row.route)
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

/// The star: a set choice, filled when on, in the app's colour (amber only ever means a state),
/// spoken by Rust's label.
struct PeopleStarButton: View {
    let starred: Bool
    let label: String
    let identifier: String
    let onTap: () -> Void

    @Environment(\.appAccent) private var accent

    var body: some View {
        Button(action: onTap) {
            CentraidIconView(
                iconKey: "Star",
                tint: starred ? accent.text : Surface.meta,
                size: 18,
                solid: starred
            )
            .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
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
