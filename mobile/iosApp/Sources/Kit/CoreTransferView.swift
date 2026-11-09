import SwiftUI

/// THE KIT'S TRANSFER PAGE, WHEN RUST OWNS IT (#1173; `kit_screens.proto`'s `TransferView`).
///
/// Notes' Markdown and People's vCards, in and out, on one page: the lede, the headline, the rows
/// (what a file holds, or what can be exported), and the buttons. Every word is on the state; the
/// view sends the key of whichever row or button was tapped and draws nothing of its own.
struct CoreTransferView: View {
    let state: Centraid_Core_V1_TransferView
    let send: (Centraid_Core_V1_TransferEvent) -> Void
    let onBack: () -> Void

    /// The page's own accent: this view sits outside the environment it sets for its content.
    private var accent: AppAccent { AppAccent(state.appID) }

    private func tapped(_ key: String) {
        var event = Centraid_Core_V1_TransferEvent()
        event.key = key
        send(event)
    }

    var body: some View {
        PushedPage(
            title: state.title,
            parentTitle: state.backLabel,
            onBack: onBack,
            showsTitle: true,
            meta: ""
        ) {
            EmptyView()
        } content: {
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        Text(state.lede)
                            .kitType(.row)
                            .foregroundStyle(Surface.meta)
                        if !state.headline.isEmpty {
                            Text(state.headline)
                                .kitType(.row)
                                .fontWeight(.semibold)
                                .foregroundStyle(Surface.ink)
                                .accessibilityIdentifier("transfer-headline")
                        }
                        if !state.rows.isEmpty {
                            LazyVStack(spacing: 0) {
                                ForEach(state.rows, id: \.key) { row in
                                    TransferRowView(row: row, busy: state.busy) { tapped(row.key) }
                                }
                            }
                            .padding(.bottom, -1)
                            .kitCard()
                            .clipShape(RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))
                        }
                        ForEach(state.actions, id: \.key) { action in
                            Group {
                                if action.primary {
                                    KitPillButton(label: action.label) { tapped(action.key) }
                                } else {
                                    Button { tapped(action.key) } label: {
                                        Text(action.label)
                                            .kitType(.row)
                                            .fontWeight(.semibold)
                                            .foregroundStyle(accent.text)
                                            .frame(minHeight: CentraidGeometry.targetMinCoarse)
                                            .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .disabled(!action.enabled || state.busy)
                            .opacity(action.enabled && !state.busy ? 1 : 0.4)
                            .accessibilityIdentifier("transfer-\(action.key)")
                        }
                    }
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .padding(.top, 4)
                }
                StatusLineView(status: state.status, identifier: "transfer-status-action") {}
            }
        }
        .environment(\.appAccent, AppAccent(state.appID))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("\(state.appID)-transfer")
    }
}

private struct TransferRowView: View {
    let row: Centraid_Core_V1_TransferRow
    let busy: Bool
    let onTap: () -> Void

    var body: some View {
        let content = HStack(spacing: 12) {
            if !row.iconKey.isEmpty {
                KitTile(iconKey: row.iconKey, size: 30)
            }
            Text(row.label)
                .kitType(.row)
                .foregroundStyle(Surface.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
            if !row.value.isEmpty {
                Text(row.value)
                    .kitType(.row)
                    .foregroundStyle(Surface.meta)
            }
            if row.tappable {
                CentraidIconView(iconKey: "ChevronRight", tint: Surface.meta, size: 14)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(minHeight: CentraidGeometry.targetMinCoarse)
        .contentShape(Rectangle())
        .overlay(alignment: .bottom) {
            Rectangle().fill(Surface.line).frame(height: CentraidGeometry.hairline)
        }
        if row.tappable {
            Button(action: onTap) { content }
                .buttonStyle(.plain)
                .disabled(busy)
                .accessibilityLabel(row.accessibilityLabel)
                .accessibilityIdentifier("transfer-row-\(row.key)")
        } else {
            content
                .accessibilityElement(children: .combine)
                .accessibilityLabel(row.accessibilityLabel)
        }
    }
}
