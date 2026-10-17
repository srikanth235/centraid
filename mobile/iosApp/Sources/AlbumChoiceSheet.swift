import SwiftUI

import CentraidShared

/// "ADD TO ALBUM", AS ONE SHEET FOR EVERY SCREEN THAT OFFERS IT (#1029, the
/// photos port).
///
/// v0 asked "which album?" from four surfaces through `Alert.alert` with a row
/// per album — no grabber, no scroll, and a cap on how many rows fit before the
/// system dropped the rest, which is why Album detail sliced its list to six
/// (`PhotosChoiceSheet.tsx`). A choice is a `SheetRoom` (DESIGN.md): a
/// grabber, a title carrying the noun, one quiet way out.
///
/// **It decides nothing.** The list is the host state's `album_choices`, read by
/// `AlbumChoice.kt`; a tap names an album and the host's reducer turns it into
/// one `media.add_to_album` per picked photograph. Presented with `.sheet` by a
/// host whose `isPresented` is derived from `album_choice_open`.
///
/// **"New album…" does not put the pick in the album it makes**, and the sheet
/// stays open on purpose: the vault mints the album's id and no settle carries
/// it back, so the new album joins this list when the create commits and the
/// member's next tap finishes the job (`AlbumChoice.kt`'s note).
struct AlbumChoiceSheet: View {
    let choices: [Centraid_Screen_V1_AlbumChoiceEntry]
    let onChoose: (String) -> Void
    let onNewAlbum: (String) -> Void
    let onCancel: () -> Void

    @Environment(\.colorScheme) private var scheme
    @State private var naming = false
    @State private var name = ""
    @FocusState private var nameFocused: Bool

    var body: some View {
        SheetRoom(title: PhotosCopy.shared.PHOTOS_ADD_TO_ALBUM) {
            newAlbumRow
            ScrollView {
                VStack(spacing: 0) {
                    if choices.isEmpty {
                        // ONE SENTENCE, NEVER AN EMPTY SHEET. The row above is
                        // the action; this only says why the list is short.
                        Text(PhotosCopy.shared.PHOTOS_ALBUM_CHOICE_NONE)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textFaint", scheme))
                            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
                            .accessibilityIdentifier("photos.album-choice.empty")
                    } else {
                        ForEach(choices, id: \.albumID) { choice in
                            row(choice)
                        }
                    }
                }
            }
            KitLink(label: PhotosCopy.shared.PHOTOS_CANCEL, identifier: "photos.album-choice.cancel", action: onCancel)
                .frame(maxWidth: .infinity)
        }
    }

    /// "NEW ALBUM…", AND THE FIELD IT BECOMES.
    ///
    /// Inline rather than a second sheet over this one: a sheet on a sheet is
    /// two ways out for one question, and the name is one field.
    @ViewBuilder
    private var newAlbumRow: some View {
        if naming {
            HStack(spacing: 12) {
                TextField(PhotosCopy.shared.PHOTOS_ALBUM_NAME, text: $name)
                    .centraidType("body")
                    .focused($nameFocused)
                    .submitLabel(.done)
                    .onSubmit(create)
                    .frame(minHeight: CentraidGeometry.targetMinCoarse)
                    .accessibilityIdentifier("photos.album-choice.name")
                KitLink(label: PhotosCopy.shared.PHOTOS_CREATE, identifier: "photos.album-choice.create", action: create)
                    // AN EMPTY NAME IS NOT A WRITE: `media.create_album`'s
                    // `title` is `minLength: 1`.
                    .disabled(trimmed.isEmpty)
            }
        } else {
            SheetRow(iconKey: "add", label: PhotosCopy.shared.PHOTOS_ALBUM_CHOICE_NEW, identifier: "photos.album-choice.new") {
                naming = true
                nameFocused = true
            }
        }
    }

    private func row(_ choice: Centraid_Screen_V1_AlbumChoiceEntry) -> some View {
        let title = choice.title.isEmpty ? PhotosCopy.shared.PHOTOS_UNTITLED_ALBUM : choice.title
        let count = Self.count(choice)
        return Button {
            onChoose(choice.albumID)
        } label: {
            HStack(spacing: 12) {
                ZStack {
                    Theme.color("bgElev", scheme)
                    if choice.hasCoverThumbnailPath, !choice.coverThumbnailPath.isEmpty {
                        ContentImage(path: choice.coverThumbnailPath)
                    } else {
                        CentraidIconView(iconKey: "album", tint: Theme.color("textFaint", scheme), size: 20)
                    }
                }
                .frame(width: coverSide, height: coverSide)
                .clipShape(RoundedRectangle(cornerRadius: Theme.radius("md", scheme)))
                VStack(alignment: .leading, spacing: 0) {
                    Text(title)
                        .centraidType("body")
                        .foregroundStyle(Theme.color("text", scheme))
                        .lineLimit(1)
                    Text(count.shown)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
        .accessibilityLabel("\(title), \(count.spoken)")
        .accessibilityIdentifier("photos.album-choice.album")
    }

    private var trimmed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func create() {
        guard !trimmed.isEmpty else { return }
        onNewAlbum(trimmed)
        name = ""
        naming = false
    }

    /// A CAPPED COUNT SAYS `N+` AND NEVER A BARE NUMBER — Collections' rule,
    /// spelled the same way, with "at least" for a screen reader.
    static func count(_ choice: Centraid_Screen_V1_AlbumChoiceEntry) -> (shown: String, spoken: String) {
        if choice.count == 0 && !choice.countCapped {
            return (PhotosCopy.shared.PHOTOS_COUNT_EMPTY, PhotosCopy.shared.PHOTOS_COUNT_EMPTY)
        }
        let count = Int64(choice.count)
        return (
            CappedCount.shared.shown(count: count, capped: choice.countCapped, one: PhotosCopy.shared.TILE_COUNT_ONE, many: PhotosCopy.shared.TILE_COUNT_MANY),
            CappedCount.shared.spoken(count: count, capped: choice.countCapped, one: PhotosCopy.shared.TILE_COUNT_ONE, many: PhotosCopy.shared.TILE_COUNT_MANY)
        )
    }
}

/// A cover thumbnail's side in the list — the system's album-picker row.
private let coverSide: CGFloat = 44
