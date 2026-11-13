import SwiftUI

/// CHECK MY BACKUP (#1188, B6): a page pushed from Backup's Recovery section. Every word and the
/// bar's fraction are the state's: the intro, one block per device (what was found, then how), a
/// determinate bar while a check runs, and the status line at the foot. A tap sends an event; a
/// pop is the shell's. Same selector ids as the Compose page.
struct BackupCheckView: View {
    let state: Centraid_Core_V1_BackupCheckState
    let send: (Centraid_Core_V1_BackupCheckEvent) -> Void
    let onBack: () -> Void

    private var shown: [String] { BackupCheckControls.shown(state) }

    var body: some View {
        PushedPage(
            title: state.title,
            parentTitle: state.backLabel,
            onBack: onBack,
            meta: ""
        ) {
            EmptyView()
        } content: {
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        Text(state.intro)
                            .kitType(.row)
                            .foregroundStyle(Surface.meta)
                            .accessibilityIdentifier(BackupCheckControls.intro)
                        if shown.contains(BackupCheckControls.heading) {
                            Text(state.heading)
                                .kitType(.row)
                                .foregroundStyle(Surface.meta)
                                .accessibilityIdentifier(BackupCheckControls.heading)
                        }
                        if !state.rows.isEmpty {
                            VStack(spacing: 0) {
                                ForEach(state.rows, id: \.gatewayID) { row in
                                    CheckRowView(row: row)
                                }
                                if shown.contains(BackupCheckControls.bar) {
                                    KitProgressBar(fraction: Double(state.fraction))
                                        .padding(.horizontal, 14)
                                        .padding(.vertical, 10)
                                        .accessibilityIdentifier(BackupCheckControls.bar)
                                }
                            }
                            .kitCard()
                            .clipShape(RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))
                        }
                        if let tag = BackupCheckControls.actionTag(state) {
                            let stop = tag == BackupCheckControls.stop
                            KitPillButton(label: state.actionLabel) {
                                var event = Centraid_Core_V1_BackupCheckEvent()
                                if stop { event.stop = .init() } else { event.start = .init() }
                                send(event)
                            }
                            .accessibilityIdentifier(tag)
                        }
                        if shown.contains(BackupCheckControls.backUpNow) {
                            Button {
                                var event = Centraid_Core_V1_BackupCheckEvent()
                                event.backUpNow = .init()
                                send(event)
                            } label: {
                                Text(state.backUpNowLabel)
                                    .kitType(.row)
                                    .fontWeight(.semibold)
                                    .foregroundStyle(AppAccent("").text)
                                    .frame(minHeight: CentraidGeometry.targetMinCoarse)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier(BackupCheckControls.backUpNow)
                        }
                    }
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .padding(.top, 4)
                }
                StatusLineView(status: state.status, identifier: "backup-check-status")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("backup-check")
    }
}

private struct CheckRowView: View {
    let row: Centraid_Core_V1_BackupCheckRow

    private var ink: Color {
        switch BackupCheckControls.ink(row.tone) {
        case "bad": return StateColor.red.text
        case "ok": return Surface.ink
        default: return Surface.meta
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(row.name).kitType(.row).foregroundStyle(Surface.ink)
            if !row.line.isEmpty { Text(row.line).kitType(.row).foregroundStyle(ink) }
            if !row.detail.isEmpty { Text(row.detail).kitType(.row).foregroundStyle(Surface.meta) }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(BackupCheckControls.rowTag(row.gatewayID))
    }
}
