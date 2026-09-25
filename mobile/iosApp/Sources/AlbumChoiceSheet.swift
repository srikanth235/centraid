import SwiftUI

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
        NavigationStack {
            List {
                Section {
                    newAlbumRow
                }
                Section {
                    if choices.isEmpty {
                        // ONE SENTENCE, NEVER AN EMPTY SHEET. The row above is
                        // the action; this only says why the list is short.
                        Text("No albums yet.")
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textFaint", scheme))
                            .accessibilityIdentifier("photos.album-choice.empty")
                    } else {
                        ForEach(choices, id: \.albumID) { choice in
                            row(choice)
                        }
                    }
                }
            }
            .navigationTitle("Add to album")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                        .accessibilityIdentifier("photos.album-choice.cancel")
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    /// "NEW ALBUM…", AND THE FIELD IT BECOMES.
    ///
    /// Inline rather than a second sheet over this one: a sheet on a sheet is
    /// two ways out for one question, and the name is one field.
    @ViewBuilder
    private var newAlbumRow: some View {
        if naming {
            HStack(spacing: 12) {
                TextField("Album name", text: $name)
                    .focused($nameFocused)
                    .submitLabel(.done)
                    .onSubmit(create)
                    .accessibilityIdentifier("photos.album-choice.name")
                Button("Create", action: create)
                    // AN EMPTY NAME IS NOT A WRITE: `media.create_album`'s
                    // `title` is `minLength: 1`.
                    .disabled(trimmed.isEmpty)
                    .accessibilityIdentifier("photos.album-choice.create")
            }
        } else {
            Button {
                naming = true
                nameFocused = true
            } label: {
                HStack(spacing: 12) {
                    CentraidIconView(iconKey: "add", tint: Theme.color("link", scheme), size: 22)
                        .frame(width: coverSide, height: coverSide)
                        .background(
                            RoundedRectangle(cornerRadius: coverRadius)
                                .fill(Theme.color("bgElev", scheme))
                        )
                    Text("New album…")
                        .centraidType("body")
                        .foregroundStyle(Theme.color("link", scheme))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("New album")
            .accessibilityIdentifier("photos.album-choice.new")
        }
    }

    private func row(_ choice: Centraid_Screen_V1_AlbumChoiceEntry) -> some View {
        let title = choice.title.isEmpty ? "Untitled album" : choice.title
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
                .clipShape(RoundedRectangle(cornerRadius: coverRadius))
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
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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
        let noun = choice.count == 1 ? "photograph" : "photographs"
        if choice.countCapped {
            return ("\(choice.count)+ \(noun)", "at least \(choice.count) \(noun)")
        }
        if choice.count == 0 { return ("Empty", "empty") }
        return ("\(choice.count) \(noun)", "\(choice.count) \(noun)")
    }
}

/// A cover thumbnail's side in the list — the system's album-picker row.
private let coverSide: CGFloat = 44
/// The CONTROL rung: a thumbnail in a row is content held by a control.
private let coverRadius: CGFloat = 7
