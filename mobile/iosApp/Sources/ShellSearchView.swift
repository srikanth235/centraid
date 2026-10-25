import SwiftUI

/// HOME'S SEARCH, DRAWN FROM RUST (#1135, lane H1; R-CHROME-6). The screen is
/// `home.search` (`crates/screens/src/shell/search.rs`): it asks the vault once
/// through the shell's named query, groups the hits by app, words every row and
/// carries the route each row opens. Home's search key pushes the route Home
/// gives it; this file draws `Centraid_Core_V1_HomeSearchState` and writes no copy.

/// THE PAGE: the kit's field with the scope beside it and Cancel after it, the
/// recent searches while the field is empty, then the answer grouped by app —
/// a hue dot, the app's name and its count over rows of kind and title. No
/// navigation bar: the field is the header.
struct ShellSearchView: View {
    let state: Centraid_Core_V1_HomeSearchState
    let send: (Centraid_Core_V1_HomeSearchEvent) -> Void
    /// Push the route a row, a container or the Ask carries.
    let open: (Centraid_Core_V1_Route) -> Void
    let onCancel: () -> Void

    @Environment(\.colorScheme) private var scheme

    private func event(_ build: (inout Centraid_Core_V1_HomeSearchEvent) -> Void) -> Centraid_Core_V1_HomeSearchEvent {
        var event = Centraid_Core_V1_HomeSearchEvent()
        build(&event)
        return event
    }

    private enum Found {
        case resting(Centraid_Core_V1_HomeSearchResting)
        case results(Centraid_Core_V1_HomeSearchData)
    }

    private var content: ScreenContent<Found> {
        switch state.content {
        case let .resting(resting)?: return .data(.resting(resting))
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .gated(denied)
        case let .data(data)?: return .data(.results(data))
        case nil: return .loading(true)
        }
    }

    /// The field as Rust holds it: open at once, with the term typed so far.
    private var field: Centraid_Screen_V1_SearchField {
        var field = Centraid_Screen_V1_SearchField()
        field.open = true
        field.term = state.term
        return field
    }

    var body: some View {
        VStack(spacing: 0) {
            // TOP-ALIGNED: the field can carry the corrected line under it, and
            // Cancel stays beside the capsule and not beside the line.
            HStack(alignment: .top, spacing: 4) {
                VStack(alignment: .leading, spacing: 4) {
                    CentraidSearchField(
                        field: field,
                        placeholder: state.chrome.placeholder,
                        closeLabel: state.chrome.closeLabel,
                        identifier: "home-search",
                        scope: state.chrome.scopeLabel,
                        closes: false,
                        onSubmit: { send(event { $0.committed = .init() }) },
                        onTerm: { term in send(event { $0.term = .with { $0.term = term } }) },
                        onClose: {}
                    )
                    // THE LINE UNDER THE FIELD, finished by Rust.
                    if case let .data(data)? = state.content, !data.corrected.isEmpty {
                        Text(data.corrected)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                            .lineLimit(2)
                            .padding(.leading, BandMetrics.searchGlyphLead)
                            .accessibilityIdentifier("search-corrected")
                    }
                }
                KitLink(label: state.chrome.cancel, identifier: "home-search-cancel") {
                    send(event { $0.cleared = .init() })
                    onCancel()
                }
                .frame(height: 40)
            }
            .padding(.leading, CentraidGeometry.pageMargin)
            .padding(.trailing, CentraidGeometry.pageMargin - 4)
            .padding(.vertical, 8)
            ReadStateView(
                content: content,
                loadingLabel: state.chrome.loading,
                onRetry: { send(event { $0.refreshed = .init() }) },
                retryLabel: state.chrome.retry
            ) { found in
                switch found {
                case let .resting(resting):
                    RestingView(resting: resting) { term in
                        send(event { $0.suggestion = .with { $0.term = term } })
                    }
                case let .results(results):
                    if results.hasEmpty {
                        // NOTHING MATCHED: the sentence, and the Ask row under it.
                        EmptyStateView(results.empty.legacy)
                        askRow(results)
                    } else {
                        groups(results)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Theme.color("bg", scheme).ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
    }

    /// THE ASK ROW closes the answer, matched or not; pressing it records the search.
    @ViewBuilder
    private func askRow(_ results: Centraid_Core_V1_HomeSearchData) -> some View {
        if results.hasAsk {
            // The Ask's finished route (`chat.ask`) is pushed like any row.
            SearchAskRow(ask: results.ask.legacy, onAsk: { send(event { $0.committed = .init() }) }) {
                if results.hasAskRoute { open(results.askRoute) }
            }
        }
    }

    /// Record the search, then push the row's page.
    private func commit(_ route: Centraid_Core_V1_Route?) {
        send(event { $0.committed = .init() })
        if let route { open(route) }
    }

    private func groups(_ results: Centraid_Core_V1_HomeSearchData) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(results.groups, id: \.appID) { group in
                    GroupHeader(group: group)
                    // CONTAINERS FIRST (#1097): the notebook, project, group or folder whose name matched.
                    ForEach(group.containers, id: \.id) { container in
                        SearchContainerRow(container: container.legacy) { _ in
                            commit(container.hasRoute ? container.route : nil)
                        }
                    }
                    ForEach(group.rows, id: \.id) { row in
                        HitRow(row: row) { commit(row.hasRoute ? row.route : nil) }
                    }
                }
                askRow(results)
            }
            .padding(.bottom, 16)
        }
        .scrollDismissesKeyboard(.immediately)
    }
}

/// The empty field: what search reaches, then this session's searches as chips.
private struct RestingView: View {
    let resting: Centraid_Core_V1_HomeSearchResting
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
    let group: Centraid_Core_V1_HomeSearchGroup

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
    let row: Centraid_Core_V1_HomeSearchRow
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
