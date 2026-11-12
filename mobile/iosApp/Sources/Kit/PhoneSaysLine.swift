import SwiftUI

/// WHAT THE PHONE SAYS (#1183): the one quiet line a followed row's detail page draws where the
/// member's value differs from the phone's. Rust's `lead` in the secondary text style and a plain
/// words-only action in the app's accent, a 44pt target, with no border, fill, icon or badge. The
/// same view draws it on the person, event, document and workout pages; every word is Rust's, and
/// a tap hands the line's own take back, unchanged, as `PhoneSaysTaken`. A line that is absent or
/// has no words draws nothing and reserves no space.
///
/// Ids: `phone-says-<field>[-<item>]` on the line and `phone-says-take-<field>[-<item>]` on the
/// action; the Compose twin is `kit/PhoneSaysLine.kt`.
struct PhoneSaysLine: View {
    let line: Centraid_Core_V1_PhoneSays
    /// Centred under a hero (the person's name and role); otherwise leading, with the action trailing.
    var centered = false
    let onTake: (Centraid_Core_V1_PhoneSaysTaken) -> Void

    @Environment(\.appAccent) private var accent

    var body: some View {
        if PhoneSaysLine.isDrawn(line) {
            let ids = PhoneSaysLine.identifiers(for: line.take)
            HStack(spacing: centered ? 10 : 12) {
                Text(line.lead)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
                    .frame(maxWidth: centered ? nil : .infinity, alignment: .leading)
                    .multilineTextAlignment(centered ? .center : .leading)
                Button {
                    var taken = Centraid_Core_V1_PhoneSaysTaken()
                    taken.take = line.take
                    onTake(taken)
                } label: {
                    Text(line.actionLabel)
                        .kitType(.meta)
                        .fontWeight(.semibold)
                        .foregroundStyle(accent.text)
                        .frame(minHeight: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(line.accessibilityLabel.isEmpty ? line.actionLabel : line.accessibilityLabel)
                .accessibilityIdentifier(ids.take)
            }
            .frame(maxWidth: .infinity, alignment: centered ? .center : .leading)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(ids.line)
        }
    }

    /// True when the line has words to draw; an empty one draws nothing.
    nonisolated static func isDrawn(_ line: Centraid_Core_V1_PhoneSays) -> Bool {
        !line.lead.isEmpty && !line.actionLabel.isEmpty
    }

    /// The two selector ids of a line, from the field and item its take names.
    nonisolated static func identifiers(for take: Centraid_Core_V1_PhoneSaysTake) -> (line: String, take: String) {
        var parts: [String] = []
        if !take.field.isEmpty { parts.append(take.field) }
        if take.hasItemKey, !take.itemKey.isEmpty { parts.append(take.itemKey) }
        let suffix = parts.isEmpty ? "" : "-" + parts.joined(separator: "-")
        return ("phone-says" + suffix, "phone-says-take" + suffix)
    }
}

/// A run of lines under a list or a field, padded to the page margin; nothing at all for none.
struct PhoneSaysLines: View {
    let lines: [Centraid_Core_V1_PhoneSays]
    var centered = false
    /// Off where the caller's column already carries the page margin.
    var padded = true
    let onTake: (Centraid_Core_V1_PhoneSaysTaken) -> Void

    var body: some View {
        if lines.contains(where: PhoneSaysLine.isDrawn) {
            VStack(alignment: centered ? .center : .leading, spacing: 0) {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    PhoneSaysLine(line: line, centered: centered, onTake: onTake)
                }
            }
            .padding(.horizontal, padded ? CentraidGeometry.pageMargin : 0)
        }
    }
}
