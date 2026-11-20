import SwiftUI

/// THE PHONE CONTACTS ROW of People's More (#1173): "Phone contacts", whether People follows the
/// address book (On / Paused / Off / No access), how many it follows and when it last looked, and
/// the one action that fits (Pause, Resume, Turn on, or Settings when the phone said no).
struct PeopleContactsRowView: View {
    let row: Centraid_Core_V1_PeopleContactsRow
    let onAction: () -> Void

    @Environment(\.appAccent) private var accent
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        // AT ACCESSIBILITY SIZES THE ROW STACKS (#1202): beside the status and "Turn on" the
        // title was a column of syllables ("Phon / e / conta / cts").
        let stacked = dynamicTypeSize.isAccessibilitySize
        let layout = stacked
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(spacing: 12))
        let titleLayout = stacked
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
            : AnyLayout(HStackLayout(spacing: 6))
        layout {
            KitTile(iconKey: "Users", size: 30)
            VStack(alignment: .leading, spacing: 1) {
                titleLayout {
                    Text(row.title).kitType(.row).foregroundStyle(Surface.ink)
                    Text(row.stateLabel)
                        .kitType(.meta)
                        .fontWeight(.semibold)
                        .foregroundStyle(row.state == .denied ? StateColor.red.text : accent.text)
                }
                if !row.detail.isEmpty {
                    Text(row.detail.dotSafe).kitType(.meta).foregroundStyle(Surface.meta).kitLineLimit(2, wide: 6)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(row.accessibilityLabel)
            Button(action: onAction) {
                Text(row.actionLabel)
                    .centraidType("smallStrong")
                    .foregroundStyle(accent.text)
                    // THE ACTION'S WORDS ARE WHOLE (#1202): beside a long title the row gave the button less
                    // than "Turn on" needs; it keeps its width and the title wraps instead.
                    .fixedSize(horizontal: !stacked, vertical: true)
                    .frame(minWidth: CentraidGeometry.targetMinCoarse, minHeight: CentraidGeometry.targetMinCoarse)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .layoutPriority(1)
            .accessibilityIdentifier("people-contacts-action")
        }
        .padding(.horizontal, 16)
        .accessibilityIdentifier("people-contacts-row")
    }
}
