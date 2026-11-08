import SwiftUI

/// THE CONFIRM: the machine's `Confirm` (title, the one full sentence the copy
/// table allows, the verb) in a `SheetRoom`. **Destructive is the outlined
/// `net` button** — the handoff's "destructive outline" — and Cancel is always
/// there, because a confirm with one way out is not a question.
struct ConfirmSheet: View {
    /// Its detents, named so a host that shields it can state them again.
    static let detents: Set<PresentationDetent> = [.height(320), .medium]

    let confirm: Centraid_Core_V1_Confirm
    var cancelLabel: String = KitWords.CANCEL
    let onConfirm: () -> Void
    let onDismiss: () -> Void

    @Environment(\.colorScheme) private var scheme

    init(
        _ confirm: Centraid_Core_V1_Confirm,
        cancelLabel: String = KitWords.CANCEL,
        onConfirm: @escaping () -> Void,
        onDismiss: @escaping () -> Void
    ) {
        self.confirm = confirm
        self.cancelLabel = cancelLabel
        self.onConfirm = onConfirm
        self.onDismiss = onDismiss
    }

    var body: some View {
        // THE VERB, THEN ITS WAY OUT UNDER IT: the same order as every sheet's answers.
        SheetRoom(
            title: confirm.title,
            primary: SheetPrimary(label: confirm.confirmLabel, destructive: confirm.destructive, action: onConfirm),
            // THE WAY OUT IS A TEXT KEY (the Trash and Cancel-event boards): bold, no outline.
            outlines: [SheetOutline(label: cancelLabel, link: true, ink: true, identifier: "kit-confirm-cancel", action: onDismiss)],
            titleIdentifier: "kit-confirm"
        ) {
            if !confirm.body.isEmpty {
                Text(confirm.body)
                    .kitType(.row)
                    .foregroundStyle(Surface.body)
            }
        }
        .presentationDetents(Self.detents)
        // NO IDENTIFIER ON THE CONTAINER (#1047): one there is handed down to
        // every child and replaced theirs (`kit-destructive`,
        // `kit-confirm-cancel`) even under `.contain`. The sheet is found by
        // its title, which carries `kit-confirm`.
    }
}

/// A REFUSAL TOLD IN A SHEET, NOT AN ALERT (product-intuition/references/design-behaviour.md § Controls):
/// the act that was refused as the title, the sentence saying what happened
/// and what to do, and one way out, the outline [doneLabel]. A swipe away is
/// the same as Done.
struct NoticeSheet: View {
    static let detents: Set<PresentationDetent> = [.height(240), .medium]

    let title: String
    let sentence: String
    let doneLabel: String
    let onDone: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        SheetRoom(
            title: title,
            outlines: [SheetOutline(label: doneLabel, identifier: "kit-notice-done", action: onDone)],
            titleIdentifier: "kit-notice"
        ) {
            Text(sentence)
                .kitType(.row)
                .foregroundStyle(Surface.body)
        }
        .presentationDetents(Self.detents)
    }
}

/// ONE ROW OF A SHEET OF CHOICES: a mark and a verb, 44pt, the whole row the
/// target. A destructive row is `net` ink, never a red fill.
struct SheetRow: View {
    var iconKey: String = ""
    let label: String
    /// A line of meta under the label ("From a password manager"); the machine's words.
    var detail: String = ""
    var destructive: Bool = false
    var selected: Bool = false
    /// A row that opens another sheet or page says so with a trailing chevron.
    var chevron: Bool = false
    /// A colour dot in the mark's place (a label wears its colour); the dot replaces the tile.
    var dot: Color? = nil
    var identifier: String = ""
    let onTap: () -> Void

    @Environment(\.isEnabled) private var enabled
    @Environment(\.appAccent) private var accent

    var body: some View {
        let ink = enabled ? (destructive ? StateColor.red.text : Surface.ink) : Surface.meta
        Button(action: onTap) {
            HStack(spacing: 12) {
                if let dot {
                    Circle().fill(dot).frame(width: 10, height: 10)
                        .frame(width: 32, height: 32)
                        .accessibilityHidden(true)
                } else if !iconKey.isEmpty {
                    // THE MARK IS A SMALL TILE in the app's fill with a white glyph; a
                    // destructive row's is the state's red.
                    KitTile(iconKey: iconKey, size: 32, fill: destructive ? StateColor.red.fill : nil)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(label)
                        .kitType(.row)
                        .foregroundStyle(ink)
                    if !detail.isEmpty {
                        Text(detail)
                            .kitType(.meta)
                            .foregroundStyle(Surface.meta)
                    }
                }
                Spacer(minLength: 0)
                if selected {
                    CentraidIconView(iconKey: "Check", tint: accent.text, size: 16)
                }
                if chevron {
                    CentraidIconView(iconKey: "ChevronRight", tint: Surface.meta, size: 16)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse + 8)
            .overlay(alignment: .bottom) {
                Rectangle().fill(Surface.line).frame(height: CentraidGeometry.hairline).padding(.leading, 56)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(identifier.isEmpty ? "kit-sheet-row" : identifier)
    }
}

/// A SHEET OF CHOICES — a More sheet, a pick. Rows are `SheetRow`s; choosing
/// is the row's own event, so the sheet carries no ink button.
struct OptionSheet<Rows: View>: View {
    let title: String
    var status: String = ""
    let rows: () -> Rows

    init(title: String, status: String = "", @ViewBuilder rows: @escaping () -> Rows) {
        self.title = title
        self.status = status
        self.rows = rows
    }

    var body: some View {
        SheetRoom(title: title, status: status) {
            // THE ROWS ARE ONE CARD ON THE SHEET (#1173); the last row's hairline falls outside
            // the clip, so a card never ends on a rule.
            VStack(spacing: 0) { rows() }
                .padding(.bottom, -1)
                .background(Surface.sheetCard)
                .clipShape(RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))
        }
    }
}
