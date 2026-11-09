import SwiftUI

/// ONE ACTION ON A ROW (#1173, the Swipe board): Details, Flag, Delete. The same actions are the
/// swipe and the long-press menu, so a row that can be swiped can be reached without a swipe
/// too. The labels are the machine's (`KitWords.DETAILS`, `FLAG`, `DELETE`); what each does is
/// the screen's own event, so the closure sends it.
struct KitRowAction: Identifiable {
    enum Tone {
        /// Details: a quiet graphite fill.
        case neutral
        /// Flag: the state's amber, because a flag says "look at this".
        case amber
        /// Delete: the state's red.
        case red
    }

    let id: String
    let label: String
    let iconKey: String
    var tone: Tone = .neutral
    /// In the long-press menu only, not on the swipe (Move up, Move down, Move to project).
    var menuOnly: Bool = false
    let action: () -> Void

    fileprivate var fill: Color {
        switch tone {
        case .neutral: Color(CentraidAsset.appLocker)
        case .amber: StateColor.amber.fill
        case .red: StateColor.red.fill
        }
    }
}

extension View {
    /// Swipe actions on a row of a `List` (the trailing edge, none a full swipe so a slip never
    /// deletes) and the same actions on long-press. A row with no actions is left as it is.
    func kitRowActions(_ actions: [KitRowAction]) -> some View {
        modifier(KitRowActions(actions: actions))
    }
}

private struct KitRowActions: ViewModifier {
    let actions: [KitRowAction]

    func body(content: Content) -> some View {
        if actions.isEmpty {
            content
        } else {
            content
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    // Drawn right to left from the edge: Delete is the one nearest it.
                    ForEach(actions.filter { !$0.menuOnly }.reversed()) { action in
                        Button(role: action.tone == .red ? .destructive : nil, action: action.action) {
                            // The system draws a swipe action's face from a text or an `Image`; the
                            // catalogue's glyphs are paths, so the word carries it.
                            Text(action.label)
                        }
                        .tint(action.fill)
                        .accessibilityIdentifier("row-action-\(action.id)")
                    }
                }
                .contextMenu {
                    ForEach(actions) { action in
                        Button(role: action.tone == .red ? .destructive : nil, action: action.action) {
                            Text(action.label)
                        }
                        .accessibilityIdentifier("row-menu-\(action.id)")
                    }
                }
        }
    }
}
