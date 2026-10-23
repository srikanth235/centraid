import SwiftUI

import CentraidShared

/// Export's and import's events, built once.
enum LockerExportEvents {
    static func make(_ build: (inout Centraid_Core_V1_LockerExportEvent) -> Void) -> Centraid_Core_V1_LockerExportEvent {
        var event = Centraid_Core_V1_LockerExportEvent()
        build(&event)
        return event
    }
}

enum LockerImportEvents {
    static func make(_ build: (inout Centraid_Core_V1_LockerImportEvent) -> Void) -> Centraid_Core_V1_LockerImportEvent {
        var event = Centraid_Core_V1_LockerImportEvent()
        build(&event)
        return event
    }
}

/// `locker.export` — every secret, in a file (#1047 T2; the handoff's
/// `locker/export`). The lede in the net register, what leaves, the format,
/// where it goes, and Write the file.
///
/// **THE VIEW DECIDES NOTHING, AND NEVER SEES THE FILE.** The confirm, the
/// owner check (`OwnerCheck` effect) and the save sheet (`SaveFile` effect) are
/// Rust's three asks, in order; the file goes from the core to the system's
/// save sheet and nowhere else.
struct LockerExportView: View {
    let state: Centraid_Core_V1_LockerExportState
    let send: (Centraid_Core_V1_LockerExportEvent) -> Void
    let sendWall: (Centraid_Core_V1_LockerWallEvent) -> Void
    let onWords: () -> Void
    let onBack: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var content: ScreenContent<Centraid_Core_V1_LockerExportData> {
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
                        onRetry: { send(LockerExportEvents.make { $0.refreshed = .init() }) }
                    ) { export in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 0) { page(export) }
                                .padding(.bottom, 16)
                        }
                    }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if state.hasStatus {
                        StatusLineView(status: state.status.legacy, identifier: "locker-export-status") {}
                            .padding(.vertical, 4)
                            .background(Theme.color("bg", scheme))
                    }
                }
            }
        }
        .sheet(isPresented: Binding(
            get: { state.hasConfirm },
            set: { isOpen in if !isOpen, state.hasConfirm { send(LockerExportEvents.make { $0.dismissed = .init() }) } }
        )) {
            LockerShield(secure: state.secure) {
                ConfirmSheet(
                    state.confirm.legacy,
                    onConfirm: { send(LockerExportEvents.make { $0.confirmed = .init() }) },
                    onDismiss: { send(LockerExportEvents.make { $0.dismissed = .init() }) }
                )
            }
            .modifier(SheetPresentation(detents: ConfirmSheet.detents))
        }
    }

    @ViewBuilder
    private func page(_ export: Centraid_Core_V1_LockerExportData) -> some View {
        Text(export.lede)
            .centraidType("body")
            .foregroundStyle(Theme.color("net", scheme))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 12)
            .accessibilityIdentifier("locker-export-lede")
        FieldRow(key: export.whatLabel, value: export.whatValue, note: export.leavesOut)
        VStack(alignment: .leading, spacing: 2) {
            Text(export.formatLabel)
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color("textSoft", scheme))
                .padding(.horizontal, CentraidGeometry.pageMargin)
            LockerChoicePills(choices: export.formats, identifier: "locker-export-format") { key in
                send(LockerExportEvents.make { $0.format = .with { $0.key = key } })
            }
            LockerNote(text: export.formatNote)
        }
        .padding(.top, 8)
        FieldRow(key: export.whereLabel, value: export.whereValue, note: export.whereNote)
        if !export.commitLabel.isEmpty {
            KitInkButton(label: export.commitLabel) {
                send(LockerExportEvents.make { $0.commit = .init() })
            }
            .accessibilityIdentifier("locker-export-commit")
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.top, 12)
        }
        LockerNote(text: export.commitNote)
    }
}

/// `locker.import` — a password-manager file, reviewed and sealed in (#1047 T2;
/// the handoff's `locker/import`). Choose is a `PickFile` effect Rust asks the
/// shell for; every word, verdict and verb is Rust's.
struct LockerImportView: View {
    let state: Centraid_Core_V1_LockerImportState
    let send: (Centraid_Core_V1_LockerImportEvent) -> Void
    let sendWall: (Centraid_Core_V1_LockerWallEvent) -> Void
    let onWords: () -> Void
    let onBack: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var content: ScreenContent<Centraid_Core_V1_LockerImportData> {
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
                        onRetry: { send(LockerImportEvents.make { $0.refreshed = .init() }) }
                    ) { plan in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 0) { page(plan) }
                                .padding(.bottom, 16)
                        }
                    }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if state.hasStatus {
                        StatusLineView(status: state.status.legacy, identifier: "locker-import-status") {}
                            .padding(.vertical, 4)
                            .background(Theme.color("bg", scheme))
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func page(_ plan: Centraid_Core_V1_LockerImportData) -> some View {
        LockerNote(text: plan.lede)
        FieldRow(key: plan.fileLabel, value: plan.fileValue, note: plan.fileNote)
        if !plan.chooseLabel.isEmpty {
            KitOutlineButton(label: plan.chooseLabel) {
                send(LockerImportEvents.make { $0.choose = .init() })
            }
            .accessibilityIdentifier("locker-import-choose")
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 8)
        }
        if !plan.verdicts.isEmpty {
            SectionHeader(title: plan.verdictsLabel)
            ForEach(Array(plan.verdicts.enumerated()), id: \.offset) { _, verdict in
                FieldRow(key: verdict.label, value: verdict.detail)
            }
        }
        if plan.hasEmpty {
            EmptyStateView(plan.empty.legacy)
        }
        if !plan.rowsLabel.isEmpty {
            SectionHeader(title: plan.rowsLabel)
            LockerNote(text: plan.counts)
            ForEach(plan.rows, id: \.key) { row in
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.title)
                            .centraidType("body")
                            .foregroundStyle(Theme.color("text", scheme))
                            .lineLimit(1)
                        Text(row.meta)
                            .centraidType("annotLabel")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                            .lineLimit(2)
                    }
                    Spacer(minLength: 8)
                    StatusChipView(row.chip.legacy)
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
                .overlay(alignment: .bottom) { KitHairline() }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(row.accessibilityLabel)
                .accessibilityIdentifier("locker-import-\(row.key)")
            }
        }
        if !plan.publishLabel.isEmpty {
            // PUBLISH AND DISCARD ARE ALTERNATIVES: one stack, the note that
            // says what publishing does between them.
            KitChoiceStack {
                KitInkButton(label: plan.publishLabel) {
                    send(LockerImportEvents.make { $0.publish = .init() })
                }
                .accessibilityIdentifier("locker-import-publish")
                if !plan.publishNote.isEmpty {
                    LockerNote(text: plan.publishNote)
                        .padding(.horizontal, -CentraidGeometry.pageMargin)
                }
                if !plan.discardLabel.isEmpty {
                    discard(plan)
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 12)
        } else if !plan.discardLabel.isEmpty {
            discard(plan)
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.vertical, 8)
        }
    }

    private func discard(_ plan: Centraid_Core_V1_LockerImportData) -> some View {
        KitOutlineButton(label: plan.discardLabel) {
            send(LockerImportEvents.make { $0.discard = .init() })
        }
        .accessibilityIdentifier("locker-import-discard")
    }
}
