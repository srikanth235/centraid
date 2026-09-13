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

            VStack(alignment: .leading) {
                Text(state.backupSentence)
                if !state.pausedReason.isEmpty { Text(state.pausedReason) }
                if state.canAskForPhotos {
                    Button("Allow photo access") {
                        shell.send(screen: "photos.grid", event: state.permissionRequestEvent)
                    }
                }
            }

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
                        if let path = cell.thumbnailPath {
                            Image(systemName: "photo")
                                .accessibilityLabel("Photo")
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
}
