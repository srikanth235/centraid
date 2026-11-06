import SwiftUI

/// THE KIT'S TRASH, WHEN RUST OWNS IT (#1135; `kit_screens.proto`'s `TrashView`).
///
/// The kit's trash page for the apps whose screens are Rust's: the same
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

    /// The scope line under the title: the machine's, once the rows are read.
    private var countLabel: String {
        if case let .data(data)? = state.content { return data.countLabel }
        return ""
    }

    var body: some View {
        PushedPage(
            title: state.title,
            parentTitle: state.backLabel,
            onBack: onBack,
            showsTitle: true,
            meta: countLabel
        ) {
            EmptyView()
        } content: {
            VStack(spacing: 0) {
                ReadStateView(
                    content: content,
                    onRetry: { event { $0.kind = .refreshed(.init()) } }
                ) { data in
                    if data.rows.isEmpty {
                        EmptyStateView(data.empty)
                    } else {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 12) {
                                // THE ROWS ARE ONE CARD (#1173); the last hairline falls outside the clip.
                                LazyVStack(spacing: 0) {
                                    ForEach(data.rows, id: \.id) { row in
                                        TrashRowView(
                                            row: row,
                                            onRestore: { event { $0.kind = .restore(.with { $0.id = row.id }) } },
                                            onPurge: { event { $0.kind = .purge(.with { $0.id = row.id }) } }
                                        )
                                    }
                                }
                                .padding(.bottom, -1)
                                .kitCard()
                                .clipShape(RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))
                                if !data.emptyLabel.isEmpty {
                                    Button { event { $0.kind = .empty(.init()) } } label: {
                                        Text(data.emptyLabel)
                                            .kitType(.row)
                                            .fontWeight(.semibold)
                                            .foregroundStyle(StateColor.red.text)
                                            .frame(minHeight: CentraidGeometry.targetMinCoarse)
                                            .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityIdentifier("trash-empty")
                                }
                            }
                            .padding(.horizontal, CentraidGeometry.pageMargin)
                            .padding(.top, 4)
                        }
                        .refreshable { event { $0.kind = .refreshed(.init()) } }
                    }
                }
                StatusLineView(status: state.status, identifier: "trash-status-action") {}
            }
        }
        .sheet(isPresented: Binding(
            get: { state.hasConfirm },
            set: { open in if !open, state.hasConfirm { event { $0.kind = .dismissed(.init()) } } }
        )) {
            ConfirmSheet(
                state.confirm,
                onConfirm: { event { $0.kind = .confirmed(.init()) } },
                onDismiss: { event { $0.kind = .dismissed(.init()) } }
            )
            .modifier(SheetPresentation(detents: ConfirmSheet.detents))
        }
        .environment(\.appAccent, AppAccent(state.appID))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("\(state.appID)-trash")
    }
}

private struct TrashRowView: View {
    let row: Centraid_Core_V1_TrashRow
    let onRestore: () -> Void
    let onPurge: () -> Void

    @Environment(\.appAccent) private var accent

    var body: some View {
        HStack(spacing: 10) {
            if !row.iconKey.isEmpty {
                CentraidIconView(iconKey: row.iconKey, tint: .white, size: 16)
                    .frame(width: 34, height: 34)
                    .background(accent.fill, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(row.title)
                    .kitType(.row)
                    .foregroundStyle(Surface.ink)
                    .lineLimit(2)
                if !row.meta.isEmpty {
                    Text(row.meta)
                        .kitType(.meta)
                        .foregroundStyle(Surface.meta)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("trash-row-\(row.id)")
            Button(action: onRestore) {
                Text(row.restoreLabel)
                    .kitType(.row)
                    .fontWeight(.semibold)
                    .foregroundStyle(accent.text)
                    .frame(minWidth: CentraidGeometry.targetMinCoarse, minHeight: CentraidGeometry.targetMinCoarse)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("trash-restore-\(row.id)")
            if !row.purgeLabel.isEmpty {
                Button(action: onPurge) {
                    CentraidIconView(iconKey: "Trash", tint: StateColor.red.text, size: 16)
                        .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(row.purgeLabel)
                .accessibilityIdentifier("trash-purge-\(row.id)")
            }
        }
        .padding(.leading, 12)
        .padding(.trailing, 2)
        .padding(.vertical, 4)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Surface.line).frame(height: CentraidGeometry.hairline).padding(.leading, 56)
        }
    }
}
