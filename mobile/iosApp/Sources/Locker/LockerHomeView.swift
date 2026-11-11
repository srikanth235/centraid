import SwiftUI

/// The home's events, built once.
enum LockerHomeEvents {
    static func make(_ build: (inout Centraid_Core_V1_LockerHomeEvent) -> Void) -> Centraid_Core_V1_LockerHomeEvent {
        var event = Centraid_Core_V1_LockerHomeEvent()
        build(&event)
        return event
    }
}

/// LOCKER'S HOME — Items · Review · Generate, More as a sheet (#1047; the
/// handoff's Locker §1). Search is the room's bar (R-CHROME-2), never a tab;
/// the Items filter is the header's menu (R-CHROME-3).
///
/// **THE VIEW DECIDES NOTHING.** The band (kept while locked, dimmed: `band_locked`), the filter
/// menu, the rows, the review verdicts, the generator, the search note, every
/// empty and every word are `LockerHomeState`'s (Rust); the wall is its `wall`.
/// A row, the add control and a More row carry the `Route` to push.
struct LockerHomeView: View {
    let state: Centraid_Core_V1_LockerHomeState
    let send: (Centraid_Core_V1_LockerHomeEvent) -> Void
    let sendWall: (Centraid_Core_V1_LockerWallEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onWords: () -> Void
    let onHome: () -> Void

    @Environment(\.colorScheme) private var scheme

    /// The vault refused Locker: the page's gate. It has no band, search or add.
    private var isDenied: Bool {
        if case .refused? = state.page.state { return true }
        return false
    }

    private var searchField: KitSearchField {
        var field = KitSearchField()
        field.open = state.search.open
        field.term = state.search.term
        field.corrected = state.search.corrected
        return field
    }

    var body: some View {
        let covered = state.hasWall
        AppPlace(
            app: "locker",
            title: state.chrome.title,
            trailing: covered || isDenied || state.chrome.addLabel.isEmpty
                ? nil
                : RoomAction(iconKey: "Plus", label: state.chrome.addLabel, identifier: "locker-add") {
                    open(state.chrome.addRoute)
                },
            search: covered || isDenied ? nil : SearchSlot(
                field: searchField,
                placeholder: state.chrome.searchPlaceholder,
                closeLabel: state.chrome.closeLabel,
                onOpen: { send(LockerHomeEvents.make { $0.searchOpened = .init() }) },
                onTerm: { term in send(LockerHomeEvents.make { $0.searchTyped = .with { $0.term = term } }) },
                onClose: { send(LockerHomeEvents.make { $0.searchClosed = .init() }) }
            ),
            // THE LOCK KEY (#1173): cover every item now, Rust's own event.
            lead: covered || isDenied || state.chrome.lockLabel.isEmpty
                ? nil
                : RoomAction(iconKey: "Lock", label: state.chrome.lockLabel, identifier: "locker-lock") {
                    send(LockerHomeEvents.make { $0.lockRequested = .init() })
                },
            filter: covered ? nil : filterSlot(),
            showsBand: !isDenied
        ) {
            AppBand(
                app: "locker",
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
                    send(LockerHomeEvents.make { $0.band = .with { $0.key = key } })
                },
                locked: state.bandLocked,
                onHome: onHome
            )
        } content: {
            if state.hasWall {
                let wall = state.wall
                LockerWallView(wall: wall, send: sendWall, onWords: onWords)
            } else {
                // OPEN, AND SHIELDED FROM CAPTURE while Rust says `secure`.
                LockerShield(secure: state.secure) { unlocked() }
            }
        }
        .sheet(isPresented: sheetBinding(.more)) {
            OptionSheet(title: state.chrome.moreTitle) {
                ForEach(state.chrome.moreRows, id: \.key) { row in
                    SheetRow(
                        iconKey: row.iconKey,
                        label: row.label,
                        identifier: "locker-more-\(row.key)",
                        onTap: { more(row) }
                    )
                }
            }
        }
        .sheet(isPresented: sheetBinding(.facts)) {
            SheetRoom(title: state.chrome.factsTitle) {
                VStack(spacing: 0) {
                    ForEach(Array(state.chrome.facts.enumerated()), id: \.offset) { _, fact in
                        FieldRow(key: fact.label, value: fact.detail)
                    }
                }
            }
        }
    }

    /// What an open Locker draws under its header: the tab's list, or the generator.
    @ViewBuilder
    private func unlocked() -> some View {
        PageReadStateView(
            page: state.page,
            onRetry: { send(LockerHomeEvents.make { $0.refreshed = .init() }) },
            onEmptyAction: { open(state.chrome.addRoute) }
        ) {
            if case let .data(home)? = state.content {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        switch state.destination {
                        case .review: review(home)
                        case .search: search(home)
                        case .generate: LockerGeneratorView(generator: home.generator, send: send, open: open)
                        default: items(home)
                        }
                    }
                    .padding(.bottom, 16)
                }
                .refreshable { send(LockerHomeEvents.make { $0.refreshed = .init() }) }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if state.hasStatus {
                StatusLineView(status: state.status, identifier: "locker-home-status")
                    .padding(.vertical, 4)
                    .background(Theme.color("bg", scheme))
            }
        }
    }

    // MARK: Tabs

    @ViewBuilder
    private func items(_ home: Centraid_Core_V1_LockerHomeData) -> some View {
        if home.listTitle.isEmpty {
            landing(home)
        } else {
            list(home)
        }
    }

    /// THE LANDING: the six category cards, then Starred and Recently used. Rust decides every
    /// count, label and colour; this lays them out.
    @ViewBuilder
    private func landing(_ home: Centraid_Core_V1_LockerHomeData) -> some View {
        LockerNote(text: home.statusLine)
        if !home.categories.isEmpty {
            KitCardGrid(items: home.categories) { category in
                LockerCategoryCard(category: category) {
                    if category.hasRoute {
                        open(category.route)
                    } else {
                        send(LockerHomeEvents.make { $0.categoryPicked = .with { $0.key = category.key } })
                    }
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 8)
        }
        if !home.starred.isEmpty {
            LockerRowGroup(title: home.starredTitle, rows: home.starred, open: open)
        }
        if !home.recent.isEmpty {
            LockerRowGroup(title: home.recentTitle, rows: home.recent, open: open)
        }
    }

    /// ONE CATEGORY'S LIST, with the chevron back to the landing (the Items key does the same).
    @ViewBuilder
    private func list(_ home: Centraid_Core_V1_LockerHomeData) -> some View {
        HStack(spacing: 4) {
            Button {
                send(LockerHomeEvents.make { $0.categoryClosed = .init() })
            } label: {
                CentraidIconView(iconKey: "ChevronLeft", tint: Surface.ink, size: 18)
                    .frame(minWidth: 30, minHeight: CentraidGeometry.targetMinCoarse)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(KitWords.backTo(parent: home.listBackLabel))
            .accessibilityIdentifier("locker-category-back")
            Text(home.listTitle).kitType(.section).foregroundStyle(Surface.ink)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, CentraidGeometry.pageMargin - 6)
        if !home.rows.isEmpty {
            LockerRowGroup(title: "", rows: home.rows, open: open)
        }
        LockerNote(text: home.window)
    }

    @ViewBuilder
    private func review(_ home: Centraid_Core_V1_LockerHomeData) -> some View {
        LockerNote(text: home.reviewNote)
        if home.hasReviewClear {
            EmptyStateView(home.reviewClear)
        }
        ForEach(home.review, id: \.key) { section in
            SectionHeader(title: section.head.title, count: section.head.count)
            LockerNote(text: section.reason)
            // ONE ITEM CAN BE IN TWO VERDICTS, and a `LazyVStack` flattens nested
            // `ForEach`es into one identity space: the section key scopes it.
            ForEach(section.rows.map { LockerReviewEntry(section: section.key, row: $0) }) { entry in
                LockerRowView(row: entry.row) { open(entry.row.route) }
            }
        }
        if !home.reviewUnchecked.isEmpty {
            SectionHeader(title: home.reviewUncheckedTitle)
            ForEach(Array(home.reviewUnchecked.enumerated()), id: \.offset) { _, fact in
                FieldRow(key: fact.label, value: fact.detail)
            }
        }
    }

    @ViewBuilder
    private func search(_ home: Centraid_Core_V1_LockerHomeData) -> some View {
        LockerNote(text: state.chrome.searchNote)
        ForEach(home.hits, id: \.itemID) { row in
            LockerRowView(row: row) { open(row.route) }
        }
    }

    /// THE ITEMS FILTER AS THE HEADER'S MENU (R-CHROME-3): only Items' data carries it, so the
    /// button is there on Items and nowhere else. A pick or the clear row is an event; which
    /// option is checked, and whether the funnel is lit, is Rust's.
    private func filterSlot() -> FilterSlot? {
        guard case let .data(home)? = state.content, home.hasFilterMenu else { return nil }
        return FilterSlot(
            menu: home.filterMenu,
            onPick: { section, option in
                send(LockerHomeEvents.make {
                    $0.filterMenuPicked = .with {
                        $0.sectionKey = section
                        $0.optionKey = option
                    }
                })
            },
            onClear: { send(LockerHomeEvents.make { $0.filterMenuCleared = .init() }) }
        )
    }

    // MARK: Intents

    /// A More row: it tells Rust (a sheet closes, `facts` opens its own, `lock`
    /// locks) and, when the row carries a route, the shell pushes it.
    private func more(_ row: Centraid_Core_V1_LockerMoreRow) {
        send(LockerHomeEvents.make { $0.more = .with { $0.key = row.key } })
        if row.hasRoute { open(row.route) }
    }

    private func sheetBinding(_ sheet: Centraid_Core_V1_LockerHomeState.Sheet) -> Binding<Bool> {
        Binding(
            get: { state.sheet == sheet && !state.hasWall },
            set: { isOpen in
                guard !isOpen, state.sheet == sheet else { return }
                send(LockerHomeEvents.make { $0.sheetClosed = .init() })
            }
        )
    }
}

/// THE GENERATOR (the handoff's Generate tab): a string without an item. Its
/// randomness is Rust's (the operating system's CSPRNG); the view draws the
/// candidate, its strength, the kind, the length, what it includes, and verbs.
struct LockerGeneratorView: View {
    let generator: Centraid_Core_V1_LockerGenerator
    let send: (Centraid_Core_V1_LockerHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // THE CANDIDATE, at the display rung in a bordered box. Never
            // selectable: copying is the Copy verb's, sensitive and expiring.
            Text(generator.output)
                .centraidType("mono")
                .foregroundStyle(Theme.color("text", scheme))
                .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
                .padding(12)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                        .strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline)
                )
                .accessibilityLabel(generator.accessibilityLabel)
                .accessibilityIdentifier("locker-generator-output")
            if !generator.strength.isEmpty {
                Text(generator.strength)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
            HStack(spacing: 8) {
                KitOutlineButton(label: generator.regenerateLabel) {
                    send(LockerHomeEvents.make { $0.generatorRegenerate = .init() })
                }
                .accessibilityIdentifier("locker-generator-regenerate")
                KitOutlineButton(label: generator.copyLabel) {
                    send(LockerHomeEvents.make { $0.generatorCopy = .init() })
                }
                .accessibilityIdentifier("locker-generator-copy")
            }
            if !generator.useLabel.isEmpty {
                KitInkButton(label: generator.useLabel) {
                    // Rust keeps the candidate for the editor; the shell pushes it.
                    send(LockerHomeEvents.make { $0.generatorUsed = .init() })
                    if generator.hasUseRoute { open(generator.useRoute) }
                }
                .accessibilityIdentifier("locker-generator-use")
            }
            SectionHeader(title: generator.kindsLabel).padding(.horizontal, -CentraidGeometry.pageMargin)
            LockerChoicePills(choices: generator.kinds, identifier: "locker-generator-kind") { key in
                send(LockerHomeEvents.make { $0.generatorKind = .with { $0.key = key } })
            }
            .padding(.horizontal, -CentraidGeometry.pageMargin)
            if generator.lengthMax > generator.lengthMin {
                Text(generator.lengthLabel)
                    .centraidType("smallStrong")
                    .foregroundStyle(Theme.color("text", scheme))
                Slider(
                    value: Binding(
                        get: { Double(generator.length) },
                        set: { value in
                            let length = UInt32(value.rounded())
                            if length != generator.length {
                                send(LockerHomeEvents.make { $0.generatorLength = .with { $0.length = length } })
                            }
                        }
                    ),
                    in: Double(generator.lengthMin)...Double(generator.lengthMax),
                    step: 1
                )
                .tint(Theme.color("text", scheme))
                .accessibilityLabel(generator.lengthLabel)
                .accessibilityIdentifier("locker-generator-length")
            }
            if !generator.include.isEmpty {
                SectionHeader(title: generator.includeLabel).padding(.horizontal, -CentraidGeometry.pageMargin)
                LockerChoicePills(choices: generator.include, identifier: "locker-generator-include") { key in
                    send(LockerHomeEvents.make { $0.generatorInclude = .with { $0.key = key } })
                }
                .padding(.horizontal, -CentraidGeometry.pageMargin)
            }
            if !generator.lookalikeNote.isEmpty {
                Text(generator.lookalikeNote)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textFaint", scheme))
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 12)
    }
}

/// A review row with its section: the identity a `LazyVStack` needs when one
/// item stands under two verdicts.
private struct LockerReviewEntry: Identifiable {
    let section: String
    let row: Centraid_Core_V1_LockerRow

    var id: String { section + "/" + row.itemID }
}
