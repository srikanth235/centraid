import SwiftUI

/// The item page's events, built once.
enum LockerItemEvents {
    static func make(_ build: (inout Centraid_Core_V1_LockerItemEvent) -> Void) -> Centraid_Core_V1_LockerItemEvent {
        var event = Centraid_Core_V1_LockerItemEvent()
        build(&event)
        return event
    }
}

/// ONE LOCKER ITEM (#1047; the handoff's field row recipe): its sections of
/// field rows — plain metadata shows its value, a sealed cell shows its mask
/// and offers Reveal and Copy, a revealed one counts down and offers Copy and
/// Conceal — its tags, its memo, and its verbs.
///
/// **THE VIEW DECIDES NOTHING**, and it NEVER makes a revealed value
/// selectable: a copy is the Copy verb's, a sensitive clip with a deadline the
/// shell keeps (`ClipboardSet`). Leaving by any route is Rust's `Left`, which
/// conceals what was shown. A verb tap names its row and verb; opening an
/// address is Rust's `OpenUrl` effect.
struct LockerItemView: View {
    let state: Centraid_Core_V1_LockerItemState
    let send: (Centraid_Core_V1_LockerItemEvent) -> Void
    let sendWall: (Centraid_Core_V1_LockerWallEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onWords: () -> Void
    let onBack: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var content: ScreenContent<Centraid_Core_V1_LockerItemData> {
        switch state.content {
        case .loading?, nil: return .loading(true)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .gated(denied)
        case let .data(data)?: return .data(data)
        }
    }

    var body: some View {
        LockerCovered(wall: state.hasWall ? state.wall : nil, backLabel: state.chrome.backLabel, send: sendWall, onWords: onWords, onBack: onBack) {
            // THE ITEM'S NAME NEVER SITS IN THE NAVIGATION BAR while the Locker
            // is `secure`: the bar is outside the secure canvas, and the page
            // already draws the title in its shielded header.
            PushedPage(title: state.secure ? "" : state.chrome.title, parentTitle: state.chrome.backLabel, onBack: onBack) {
                HStack(spacing: 8) {
                    // THE "…" MENU holds the item's verbs (add a field, star, archive, trash).
                    if case let .data(item)? = state.content, !item.hasGone, !item.actions.isEmpty {
                        Menu {
                            ForEach(item.actions, id: \.key) { action in
                                Button(role: action.destructive ? .destructive : nil) {
                                    send(LockerItemEvents.make { $0.action = .with { $0.key = action.key } })
                                } label: {
                                    Text(action.label)
                                }
                                .accessibilityIdentifier("locker-item-action-\(action.key)")
                            }
                        } label: {
                            ToolbarIconFace(iconKey: "MoreHoriz")
                        }
                        .accessibilityLabel(state.chrome.menuLabel)
                        .accessibilityIdentifier("locker-item-menu")
                    }
                    if !state.chrome.editLabel.isEmpty {
                        ToolbarVerb(label: state.chrome.editLabel, identifier: "locker-item-edit") {
                            if state.chrome.hasEditRoute { open(state.chrome.editRoute) }
                        }
                    }
                }
            } content: {
                LockerShield(secure: state.secure) {
                    ReadStateView(
                        content: content,
                        onRetry: { send(LockerItemEvents.make { $0.refreshed = .init() }) }
                    ) { item in
                        if item.hasGone {
                            EmptyStateView(item.gone)
                        } else {
                            ScrollView {
                                LazyVStack(alignment: .leading, spacing: 0) { page(item) }
                                    .padding(.bottom, 16)
                            }
                            .accessibilityIdentifier("locker-item")
                        }
                    }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if state.hasStatus {
                        StatusLineView(status: state.status, identifier: "locker-item-status") {
                            send(LockerItemEvents.make { $0.statusActed = .init() })
                        }
                        .padding(.vertical, 4)
                        .background(Theme.color("bg", scheme))
                    }
                }
            }
        }
        .sheet(isPresented: Binding(
            get: { state.hasConfirm },
            set: { isOpen in if !isOpen, state.hasConfirm { send(LockerItemEvents.make { $0.dismissed = .init() }) } }
        )) {
            LockerShield(secure: state.secure) {
                ConfirmSheet(
                    state.confirm,
                    onConfirm: { send(LockerItemEvents.make { $0.confirmed = .init() }) },
                    onDismiss: { send(LockerItemEvents.make { $0.dismissed = .init() }) }
                )
            }
            .modifier(SheetPresentation(detents: ConfirmSheet.detents))
        }
        .sheet(isPresented: Binding(
            get: { state.linkPicker.open },
            set: { isOpen in
                if !isOpen, state.linkPicker.open {
                    send(LockerItemEvents.make { $0.link = .with { $0.closed = .init() } })
                }
            }
        )) {
            // A SHEET IS ITS OWN PRESENTATION: it carries its own shield, like the memo.
            LockerShield(secure: state.secure) {
                LinkPickerSheet(picker: state.linkPicker) { link in
                    send(LockerItemEvents.make { $0.link = link })
                }
            }
            .modifier(SheetPresentation())
        }
        .sheet(isPresented: Binding(
            get: { state.hasMemo },
            set: { isOpen in if !isOpen, state.hasMemo { send(LockerItemEvents.make { $0.memoClosed = .init() }) } }
        )) {
            // A SHEET IS ITS OWN PRESENTATION: the root switcher mask does not
            // reach it, so an open Locker's memo carries its own shield.
            LockerShield(secure: state.secure) {
                LockerMemoSheetView(
                    memo: state.memo,
                    onType: { text in send(LockerItemEvents.make { $0.memoTyped = .with { $0.text = text } }) },
                    onSave: { send(LockerItemEvents.make { $0.memoSaved = .init() }) },
                    onClose: { send(LockerItemEvents.make { $0.memoClosed = .init() }) }
                )
            }
            .modifier(SheetPresentation())
        }
        // THE CUSTOM FIELD SHEET (#1047 T2): one field, added or edited. A
        // sealed value is typed into a secure entry, shielded like the memo.
        .sheet(isPresented: Binding(
            get: { state.hasFieldSheet },
            set: { isOpen in if !isOpen, state.hasFieldSheet { send(LockerItemEvents.make { $0.fieldClosed = .init() }) } }
        )) {
            LockerShield(secure: state.secure) {
                LockerFieldSheetView(sheet: state.fieldSheet, send: send)
            }
            .modifier(SheetPresentation())
        }
        // THE PASSKEY'S NAME (#1047 T2): the memo sheet's shape.
        .sheet(isPresented: Binding(
            get: { state.hasPasskeyName },
            set: { isOpen in if !isOpen, state.hasPasskeyName { send(LockerItemEvents.make { $0.passkeyNameClosed = .init() }) } }
        )) {
            LockerShield(secure: state.secure) {
                LockerMemoSheetView(
                    memo: state.passkeyName,
                    identifier: "locker-passkey-name",
                    onType: { text in send(LockerItemEvents.make { $0.passkeyNameTyped = .with { $0.text = text } }) },
                    onSave: { send(LockerItemEvents.make { $0.passkeyNameSaved = .init() }) },
                    onClose: { send(LockerItemEvents.make { $0.passkeyNameClosed = .init() }) }
                )
            }
            .modifier(SheetPresentation())
        }
    }

    @ViewBuilder
    private func page(_ item: Centraid_Core_V1_LockerItemData) -> some View {
        // THE CENTRED HERO (the Locker item board): the title's first letter on ink, the title with its star
        // beside it, and the type with when it was last used under that.
        VStack(spacing: 8) {
            LockerHeroTile(letter: item.heroInitial)
            HStack(spacing: 6) {
                Text(item.title)
                    .kitType(.hero)
                    .foregroundStyle(Surface.ink)
                    .multilineTextAlignment(.center)
                if !item.starLabel.isEmpty {
                    CentraidIconView(iconKey: "Star", tint: AppAccent("locker").text, size: 18, solid: true)
                        .accessibilityLabel(item.starLabel)
                        .accessibilityIdentifier("locker-item-star")
                }
            }
            Text(item.subtitle)
                .kitType(.meta)
                .foregroundStyle(Surface.meta)
                .multilineTextAlignment(.center)
            if !item.chips.isEmpty {
                HStack(spacing: 6) {
                    ForEach(Array(item.chips.enumerated()), id: \.offset) { _, chip in StatusChipView(chip) }
                }
            }
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("locker-item-head")
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.top, 8)
        LockerNote(text: item.trashedNote)
        LockerNote(text: item.statusLine)
        ForEach(Array(item.sections.enumerated()), id: \.offset) { index, section in
            if !section.title.isEmpty { SectionHeader(title: section.title) }
            // EACH SECTION IS A WHITE CARD OF ROWS; the verification code is the first.
            VStack(spacing: 0) {
                ForEach(section.rows, id: \.key) { row in
                    LockerFieldRowView(row: row) { verb in
                        send(LockerItemEvents.make { $0.verb = .with { $0.key = row.key; $0.verb = verb.key } })
                    }
                }
            }
            .kitCard()
            .clipShape(RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.top, 8)
            if !section.note.isEmpty { LockerNote(text: section.note) }
            // "Change password on website" sits under the type's own fields.
            if item.hasChangePassword, section.rows.contains(where: { $0.key == "password" }) {
                KitOutlineButton(label: item.changePassword.label) {
                    send(LockerItemEvents.make { $0.action = .with { $0.key = item.changePassword.key } })
                }
                .accessibilityIdentifier("locker-item-action-change_password")
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.top, 8)
            }
        }
        if item.hasLinks {
            LinkSectionView(section: item.links, send: { link in
                send(LockerItemEvents.make { $0.link = link })
            }, open: open)
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
                    KitOutlineButton(label: item.memoAction) { send(LockerItemEvents.make { $0.memoOpened = .init() }) }
                        .accessibilityIdentifier("locker-item-memo")
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 8)
        }
        // EVERY RECORD KEEPS ITS EARLIER VALUES (#1185): the last content row; it is inside the item's
        // data, so it is absent while Locker is locked.
        EarlierEntryRow(entry: item.hasEarlier ? item.earlier : nil, open: open)
        OriginLineView(line: item.hasOrigin ? item.origin : nil)
    }
}

/// THE FIELD ROW WITH VERBS. The value is never selectable; a sealed one is its
/// dot run in `textSoft`.
struct LockerFieldRowView: View {
    let row: Centraid_Core_V1_LockerFieldRow
    let onVerb: (Centraid_Core_V1_LockerVerb) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        // THE BOARD'S ROW: the label over the value on the left, the verbs on the trailing edge of
        // the same row (Copy, Hide, Open), so a field is one compact line, not a stack.
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(row.label)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
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
                                .font(row.key == "otp_seed" ? .system(size: 28, weight: .semibold, design: .monospaced) : nil)
                                .foregroundStyle(Surface.ink)
                            if row.hasCountdown {
                                LockerCountdownRing(countdown: row.countdown)
                            }
                        }
                    }
                }
                .textSelection(.disabled)
                .accessibilityIdentifier("locker-value-\(row.key)")
                if !row.note.isEmpty {
                    Text(row.note)
                        .centraidType("annotLabel")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                        .monospacedDigit()
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if !row.verbs.isEmpty {
                HStack(spacing: 12) {
                    ForEach(row.verbs, id: \.key) { verb in
                        if verb.pill {
                            // THE CODE CARD'S COPY: a green pill, as the board draws it.
                            Button(action: { onVerb(verb) }) {
                                Text(verb.label)
                                    .centraidType("smallStrong")
                                    .foregroundStyle(StateColor.green.text)
                                    .padding(.horizontal, 14)
                                    .frame(minHeight: 36)
                                    .background(StateColor.green.tint, in: Capsule())
                                    .contentShape(Capsule())
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("locker-verb-\(row.key)-\(verb.key)")
                        } else {
                            KitLink(label: verb.label, dense: true, identifier: "locker-verb-\(row.key)-\(verb.key)") {
                                onVerb(verb)
                            }
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
        .overlay(alignment: .bottom) { KitHairline().padding(.leading, 14) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(row.accessibilityLabel)
        .accessibilityIdentifier("locker-field-\(row.key)")
    }
}

/// THE MEMO SHEET: one field, Save as the sheet's one ink button, Cancel.
struct LockerMemoSheetView: View {
    let memo: Centraid_Core_V1_LockerMemoSheet
    var identifier: String = "locker-memo"
    let onType: (String) -> Void
    let onSave: () -> Void
    let onClose: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        SheetRoom(
            title: memo.title,
            primary: SheetPrimary(label: memo.saveLabel, action: onSave),
            outlines: [SheetOutline(label: memo.cancelLabel, identifier: "\(identifier)-cancel", action: onClose)],
            titleIdentifier: identifier
        ) {
            MachineTextField(placeholder: memo.hint, value: memo.text, axis: .vertical, focusOnAppear: true, onEdit: onType)
                .centraidType("body")
                .foregroundStyle(Theme.color("text", scheme))
                .lineLimit(3...8)
                .accessibilityIdentifier("\(identifier)-text")
        }
    }
}

/// ONE CUSTOM FIELD (#1047 T2; `LockerFieldSheet`): its section, its label, its
/// kind on a new field, and its value — a secure entry when sealed, never
/// autocorrected, never suggested, out of the keyboard's learning. Save is the
/// sheet's one ink button, offered only when Rust says; otherwise its reason
/// stands where the status goes.
struct LockerFieldSheetView: View {
    let sheet: Centraid_Core_V1_LockerFieldSheet
    let send: (Centraid_Core_V1_LockerItemEvent) -> Void

    @Environment(\.colorScheme) private var scheme

    private func typed(_ key: String) -> (String) -> Void {
        { value in send(LockerItemEvents.make { $0.fieldTyped = .with { $0.key = key; $0.value = value } }) }
    }

    /// REMOVE, WHERE THE FIELD CAN BE REMOVED, THEN CANCEL: Save's alternatives.
    private var alternatives: [SheetOutline] {
        var outlines: [SheetOutline] = []
        if !sheet.removeLabel.isEmpty {
            outlines.append(SheetOutline(label: sheet.removeLabel, tone: "net", identifier: "locker-field-remove") {
                send(LockerItemEvents.make { $0.fieldRemoved = .init() })
            })
        }
        outlines.append(SheetOutline(label: sheet.cancelLabel, identifier: "locker-field-cancel") {
            send(LockerItemEvents.make { $0.fieldClosed = .init() })
        })
        return outlines
    }

    var body: some View {
        SheetRoom(
            title: sheet.title,
            status: sheet.blocked,
            primary: sheet.canSave ? SheetPrimary(label: sheet.saveLabel) {
                send(LockerItemEvents.make { $0.fieldSaved = .init() })
            } : nil,
            outlines: alternatives,
            titleIdentifier: "locker-field-sheet"
        ) {
            labelled(sheet.sectionLabel) {
                MachineTextField(placeholder: sheet.sectionHint, value: sheet.section, onEdit: typed("section"))
                    .accessibilityIdentifier("locker-field-section")
            }
            labelled(sheet.labelLabel) {
                MachineTextField(placeholder: sheet.labelHint, value: sheet.label, focusOnAppear: true, onEdit: typed("label"))
                    .accessibilityIdentifier("locker-field-label")
            }
            if !sheet.kinds.isEmpty {
                labelled(sheet.kindLabel) {
                    LockerChoicePills(choices: sheet.kinds, identifier: "locker-field-kind") { key in
                        send(LockerItemEvents.make { $0.fieldKind = .with { $0.key = key } })
                    }
                    .padding(.horizontal, -CentraidGeometry.pageMargin)
                }
            }
            labelled(sheet.valueLabel) {
                Group {
                    if sheet.secret {
                        LockerSecretField(placeholder: sheet.valueHint, value: sheet.value, concealed: false, onEdit: typed("value"))
                            .centraidType("mono")
                    } else {
                        MachineTextField(placeholder: sheet.valueHint, value: sheet.value, axis: .vertical, onEdit: typed("value"))
                            .textContentType(nil)
                    }
                }
                .id(sheet.secret)
                .accessibilityIdentifier("locker-field-value")
            }
            if !sheet.valueNote.isEmpty {
                Text(sheet.valueNote)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textFaint", scheme))
            }
        }
    }

    @ViewBuilder
    private func labelled(_ label: String, @ViewBuilder _ field: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color("textSoft", scheme))
            field()
                .centraidType("body")
                .foregroundStyle(Theme.color("text", scheme))
        }
    }
}
