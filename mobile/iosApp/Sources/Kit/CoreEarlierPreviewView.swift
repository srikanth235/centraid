import SwiftUI

/// THE FULL PREVIEW OF ONE EARLIER VERSION, WHEN RUST OWNS IT (#1185; `kit_screens.proto`'s
/// `EarlierPreviewView`).
///
/// One page for every app: a banner that says which version it is and what changed it, the record
/// as it was (its first line as the heading, one line per thing it held, read only), and two keys,
/// Close and Restore this version. Every word is on the state; the view sends
/// `EarlierPreviewEvent`s and the shell pops it when `done` says so.
///
/// Ids: `earlier-preview-banner`, `earlier-preview-restore`, `earlier-preview-close`,
/// `earlier-preview-status-action`. The Compose twin is `kit/EarlierPreviewScreen.kt`.
struct CoreEarlierPreviewView: View {
    let state: Centraid_Core_V1_EarlierPreviewView
    let send: (Centraid_Core_V1_EarlierPreviewEvent) -> Void
    let onBack: () -> Void

    @Environment(\.appAccent) private var accent

    private func event(_ build: (inout Centraid_Core_V1_EarlierPreviewEvent) -> Void) {
        var event = Centraid_Core_V1_EarlierPreviewEvent()
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
                    if state.hasData {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 12) {
                                banner(state.data)
                                record(state.data)
                            }
                            .padding(.horizontal, CentraidGeometry.pageMargin)
                            .padding(.top, 4)
                        }
                        keys(state.data)
                    }
                }
                StatusLineView(status: state.status, identifier: "earlier-preview-status-action", onAct: {})
            }
        }
        .environment(\.appAccent, AppAccent(state.appID))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("\(state.appID)-earlier-preview")
        .onChange(of: state.done) { _, done in
            if done { onBack() }
        }
    }

    private func banner(_ data: Centraid_Core_V1_EarlierPreviewData) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(data.bannerHeadline)
                .kitType(.row)
                .fontWeight(.semibold)
                .foregroundStyle(Surface.ink)
            if !data.bannerChanged.isEmpty {
                Text(data.bannerChanged).kitType(.meta).foregroundStyle(Surface.ink)
            }
            Text(data.bannerNote).kitType(.meta).foregroundStyle(Surface.meta)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(Surface.fill, in: RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(data.accessibilityLabel.isEmpty ? data.bannerHeadline : data.accessibilityLabel)
        .accessibilityIdentifier("earlier-preview-banner")
    }

    /// The record as it was: its first line as the heading, then one line per thing it held.
    private func record(_ data: Centraid_Core_V1_EarlierPreviewData) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(data.heading)
                .kitType(.row)
                .fontWeight(.semibold)
                .foregroundStyle(Surface.ink)
                .padding(.horizontal, 14)
                .padding(.vertical, 14)
            ForEach(Array(data.details.enumerated()), id: \.offset) { _, line in
                Rectangle().fill(Surface.line).frame(height: CentraidGeometry.hairline)
                Text(line)
                    .kitType(.row)
                    .foregroundStyle(Surface.ink)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .kitCard()
        .clipShape(RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))
    }

    private func keys(_ data: Centraid_Core_V1_EarlierPreviewData) -> some View {
        HStack(spacing: 10) {
            Button { event { $0.kind = .close(.init()) } } label: {
                Text(data.closeLabel)
                    .kitType(.row)
                    .fontWeight(.semibold)
                    .foregroundStyle(Surface.ink)
                    .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
                    .overlay(Capsule().strokeBorder(Surface.border, lineWidth: CentraidGeometry.hairline))
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("earlier-preview-close")
            Button { event { $0.kind = .restore(.init()) } } label: {
                Text(data.restoreLabel)
                    .kitType(.row)
                    .fontWeight(.semibold)
                    .foregroundStyle(Color.white)
                    .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
                    .background(accent.fill, in: Capsule())
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("earlier-preview-restore")
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 12)
    }
}
