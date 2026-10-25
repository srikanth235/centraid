import Foundation

// THE ONE PLACE A SENTENCE IS FILLED ON THIS SIDE (#1135): a template Rust
// finished but for a value only the platform has at the moment of drawing (a
// player's position). Every word is Rust's; this closes one hole.

/// Closes one `{hole}` in a template.
func copyFill(_ template: String, _ hole: String, _ value: String) -> String {
    template.replacingOccurrences(of: "{\(hole)}", with: value)
}
