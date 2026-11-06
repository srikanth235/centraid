import SwiftUI

extension EnvironmentValues {
    /// WHETHER TEXT IS AT THE LARGEST SIZE THE APP FOLLOWS (#1173, the LargeText board). The root
    /// caps Dynamic Type at `Theme.textSizeCap`, so this is true exactly at the cap: the point
    /// where a card that shared a row with another no longer has room for its words.
    var isLargestText: Bool { dynamicTypeSize >= Theme.textSizeCap }
}

/// CARDS IN `columns` COLUMNS, ONE COLUMN AT THE LARGEST TEXT. The cards of a row share the row's
/// height. An odd count leaves the last row's second slot empty. Any grid of cards (a count tile,
/// a category card) is drawn through this, so each reflows alike.
struct KitCardGrid<Item: Identifiable, Card: View>: View {
    let items: [Item]
    var columns: Int = 2
    var gap: CGFloat = 10
    let card: (Item) -> Card

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var across: Int { dynamicTypeSize >= Theme.textSizeCap ? 1 : max(columns, 1) }

    var body: some View {
        let rows = stride(from: 0, to: items.count, by: across).map { Array(items[$0 ..< min($0 + across, items.count)]) }
        VStack(spacing: gap) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(alignment: .top, spacing: gap) {
                    ForEach(row) { item in card(item).frame(maxWidth: .infinity, alignment: .top) }
                    ForEach(0 ..< (across - row.count), id: \.self) { _ in Color.clear.frame(maxWidth: .infinity) }
                }
            }
        }
    }
}
