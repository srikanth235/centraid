import SwiftUI

/// THE KIT'S TRASH, WHEN RUST OWNS IT (#1135; `kit_screens.proto`'s `TrashView`).
///
/// The twin of `TrashListView` for the apps whose screens are Rust's: the same
/// page, the same row and the same confirm, over `ViewState.trash`. Every word
/// is on the state (the title and back words, the rows' meta and verbs, the
/// empty state, "Empty trash", the confirm and the refusal's line); the view
/// sends `TrashEvent`s and the shell pops it when the back control says so.
struct CoreTrashView: View {
    let state: Centraid_Core_V1_TrashView
    let send: (Centraid_Core_V1_TrashEvent) -> Void
    let onBack: () -> Void

    private func event(_ build: (inout Centraid_Core_V1_TrashEvent) -> Void) {
        var event = Centraid_Core_V1_TrashEvent()
        build(&event)
        send(event)
    }

    private var content: ScreenContent<Centraid_Core_V1_TrashData> {
        switch state.content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .gated(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }

    var body: some View {
        PushedPage(title: state.title, parentTitle: state.backLabel, onBack: onBack) {
            EmptyView()
        } content: {
            VStack(spacing: 0) {
                ReadStateView(
                    content: content,
                    onRetry: { event { $0.kind = .refreshed(.init()) } }
                ) { data in
                    if data.rows.isEmpty {
                        EmptyStateView(data.empty.legacy)
                    } else {
                        ScrollView {
                            LazyVStack(spacing: 0) {
                                SectionHeader(
                                    title: state.title,
                                    count: UInt32(data.rows.count),
                                    verb: data.emptyLabel,
                                    onVerb: { event { $0.kind = .empty(.init()) } }
                                )
                                ForEach(data.rows, id: \.id) { row in
                                    TrashRowView(
                                        row: row.legacy,
                                        onRestore: { event { $0.kind = .restore(.with { $0.id = row.id }) } },
                                        onPurge: { event { $0.kind = .purge(.with { $0.id = row.id }) } }
                                    )
                                }
                            }
                        }
                        .refreshable { event { $0.kind = .refreshed(.init()) } }
                    }
                }
                StatusLineView(status: state.status.legacy, identifier: "trash-status-action") {}
            }
        }
        .sheet(isPresented: Binding(
            get: { state.hasConfirm },
            set: { open in if !open, state.hasConfirm { event { $0.kind = .dismissed(.init()) } } }
        )) {
            ConfirmSheet(
                state.confirm.legacy,
                onConfirm: { event { $0.kind = .confirmed(.init()) } },
                onDismiss: { event { $0.kind = .dismissed(.init()) } }
            )
            .modifier(SheetPresentation(detents: ConfirmSheet.detents))
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("\(state.appID)-trash")
    }
}
