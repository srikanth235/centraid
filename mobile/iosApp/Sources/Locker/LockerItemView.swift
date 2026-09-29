import SwiftUI

#if canImport(CentraidShared)
import CentraidShared
#endif

/// ONE LOCKER ITEM (#1047; the handoff's field row recipe): its sections of
/// field rows — plain metadata shows its value, a sealed cell shows its mask
/// and offers Reveal and Copy, a revealed one counts down and offers Copy and
/// Conceal — its tags, its memo, and its verbs.
///
/// **THE VIEW DECIDES NOTHING**, and it NEVER makes a revealed value
/// selectable: a copy is the Copy verb's, performed local-only and expiring
/// by `LockerClipboardSeam`. Leaving by any route is `onDeparted`, whose
/// `Left` conceals what was shown.
struct LockerItemView: View {
    let data: Data
    let lock: Data
    let send: (Data) -> Void
    let sendLock: (Data) -> Void
    let push: (ShellModel.Route) -> Void
    let onBack: () -> Void
    let onDeparted: () -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(\.openURL) private var openURL

    private var state: Centraid_Screen_V1_LockerItemState {
        (try? Centraid_Screen_V1_LockerItemState(serializedBytes: data)) ?? .init()
    }

    static func event(_ build: (inout Centraid_Screen_V1_LockerItemEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_LockerItemEvent()
        build(&event)
        return event.encoded
    }

    private func content(_ state: Centraid_Screen_V1_LockerItemState) -> ScreenContent<Centraid_Screen_V1_LockerItemData> {
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
        let secure = Centraid_Screen_V1_LockerLockState.of(lock).secure
        LockerCovered(lock: lock, sendLock: sendLock, onBack: onBack) {
            // THE ITEM'S NAME NEVER SITS IN THE NAVIGATION BAR while the gate
            // says `secure`: the bar is outside the secure canvas, and the page
            // already draws the title in its shielded header.
            PushedPage(title: secure ? "" : state.chrome.title, parentTitle: state.chrome.backLabel, onBack: onBack) {
                if !state.chrome.editLabel.isEmpty {
                    Button {
                        send(Self.event { $0.edit = .init() })
                        push(LockerScreens.editRoute(state.itemID))
                    } label: {
                        Text(state.chrome.editLabel)
                            .centraidType("smallStrong")
                            .foregroundStyle(Theme.color("text", scheme))
                            .padding(.horizontal, 8)
                            .frame(minHeight: CentraidGeometry.targetMinCoarse)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("locker-item-edit")
                }
            } content: {
                // THE ITEM IS SHIELDED FROM CAPTURE while the gate says `secure`.
                LockerShield(lock: lock) {
                    ReadStateView(
                        content: content(state),
                        onRetry: { send(Self.event { $0.refreshed = .init() }) }
                    ) { item in
                        if item.hasGone {
                            EmptyStateView(item.gone)
                        } else {
                            ScrollView {
                                LazyVStack(alignment: .leading, spacing: 0) { page(item) }
                                    .padding(.bottom, 16)
                            }
                        }
                    }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if state.hasStatus {
                        StatusLineView(status: state.status, identifier: "locker-item-status") {
                            send(Self.event { $0.statusActed = .init() })
                        }
                        .padding(.vertical, 4)
                        .background(Theme.color("bg", scheme))
                    }
                }
            }
        }
        .modifier(LockerClipboardRunner(clip: state.hasClipboard ? state.clipboard : nil) { token in
            send(Self.event { $0.clipboardDone = .with { $0.token = token } })
        })
        .sheet(isPresented: Binding(
            get: { state.hasConfirm },
            set: { open in if !open, state.hasConfirm { send(Self.event { $0.dismissed = .init() }) } }
        )) {
            LockerShield(lock: lock) {
                ConfirmSheet(
                    state.confirm,
                    onConfirm: { send(Self.event { $0.confirmed = .init() }) },
                    onDismiss: { send(Self.event { $0.dismissed = .init() }) }
                )
            }
            .modifier(SheetPresentation(detents: ConfirmSheet.detents))
        }
        .sheet(isPresented: Binding(
            get: { state.hasMemo },
            set: { open in if !open, state.hasMemo { send(Self.event { $0.memoClosed = .init() }) } }
        )) {
            // A SHEET IS ITS OWN PRESENTATION: the root switcher mask does not
            // reach it, so an open Locker's memo carries its own shield — the
            // room in the secure canvas, and its presentation (which cannot
            // climb out of the canvas's controller) stated again outside it.
            LockerShield(lock: lock) {
                LockerMemoSheetView(
                    memo: state.memo,
                    onType: { text in send(Self.event { $0.memoTyped = .with { $0.text = text } }) },
                    onSave: { send(Self.event { $0.memoSaved = .init() }) },
                    onClose: { send(Self.event { $0.memoClosed = .init() }) }
                )
            }
            .modifier(SheetPresentation())
        }
        .onDisappear(perform: onDeparted)
    }

    @ViewBuilder
    private func page(_ item: Centraid_Screen_V1_LockerItemData) -> some View {
        HStack(spacing: 12) {
            LockerTypeChip(letters: item.typeChip)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .centraidType("title")
                    .foregroundStyle(Theme.color("text", scheme))
                Text(item.typeLabel)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
            Spacer(minLength: 0)
            ForEach(Array(item.chips.enumerated()), id: \.offset) { _, chip in StatusChipView(chip) }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.top, 8)
        LockerNote(text: item.trashedNote)
        LockerNote(text: item.statusLine)
        ForEach(Array(item.sections.enumerated()), id: \.offset) { _, section in
            if !section.title.isEmpty { SectionHeader(title: section.title) }
            ForEach(section.rows, id: \.key) { row in
                LockerFieldRowView(row: row) { verb in tapped(row, verb) }
            }
        }
        if !item.tags.isEmpty {
            FieldRow(key: item.tagsLabel, value: item.tags.joined(separator: " · "))
        }
        if !item.memo.isEmpty || !item.memoAction.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                if !item.memo.isEmpty {
                    FieldRow(key: item.memoLabel, value: item.memo)
                        .padding(.horizontal, -CentraidGeometry.pageMargin)
                }
                if !item.memoAction.isEmpty {
                    KitOutlineButton(label: item.memoAction) { send(Self.event { $0.memoOpened = .init() }) }
                        .accessibilityIdentifier("locker-item-memo")
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 8)
        }
        if !item.actions.isEmpty {
            VStack(spacing: 0) {
                ForEach(item.actions, id: \.key) { action in
                    SheetRow(
                        label: action.label,
                        destructive: action.destructive,
                        identifier: "locker-item-action-\(action.key)",
                        onTap: { send(Self.event { $0.action = .with { $0.key = action.key } }) }
                    )
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.top, 12)
        }
    }

    /// A row's verb. `open` is the shell's — the address, handed to the OS;
    /// every other verb is the machine's.
    private func tapped(_ row: Centraid_Screen_V1_LockerFieldRow, _ verb: Centraid_Screen_V1_LockerVerb) {
        if verb.key == "open", let url = URL(string: row.value), url.scheme != nil {
            openURL(url)
            return
        }
        send(Self.event { $0.verb = .with { $0.key = row.key; $0.verb = verb.key } })
    }
}

/// THE FIELD ROW WITH VERBS. The value is never selectable; a sealed one is
/// its dot run in `textSoft`.
struct LockerFieldRowView: View {
    let row: Centraid_Screen_V1_LockerFieldRow
    let onVerb: (Centraid_Screen_V1_LockerVerb) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(row.label)
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color("textSoft", scheme))
            Group {
                if row.sealed && !row.revealed {
                    Text(row.mask)
                        .centraidType("mono")
                        .kerning(2)
                        .foregroundStyle(Theme.color("textSoft", scheme))
                } else {
                    HStack(spacing: 8) {
                        Text(row.value)
                            .centraidType(row.monospace ? "mono" : "body")
                            .foregroundStyle(Theme.color("text", scheme))
                        if row.hasCountdown {
                            LockerCountdownRing(countdown: row.countdown)
                        }
                    }
                }
            }
            .textSelection(.disabled)
            .accessibilityIdentifier("locker-field-\(row.key)-value")
            if !row.note.isEmpty {
                Text(row.note)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textFaint", scheme))
                    .monospacedDigit()
            }
            if !row.verbs.isEmpty {
                HStack(spacing: 16) {
                    ForEach(row.verbs, id: \.key) { verb in
                        Button { onVerb(verb) } label: {
                            Text(verb.label)
                                .centraidType("smallStrong")
                                .foregroundStyle(Theme.color("text", scheme))
                                .frame(minHeight: CentraidGeometry.targetMinFine)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("locker-field-\(row.key)-\(verb.key)")
                    }
                }
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
        .overlay(alignment: .bottom) { KitHairline() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(row.accessibilityLabel)
    }
}

/// A ONE-TIME CODE'S LIFE (Q-1047-16): a small ring that empties as the step
/// runs out. The seconds are also in the row's note, so the ring is
/// decoration and hidden from VoiceOver.
struct LockerCountdownRing: View {
    let countdown: Centraid_Screen_V1_LockerCountdown

    @Environment(\.colorScheme) private var scheme

    private var fraction: Double {
        guard countdown.period > 0 else { return 0 }
        return min(1, Double(countdown.secondsLeft) / Double(countdown.period))
    }

    var body: some View {
        ZStack {
            Circle()
                .stroke(Theme.color("line", scheme), lineWidth: 2)
            Circle()
                .trim(from: 0, to: fraction)
                .stroke(Theme.color(countdown.secondsLeft <= 5 ? "net" : "textSoft", scheme), style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.linear(duration: 1), value: fraction)
        }
        .frame(width: 14, height: 14)
        .accessibilityHidden(true)
        .accessibilityIdentifier("locker-code-countdown")
    }
}

/// THE MEMO SHEET: one field, Save as the sheet's one ink button, Cancel.
struct LockerMemoSheetView: View {
    let memo: Centraid_Screen_V1_LockerMemoSheet
    let onType: (String) -> Void
    let onSave: () -> Void
    let onClose: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        SheetRoom(
            title: memo.title,
            primary: SheetPrimary(label: memo.saveLabel, action: onSave),
            titleIdentifier: "locker-memo"
        ) {
            MachineTextField(placeholder: memo.hint, value: memo.text, axis: .vertical, focusOnAppear: true, onEdit: onType)
                .centraidType("body")
                .foregroundStyle(Theme.color("text", scheme))
                .lineLimit(3...8)
                .accessibilityIdentifier("locker-memo-text")
            Button(action: onClose) {
                Text(memo.cancelLabel)
                    .centraidType("labelOn")
                    .foregroundStyle(Theme.color("text", scheme))
                    .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("locker-memo-cancel")
        }
    }
}
