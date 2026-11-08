import SwiftUI

// THE EVENT EDITOR'S ROWS ON THE BOARD (#1173, `EventEditorRows`): two rounded cards, each row a
// colour tile, its label, its value and a chevron. The glyph and the colour of every tile come
// from Rust (`AgendaEditorChrome.tiles`, by the row's key); these views only lay them out.

/// A rounded card the editor's rows sit in: the card colour, the card radius, rows divided by a
/// hairline inset past the tile.
struct AgendaGroupCard<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(spacing: 0) { content() }
            .frame(maxWidth: .infinity, alignment: .leading)
            .kitCard()
            .clipShape(RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.top, 12)
    }
}

/// The row's tile: a white glyph on the token Rust names. Nothing without a tile.
struct AgendaRowTileView: View {
    let tile: Centraid_Core_V1_AgendaRowTile?

    var body: some View {
        if let tile, !tile.iconKey.isEmpty {
            KitTile(iconKey: tile.iconKey, size: 30, fill: AgendaPalette.token(tile.colorKey))
        }
    }
}

/// The hairline under a card row, inset to the label's start.
private struct AgendaRowDivider: ViewModifier {
    let on: Bool
    let inset: CGFloat

    func body(content: Content) -> some View {
        content.overlay(alignment: .bottom) {
            if on { KitHairline(inset: inset) }
        }
    }
}

extension View {
    /// 56 clears a 30pt tile and its gap; a tile-less row passes its own padding.
    fileprivate func agendaRowDivider(_ on: Bool, inset: CGFloat = 56) -> some View {
        modifier(AgendaRowDivider(on: on, inset: inset))
    }
}

/// A card row whose value is a choice: tile, label, value, chevron. A tap opens the sheet.
struct AgendaTileChoiceRow: View {
    let key: String
    let value: String
    let tile: Centraid_Core_V1_AgendaRowTile?
    var identifier: String = ""
    var divider = true
    let onTap: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                AgendaRowTileView(tile: tile)
                Text(key)
                    .kitType(.row)
                    .foregroundStyle(Surface.ink)
                Spacer(minLength: 8)
                Text(value)
                    .centraidType("body")
                    .foregroundStyle(Surface.meta)
                    .lineLimit(1)
                CentraidIconView(iconKey: "ChevronRight", tint: Theme.color("textFaint", scheme), size: 14)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
            .agendaRowDivider(divider)
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
        .accessibilityElement(children: .combine)
        .modifier(OptionalIdentifier(identifier: identifier))
    }
}

/// A card row the member types into (the joining link): tile, label, then the field.
struct AgendaTileFieldRow: View {
    let key: String
    @Binding var text: String
    var placeholder = ""
    let tile: Centraid_Core_V1_AgendaRowTile?
    var identifier: String = ""
    var divider = true
    let onEdit: (String) -> Void

    var body: some View {
        HStack(spacing: 12) {
            AgendaRowTileView(tile: tile)
            Text(key)
                .kitType(.row)
                .foregroundStyle(Surface.ink)
            TextField(placeholder, text: $text)
                .centraidType("body")
                .multilineTextAlignment(.trailing)
                .foregroundStyle(Surface.meta)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .onChange(of: text) { _, typed in onEdit(typed) }
                .accessibilityLabel(key)
                .modifier(OptionalIdentifier(identifier: identifier))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
        .agendaRowDivider(divider)
    }
}

/// A card row for a start or an end: tile, label, then the day and the time as the two taps that
/// open the pickers. The faces are the caller's, so the picking stays in the editor.
struct AgendaTileWhenRow<Faces: View>: View {
    let key: String
    let tile: Centraid_Core_V1_AgendaRowTile?
    var identifier: String = ""
    var divider = true
    @ViewBuilder let faces: () -> Faces

    var body: some View {
        HStack(spacing: 12) {
            AgendaRowTileView(tile: tile)
            Text(key)
                .kitType(.row)
                .foregroundStyle(Surface.ink)
            Spacer(minLength: 8)
            faces()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
        .agendaRowDivider(divider)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }
}

/// A fact on the event page: the label left in soft ink, the value right, one row of the facts card.
struct AgendaFactRow: View {
    let label: String
    let value: String
    var divider = true

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            Text(label)
                .centraidType("body")
                .foregroundStyle(Surface.meta)
                .fixedSize(horizontal: true, vertical: false)
            Spacer(minLength: 0)
            Text(value)
                .centraidType("body")
                .foregroundStyle(Surface.ink)
                .multilineTextAlignment(.trailing)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
        .agendaRowDivider(divider, inset: 14)
        .accessibilityElement(children: .combine)
    }
}
