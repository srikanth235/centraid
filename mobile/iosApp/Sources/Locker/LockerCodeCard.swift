import SwiftUI

/// The existing reveal/copy/conceal protocol in a dedicated verification card.
struct LockerCodeCard: View {
    let row: Centraid_Core_V1_LockerFieldRow
    let onVerb: (Centraid_Core_V1_LockerVerb) -> Void
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private var codeLayout: AnyLayout {
        dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
            : AnyLayout(HStackLayout(spacing: 12))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(row.label).centraidType("title").foregroundStyle(Theme.color("text", scheme))
            codeLayout {
                Text(row.revealed ? row.value : row.mask)
                    .centraidType("title").monospacedDigit().textSelection(.disabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .foregroundStyle(Theme.color("lockerText", scheme))
                    .accessibilityIdentifier("locker-field-\(row.key)-value")
                if row.hasCountdown { LockerCountdownRing(countdown: row.countdown) }
            }
            Text(row.note).centraidType("small").foregroundStyle(Theme.color("textSoft", scheme))
            LazyVGrid(columns: [GridItem(.adaptive(minimum: dynamicTypeSize.isAccessibilitySize ? 220 : 110))], spacing: 8) {
                ForEach(row.verbs, id: \.key) { verb in
                    KitOutlineButton(label: verb.label) { onVerb(verb) }
                        .accessibilityIdentifier("locker-verb-\(row.key)-\(verb.key)")
                }
            }
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.color("bgElev", scheme), in: RoundedRectangle(cornerRadius: Theme.radius("lg", scheme)))
            .padding(CentraidGeometry.pageMargin)
            .accessibilityIdentifier("locker-verification-code")
    }
}
