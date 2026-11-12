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

/// WHERE IT CAME FROM (#1185): one quiet line under the Earlier versions entry of a detail page,
/// "From contacts.vcf". Every word is Rust's (`OriginLine`); it is not a row and takes no tap. An
/// absent line, or one with no text (a typed item), draws nothing and reserves no space.
///
/// A detail page embeds it right after the entry:
/// `OriginLineView(line: state.hasOrigin ? state.origin : nil)`.
///
/// Id: `origin-line`; the Compose twin is `OriginLineView` in `kit/EarlierEntry.kt`.
struct OriginLineView: View {
    let line: Centraid_Core_V1_OriginLine?

    var body: some View {
        if let line, OriginLineView.isDrawn(line) {
            Text(line.text)
                .kitType(.meta)
                .foregroundStyle(Surface.meta)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, CentraidGeometry.pageMargin + 14)
                .padding(.top, 8)
                .accessibilityLabel(line.accessibilityLabel.isEmpty ? line.text : line.accessibilityLabel)
                .accessibilityIdentifier(OriginLineView.identifier)
        }
    }

    nonisolated static let identifier = "origin-line"

    /// True when the line has words to draw; an empty one draws nothing.
    nonisolated static func isDrawn(_ line: Centraid_Core_V1_OriginLine?) -> Bool {
        guard let line else { return false }
        return !line.text.isEmpty
    }
}
