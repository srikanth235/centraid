import SwiftUI

/// THE KIT'S EARLIER VERSIONS, WHEN RUST OWNS IT (#1185; `kit_screens.proto`'s `EarlierView`).
///
/// One page for every app: the record's current values tagged "Current", then each earlier
/// version with its words and a plain "Restore". Every word is on the state; the view sends
/// `EarlierEvent`s and the shell pops it when the back control says so.
///
/// A row that holds a `preview` route opens it (the full preview, `CoreEarlierPreviewView`).
///
/// Ids: `earlier-row-<seq>`, `earlier-restore-<seq>`, `earlier-more`, `earlier-status-action`.
/// The Compose twin is `kit/EarlierScreen.kt`.
struct CoreEarlierView: View {
    let state: Centraid_Core_V1_EarlierView
    let send: (Centraid_Core_V1_EarlierEvent) -> Void
    /// Opens a route Rust built: a row of an earlier version opens its full preview.
    let open: (Centraid_Core_V1_Route) -> Void
    let onBack: () -> Void

    private func event(_ build: (inout Centraid_Core_V1_EarlierEvent) -> Void) {
        var event = Centraid_Core_V1_EarlierEvent()
        build(&event)
        send(event)
    }

    var body: some View {
        PushedPage(
            title: state.title,
            parentTitle: state.backLabel,
            onBack: onBack
        ) {
            EmptyView()
        } content: {
            VStack(spacing: 0) {
                PageReadStateView(
                    page: state.page,
                    onRetry: { event { $0.kind = .refreshed(.init()) } }
                ) {
                    if case let .data(data)? = state.content {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 12) {
                                LazyVStack(spacing: 0) {
                                    ForEach(data.rows, id: \.seq) { row in
                                        EarlierRowView(
                                            row: row,
                                            onOpen: row.hasPreview ? { open(row.preview) } : nil,
                                            onRestore: { event { $0.kind = .restore(.with { $0.seq = row.seq }) } },
                                            onReveal: { key in event { $0.kind = .reveal(.with { $0.seq = row.seq; $0.key = key }) } },
                                            onConceal: { key in event { $0.kind = .conceal(.with { $0.seq = row.seq; $0.key = key }) } }
                                        )
                                    }
                                }
                                .padding(.bottom, -1)
                                .kitCard()
                                .clipShape(RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))
                                if !data.moreLabel.isEmpty {
                                    Button { event { $0.kind = .more(.init()) } } label: {
                                        Text(data.moreLabel)
                                            .kitType(.row)
                                            .fontWeight(.semibold)
                                            .foregroundStyle(Surface.ink)
                                            .frame(minHeight: CentraidGeometry.targetMinCoarse)
                                            .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityIdentifier("earlier-more")
                                }
                            }
                            .padding(.horizontal, CentraidGeometry.pageMargin)
                            .padding(.top, 4)
                        }
                        .refreshable { event { $0.kind = .refreshed(.init()) } }
                    }
                }
                StatusLineView(status: state.status, identifier: "earlier-status-action") {
                    event { $0.kind = .statusActed(.init()) }
                }
            }
        }
        .environment(\.appAccent, AppAccent(state.appID))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("\(state.appID)-earlier")
    }
}

private struct EarlierRowView: View {
    let row: Centraid_Core_V1_EarlierRow
    let onOpen: (() -> Void)?
    let onRestore: () -> Void
    let onReveal: (String) -> Void
    let onConceal: (String) -> Void

    @Environment(\.appAccent) private var accent

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            mainRow
            ForEach(row.secrets, id: \.key) { secret in
                secretLine(secret)
            }
        }
        .overlay(alignment: .bottom) {
            Rectangle().fill(Surface.line).frame(height: CentraidGeometry.hairline)
        }
    }

    /// One sealed value: `label · masked`, or the value while Rust says `revealed`; the value is
    /// only ever read from the state being drawn.
    private func secretLine(_ secret: Centraid_Core_V1_EarlierSecret) -> some View {
        HStack(spacing: 8) {
            Text("\(secret.label) · \(secret.revealed ? secret.value : secret.masked)")
                .kitType(.meta)
                .foregroundStyle(Surface.meta)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityLabel(secret.accessibilityLabel.isEmpty ? secret.label : secret.accessibilityLabel)
            let title = secret.revealed ? secret.concealLabel : secret.revealLabel
            if !secret.revealLabel.isEmpty && !title.isEmpty {
                Button { secret.revealed ? onConceal(secret.key) : onReveal(secret.key) } label: {
                    Text(title)
                        .centraidType("smallStrong")
                        .foregroundStyle(accent.text)
                        .frame(minWidth: CentraidGeometry.targetMinCoarse, minHeight: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(secret.accessibilityLabel.isEmpty ? title : secret.accessibilityLabel)
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, 6)
    }

    /// A row of an earlier version opens its preview; the current row is the record itself.
    @ViewBuilder
    private func openable<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        if let onOpen {
            Button(action: onOpen) { content().contentShape(Rectangle()) }
                .buttonStyle(KitRowPress())
        } else {
            content()
        }
    }

    private var mainRow: some View {
        HStack(spacing: 8) {
            openable {
            VStack(alignment: .leading, spacing: 3) {
                Text(row.label)
                    .kitType(.row)
                    .fontWeight(.semibold)
                    .foregroundStyle(Surface.ink)
                    .lineLimit(2)
                if !row.value.isEmpty {
                    Text(row.value)
                        .kitType(.meta)
                        .foregroundStyle(Surface.meta)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(row.accessibilityLabel.isEmpty ? row.label : row.accessibilityLabel)
            .accessibilityIdentifier(CoreEarlierView.rowIdentifier(row.seq))
            }
            if CoreEarlierView.showsCurrentTag(row) {
                Text(row.currentLabel)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
                    .padding(.horizontal, 6)
            } else if CoreEarlierView.showsRestore(row) {
                Button(action: onRestore) {
                    Text(row.restoreLabel)
                        .centraidType("smallStrong")
                        .foregroundStyle(accent.text)
                        .frame(minWidth: CentraidGeometry.targetMinCoarse, minHeight: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(row.accessibilityLabel.isEmpty ? row.restoreLabel : row.accessibilityLabel)
                .accessibilityIdentifier(CoreEarlierView.restoreIdentifier(row.seq))
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
    }
}

extension CoreEarlierView {
    nonisolated static func rowIdentifier(_ seq: Int64) -> String { "earlier-row-\(seq)" }
    nonisolated static func restoreIdentifier(_ seq: Int64) -> String { "earlier-restore-\(seq)" }

    /// The current row wears its tag and never a Restore.
    nonisolated static func showsCurrentTag(_ row: Centraid_Core_V1_EarlierRow) -> Bool {
        row.current && !row.currentLabel.isEmpty
    }

    /// Every other row restores, when Rust gave the action words.
    nonisolated static func showsRestore(_ row: Centraid_Core_V1_EarlierRow) -> Bool {
        !row.current && !row.restoreLabel.isEmpty
    }
}
