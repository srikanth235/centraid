import SwiftUI

// THE REDESIGN'S COLOURS FOR AGENDA (#1173), looked up by the key Rust sends.
//
// A list's colour is one of the eight `[list]` names in `design/tokens.toml`
// (`blue`, `raspberry`, ...); a smart-list card's is a token name
// (`listBlue`, `stateAmber`, `textInk`). Both map to the generated colour
// sets (light and dark are built into each set), so no hex lives here.

enum AgendaPalette {
    /// The colour of a list key (`raspberry`); nil for an empty key.
    static func list(_ key: String) -> Color? {
        guard let first = key.first else { return nil }
        return Color("CentraidList" + first.uppercased() + key.dropFirst())
    }

    /// The colour of a token name (`listBlue`, `stateAmber`, `textInk`).
    static func token(_ key: String) -> Color {
        guard let first = key.first else { return Color("CentraidTextInk") }
        return Color("Centraid" + first.uppercased() + key.dropFirst())
    }
}

/// The smart-list cards of the Reminders home: a 2-column grid of rounded
/// cards, each a glyph, a big count and the label, in the card's colour.
struct AgendaSmartListGrid: View {
    let lists: [Centraid_Core_V1_AgendaSmartList]
    let open: (Centraid_Core_V1_Route) -> Void

    private let columns = [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]

    var body: some View {
        LazyVGrid(columns: columns, spacing: 10) {
            ForEach(lists, id: \.key) { list in
                Button { open(list.route) } label: {
                    VStack(alignment: .leading) {
                        HStack(alignment: .top) {
                            CentraidIconView(iconKey: list.iconKey, tint: .white, size: 26)
                            Spacer(minLength: 0)
                            if !list.count.isEmpty {
                                Text(list.count)
                                    .font(.system(size: 28, weight: .bold))
                                    .foregroundStyle(.white)
                            }
                        }
                        Spacer(minLength: 0)
                        Text(list.label)
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(.white)
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, minHeight: 92, alignment: .leading)
                    .background(AgendaPalette.token(list.colorKey))
                    .clipShape(RoundedRectangle(cornerRadius: 18))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(list.accessibilityLabel)
                .accessibilityIdentifier("agenda-smart-\(list.key)")
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
    }
}

/// The Calendar tab's view menu: the current view's name and a chevron; a tap
/// lists Day and List (Rust's rows), each picking its destination.
struct AgendaViewMenu: View {
    let views: [Centraid_Core_V1_AgendaCalendarView]
    let label: String
    let pick: (Centraid_Core_V1_AgendaDestination) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Menu {
            ForEach(views, id: \.key) { view in
                Button(view.label) { pick(view.destination) }
                    .accessibilityIdentifier("agenda-view-\(view.key)")
            }
        } label: {
            HStack(spacing: 4) {
                Text(views.first(where: { $0.current })?.label ?? label)
                    .centraidType("smallStrong")
                CentraidIconView(iconKey: "ChevronDown", tint: Theme.color("textSoft", scheme), size: 14)
            }
            .foregroundStyle(Theme.color("text", scheme))
            .frame(minHeight: CentraidGeometry.targetMinCoarse)
        }
        .accessibilityLabel(label)
        .accessibilityIdentifier("agenda-view-menu")
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
