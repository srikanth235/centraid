import SwiftUI

import CentraidShared

/// HOME'S SEARCH, REGISTERED (R-CHROME-6). Not an app — Home is not one — so
/// `ShellModel` registers it beside `AppRegistry.apps`, by the machine's
/// `SCREEN_ID`, and Home's search bar pushes `route`.
///
/// **`Opened` IS SENT AT THE PUSH, NOT ON APPEARANCE.** The registry sends a
/// route's `open` every time it appears, and this screen appears again when a
/// member comes back from a row they opened — which must find the results they
/// left, not a fresh field. So the route's `open` does nothing, and the bar
/// sends `Opened` before it pushes (`open(_:)`).
enum HomeSearchScreens {
    /// `HomeSearchMachine.SCREEN_ID`.
    static let screen = HomeSearchMachine.shared.SCREEN_ID

    static let route = ShellModel.Route.screen(screen, Data())

    static func event(_ build: (inout Centraid_Screen_V1_HomeSearchEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_HomeSearchEvent()
        build(&event)
        return event.encoded
    }

    /// Home's bar: a fresh field, then the page.
    @MainActor
    static func open(_ shell: ShellModel) {
        // THIS SHELL HAS A CHAT TAB (R-1097-24): the machine draws the member's
        // conversations as a group only when the shell says so.
        shell.send(screen: screen, event: event { $0.opened = .with { $0.chatTab = true } })
        shell.path.append(route)
    }

    @MainActor
    static func register(into shell: ShellModel) {
        shell.register(.of(screen, HomeSearchBridge()))
        shell.route(
            screen,
            open: { _ in },
            view: { shell, _ in
                AnyView(HomeSearchView(
                    data: shell.state(screen),
                    send: { [weak shell] in shell?.send(screen: screen, event: $0) },
                    open: { [weak shell] target, among, parent in
                        guard let shell else { return }
                        // A conversation opens in the Chat tab, not as a page over Search.
                        if ChatRouting.isThread(target) {
                            shell.openChatThread(target.id, title: target.title)
                            return
                        }
                        guard let route = ChatRouting.route(for: target, among: among, parent: parent) else { return }
                        shell.path.append(route)
                    },
                    openContainer: { [weak shell] container, parent in
                        guard let shell else { return }
                        shell.send(screen: screen, event: event { $0.container = .with { $0.container = container } })
                        shell.openRow(container.target, parent: parent)
                    },
                    onCancel: { [weak shell] in
                        guard let shell, !shell.path.isEmpty else { return }
                        shell.path.removeLast()
                    }
                ))
            }
        )
    }
}

/// THE PAGE: the kit's field with the scope beside it and Cancel after it, the
/// recent searches while the field is empty, then the answer grouped by app —
/// a hue dot, the app's name and its count over rows of kind and title. No
/// navigation bar: the field is the header. Every word, the order and where a
/// row opens arrive finished in `HomeSearchState`.
struct HomeSearchView: View {
    let data: Data
    let send: (Data) -> Void
    /// Open a row's target through the one router a row reference has.
    let open: (Centraid_Screen_V1_ChatCard, [Centraid_Screen_V1_ChatCard], String) -> Void
    /// Open a container found by name (#1097) through the same router.
    let openContainer: (Centraid_Screen_V1_SearchContainer, String) -> Void
    let onCancel: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_HomeSearchState {
        (try? Centraid_Screen_V1_HomeSearchState(serializedBytes: data)) ?? .init()
    }

    private enum Found {
        case resting(Centraid_Screen_V1_HomeSearchResting)
        case results(Centraid_Screen_V1_HomeSearchData)
    }

    private func content(_ state: Centraid_Screen_V1_HomeSearchState) -> ScreenContent<Found> {
        switch state.content {
        case let .resting(resting)?: return .data(.resting(resting))
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(.results(data))
        case nil: return .loading(true)
        }
    }

    var body: some View {
        let state = state
        VStack(spacing: 0) {
            // TOP-ALIGNED: the field can carry the corrected line under it, and
            // Cancel stays beside the capsule and not beside the line.
            HStack(alignment: .top, spacing: 4) {
                CentraidSearchField(
                    field: state.field,
                    placeholder: state.chrome.placeholder,
                    closeLabel: state.chrome.closeLabel,
                    identifier: "home-search",
                    scope: state.chrome.scopeLabel,
                    closes: false,
                    onSubmit: { send(HomeSearchScreens.event { $0.submitted = .init() }) },
                    onTerm: { term in send(HomeSearchScreens.event { $0.term = .with { $0.term = term } }) },
                    onClose: {}
                )
                KitLink(label: state.chrome.cancel, identifier: "home-search-cancel") {
                    send(HomeSearchScreens.event { $0.cancelled = .init() })
                    onCancel()
                }
                .frame(height: 40)
            }
            .padding(.leading, CentraidGeometry.pageMargin)
            .padding(.trailing, CentraidGeometry.pageMargin - 4)
            .padding(.vertical, 8)
            ReadStateView(
                content: content(state),
                loadingLabel: state.chrome.loading,
                onRetry: { send(HomeSearchScreens.event { $0.refreshed = .init() }) }
            ) { found in
                switch found {
                case let .resting(resting):
                    RestingView(resting: resting) { term in
                        send(HomeSearchScreens.event { $0.suggestion = .with { $0.term = term } })
                    }
                case let .results(results):
                    if results.hasEmpty {
                        // NOTHING MATCHED: the sentence, and the Ask row under it.
                        EmptyStateView(results.empty)
                        askRow(state)
                    } else {
                        groups(results, parent: state.chrome.title, ask: askRow(state))
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Theme.color("bg", scheme).ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
    }

    /// THE ASK ROW closes the answer, matched or not (#1135); pressing it records the search.
    @ViewBuilder
    private func askRow(_ state: Centraid_Screen_V1_HomeSearchState) -> some View {
        if state.field.hasAskRow {
            SearchAskRow(ask: state.field.askRow) { send(HomeSearchScreens.event { $0.asked = .init() }) }
        }
    }

    private func groups(_ results: Centraid_Screen_V1_HomeSearchData, parent: String, ask: some View) -> some View {
        let targets = results.groups.flatMap { $0.rows.map(\.target) }
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(results.groups, id: \.appID) { group in
                    GroupHeader(group: group)
                    // CONTAINERS FIRST (#1097): the notebook, project, group or folder whose name matched.
                    ForEach(group.containers, id: \.id) { container in
                        SearchContainerRow(container: container) { _ in openContainer(container, parent) }
                    }
                    ForEach(group.rows, id: \.id) { row in
                        HitRow(row: row) {
                            send(HomeSearchScreens.event { $0.row = .with { $0.row = row } })
                            open(row.target, targets.filter { $0.app == row.target.app && $0.entity == row.target.entity }, parent)
                        }
                    }
                }
                ask
            }
            .padding(.bottom, 16)
        }
        .scrollDismissesKeyboard(.immediately)
    }
}

/// The empty field: what search reaches, then this session's searches as chips.
private struct RestingView: View {
    let resting: Centraid_Screen_V1_HomeSearchResting
    let onPick: (String) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text(resting.note)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                if !resting.suggestions.isEmpty {
                    SectionHeader(title: resting.suggestionsLabel)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(resting.suggestions, id: \.self) { term in
                                KitChip(label: term, selected: false, identifier: "home-search-recent-\(term)") {
                                    onPick(term)
                                }
                            }
                        }
                        .padding(.horizontal, CentraidGeometry.pageMargin)
                    }
                }
            }
            .padding(.top, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDismissesKeyboard(.immediately)
    }
}

/// One app's head: its hue dot, its name in the section micro-label, its count.
private struct GroupHeader: View {
    let group: Centraid_Screen_V1_HomeSearchGroup

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            Circle()
                .fill(scheme.centraidMarks[group.appID]?.hue ?? Theme.color("textFaint", scheme))
                .frame(width: 8, height: 8)
            Text(group.label)
                .centraidType("eyebrow")
                .foregroundStyle(Theme.color("textSoft", scheme))
            Spacer(minLength: 0)
            Text("\(group.count)")
                .centraidType("eyebrow")
                .monospacedDigit()
                .foregroundStyle(Theme.color("textFaint", scheme))
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.top, 16)
        .padding(.bottom, 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(group.accessibilityLabel)
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("home-search-group-\(group.appID)")
    }
}

/// One hit: the kind in a soft fixed column, then the title on one line.
private struct HitRow: View {
    let row: Centraid_Screen_V1_HomeSearchRow
    let onTap: () -> Void

    @Environment(\.colorScheme) private var scheme

    /// The kind column's width: "Document" at the body rung, so titles align.
    private static let kindColumn: CGFloat = 88

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(row.kindLabel)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .lineLimit(1)
                    .frame(width: Self.kindColumn, alignment: .leading)
                Text(row.title)
                    .centraidType("body")
                    .foregroundStyle(Theme.color("text", scheme))
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
            .overlay(alignment: .bottom) { KitHairline() }
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("home-search-row-\(row.entity)-\(row.id)")
    }
}
