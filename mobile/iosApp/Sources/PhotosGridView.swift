import SwiftUI

/// The Photos grid, in SwiftUI (#1020, D-1020-E3).
///
/// Two planes on one screen: the GRID renders the vault's assets, the BACKUP
/// banner renders the camera roll's permission and progress. A denied photo
/// grant changes the banner and never the grid — which on iOS is the difference
/// between a member seeing their library and a member seeing an empty screen
/// with a Settings link.
///
/// `PHAuthorizationStatusLimited` is a first-class state here, not a degraded
/// denial: the banner says "the photos you selected".
struct PhotosGridView: View {
    @ObservedObject var shell: ShellModel

    var state: PhotosGridStateView { PhotosGridStateView(data: shell.photosState) }

    var body: some View {
        VStack(alignment: .leading) {
            HStack {
                ForEach(state.bands, id: \.self) { band in
                    Button(band.label) { shell.send(screen: "photos.grid", event: band.event) }
                }
                Button {
                    // `more` IS A SHEET, NEVER A DESTINATION. It sends a sheet
                    // event; there is no band value it could send.
                    shell.send(screen: "photos.grid", event: state.moreSheetEvent)
                } label: {
                    Image(systemName: "ellipsis")
                        .accessibilityLabel("More")
                }
            }

            // THE OTHER PLANE, IN ITS OWN VIEW (#1025 S6). See `BackupStatus`.
            BackupStatus(shell: shell, state: state)

            switch state.content {
            case .loading:
                ProgressView()
            case let .failure(sentence, remedy):
                VStack(alignment: .leading) {
                    Text(sentence)
                    if !remedy.isEmpty { Text(remedy) }
                }
            case let .data(cells, packAbsent):
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 96))]) {
                    ForEach(cells, id: \.identifier) { cell in
                        if let path = cell.thumbnailPath, !path.isEmpty {
                            // THE SAME RENDERER AS HOME'S MOSAIC
                            // (D-1025-S7-20). This drew `Image(systemName:
                            // "photo")` — an SF Symbol — over a real path, so
                            // a device holding nineteen photographs showed
                            // nineteen identical glyphs, and the one place in
                            // the product that drew a vault's own bytes was a
                            // four-cell tile on Home. One path, one view.
                            // A SQUARE CELL, and the ground is what holds it.
                            // `ContentImage` fills and deliberately overflows
                            // its frame, so an image asked for its own size
                            // grows the row: the ground states the geometry and
                            // the clip keeps the overflow off the neighbour,
                            // which is what Home's mosaic does with a fixed
                            // rectangle.
                            Color.clear
                                .aspectRatio(1, contentMode: .fit)
                                .overlay { ContentImage(path: path) }
                                // WHAT THIS DEVICE HAS OF THIS PHOTOGRAPH, ON
                                // TOP OF IT (#1025 S5, D-1025-S7-62). A
                                // thumbnail is drawn under every one of these:
                                // the grid is the product and it is full under
                                // every rule there is, and what the overlay
                                // says is whether the FULL-SIZE file is here,
                                // moving, or waiting on the member's own rule.
                                .overlay(alignment: .bottomTrailing) {
                                    cellState(cell)
                                }
                                .clipped()
                                .accessibilityIdentifier(path)
                        } else {
                            // TWO DIFFERENT EMPTY-CELL SENTENCES. A member with
                            // no pack at all and a member whose pack has evicted
                            // these must not read the same words.
                            Text(
                                packAbsent
                                    ? "Preview not downloaded to this device"
                                    : "Preview no longer on this device"
                            )
                        }
                    }
                }
            }
        }
        .padding()
        .navigationTitle("Photos")
    }

    /// The per-cell affordance, and nothing for the two states that need none.
    ///
    /// **The download arrow is drawn ONLY for `withheld_by_rule`**, which is
    /// the distinction that matters to a member: a photograph that is simply
    /// still on its way gets no arrow, because tapping it would ask for
    /// something already queued, and an affordance that does nothing is worse
    /// than none. `held` and `absent` draw nothing at all.
    @ViewBuilder
    private func cellState(_ cell: PhotoCellView) -> some View {
        if cell.isFetching {
            ProgressView()
                .padding(4)
                .background(.thinMaterial, in: Circle())
                .padding(4)
                .accessibilityIdentifier("photos.cell.fetching.\(cell.identifier)")
                .accessibilityLabel("Downloading")
        } else if cell.offersDownload {
            Button {
                shell.send(screen: "photos.grid", event: state.fetchEvent(for: cell))
            } label: {
                Image(systemName: "arrow.down.circle.fill")
                    // THE BUTTON IS WHAT VOICEOVER READS, and it carries the
                    // label below; a glyph inside it that described itself too
                    // would be announced twice.
                    .accessibilityHidden(true)
                    .imageScale(.large)
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.white, .black.opacity(0.55))
            }
            .padding(4)
            .accessibilityIdentifier("photos.cell.download.\(cell.identifier)")
            .accessibilityLabel("Download full-size photo")
        }
    }
}
