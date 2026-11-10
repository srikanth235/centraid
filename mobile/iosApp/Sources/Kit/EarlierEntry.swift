import SwiftUI

/// THE ENTRY TO A RECORD'S EARLIER VERSIONS (#1185): one row in a white card at the foot of a
/// detail page, "Earlier versions   2 ›". Every word is Rust's (`EarlierEntry`); a tap hands the
/// entry's own `route` to the shell, like any row that opens a page. An absent entry, or one with
/// no label, draws nothing and reserves no space.
///
/// A detail page embeds it with its state's optional field:
/// `EarlierEntryRow(entry: state.hasEarlier ? state.earlier : nil, open: open)`.
///
/// Id: `earlier-entry`; the Compose twin is `kit/EarlierEntry.kt`.
struct EarlierEntryRow: View {
    let entry: Centraid_Core_V1_EarlierEntry?
    let open: (Centraid_Core_V1_Route) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if let entry, EarlierEntryRow.isDrawn(entry) {
            Button { open(entry.route) } label: {
                HStack(spacing: 8) {
                    Text(entry.label)
                        .kitType(.row)
                        .foregroundStyle(Surface.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(entry.countLabel)
                        .kitType(.row)
                        .foregroundStyle(Surface.meta)
                    CentraidIconView(iconKey: "ChevronRight", tint: Theme.color("textFaint", scheme), size: 14)
                }
                .padding(.horizontal, 14)
                .frame(minHeight: 48)
                .contentShape(Rectangle())
            }
            .buttonStyle(KitRowPress())
            .accessibilityElement(children: .combine)
            .accessibilityLabel(entry.accessibilityLabel.isEmpty ? entry.label : entry.accessibilityLabel)
            .accessibilityIdentifier(EarlierEntryRow.identifier)
            .kitCard()
            .clipShape(RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.top, 10)
        }
    }

    nonisolated static let identifier = "earlier-entry"

    /// True when the entry has words to draw; an empty one draws nothing.
    nonisolated static func isDrawn(_ entry: Centraid_Core_V1_EarlierEntry?) -> Bool {
        guard let entry else { return false }
        return !entry.label.isEmpty
    }
}
