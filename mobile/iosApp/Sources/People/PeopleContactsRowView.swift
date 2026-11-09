import SwiftUI

/// THE PHONE CONTACTS ROW of People's More (#1173): "Phone contacts", whether People follows the
/// address book (On / Paused / Off / No access), how many it follows and when it last looked, and
/// the one action that fits (Pause, Resume, Turn on, or Settings when the phone said no).
struct PeopleContactsRowView: View {
    let row: Centraid_Core_V1_PeopleContactsRow
    let onAction: () -> Void

    @Environment(\.appAccent) private var accent

    var body: some View {
        HStack(spacing: 12) {
            KitTile(iconKey: "Users", size: 30)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(row.title).kitType(.row).foregroundStyle(Surface.ink)
                    Text(row.stateLabel)
                        .kitType(.meta)
                        .fontWeight(.semibold)
                        .foregroundStyle(row.state == .denied ? StateColor.red.text : accent.text)
                }
                if !row.detail.isEmpty {
                    Text(row.detail).kitType(.meta).foregroundStyle(Surface.meta).lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(row.accessibilityLabel)
            Button(action: onAction) {
                Text(row.actionLabel)
                    .centraidType("smallStrong")
                    .foregroundStyle(accent.text)
                    .frame(minWidth: CentraidGeometry.targetMinCoarse, minHeight: CentraidGeometry.targetMinCoarse)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("people-contacts-action")
        }
        .padding(.horizontal, 16)
        .accessibilityIdentifier("people-contacts-row")
    }
}
