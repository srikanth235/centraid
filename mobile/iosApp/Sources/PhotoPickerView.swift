import Foundation
import SwiftProtobuf
import SwiftUI

/// ADDING PHOTOGRAPHS TO AN ALBUM, in SwiftUI (#1029, photos port; v0's
/// `PhotoPicker.tsx`).
///
/// A pushed screen and not a modal card, which is v0's own choice and the right
/// one on a phone: choosing from a whole library is a place a member goes, not
/// a sheet they hold open.
///
/// **Its picked set is its own.** No selection bar is handed to the shell: the
/// shelf's five-target bar belongs to "these photographs", and this screen's
/// one verb is "add these to THIS album". A shelf that could be picked from
/// would carry an album id on every surface that shows one.
///
/// **No search field.** v0 states the reason and it still holds: search is its
/// own screen with its own unreachable state, and a silent miss here would be
/// pretence.
struct PhotoPickerView: View {
    @Environment(\.colorScheme) private var scheme

    /// The encoded `PhotoPickerState` the bridge published.
    let data: Data

    /// WHERE THE PICKED ASSETS ARE GOING, from the route.
    ///
    /// All three ride the destination (`nav/Navigation.kt`,
    /// `Destination.PhotoPicker`, plus the album's membership from the surface
    /// that pushed this screen), because the view is what sends `Opened` and
    /// `Opened` carries all three. The name is there so the head says "Add to
    /// Portugal" before any read has landed.
    let collectionIdentifier: String
    let collectionName: String

    /// WHAT THE CALLER ALREADY KNOWS THE ALBUM HOLDS, and it may be nothing.
    ///
    /// The picker reads the album's whole membership itself on open
    /// (`PhotoPickerMachine.MEMBERS_READ_ID`, a second statement beside the
    /// asset page) and unions it with this, so a caller that holds one page of
    /// the album — which is every caller — is not the limit of what draws as
    /// taken.
    let alreadyInAlbum: [String]

    /// One encoded `PhotoPickerEvent`, back to the bridge.
    let send: (Data) -> Void

    /// The picker is done with itself. Adding is the end of this screen, and
    /// the pop is the shell's — v0 navigates back on a successful batch.
    var onFinished: () -> Void = {}

    private var state: PhotoPickerStateView { PhotoPickerStateView(data: data) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                // ADDING REFERS, IT DOES NOT COPY — v0's sentence, verbatim,
                // and the fact that makes this screen safe to use. Nothing is
                // duplicated and nothing moves.
                Text(PhotoPickerStateView.refersNotCopies)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))

                // AN ADD WAS REFUSED, AND THE GRID STAYS.
                //
                // Above the cells and outside the `content` switch: a refusal
                // drawn through the read's `failure` would replace the library
                // mid-pick and take the member's picks off the screen they were
                // choosing from. That is what `write_failure` is a separate
                // field for.
                if let refusal = state.writeFailure {
                    ScreenFailureView(sentence: refusal.sentence, remedy: refusal.remedy)
                        .accessibilityIdentifier("photos.picker.writeFailure")
                }

                switch state.content {
                case .loading:
                    ProgressView()
                case let .failure(sentence, remedy):
                    // A FAILED READ IS NOT AN EMPTY LIBRARY, and on this screen
                    // the difference decides what a member does next: one means
                    // there is nothing left to add, the other means they must
                    // not conclude that.
                    ScreenFailureView(sentence: sentence, remedy: remedy)
                case let .data(cells, packAbsent):
                    if cells.isEmpty {
                        ScreenEmptyView(sentence: PhotoPickerStateView.nothingLeft)
                    } else {
                        // TAKEN, NOT HIDDEN. A member hunting for the
                        // photograph they added last week should find it, and
                        // find out why it will not tick. `PhotoCellsGrid` draws
                        // `taken` and refuses the tap.
                        PhotoCellsGrid(
                            cells: cells,
                            packAbsent: packAbsent,
                            selected: state.picked,
                            taken: state.taken,
                            onTap: { identifier in
                                send(state.pickEvent(assetIdentifier: identifier))
                            }
                        )
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .contentMargins(.horizontal, CentraidGeometry.pageMargin, for: .scrollContent)
        .navigationTitle("Add to \u{201C}\(collectionName)\u{201D}")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                // THE ONE FILLED ELEMENT (§18) — and it cannot fire with
                // nothing picked, so it is disabled rather than absent: a
                // control that appears when a member picks is a control that
                // moves under their thumb.
                Button(state.picked.isEmpty ? "Add" : "Add \(state.picked.count)") {
                    send(state.confirmEvent)
                    onFinished()
                }
                .disabled(state.picked.isEmpty)
                .accessibilityIdentifier("photos.picker.add")
            }
        }
        .safeAreaInset(edge: .bottom) {
            Text(state.chosenSentence)
                .centraidType("small")
                .foregroundStyle(Theme.color("textSoft", scheme))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.vertical, 8)
                .background(.thinMaterial)
        }
        .onAppear {
            send(
                state.openedEvent(
                    collectionIdentifier: collectionIdentifier,
                    collectionName: collectionName,
                    alreadyInAlbum: alreadyInAlbum
                )
            )
        }
    }
}

/// The thin decoder between the picker's bytes and its view.
///
/// Its own struct in its own file rather than an addition to `StateViews.swift`,
/// which is shared by every lane of this port.
struct PhotoPickerStateView {
    let data: Data

    /// v0's two sentences, verbatim. Static because they are constants of the
    /// screen and not of a state — a member reads the first one before any read
    /// has landed.
    static let refersNotCopies = "An album refers to a photograph where it lives."
    static let nothingLeft = "Everything in your library is already in this album."

    private var state: Centraid_Screen_V1_PhotoPickerState {
        (try? Centraid_Screen_V1_PhotoPickerState(serializedBytes: data)) ?? .init()
    }

    var content: ScreenContent<([Centraid_Screen_V1_PhotoCell], Bool)> {
        switch state.content {
        case let .failure(failure):
            return .failure(failure.sentence, failure.remedy)
        case let .data(data):
            return .data((data.cells, data.thumbnailPackAbsent))
        case let .loading(loading):
            return .loading(loading.firstLoad)
        case .none:
            return .loading(true)
        }
    }

    var picked: Set<String> { Set(state.pickedAssetIds) }

    var taken: Set<String> { Set(state.alreadyInAlbumAssetIds) }

    /// A WRITE WAS REFUSED. Its own slot, never the read's `failure`. See the
    /// twin in `PhotoShelfView.swift`.
    var writeFailure: Centraid_Screen_V1_ReadFailure? {
        state.hasWriteFailure ? state.writeFailure : nil
    }

    /// NOTHING HAS BEEN ADDED YET, and the line says so while a member picks.
    /// v0's wording, because the reassurance is the point: a picked set is not
    /// a write and a member should not have to guess when the album changed.
    var chosenSentence: String {
        picked.isEmpty
            ? "Nothing chosen yet"
            : "\(picked.count) chosen \u{00B7} nothing has been added yet"
    }

    func openedEvent(
        collectionIdentifier: String,
        collectionName: String,
        alreadyInAlbum: [String]
    ) -> Data {
        var event = Centraid_Screen_V1_PhotoPickerEvent()
        event.opened = .with {
            $0.collectionID = collectionIdentifier
            $0.collectionName = collectionName
            $0.alreadyInAlbumAssetIds = alreadyInAlbum
        }
        return event.encodedPickerEvent
    }

    func pickEvent(assetIdentifier: String) -> Data {
        var event = Centraid_Screen_V1_PhotoPickerEvent()
        event.pick = .with { $0.assetID = assetIdentifier }
        return event.encodedPickerEvent
    }

    var confirmEvent: Data {
        var event = Centraid_Screen_V1_PhotoPickerEvent()
        event.confirm = .init()
        return event.encodedPickerEvent
    }
}

private extension SwiftProtobuf.Message {
    /// See `PhotoShelfView.swift`'s twin: a private extension is file scoped,
    /// so each of these files spells its own rather than sharing a name with
    /// `StateViews.swift`'s `encoded`.
    var encodedPickerEvent: Data { (try? serializedData()) ?? Data() }
}
