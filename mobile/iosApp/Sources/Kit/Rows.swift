import SwiftUI

/// The press every tappable kit row shows: `bgPress` under the row while held.
struct KitRowPress: ButtonStyle {
    @Environment(\.colorScheme) private var scheme

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Surface.fill : Color.clear)
    }
}

struct OptionalIdentifier: ViewModifier {
    let identifier: String
    func body(content: Content) -> some View {
        if identifier.isEmpty { content } else { content.accessibilityIdentifier(identifier) }
    }
}

/// THE NEXT PAGE, ASKED FOR. A paged list's foot: shown only while the data
/// names a next cursor, and quiet while a page-one re-read is in flight (the
/// kit's `PagedList` refuses a next page then anyway).
struct ShowMoreFooter: View {
    let visible: Bool
    var loading: Bool = false
    var label: String = KitWords.SHOW_MORE
    let onMore: () -> Void

    var body: some View {
        if visible {
            HStack {
                Spacer()
                KitOutlineButton(label: label, action: onMore)
                    .disabled(loading)
                    .accessibilityIdentifier("kit-show-more")
                Spacer()
            }
            .padding(.vertical, 12)
        }
    }
}

/// The row divider every kit row draws: a hairline inset by the page margin,
/// or by `inset` where the row's words start further in (Tasks' circle).
struct KitHairline: View {
    var inset: CGFloat = CentraidGeometry.pageMargin

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Rectangle()
            .fill(Surface.line)
            .frame(height: CentraidGeometry.hairline)
            .padding(.leading, inset)
    }
}

/// A ROW'S HUE, AS THE THEME SPELLS IT. Machines send the colour role
/// (`cRose`); a few still send the wheel key (`rose`). Both resolve here, and
/// anything the emitted table lacks draws no rule — `Theme.color` traps on an
/// unknown role, and a row must never crash on what the vault stored.
enum KitHue {
    static func role(_ key: String) -> String? {
        guard !key.isEmpty else { return nil }
        if centraidColorRoles.contains(key) { return key }
        let wheel = "c" + String(key.prefix(1)).uppercased() + String(key.dropFirst())
        return centraidColorRoles.contains(wheel) ? wheel : nil
    }
}
