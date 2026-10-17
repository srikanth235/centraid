import SwiftUI

import CentraidShared

/// `money.search` — the search bar's page (R-CHROME-2; #1099).
///
/// Home's bar is a door and never a field: it pushes this page, whose field is
/// open at once. The words, the count line and the resting sentence are the
/// machine's; a container whose name matched (an account) is drawn through the
/// kit's container row above the rows, and a tap hands its reference to the
/// shell's one row router.
struct MoneySearchView: View {
    let data: Data
    let send: (Data) -> Void
    let onBack: () -> Void
    var openContainer: (Centraid_Screen_V1_ChatCard, String) -> Void = { _, _ in }

    private var state: Centraid_Screen_V1_MoneySearchState {
        (try? Centraid_Screen_V1_MoneySearchState(serializedBytes: data)) ?? .init()
    }

    private func event(_ build: (inout Centraid_Screen_V1_MoneySearchEvent) -> Void) -> Data {
        moneyEvent(Centraid_Screen_V1_MoneySearchEvent.self, build)
    }

    /// The field as the machine holds it; before its first state it is an open, empty one.
    private func field(_ state: Centraid_Screen_V1_MoneySearchState) -> Centraid_Screen_V1_SearchField {
        if state.hasField { return state.field }
        var field = Centraid_Screen_V1_SearchField()
        field.open = true
        return field
    }

    var body: some View {
        let state = state
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
                    EmptyStateView(resting)
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
    private func results(_ search: Centraid_Screen_V1_MoneySearchData, state: Centraid_Screen_V1_MoneySearchState) -> some View {
        if search.rows.isEmpty, search.hasEmpty {
            EmptyStateView(search.empty)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    // THE CONTAINERS WHOSE NAME MATCHED come first, in a plain stack above the rows.
                    SearchContainerList(containers: state.field.containers) { openContainer($0, state.chrome.title) }
                    LazyVStack(alignment: .leading, spacing: 0) {
                        StatusLineView(status: countLine(search.countLabel), identifier: "money-search-count") {}
                        ForEach(Array(search.rows.enumerated()), id: \.offset) { _, row in
                            let txnID = row.txnID
                            MoneyRowView(row: row) {
                                send(event { $0.transaction = .with { $0.txnID = txnID } })
                            }
                        }
                    }
                }
                .padding(.bottom, 16)
            }
        }
    }

    private func countLine(_ sentence: String) -> Centraid_Screen_V1_StatusLine {
        var line = Centraid_Screen_V1_StatusLine()
        line.sentence = sentence
        return line
    }
}
