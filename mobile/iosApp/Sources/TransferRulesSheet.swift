import SwiftUI

/// THE MEMBER'S TRANSFER RULE, AS A SHEET (#1025 S4, D-1025-S7-60): Rust's
/// (`HomeState.transfer_sheet`). Three choices, each a plain SENTENCE rather than
/// a label — a member deciding how their phone spends money is owed something
/// they can act on — the same three the Backup page draws, from the same store.
/// The tick is the store's answer, never the tap.
///
/// **It sets the rule and starts nothing.** A member who has just chosen to
/// spend less must not be answered by a pass that spends; the new rule governs
/// the next window, and what the OS already holds is cancelled in Rust.
struct TransferRulesSheet: View {
    let sheet: Centraid_Core_V1_HomeTransferSheet
    /// A choice's stored word: Home's and Settings' own events carry it.
    let onPick: (String) -> Void
    let onClose: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        SheetRoom(
            title: sheet.title,
            primary: SheetPrimary(label: KitWords.DONE, action: onClose),
            fit: true
        ) {
            Text(sheet.subtitle)
                .centraidType("small")
                .foregroundStyle(Theme.color("textSoft", scheme))

            VStack(spacing: 0) {
                ForEach(sheet.choices, id: \.stored) { choice in
                    SheetRow(
                        label: choice.sentence,
                        selected: choice.picked,
                        identifier: "transfer-rule-\(choice.stored)"
                    ) {
                        onPick(choice.stored)
                    }
                }
            }
            // THE CHOICES STAND ON THE SHEET AS ONE GROUP, as `OptionSheet`'s rows do.
            .sheetRowGroup()
        }
    }
}
