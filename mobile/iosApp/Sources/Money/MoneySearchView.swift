import SwiftUI

/// `money.search` — the search key's page (R-CHROME-2; #1099).
///
/// Home's key is a door and never a field: it pushes this page, whose field is
/// open at once, at the foot. The words, the count line and the resting sentence are Rust's;
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
    private func field(_ state: Centraid_Core_V1_MoneySearchState) -> KitSearchField {
        var field = KitSearchField()
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
                PageReadStateView(
                    page: state.page,
                    onRetry: { send(event { $0.refreshed = .init() }) },
                    emptyExtra: {
                        // A term that found nothing still offers the Ask row under the empty sentence.
                        if case let .data(search)? = state.content, search.hasAsk {
                            return AnyView(SearchAskRow(ask: search.ask))
                        }
                        return AnyView(EmptyView())
                    }
                ) {
                    if case let .data(search)? = state.content {
                        results(search, state: state)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            // THE FIELD IS AT THE FOOT, over the keyboard, like every app's search (R-CHROME-2).
            .safeAreaInset(edge: .bottom, spacing: 0) {
                BandSearchField(
                    field: field(state),
                    placeholder: state.placeholder,
                    closeLabel: state.clearLabel_p.isEmpty ? KitWords.CLOSE_SEARCH : state.clearLabel_p,
                    identifier: "money-search",
                    keepsFocusOnClose: true,
                    onTerm: { term in send(event { $0.term = .with { $0.term = term } }) },
                    onClose: { send(event { $0.cleared = .init() }) }
                )
                .bandStrip()
            }
        }
    }

    @ViewBuilder
    private func results(_ search: Centraid_Core_V1_MoneySearchData, state: Centraid_Core_V1_MoneySearchState) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(search.countLabel)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
                    .padding(.horizontal, 4)
                    .accessibilityIdentifier("money-search-count")
                MoneyCardStack {
                    ForEach(Array(search.rows.enumerated()), id: \.offset) { index, row in
                        if index > 0 { KitHairline(inset: 64) }
                        MoneyTxnRow(row: row) { open(row.route) }
                    }
                }
                if search.hasAsk { SearchAskRow(ask: search.ask) }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.top, 8)
            .padding(.bottom, 16)
        }
    }

    private func countLine(_ sentence: String) -> Centraid_Core_V1_StatusLine {
        var line = Centraid_Core_V1_StatusLine()
        line.sentence = sentence
        return line
    }
}
