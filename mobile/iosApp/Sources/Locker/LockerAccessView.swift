import SwiftUI

/// The access history's events, built once.
enum LockerAccessEvents {
    static func make(_ build: (inout Centraid_Core_V1_LockerAccessEvent) -> Void) -> Centraid_Core_V1_LockerAccessEvent {
        var event = Centraid_Core_V1_LockerAccessEvent()
        build(&event)
        return event
    }
}

/// `locker.access` — the whole Locker's access history (#1047, Q-1047-21; the
/// handoff's `locker/access`): every unlock, reveal, copy, one-time code and
/// export, newest first, pushed from the More sheet's Access history row.
///
/// **THE VIEW DECIDES NOTHING, AND THERE IS NOTHING TO CONCEAL.** The page is
/// read-only: one lede, Rust's rows — the item page's own history rows
/// (`LockerFieldRowView`), each now also naming the item — and a note. A row
/// names the act, the item and the minute and never a value, so no verb is
/// drawn and nothing here is selectable. It is covered by the lock wall and
/// shielded from capture like every Locker page, because an item's title is
/// inside Locker.
struct LockerAccessView: View {
    let state: Centraid_Core_V1_LockerAccessState
    let send: (Centraid_Core_V1_LockerAccessEvent) -> Void
    let sendWall: (Centraid_Core_V1_LockerWallEvent) -> Void
    let onWords: () -> Void
    let onBack: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var content: ScreenContent<Centraid_Core_V1_LockerAccessData> {
        switch state.content {
        case .loading?, nil: return .loading(true)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .gated(denied)
        case let .data(data)?: return .data(data)
        }
    }

    var body: some View {
        LockerCovered(wall: state.hasWall ? state.wall : nil, backLabel: state.chrome.backLabel, send: sendWall, onWords: onWords, onBack: onBack) {
            PushedPage(title: state.chrome.title, parentTitle: state.chrome.backLabel, onBack: onBack) {
                EmptyView()
            } content: {
                LockerShield(secure: state.secure) {
                    ReadStateView(
                        content: content,
                        onRetry: { send(LockerAccessEvents.make { $0.refreshed = .init() }) }
                    ) { access in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 0) { page(access) }
                                .padding(.bottom, 16)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func page(_ access: Centraid_Core_V1_LockerAccessData) -> some View {
        Text(access.lede)
            .centraidType("body")
            .foregroundStyle(Theme.color("textSoft", scheme))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 12)
            .accessibilityIdentifier("locker-access-lede")
        if access.hasHistory {
            // THE ITEM PAGE'S ROW, with no verb to offer: a history is read.
            ForEach(access.history.rows, id: \.key) { row in
                LockerFieldRowView(row: row) { _ in }
            }
            LockerNote(text: access.history.note)
        }
    }
}

/// `locker.lock` — the wall as a page, pushed by a caller that needs the key
/// (chat). Rust asks the owner check on appearing and sets `finished` once the
/// Locker is open, so this pops itself.
struct LockerLockPageView: View {
    let state: Centraid_Core_V1_LockerLockState
    let sendWall: (Centraid_Core_V1_LockerWallEvent) -> Void
    let onWords: () -> Void
    let onClose: () -> Void

    var body: some View {
        Group {
            if let wall = state.wall {
                PushedPage(title: "", parentTitle: state.closeLabel, onBack: onClose) {
                    EmptyView()
                } content: {
                    LockerWallView(wall: wall, send: sendWall, onWords: onWords)
                }
            } else {
                BarePaper()
            }
        }
        .onChange(of: state.finished) { _, done in if done { onClose() } }
    }
}
