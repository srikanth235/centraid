import SwiftUI

extension View {
    /// A 44-POINT HIT AREA ON A SMALLER DRAWING (#1202). The iOS hit floor is 44, and a dense line
    /// (Home's backup status, a calendar chip) is drawn smaller: the view keeps its drawn size and
    /// its place in the layout, and the part of the area beyond it is an invisible extension that
    /// takes the touch (and the audit's frame) and gives the room back, so nothing around it moves.
    func hitArea(minHeight: CGFloat = CentraidGeometry.targetMinCoarse) -> some View {
        modifier(HitAreaModifier(minHeight: minHeight))
    }
}

private struct HitAreaModifier: ViewModifier {
    let minHeight: CGFloat
    @State private var drawn: CGFloat = 0

    func body(content: Content) -> some View {
        let extra = max(0, (minHeight - drawn) / 2)
        content
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { drawn = $0 }
            .padding(.vertical, extra)
            .contentShape([.interaction, .accessibility], Rectangle())
            .padding(.vertical, -extra)
    }
}
