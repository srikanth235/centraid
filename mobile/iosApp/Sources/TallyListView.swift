import SwiftUI

/// The Tally list, in SwiftUI (#1020, D-1020-E3).
///
/// **THREE BRANCHES, NEVER TWO.** The `switch` below is over the state's
/// content case — loading, failure, data — and the failure branch renders a
/// sentence. A `if let rows = state.rows` would be the two-branch shape the
/// read law exists to forbid, and it is the shape SwiftUI's optional binding
/// invites.
struct TallyListView: View {
    @ObservedObject var shell: ShellModel

    /// The decoded state. In the wired build this comes from
    /// `Centraid_screen_v1_TallyListState(serializedData:)` over
    /// `shell.tallyState`; the SwiftProtobuf types are generated from the same
    /// `crates/api-proto/proto` tree the Kotlin side reads.
    var state: TallyListStateView { TallyListStateView(data: shell.tallyState) }

    var body: some View {
        VStack(alignment: .leading) {
            HStack {
                ForEach(state.bands, id: \.self) { band in
                    Button(band.label) { shell.send(screen: "tally.list", event: band.event) }
                }
                Button {
                    shell.send(screen: "tally.list", event: state.refreshEvent)
                } label: {
                    Image(systemName: "arrow.clockwise")
                        // AN ICON-ONLY CONTROL CARRIES A LABEL.
                        // `NativeAccessibilityLintSpec` in mobile/shared's
                        // jvmTest fails the build when one does not — and it is
                        // net-new work, because v0's two accessibility gates are
                        // both web-shaped (census §E8).
                        .accessibilityLabel("Refresh")
                }
            }

            if state.recurringWithheld {
                Text("Centraid adds recurring expenses when it can reach your gateway.")
            }

            switch state.content {
            case let .loading(firstLoad):
                if firstLoad {
                    ProgressView()
                } else {
                    Text("Refreshing")
                }
            case let .failure(sentence, remedy):
                VStack(alignment: .leading) {
                    Text(sentence)
                    if !remedy.isEmpty { Text(remedy) }
                }
            case let .data(rows):
                if rows.isEmpty {
                    // AN EMPTY LEDGER IS ITS OWN SENTENCE, and a different one
                    // from any failure above.
                    Text("Nothing here yet.")
                } else {
                    List(rows, id: \.identifier) { row in
                        HStack {
                            Text(row.description)
                            Spacer()
                            Text(row.amount)
                            if row.pending { Text("Saving") }
                        }
                    }
                }
            }
        }
        .padding()
        .navigationTitle("Tally")
    }
}
