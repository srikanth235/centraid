import SwiftUI

/// THE ATTACHMENTS SECTION of an event page and a task page (#1173), drawn from the core's
/// `AgendaAttachmentsSection`: what is attached a page at a time, Add photo and Add file, the
/// remove confirm and the sentence for an add that was refused.
///
/// **THE VIEW DECIDES NOTHING.** Every word, icon key, count and flag is Rust's; a tile's tap is
/// the `route` it carries (a photo's viewer, a document's page), pushed by the shell. Adding asks
/// the core, which raises the platform's picker through the `PickFile` effect. Both pages draw it
/// here, under their own selector prefix: `agenda-detail-attachment` on a task,
/// `agenda-event-attachment` on an event.
struct AgendaAttachmentsView: View {
    let section: Centraid_Core_V1_AgendaAttachmentsSection
    /// `agenda-event-attachment` or `agenda-detail-attachment`: tiles, removes, adds, more, status.
    let idPrefix: String
    /// `agenda-event-attachments` or `agenda-detail-attachments`: the section's head.
    let headIdentifier: String
    let open: (Centraid_Core_V1_Route) -> Void
    let send: (Centraid_Core_V1_AgendaAttachmentEvent) -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(\.appAccent) private var accent

    private func event(_ build: (inout Centraid_Core_V1_AgendaAttachmentEvent) -> Void) {
        var event = Centraid_Core_V1_AgendaAttachmentEvent()
        build(&event)
        send(event)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeader(title: section.heading)
                .accessibilityIdentifier(headIdentifier)
            if section.items.isEmpty, !section.emptyLabel.isEmpty {
                Text(section.emptyLabel)
                    .centraidType("body")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .padding(.vertical, 8)
            }
            // THE BOARD'S CARD: the attachments in one rounded plate, a hairline between.
            if !section.items.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(section.items.enumerated()), id: \.element.attachmentID) { index, tile in
                        row(tile, last: index == section.items.count - 1)
                    }
                }
                .background(Surface.card, in: RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))
                .padding(.horizontal, CentraidGeometry.pageMargin)
            }
            if section.hasMore_p, !section.moreLabel.isEmpty {
                KitLink(label: section.moreLabel, identifier: "\(idPrefix)-more") {
                    event { $0.showMore = .init() }
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
            }
            HStack(spacing: 8) {
                addButton(
                    label: section.addPhotoLabel,
                    iconKey: section.addPhotoIconKey,
                    identifier: "\(idPrefix)-add-photo"
                ) {
                    event { $0.addPhoto = .init() }
                }
                addButton(
                    label: section.addFileLabel,
                    iconKey: section.addFileIconKey,
                    identifier: "\(idPrefix)-add-file"
                ) {
                    event { $0.addFile = .init() }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.top, 12)
            if section.busy, !section.busyLabel.isEmpty {
                Text(section.busyLabel)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textFaint", scheme))
                    .padding(.horizontal, CentraidGeometry.pageMargin)
            }
            if section.hasStatus, !section.status.sentence.isEmpty {
                HStack(spacing: 8) {
                    Text(section.status.sentence)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("net", scheme))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("\(idPrefix)-status")
                    if !section.status.actionLabel.isEmpty {
                        KitLink(label: section.status.actionLabel, dense: true) {
                            event { $0.statusDismissed = .init() }
                        }
                    }
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.top, 8)
            }
        }
        // THE REMOVE CONFIRM: what is attached stays in Photos or Docs, and the words say so.
        .sheet(isPresented: Binding(
            get: { section.hasRemoveConfirm },
            set: { open in if !open, section.hasRemoveConfirm { event { $0.removeDismissed = .init() } } }
        )) {
            ConfirmSheet(
                section.removeConfirm,
                onConfirm: { event { $0.removeConfirmed = .init() } },
                onDismiss: { event { $0.removeDismissed = .init() } }
            )
        }
    }

    /// One attachment: its thumbnail (or the kind's icon tile), its words, and a Remove.
    private func row(_ tile: Centraid_Core_V1_AgendaAttachmentTile, last: Bool) -> some View {
        HStack(spacing: 8) {
            Button { open(tile.route) } label: {
                HStack(spacing: 12) {
                    thumbnail(tile)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(tile.title)
                            .centraidType("body")
                            .foregroundStyle(Theme.color("text", scheme))
                            .lineLimit(1)
                        Text(tile.meta)
                            .centraidType("annotLabel")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 8)
                .frame(minHeight: 60)
                .contentShape(Rectangle())
            }
            .buttonStyle(KitRowPress())
            .accessibilityLabel(tile.accessibilityLabel.isEmpty ? tile.title : tile.accessibilityLabel)
            .accessibilityIdentifier("\(idPrefix)-\(tile.attachmentID)")
            // THE BOARD'S ×: a quiet glyph, the word still the spoken label.
            Button {
                event { $0.removeAsked = .with { $0.attachmentID = tile.attachmentID } }
            } label: {
                CentraidIconView(iconKey: "X", tint: Theme.color("textFaint", scheme), size: 16)
                    .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(tile.removeAccessibilityLabel.isEmpty ? tile.removeLabel : tile.removeAccessibilityLabel)
            .accessibilityIdentifier("\(idPrefix)-remove-\(tile.attachmentID)")
        }
        .padding(.leading, 14)
        .overlay(alignment: .bottom) { if !last { KitHairline() } }
    }

    /// The photo's own thumbnail when this phone holds one, else the kind's glyph on a neutral
    /// tile, in the app's ink as the board draws it. The kind is in the words under the title,
    /// so the tile carries no badge of its own.
    @ViewBuilder
    private func thumbnail(_ tile: Centraid_Core_V1_AgendaAttachmentTile) -> some View {
        let shape = RoundedRectangle(cornerRadius: CentraidScale.cardRadius / 2, style: .continuous)
        Group {
            if !tile.thumbnailPath.isEmpty {
                ContentImage(path: tile.thumbnailPath)
                    .frame(width: 44, height: 44)
                    .clipShape(shape)
            } else {
                CentraidIconView(iconKey: tile.iconKey, tint: accent.text, size: 22)
                    .frame(width: 44, height: 44)
                    .background(Surface.fill, in: shape)
            }
        }
        .frame(width: 44, height: 44)
        .accessibilityHidden(true)
    }

    private func addButton(label: String, iconKey: String, identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                CentraidIconView(iconKey: iconKey, tint: Theme.color(section.busy ? "textDisabled" : "text", scheme), size: 18)
                Text(label)
                    .centraidType("smallStrong")
                    .foregroundStyle(Theme.color(section.busy ? "textDisabled" : "text", scheme))
            }
            // THE BOARD'S PILL: ink on a plain capsule with a hairline, not a link.
            .padding(.horizontal, 14)
            .frame(minHeight: CentraidGeometry.targetMinCoarse)
            .background(Capsule().fill(Surface.card))
            .overlay(Capsule().strokeBorder(Surface.line, lineWidth: CentraidGeometry.hairline))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(section.busy)
        .accessibilityIdentifier(identifier)
    }
}
