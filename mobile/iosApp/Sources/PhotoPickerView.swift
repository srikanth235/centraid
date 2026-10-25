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
                Text(state.refersNote)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))

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
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                // THE ONE FILLED ELEMENT (§18), disabled with nothing picked
                // rather than absent: a control that appears when a member
                // picks is a control that moves under their thumb.
                ToolbarVerb(label: state.addLabel, identifier: "photos.picker.add") {
                    event { $0.confirm = .init() }
                }
                .disabled(!state.addEnabled)
            }
        }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 0) {
                Rectangle()
                    .fill(Theme.color("line", scheme))
                    .frame(height: CentraidGeometry.hairline)
                Text(state.chosenLabel)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .padding(.vertical, 8)
            }
            .background(Theme.color("bgElev", scheme).ignoresSafeArea(edges: .bottom))
        }
        .onChange(of: state.finished) { _, done in
            if done { onFinished() }
        }
    }
}
