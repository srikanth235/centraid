import SwiftUI

import CentraidShared

/// `money.search` — the search bar's page (R-CHROME-2; #1099).
///
/// Home's bar is a door and never a field: it pushes this page, whose field is
/// open at once. The words, the count line and the resting sentence are Rust's;
/// a row carries the `Route` of its transaction, and the term is Rust's too.
struct MoneySearchView: View {
    let state: Centraid_Core_V1_MoneySearchState
    let send: (Centraid_Core_V1_MoneySearchEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onBack: () -> Void

    private func event(_ build: (inout Centraid_Core_V1_MoneySearchEvent) -> Void) -> Centraid_Core_V1_MoneySearchEvent {
        var event = Centraid_Core_V1_MoneySearchEvent()
        build(&event)
        return event
    }

    /// The field as Rust holds it: open at once, with the term typed so far.
    private func field(_ state: Centraid_Core_V1_MoneySearchState) -> Centraid_Screen_V1_SearchField {
        var field = Centraid_Screen_V1_SearchField()
        field.open = true
        field.term = state.term
        return field
    }

    var body: some View {
        let chrome = state.chrome
        PushedPage(title: chrome.title, parentTitle: chrome.backLabel, onBack: onBack) {
            EmptyView()
        } content: {
            VStack(alignment: .leading, spacing: 0) {
                CentraidSearchField(
                    field: field(state),
                    placeholder: state.placeholder,
                    closeLabel: state.clearLabel_p.isEmpty ? KitWords.shared.CLOSE_SEARCH : state.clearLabel_p,
                    identifier: "money-search",
                    onTerm: { term in send(event { $0.term = .with { $0.term = term } }) },
                    onClose: { send(event { $0.cleared = .init() }) }
                )
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.top, 4)
                .padding(.bottom, 8)
                if case let .resting(resting)? = state.content {
                    EmptyStateView(resting.legacy)
                } else {
                    ReadStateView(
                        content: state.readContent,
                        onRetry: { send(event { $0.refreshed = .init() }) }
                    ) { search in
                        results(search, state: state)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func results(_ search: Centraid_Core_V1_MoneySearchData, state: Centraid_Core_V1_MoneySearchState) -> some View {
        if search.rows.isEmpty, search.hasEmpty {
            EmptyStateView(search.empty.legacy)
            Spacer(minLength: 0)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        StatusLineView(status: countLine(search.countLabel).legacy, identifier: "money-search-count") {}
                        ForEach(Array(search.rows.enumerated()), id: \.offset) { _, row in
                            MoneyRowView(row: row) { open(row.route) }
                        }
                    }
                }
                .padding(.bottom, 16)
            }
        }
    }

    private func countLine(_ sentence: String) -> Centraid_Core_V1_StatusLine {
        var line = Centraid_Core_V1_StatusLine()
        line.sentence = sentence
        return line
    }
}
