import SwiftUI

#if canImport(CentraidShared)
import CentraidShared
#endif

/// LOCKER'S HOME — Items · Review · Generate · Search, More as a sheet
/// (#1047; the handoff's Locker §1).
///
/// **THE VIEW DECIDES NOTHING.** The band (empty while locked), the filter
/// pills, the rows, the review verdicts, the search note, every empty and
/// every word are `LockerHomeState`'s; the wall is `LockerLockState`'s.
/// GENERATE draws the generator's own state (`LockerGeneratorState`) in the
/// band's slot, on its own bridge.
struct LockerHomeView: View {
    let data: Data
    let lock: Data
    let generator: Data
    let send: (Data) -> Void
    let sendLock: (Data) -> Void
    let sendGenerator: (Data) -> Void
    let push: (ShellModel.Route) -> Void
    let onHome: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_LockerHomeState {
        (try? Centraid_Screen_V1_LockerHomeState(serializedBytes: data)) ?? .init()
    }

    static func event(_ build: (inout Centraid_Screen_V1_LockerHomeEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_LockerHomeEvent()
        build(&event)
        return event.encoded
    }

    private func content(_ state: Centraid_Screen_V1_LockerHomeState) -> ScreenContent<Centraid_Screen_V1_LockerHomeData> {
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
        let lockState = Centraid_Screen_V1_LockerLockState.of(lock)
        let covered = lockState.covers
        let content = content(state)
        AppPlace(
            app: "locker",
            title: state.chrome.title,
            search: covered ? nil : SearchSlot(
                field: state.search,
                placeholder: state.chrome.searchPlaceholder,
                onTerm: { term in send(Self.event { $0.searchTyped = .with { $0.term = term } }) },
                onClose: { send(Self.event { $0.searchClosed = .init() }) }
            ),
            showsBand: !content.isDenied
        ) {
            if !covered, !content.isDenied, !state.chrome.addLabel.isEmpty {
                Button(action: addItem) {
                    Text(state.chrome.addLabel)
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color("text", scheme))
                        .padding(.horizontal, 8)
                        .frame(minHeight: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("locker-add")
            }
        } band: {
            AppBand(
                app: "locker",
                tabs: covered ? [] : state.band.map { tab in
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
            if covered {
                LockerWall(lock: lockState, sendLock: sendLock)
            } else {
                // OPEN, AND SHIELDED FROM CAPTURE while the gate says `secure`.
                LockerShield(lock: lock) { unlocked(state, content) }
            }
        }
        // THE GENERATOR OPENS WHEN ITS TAB DOES: it reads nothing, and a
        // candidate is minted on its own `Opened`.
        .onChange(of: state.destination) { _, destination in
            if destination == .generate { sendGenerator(LockerGeneratorView.event { $0.opened = .init() }) }
        }
        .onAppear {
            if state.destination == .generate { sendGenerator(LockerGeneratorView.event { $0.opened = .init() }) }
        }
        .sheet(isPresented: sheetBinding(state, .more)) {
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
        .sheet(isPresented: sheetBinding(state, .facts)) {
            SheetRoom(title: state.chrome.factsTitle) {
                VStack(spacing: 0) {
                    ForEach(Array(state.chrome.facts.enumerated()), id: \.offset) { _, fact in
                        FieldRow(key: fact.label, value: fact.detail)
                    }
                }
            }
        }
    }

    /// What an open Locker draws under its header: the generator in the
    /// band's slot, else the tab's list.
    @ViewBuilder
    private func unlocked(
        _ state: Centraid_Screen_V1_LockerHomeState,
        _ content: ScreenContent<Centraid_Screen_V1_LockerHomeData>
    ) -> some View {
        if state.destination == .generate {
            LockerGeneratorView(
                data: generator,
                send: sendGenerator,
                onUse: {
                    sendGenerator(LockerGeneratorView.event { $0.use = .init() })
                    push(LockerScreens.addFromGeneratorRoute)
                }
            )
        } else {
            ReadStateView(
                content: content,
                onRetry: { send(Self.event { $0.refreshed = .init() }) }
            ) { home in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        switch state.destination {
                        case .review: review(home)
                        case .search: search(home, state)
                        default: items(home, state)
                        }
                    }
                    .padding(.bottom, 16)
                }
                .refreshable { send(Self.event { $0.refreshed = .init() }) }
            }
        }
    }

    // MARK: Tabs

    @ViewBuilder
    private func items(_ home: Centraid_Screen_V1_LockerHomeData, _ state: Centraid_Screen_V1_LockerHomeState) -> some View {
        LockerNote(text: home.statusLine)
        LockerChoicePills(choices: home.filters, identifier: "locker-filter") { key in
            send(Self.event { $0.filter = .with { $0.key = key } })
        }
        if home.hasItemsEmpty {
            EmptyStateView(home.itemsEmpty, onAction: home.itemsEmpty.actionLabel.isEmpty ? nil : addItem)
        }
        ForEach(home.rows, id: \.itemID) { row in
            LockerRowView(row: row) { open(row, state) }
        }
        LockerNote(text: home.window)
    }

    @ViewBuilder
    private func review(_ home: Centraid_Screen_V1_LockerHomeData) -> some View {
        LockerNote(text: home.reviewNote)
        if home.hasReviewClear {
            EmptyStateView(home.reviewClear)
        }
        ForEach(home.review, id: \.key) { section in
            SectionHeader(section.head)
            LockerNote(text: section.reason)
            // ONE ITEM CAN BE IN TWO VERDICTS — the demo's forum login is
            // compromised AND on `http://` — and a `LazyVStack` flattens nested
            // `ForEach`es into one identity space, so a bare `itemID` drew the
            // second section's row as nothing. The section key scopes it, as
            // Android's `"r-" + section.key + "-" + item_id` key does.
            ForEach(section.rows.map { LockerReviewEntry(section: section.key, row: $0) }) { entry in
                LockerRowView(row: entry.row) { open(entry.row, state) }
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
    private func search(_ home: Centraid_Screen_V1_LockerHomeData, _ state: Centraid_Screen_V1_LockerHomeState) -> some View {
        LockerNote(text: state.chrome.searchNote)
        if home.hasSearchEmpty {
            EmptyStateView(home.searchEmpty)
        }
        ForEach(home.hits, id: \.itemID) { row in
            LockerRowView(row: row) { open(row, state) }
        }
    }

    // MARK: Intents

    private func addItem() {
        send(Self.event { $0.add = .init() })
        push(LockerScreens.addRoute)
    }

    private func open(_ row: Centraid_Screen_V1_LockerRow, _ state: Centraid_Screen_V1_LockerHomeState) {
        send(Self.event { $0.item = .with { $0.itemID = row.itemID } })
        push(LockerScreens.itemRoute(row.itemID, parent: state.chrome.title))
    }

    /// A More row: `facts` is the machine's sheet; `trash` and `lock` are
    /// the shell's (a push, and the gate's `LockTapped`).
    private func more(_ row: Centraid_Screen_V1_LockerMoreRow) {
        send(Self.event { $0.more = .with { $0.key = row.key } })
        switch row.key {
        case "trash": push(LockerScreens.trashRoute)
        case "lock": sendLock(LockerLockSeam.event { $0.lock = .init() })
        default: break
        }
    }

    private func sheetBinding(
        _ state: Centraid_Screen_V1_LockerHomeState,
        _ sheet: Centraid_Screen_V1_LockerHomeState.Sheet
    ) -> Binding<Bool> {
        Binding(
            get: { state.sheet == sheet && !Centraid_Screen_V1_LockerLockState.of(lock).covers },
            set: { open in
                guard !open, state.sheet == sheet else { return }
                send(Self.event { $0.sheetClosed = .init() })
            }
        )
    }
}

/// One quiet line of the machine's — a status, a note, a window's end.
struct LockerNote: View {
    let text: String

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if !text.isEmpty {
            Text(text)
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color("textSoft", scheme))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.vertical, 8)
        }
    }
}

/// THE GENERATOR (the handoff's Generate tab): a string without an item. Its
/// randomness is the bridge's CSPRNG; the view draws the candidate, its
/// strength, the kind, the length, what it includes, and three verbs.
struct LockerGeneratorView: View {
    let data: Data
    let send: (Data) -> Void
    let onUse: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_LockerGeneratorState {
        (try? Centraid_Screen_V1_LockerGeneratorState(serializedBytes: data)) ?? .init()
    }

    static func event(_ build: (inout Centraid_Screen_V1_LockerGeneratorEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_LockerGeneratorEvent()
        build(&event)
        return event.encoded
    }

    var body: some View {
        let state = state
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                // THE CANDIDATE, at the display rung in a bordered box. Never
                // selectable: copying is the Copy verb's, local-only and expiring.
                Text(state.output)
                    .centraidType("mono")
                    .foregroundStyle(Theme.color("text", scheme))
                    .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
                    .padding(12)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                            .strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline)
                    )
                    .accessibilityLabel(state.accessibilityLabel)
                    .accessibilityIdentifier("locker-generator-output")
                if !state.strength.isEmpty {
                    Text(state.strength)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                }
                HStack(spacing: 8) {
                    KitOutlineButton(label: state.regenerateLabel) { send(Self.event { $0.regenerate = .init() }) }
                        .accessibilityIdentifier("locker-generator-regenerate")
                    KitOutlineButton(label: state.copyLabel) { send(Self.event { $0.copy = .init() }) }
                        .accessibilityIdentifier("locker-generator-copy")
                }
                if !state.useLabel.isEmpty {
                    KitInkButton(label: state.useLabel, action: onUse)
                        .accessibilityIdentifier("locker-generator-use")
                }
                SectionHeader(title: state.kindsLabel).padding(.horizontal, -CentraidGeometry.pageMargin)
                LockerChoicePills(choices: state.kinds, identifier: "locker-generator-kind") { key in
                    send(Self.event { $0.kindPicked = .with { $0.key = key } })
                }
                .padding(.horizontal, -CentraidGeometry.pageMargin)
                if state.lengthMax > state.lengthMin {
                    Text(state.lengthLabel)
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color("text", scheme))
                    Slider(
                        value: Binding(
                            get: { Double(state.length) },
                            set: { value in
                                let length = UInt32(value.rounded())
                                if length != state.length { send(Self.event { $0.length = .with { $0.length = length } }) }
                            }
                        ),
                        in: Double(state.lengthMin)...Double(state.lengthMax),
                        step: 1
                    )
                    .tint(Theme.color("text", scheme))
                    .accessibilityLabel(state.lengthLabel)
                    .accessibilityIdentifier("locker-generator-length")
                }
                if !state.include.isEmpty {
                    SectionHeader(title: state.includeLabel).padding(.horizontal, -CentraidGeometry.pageMargin)
                    LockerChoicePills(choices: state.include, identifier: "locker-generator-include") { key in
                        send(Self.event { $0.include = .with { $0.key = key } })
                    }
                    .padding(.horizontal, -CentraidGeometry.pageMargin)
                }
                if !state.lookalikeNote.isEmpty {
                    Text(state.lookalikeNote)
                        .centraidType("annotLabel")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 12)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if state.hasStatus {
                StatusLineView(status: state.status, identifier: "locker-generator-status") {}
            }
        }
        .modifier(LockerClipboardRunner(clip: state.hasClipboard ? state.clipboard : nil) { token in
            send(Self.event { $0.clipboardDone = .with { $0.token = token } })
        })
    }
}

/// A review row with its section: the identity a `LazyVStack` needs when one
/// item stands under two verdicts.
private struct LockerReviewEntry: Identifiable {
    let section: String
    let row: Centraid_Screen_V1_LockerRow

    var id: String { section + "/" + row.itemID }
}
