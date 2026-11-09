import SwiftUI

/// WHAT A NOTE IS ABOUT, as chips (#1173): "About · Maya", each a quiet pill that opens the
/// subject in its own app. Rust makes the words and the route; this draws them. On a card the chips
/// are read-only (the card's own tap opens the note); over a note they are buttons.
struct AboutChips: View {
    let chips: [Centraid_Core_V1_NotesAboutChip]
    var onOpen: ((Centraid_Core_V1_Route) -> Void)?

    @Environment(\.appAccent) private var accent

    var body: some View {
        if !chips.isEmpty {
            HStack(spacing: 6) {
                ForEach(chips, id: \.id) { chip in
                    if let onOpen {
                        Button { onOpen(chip.route) } label: { face(chip) }
                            .buttonStyle(.plain)
                            .accessibilityLabel(chip.accessibilityLabel)
                            .accessibilityIdentifier("about-chip-\(chip.id)")
                    } else {
                        face(chip)
                    }
                }
            }
        }
    }

    private func face(_ chip: Centraid_Core_V1_NotesAboutChip) -> some View {
        Text(chip.label)
            .kitType(.meta)
            .fontWeight(.semibold)
            .foregroundStyle(accent.text)
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(accent.fill.opacity(0.12), in: Capsule())
    }
}
