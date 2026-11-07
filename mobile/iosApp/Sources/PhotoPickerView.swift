import SwiftUI

/// ADDING PHOTOGRAPHS TO AN ALBUM, drawn from the core's `PhotosPickerState`
/// (#1135): the library as a grid with what the album already holds drawn as
/// taken, the one filled button, and the sentence "an album points to a photo
/// where it lives". `crates/screens/src/photos/picker.rs` decides what can be
/// picked, what Add writes and when the picker is `finished`; this draws it.
///
/// A refused add is `status`, above the grid and never instead of it, so the
/// member keeps the library they were choosing from.
///
/// The Compose twin is `androidApp/.../screens/PhotoPickerScreen.kt`.
struct PhotoPickerView: View {
    @Environment(\.colorScheme) private var scheme

    let state: Centraid_Core_V1_PhotosPickerState
    let send: (Centraid_Core_V1_PhotosPickerEvent) -> Void
    /// The picker is done with itself: adding is the end of this screen.
    let onFinished: () -> Void

    private func event(_ build: (inout Centraid_Core_V1_PhotosPickerEvent) -> Void) {
        var event = Centraid_Core_V1_PhotosPickerEvent()
        build(&event)
        send(event)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if state.hasStatus {
                    ScreenFailureView(sentence: state.status.sentence, remedy: "")
                        .accessibilityIdentifier("photos.picker.writeFailure")
                }

                switch state.content {
                case .loading?, nil:
                    RowSkeleton()
                case let .failure(failure)?:
                    // A FAILED READ IS NOT AN EMPTY LIBRARY.
                    ScreenFailureView(sentence: failure.sentence, remedy: failure.remedy)
                case let .data(data)?:
                    if data.hasEmpty {
                        ScreenEmptyView(sentence: data.empty.headline, remedy: data.empty.body)
                    } else {
                        // TAKEN, NOT HIDDEN: a member hunting for the photograph
                        // they added last week finds it, and finds out why it
                        // will not tick.
                        PhotoCellsGrid(
                            cells: data.cells.map(\.tile),
                            selected: Set(data.cells.filter(\.picked).map(\.tile.photoID)),
                            taken: Set(data.cells.filter(\.taken).map(\.tile.photoID)),
                            takenLabel: data.takenLabel,
                            onTap: { identifier in event { $0.pick = .with { $0.photoID = identifier } } }
                        )
                        if data.canShowMore {
                            KitLink(label: data.showMoreLabel) { event { $0.loadMore = .init() } }
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .contentMargins(.horizontal, CentraidGeometry.pageMargin, for: .scrollContent)
        .navigationTitle(state.title)
        .navigationBarTitleDisplayMode(.inline)
        .background(Surface.page.ignoresSafeArea())
        // THE FOOT: how many are chosen, the sentence about albums, and the one filled button,
        // in the app's colour, greyed with nothing picked and never absent: a control that
        // appears when a member picks is a control that moves under their thumb.
        .safeAreaInset(edge: .bottom) {
            VStack(alignment: .leading, spacing: 4) {
                Text(state.chosenLabel)
                    .kitType(.row)
                    .fontWeight(.semibold)
                    .foregroundStyle(Surface.ink)
                Text(state.refersNote)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
                KitInkButton(label: state.addLabel, identifier: "photos.picker.add") {
                    event { $0.confirm = .init() }
                }
                .disabled(!state.addEnabled)
                .padding(.top, 8)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.top, 12)
            .padding(.bottom, 8)
            .background(Surface.page.ignoresSafeArea(edges: .bottom))
        }
        .onChange(of: state.finished) { _, done in
            if done { onFinished() }
        }
        .appAccent("photos")
    }
}
