import SwiftUI

#if canImport(CentraidShared)
import CentraidShared
#endif

/// THE CONFIRM: the machine's `Confirm` (title, the one full sentence the copy
/// table allows, the verb) in a `SheetRoom`. **Destructive is the outlined
/// `net` button** — the handoff's "destructive outline" — and Cancel is always
/// there, because a confirm with one way out is not a question.
struct ConfirmSheet: View {
    /// Its detents, named so a host that shields it can state them again.
    static let detents: Set<PresentationDetent> = [.height(280), .medium]

    let confirm: Centraid_Screen_V1_Confirm
    var cancelLabel: String = KitWords.shared.CANCEL
    let onConfirm: () -> Void
    let onDismiss: () -> Void

    @Environment(\.colorScheme) private var scheme

    init(
        _ confirm: Centraid_Screen_V1_Confirm,
        cancelLabel: String = KitWords.shared.CANCEL,
        onConfirm: @escaping () -> Void,
        onDismiss: @escaping () -> Void
    ) {
        self.confirm = confirm
        self.cancelLabel = cancelLabel
        self.onConfirm = onConfirm
        self.onDismiss = onDismiss
    }

    var body: some View {
        SheetRoom(
            title: confirm.title,
            primary: SheetPrimary(label: confirm.confirmLabel, destructive: confirm.destructive, action: onConfirm),
            titleIdentifier: "kit-confirm"
        ) {
            if !confirm.body.isEmpty {
                Text(confirm.body)
                    .centraidType("body")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
            Button(action: onDismiss) {
                Text(cancelLabel)
                    .centraidType("labelOn")
                    .foregroundStyle(Theme.color("text", scheme))
                    .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("kit-confirm-cancel")
        }
        .presentationDetents(Self.detents)
        // NO IDENTIFIER ON THE CONTAINER (#1047): one there is handed down to
        // every child and replaced theirs (`kit-destructive`,
        // `kit-confirm-cancel`) even under `.contain`. The sheet is found by
        // its title, which carries `kit-confirm`.
    }
}

/// ONE ROW OF A SHEET OF CHOICES: a mark and a verb, 44pt, the whole row the
/// target. A destructive row is `net` ink, never a red fill.
struct SheetRow: View {
    var iconKey: String = ""
    let label: String
    var destructive: Bool = false
    var selected: Bool = false
    var identifier: String = ""
    let onTap: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                if !iconKey.isEmpty {
                    CentraidIconView(
                        iconKey: iconKey,
                        tint: Theme.color(destructive ? "net" : "text", scheme),
                        size: 18
                    )
                    .frame(width: 24, height: 24)
                }
                Text(label)
                    .centraidType("body")
                    .foregroundStyle(Theme.color(destructive ? "net" : "text", scheme))
                Spacer(minLength: 0)
                if selected {
                    CentraidIconView(iconKey: "Check", tint: Theme.color("text", scheme), size: 16)
                }
            }
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
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
            VStack(spacing: 0) { rows() }
        }
    }
}
