import SwiftUI

/// "ADD TO ALBUM", drawn from the core's `PhotosAlbumChoice` (#1135): the
/// lightbox, the library and a shelf each hold one in Rust, so this draws the
/// sheet and sends its events and decides nothing. A refused list arrives empty
/// with its sentence; "New album…" is always there, and creating keeps the sheet
/// open with the new album in the list. The typed album name is the one piece of
/// state that lives here: it exists nowhere else before it is sent.
///
/// The Compose twin is `kit/PhotosAlbumChoice.kt`.
struct PhotosAlbumChoiceSheet: View {
    let choice: Centraid_Core_V1_PhotosAlbumChoice
    let send: (Centraid_Core_V1_PhotosAlbumChoiceEvent) -> Void

    @Environment(\.colorScheme) private var scheme
    @State private var naming = false
    @State private var name = ""
    @FocusState private var nameFocused: Bool

    var body: some View {
        SheetRoom(title: choice.title) {
            newAlbumRow
            ScrollView {
                VStack(spacing: 0) {
                    if !choice.empty.isEmpty {
                        // ONE SENTENCE, NEVER AN EMPTY SHEET. The row above is
                        // the action; this only says why the list is short.
                        Text(choice.empty)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textFaint", scheme))
                            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
                            .accessibilityIdentifier("photos.album-choice.empty")
                    } else {
                        ForEach(choice.entries, id: \.albumID) { entry in
                            row(entry)
                        }
                    }
                }
            }
            KitLink(label: choice.cancelLabel, identifier: "photos.album-choice.cancel") {
                send(.with { $0.dismissed = .init() })
            }
            .frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder
    private var newAlbumRow: some View {
        if naming {
            HStack(spacing: 12) {
                TextField(choice.namePlaceholder, text: $name)
                    .centraidType("body")
                    .focused($nameFocused)
                    .submitLabel(.done)
                    .onSubmit(create)
                    .frame(minHeight: CentraidGeometry.targetMinCoarse)
                    .accessibilityIdentifier("photos.album-choice.name")
                KitLink(label: choice.createLabel, identifier: "photos.album-choice.create", action: create)
                    // AN EMPTY NAME IS NOT A WRITE.
                    .disabled(trimmed.isEmpty)
            }
        } else {
            SheetRow(iconKey: "add", label: choice.newAlbumLabel, identifier: "photos.album-choice.new") {
                naming = true
                nameFocused = true
            }
        }
    }

    private func row(_ entry: Centraid_Core_V1_PhotosAlbumChoiceEntry) -> some View {
        Button {
            send(.with { $0.chosen = .with { $0.albumID = entry.albumID } })
        } label: {
            HStack(spacing: 12) {
                ZStack {
                    Theme.color("bgElev", scheme)
                    if entry.hasCover, entry.cover.hasThumbnailPath, !entry.cover.thumbnailPath.isEmpty {
                        ContentImage(path: entry.cover.thumbnailPath)
                    } else {
                        CentraidIconView(iconKey: "album", tint: Theme.color("textFaint", scheme), size: 20)
                    }
                }
                .frame(width: 44, height: 44)
                .clipShape(RoundedRectangle(cornerRadius: Theme.radius("md", scheme)))
                VStack(alignment: .leading, spacing: 0) {
                    Text(entry.title)
                        .centraidType("body")
                        .foregroundStyle(Theme.color("text", scheme))
                        .lineLimit(1)
                    Text(entry.countLabel)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
        .accessibilityLabel("\(entry.title), \(entry.countLabel)")
        .accessibilityIdentifier("photos.album-choice.album")
    }

    private var trimmed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func create() {
        guard !trimmed.isEmpty else { return }
        send(.with { $0.created = .with { $0.title = trimmed } })
        name = ""
        naming = false
    }
}
