import SwiftUI

/// THE TRASH, DRAWN ONCE FOR EVERY APP (K5; #1015 D1 "Empty trash everywhere").
///
/// One view over the kit's `TrashListState`, parameterised by the app the
/// state names — the native half of `TrashMachine(spec)`, which is law 2's
/// parameterised screen. A port registers its `<app>.trash` bridge and routes
/// here with its app id; it writes no trash view of its own.
///
/// Every word on it is the machine's: the title and back words, the rows'
/// meta, restore and purge labels, the
/// empty state, the "Empty trash" verb (absent when the app cannot destroy —
/// Docs today) and the confirm. Restore is a row verb; purge and empty ask
/// first, through `ConfirmSheet`, whose destructive button is the `net` outline.
///
/// `secure` is the port's capture shield (Locker's gate, D-10): the list and
/// its confirm are drawn in `WordsShield`'s secure canvas, the page's own
/// toolbar and the sheet's presentation stay outside it where they can reach
/// their navigation and their presentation. It is `false` for every other app.
struct TrashListView: View {
    let data: Data
    let send: (Data) -> Void
    let onBack: () -> Void
    var secure: Bool = false

    private var state: Centraid_Screen_V1_TrashListState {
        (try? Centraid_Screen_V1_TrashListState(serializedBytes: data)) ?? .init()
    }

    static func content(_ state: Centraid_Screen_V1_TrashListState) -> ScreenContent<Centraid_Screen_V1_TrashListData> {
        switch state.content {
        case let .loading(loading): return .loading(loading.firstLoad)
        case let .failure(failure): return .failed(failure)
        case let .denied(denied): return .denied(denied)
        case let .data(data): return .data(data)
        case .none: return .loading(true)
        }
    }

    static func event(_ build: (inout Centraid_Screen_V1_TrashListEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_TrashListEvent()
        build(&event)
        return event.encoded
    }

    var body: some View {
        let state = state
        PushedPage(title: state.title, parentTitle: state.backLabel, onBack: onBack) {
            EmptyView()
        } content: {
            WordsShield(secure: secure) { list(state) }
        }
        .sheet(isPresented: Binding(
            get: { state.hasConfirm },
            set: { open in if !open, state.hasConfirm { send(Self.event { $0.dismissed = .init() }) } }
        )) {
            WordsShield(secure: secure) {
                ConfirmSheet(
                    state.confirm,
                    onConfirm: { send(Self.event { $0.confirmed = .init() }) },
                    onDismiss: { send(Self.event { $0.dismissed = .init() }) }
                )
            }
            .modifier(SheetPresentation(detents: ConfirmSheet.detents))
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("\(state.appID)-trash")
    }

    @ViewBuilder
    private func list(_ state: Centraid_Screen_V1_TrashListState) -> some View {
        ReadStateView(
            content: Self.content(state),
            onRetry: { send(Self.event { $0.refreshed = .init() }) }
        ) { data in
            if data.rows.isEmpty {
                EmptyStateView(data.empty)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        SectionHeader(
                            title: state.title,
                            count: UInt32(data.rows.count),
                            verb: data.emptyLabel,
                            onVerb: { send(Self.event { $0.empty = .init() }) }
                        )
                        ForEach(data.rows, id: \.id) { row in
                            TrashRowView(
                                row: row,
                                onRestore: { send(Self.event { $0.restore = .with { $0.id = row.id } }) },
                                onPurge: { send(Self.event { $0.purge = .with { $0.id = row.id } }) }
                            )
                        }
                        ShowMoreFooter(
                            visible: data.hasNextCursor,
                            loading: state.firstPagePending,
                            onMore: { send(Self.event { $0.nextPage = .init() }) }
                        )
                    }
                }
                .refreshable { send(Self.event { $0.refreshed = .init() }) }
            }
        }
    }
}

private struct TrashRowView: View {
    let row: Centraid_Screen_V1_TrashRow
    let onRestore: () -> Void
    let onPurge: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 8) {
            CentraidRow(title: row.title, meta: row.meta, identifier: "trash-row-\(row.id)")
            Button(action: onRestore) {
                Text(row.restoreLabel)
                    .centraidType("annotLabelOn")
                    .foregroundStyle(Theme.color("link", scheme))
                    .frame(minWidth: CentraidGeometry.targetMinCoarse, minHeight: CentraidGeometry.targetMinCoarse)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("trash-restore-\(row.id)")
            if !row.purgeLabel.isEmpty {
                Button(action: onPurge) {
                    CentraidIconView(iconKey: "Trash", tint: Theme.color("net", scheme), size: 16)
                        .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(row.purgeLabel)
                .accessibilityIdentifier("trash-purge-\(row.id)")
            }
        }
        .padding(.trailing, 8)
    }
}
