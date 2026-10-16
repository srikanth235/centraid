import SwiftUI

#if canImport(CentraidShared)
import CentraidShared
#endif

/// `locker.access` — the whole Locker's access history (#1047, Q-1047-21; the
/// handoff's `locker/access`): every unlock, reveal, copy, one-time code and
/// export, newest first, pushed from the More sheet's Access history row.
///
/// **THE VIEW DECIDES NOTHING, AND THERE IS NOTHING TO CONCEAL.** The page is
/// read-only: one lede, the machine's rows — the item page's own history rows
/// (`LockerFieldRowView`), each now also naming the item — and a note. A row
/// names the act, the item and the minute and never a value, so no verb is
/// drawn and nothing here is selectable. It is covered by the lock wall and
/// shielded from capture like every Locker page, because an item's title is
/// inside Locker.
struct LockerAccessView: View {
    let data: Data
    let lock: Data
    let send: (Data) -> Void
    let sendLock: (Data) -> Void
    let onBack: () -> Void
    let onDeparted: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_LockerAccessState {
        (try? Centraid_Screen_V1_LockerAccessState(serializedBytes: data)) ?? .init()
    }

    static func event(_ build: (inout Centraid_Screen_V1_LockerAccessEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_LockerAccessEvent()
        build(&event)
        return event.encoded
    }

    private func content(_ state: Centraid_Screen_V1_LockerAccessState) -> ScreenContent<Centraid_Screen_V1_LockerAccessData> {
        switch state.content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }

    var body: some View {
        let state = state
        LockerCovered(lock: lock, sendLock: sendLock, onBack: onBack) {
            PushedPage(title: state.chrome.title, parentTitle: state.chrome.backLabel, onBack: onBack) {
                EmptyView()
            } content: {
                LockerShield(lock: lock) {
                    ReadStateView(
                        content: content(state),
                        onRetry: { send(Self.event { $0.refreshed = .init() }) }
                    ) { access in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 0) { page(access) }
                                .padding(.bottom, 16)
                        }
                    }
                }
            }
        }
        .onDisappear(perform: onDeparted)
    }

    @ViewBuilder
    private func page(_ access: Centraid_Screen_V1_LockerAccessData) -> some View {
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
