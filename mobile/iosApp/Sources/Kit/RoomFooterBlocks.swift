import SwiftUI

struct RoomAttachmentsBlock: View {
    let attachments: Centraid_Core_V1_RoomAttachments
    let onTap: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                if !attachments.heading.isEmpty {
                    Text(attachments.heading)
                        .kitType(.group)
                        .foregroundStyle(Surface.meta)
                        .accessibilityAddTraits(.isHeader)
                }
                Spacer(minLength: 0)
                if attachments.hasAdd, !attachments.add.sections.isEmpty {
                    Menu {
                        RoomMenuContent(menu: attachments.add, onTap: onTap)
                    } label: {
                        CentraidIconView(iconKey: "Plus", tint: Surface.ink, size: 16)
                            .frame(width: CentraidGeometry.targetMinFine, height: CentraidGeometry.targetMinFine)
                    }
                    .accessibilityIdentifier(attachments.add.selectorID)
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.top, 16)
            .padding(.bottom, 6)

            ForEach(Array(attachments.items.enumerated()), id: \.offset) { _, row in
                RoomRowBlock(row: row, onTap: onTap)
            }
            if !attachments.nextPageSelectorID.isEmpty {
                ShowMoreFooter(visible: true) { onTap(attachments.nextPageSelectorID) }
            }
        }
    }
}

struct RoomLinkedBlock: View {
    let linked: Centraid_Core_V1_RoomLinked
    let onTap: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                if !linked.heading.isEmpty {
                    Text(linked.heading)
                        .kitType(.group)
                        .foregroundStyle(Surface.meta)
                        .accessibilityAddTraits(.isHeader)
                }
                Spacer(minLength: 0)
                if linked.hasAdd, !linked.add.label.isEmpty {
                    KitLink(label: linked.add.label, dense: true, identifier: linked.add.selectorID) {
                        onTap(linked.add.selectorID)
                    }
                    .disabled(!linked.add.enabled)
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.top, 16)
            .padding(.bottom, 6)

            ForEach(Array(linked.items.enumerated()), id: \.offset) { _, row in
                RoomRowBlock(row: row, onTap: onTap)
            }
            if !linked.nextPageSelectorID.isEmpty {
                ShowMoreFooter(visible: true) { onTap(linked.nextPageSelectorID) }
            }
        }
    }
}

struct RoomMentionedInBlock: View {
    let mentioned: Centraid_Core_V1_RoomMentionedIn
    let onTap: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !mentioned.heading.isEmpty {
                Text(mentioned.heading)
                    .kitType(.group)
                    .foregroundStyle(Surface.meta)
                    .accessibilityAddTraits(.isHeader)
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .padding(.top, 16)
                    .padding(.bottom, 6)
            }
            ForEach(Array(mentioned.items.enumerated()), id: \.offset) { _, row in
                RoomRowBlock(row: row, onTap: onTap)
            }
            if !mentioned.nextPageSelectorID.isEmpty {
                ShowMoreFooter(visible: true) { onTap(mentioned.nextPageSelectorID) }
            }
        }
    }
}

struct RoomSaysBlock: View {
    let says: Centraid_Core_V1_RoomSays
    let onTap: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !says.heading.isEmpty {
                Text(says.heading)
                    .kitType(.group)
                    .foregroundStyle(Surface.meta)
                    .accessibilityAddTraits(.isHeader)
            }
            ForEach(Array(says.fields.enumerated()), id: \.offset) { _, field in
                VStack(alignment: .leading, spacing: 4) {
                    Text(field.label)
                        .kitType(.meta)
                        .foregroundStyle(Surface.meta)
                    Text(field.stated)
                        .kitType(.row)
                        .foregroundStyle(Surface.ink)
                    if !field.mine.isEmpty {
                        Text(field.mine)
                            .kitType(.meta)
                            .foregroundStyle(Surface.meta)
                    }
                    if !field.takeSelectorID.isEmpty, !says.takeLabel.isEmpty {
                        KitLink(label: says.takeLabel, dense: true, identifier: field.takeSelectorID) {
                            onTap(field.takeSelectorID)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 6)
            }
        }
        .padding(14)
        .kitCard()
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 6)
    }
}

struct RoomEarlierVersionsBlock: View {
    let earlier: Centraid_Core_V1_RoomEarlierVersions
    let onTap: (String) -> Void

    var body: some View {
        Button { onTap(earlier.selectorID) } label: {
            HStack(spacing: 8) {
                Text(earlier.summary)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
                Spacer(minLength: 0)
                CentraidIconView(iconKey: "ChevronRight", tint: Surface.meta, size: 14)
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .frame(minHeight: CentraidGeometry.targetMinCoarse)
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
        .accessibilityIdentifier(earlier.selectorID)
    }
}

struct RoomOriginBlock: View {
    let origin: Centraid_Core_V1_RoomOrigin
    let onTap: (String) -> Void

    var body: some View {
        let row = HStack(spacing: 8) {
            Text(origin.line)
                .kitType(.meta)
                .foregroundStyle(Surface.meta)
            Spacer(minLength: 0)
            if !origin.selectorID.isEmpty {
                CentraidIconView(iconKey: "ChevronRight", tint: Surface.meta, size: 14)
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .frame(minHeight: CentraidGeometry.targetMinCoarse)
        .contentShape(Rectangle())

        if !origin.selectorID.isEmpty {
            Button { onTap(origin.selectorID) } label: { row }
                .buttonStyle(KitRowPress())
                .accessibilityIdentifier(origin.selectorID)
        } else {
            row
        }
    }
}
