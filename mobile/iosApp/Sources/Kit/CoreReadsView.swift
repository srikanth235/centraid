import SwiftUI

/// THE KIT'S "WHAT <APP> MAY READ", WHEN RUST OWNS IT (`kit_screens.proto`'s `ReadsView`).
///
/// One page for Notes, Docs, Money and People, opened from their More sheet by the Shield row, as
/// Calendar's, Reminders' and Health's reads are. Every word is on the state (the title, the back
/// control's words, a label and its detail per fact); the page sends nothing, and the shell pops it
/// when the back control says so.
struct CoreReadsView: View {
    let state: Centraid_Core_V1_ReadsView
    let onBack: () -> Void

    var body: some View {
        PushedPage(title: state.title, parentTitle: state.backLabel, onBack: onBack) {
            EmptyView()
        } content: {
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(Array(state.facts.enumerated()), id: \.offset) { _, fact in
                        FieldRow(key: fact.label, value: fact.detail)
                    }
                }
                .padding(.top, 4)
                .accessibilityIdentifier("\(state.appID)-reads")
            }
        }
    }
}
