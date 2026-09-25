import SwiftUI

/// TALLY'S HOME — Balances · Activity · Groups, More as a sheet (#1046;
/// handoff "README - Tally" §1).
///
/// **THE VIEW DECIDES NOTHING.** One dashboard read serves all three tabs; the
/// hero, the rows, the empties and every word are `TallyHomeState`'s. The hero
/// draws one line per currency because the state carries one line per
/// currency — nothing here sums.
struct TallyHomeView: View {
    let data: Data
    let send: (Data) -> Void
    let push: (ShellModel.Route) -> Void
    let onHome: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_TallyHomeState {
        (try? Centraid_Screen_V1_TallyHomeState(serializedBytes: data)) ?? .init()
    }

    static func event(_ build: (inout Centraid_Screen_V1_TallyHomeEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_TallyHomeEvent()
        build(&event)
        return event.encoded
    }

    private func content(_ state: Centraid_Screen_V1_TallyHomeState) -> ScreenContent<Centraid_Screen_V1_TallyHomeData> {
        switch state.content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }

    var body: some View {
        let state = state
        let content = content(state)
        AppPlace(app: "tally", title: state.chrome.title, showsBand: !content.isDenied) {
            if !content.isDenied, !state.chrome.addExpense.isEmpty {
                Button {
                    addExpense()
                } label: {
                    Text(state.chrome.addExpense)
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color("text", scheme))
                        .padding(.horizontal, 8)
                        .frame(minHeight: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("tally-add-expense")
            }
        } band: {
            AppBand(
                app: "tally",
                tabs: state.band.map { tab in
                    BandView(
                        label: tab.label,
                        event: Self.event { $0.band = .with { $0.key = tab.key } },
                        iconKey: tab.iconKey,
                        selected: tab.current
                    )
                },
                onSelect: send,
                onHome: onHome
            )
        } content: {
            ReadStateView(
                content: content,
                loadingLabel: state.chrome.loading,
                onRetry: { send(Self.event { $0.refreshed = .init() }) }
            ) { home in
                if home.dayOne {
                    EmptyStateView(home.dayOneEmpty, onAction: addExpense)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            switch state.destination {
                            case .activity: activity(home, state)
                            case .groups: groups(home)
                            default: balances(home, state)
                            }
                        }
                        .padding(.bottom, 16)
                    }
                    .refreshable { send(Self.event { $0.refreshed = .init() }) }
                }
            }
        }
        .sheet(isPresented: sheetBinding(state, .more)) {
            OptionSheet(title: state.chrome.moreTitle) {
                ForEach(state.chrome.moreRows, id: \.key) { row in
                    SheetRow(
                        iconKey: row.iconKey,
                        label: row.label,
                        identifier: "tally-more-\(row.key)",
                        onTap: { more(row, state) }
                    )
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("tally-more-sheet")
        }
        .sheet(isPresented: sheetBinding(state, .reads)) {
            SheetRoom(title: state.chrome.readsTitle) {
                VStack(spacing: 0) {
                    ForEach(Array(state.chrome.readsFacts.enumerated()), id: \.offset) { _, fact in
                        FieldRow(key: fact.label, value: fact.detail)
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("tally-reads-sheet")
        }
    }

    // MARK: Tabs

    @ViewBuilder
    private func balances(_ home: Centraid_Screen_V1_TallyHomeData, _ state: Centraid_Screen_V1_TallyHomeState) -> some View {
        TallyNote(text: home.statusLine)
        TallyHeroView(
            hero: home.hero,
            verbs: state.chrome.settleUp.isEmpty ? [] : [(state.chrome.settleUp, {
                send(Self.event { $0.settleUp = .init() })
                push(TallyScreens.settleUpRoute())
            })]
        )
        SectionHeader(title: home.friendsHeading, count: UInt32(home.friends.count))
        if home.hasAllSettled {
            EmptyStateView(home.allSettled)
        }
        ForEach(home.friends, id: \.person.partyID) { friend in
            TallyPersonRowView(
                person: friend.person,
                title: friend.person.name,
                meta: friend.meta,
                figures: friend.balances,
                accessibility: friend.accessibilityLabel,
                identifier: "tally-friend-\(friend.person.partyID)",
                onTap: {
                    send(Self.event { $0.friend = .with { $0.partyID = friend.person.partyID } })
                    push(TallyScreens.friendRoute(friend.person.partyID, friend.person.name))
                }
            )
        }
    }

    @ViewBuilder
    private func activity(_ home: Centraid_Screen_V1_TallyHomeData, _ state: Centraid_Screen_V1_TallyHomeState) -> some View {
        if home.hasActivityEmpty {
            EmptyStateView(home.activityEmpty)
        }
        ForEach(home.activity, id: \.day) { section in
            SectionHeader(title: section.heading)
            ForEach(section.rows, id: \.rowKey) { row in
                TallyLedgerRowView(row: row) { openRow(row) }
            }
        }
        TallyNote(text: home.activityWindow)
        ShowMoreFooter(
            visible: home.moreActivity,
            label: state.chrome.showMore,
            onMore: { send(Self.event { $0.showMore = .init() }) }
        )
    }

    @ViewBuilder
    private func groups(_ home: Centraid_Screen_V1_TallyHomeData) -> some View {
        if home.hasGroupsEmpty {
            EmptyStateView(home.groupsEmpty)
        }
        if !home.groups.isEmpty {
            SectionHeader(title: home.groupsHeading, count: UInt32(home.groups.count))
            ForEach(home.groups, id: \.groupID) { group in TallyGroupCard(group: group) { openGroup(group) } }
        }
        if !home.archivedGroups.isEmpty {
            SectionHeader(title: home.archivedHeading, count: UInt32(home.archivedGroups.count))
            ForEach(home.archivedGroups, id: \.groupID) { group in TallyGroupCard(group: group) { openGroup(group) } }
        }
    }

    // MARK: Intents

    private func addExpense() {
        send(Self.event { $0.addExpense = .init() })
        push(TallyScreens.addRoute())
    }

    private func openRow(_ row: Centraid_Screen_V1_TallyLedgerRow) {
        guard !row.expenseID.isEmpty else { return }
        send(Self.event { $0.expense = .with { $0.expenseID = row.expenseID } })
        push(TallyScreens.expenseRoute(row.expenseID))
    }

    private func openGroup(_ group: Centraid_Screen_V1_TallyGroupRow) {
        send(Self.event { $0.group = .with { $0.groupID = group.groupID } })
        push(TallyScreens.groupRoute(group.groupID, group.name))
    }

    /// A More row: the machine closes the sheet (or opens the facts); the
    /// route is the shell's. The keys are `TallyHomeMachine.MORE_*`.
    private func more(_ row: Centraid_Screen_V1_TallyMoreRow, _ state: Centraid_Screen_V1_TallyHomeState) {
        send(Self.event { $0.more = .with { $0.key = row.key } })
        switch row.key {
        case "settle": push(TallyScreens.settleUpRoute())
        case "recurring": push(TallyScreens.recurringRoute)
        case "spending": push(TallyScreens.spendingRoute)
        case "search": push(TallyScreens.searchRoute)
        case "trash": push(TallyScreens.trashRoute)
        case "export":
            // TODO(intent): ExportRequested — a share sheet of the ledger as
            // CSV. No screen state carries the export rows (tally-report
            // "Not done: the export screen"), so there is nothing to share yet.
            break
        default: break
        }
    }

    private func sheetBinding(
        _ state: Centraid_Screen_V1_TallyHomeState,
        _ sheet: Centraid_Screen_V1_TallyHomeState.Sheet
    ) -> Binding<Bool> {
        Binding(
            get: { state.sheet == sheet },
            set: { open in
                guard !open, state.sheet == sheet else { return }
                send(Self.event { $0.sheetClosed = .init() })
            }
        )
    }
}

/// A group card: hue mark, name, meta, and your net in its tone.
struct TallyGroupCard: View {
    let group: Centraid_Screen_V1_TallyGroupRow
    let onTap: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                TallyGroupMark(glyph: group.glyph, iconKey: group.iconKey, hue: group.hue)
                VStack(alignment: .leading, spacing: 2) {
                    Text(group.name)
                        .centraidType("body")
                        .foregroundStyle(Theme.color("text", scheme))
                        .lineLimit(1)
                    if !group.meta.isEmpty {
                        Text(group.meta)
                            .centraidType("annotLabel")
                            .foregroundStyle(Theme.color("textFaint", scheme))
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                if group.hasYourNet { TallyFigureView(figure: group.yourNet) }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                    .fill(Theme.color("bgElev", scheme))
            )
            .overlay(
                RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                    .strokeBorder(Theme.color("line", scheme), lineWidth: CentraidGeometry.hairline)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            group.hasYourNet ? "\(group.accessibilityLabel), \(tallyMoney(group.yourNet.amount))" : group.accessibilityLabel
        )
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("tally-group-\(group.groupID)")
    }
}

/// A group's mark: the glyph the member gave it ("🏔️") when there is one,
/// else its catalog icon in the group's hue, on a sunken 36pt tile.
struct TallyGroupMark: View {
    let glyph: String
    let iconKey: String
    let hue: String

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Group {
            if !glyph.isEmpty {
                Text(glyph).font(.system(size: 20))
            } else {
                CentraidIconView(iconKey: iconKey, tint: Theme.color(TallyInk.hue(hue), scheme), size: 20)
            }
        }
        .frame(width: 36, height: 36)
        .background(
            RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                .fill(Theme.color("bgSunken", scheme))
        )
        .accessibilityHidden(true)
    }
}
