import Foundation

/// THE BAND'S ONE PLACE, as an app's home draws it (#1020, D-1020-E3): the
/// label, the mark and which is lit, all off the screen's view state.
struct BandView: Hashable {
    let label: String
    let event: Data
    /// The catalog mark a drawn band shows above the label; empty draws none.
    var iconKey: String = ""
    /// Whether this is the destination on screen — read off the state, never
    /// written down by the view that draws it.
    var selected: Bool = false
    /// The destination's key, when the band's flows tap it by that and not by
    /// its label (`agenda-band-todo` for a "To-do" label); empty falls back to
    /// the lowercased label.
    var key: String = ""
}
