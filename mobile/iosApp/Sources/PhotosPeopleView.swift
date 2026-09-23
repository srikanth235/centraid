import Foundation
import SwiftUI
import SwiftProtobuf

/// PEOPLE, IN SWIFTUI (#1029, photos port, lane L5).
///
/// A list of the members of a family as this vault has been TOLD them, and a
/// door to the questions it has not been told yet. Nobody a model guessed is on
/// this screen; the guesses are one tap away, behind a door that carries their
/// count.
///
/// The view takes BYTES and a callback rather than the shell object, so the
/// root can wire it wherever the People route lands without this file naming a
/// shell type it does not own.
struct PhotosPeopleView: View {
    @Environment(\.colorScheme) private var scheme

    /// The encoded `PhotosPeopleState` the shared bridge published.
    let data: Data
    /// One encoded `PhotosPeopleEvent`, back to the same bridge.
    let onEvent: (Data) -> Void
    /// A tap on a person: the shelf its `PhotoShelf` names. Produced by the
    /// shared machine, so both shells land in the same place.
    var onOpenPerson: ((_ partyIdentifier: String, _ name: String) -> Void)?
    /// The door to the queue of questions.
    var onOpenFaceReview: (() -> Void)?

    private var state: PhotosPeopleStateView { PhotosPeopleStateView(data: data) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                switch state.content {
                case .loading:
                    ProgressView()

                case let .failure(sentence, remedy):
                    ScreenFailureView(sentence: sentence, remedy: remedy)

                case let .data(screen):
                    // A REFUSED RENAME SAYS SO, OVER THE LIST AND NEVER
                    // INSTEAD OF IT. `write_failure` is its own field for
                    // exactly that reason: the content oneof's `failure` is the
                    // READ's, and a denied write drawn there would take away
                    // the list the member was renaming from.
                    if let sentence = state.writeFailure {
                        Text(sentence)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("danger", scheme))
                            .accessibilityIdentifier("photos.people.write-failure")
                    }

                    // THE DOOR COMES FIRST AND IS DRAWN WHATEVER THE LIST SAYS.
                    // A member with nobody named needs it most, and a member
                    // with a full list still has a backlog worth clearing — v0
                    // hid it behind an empty state and the queue was reachable
                    // only from a screen that said there was nothing to see.
                    if screen.proposedFaceCount > 0 {
                        faceReviewDoor(count: screen.proposedFaceCount)
                    }

                    if screen.people.isEmpty {
                        ScreenEmptyView(
                            sentence: state.emptySentence,
                            remedy: state.emptyRemedy
                        )
                    } else {
                        // NOTHING WAITING, AND SAID SO (v0's roster foot). The
                        // door above is absent when the queue is empty, and a
                        // member who cannot see it should not have to wonder
                        // whether it is hidden or finished.
                        if screen.proposedFaceCount == 0 {
                            Text("Every face this library has found is matched.")
                                .centraidType("small")
                                .foregroundStyle(Theme.color("textFaint", scheme))
                        }
                        ForEach(screen.people, id: \.partyID) { person in
                            PersonRowView(person: person) {
                                onOpenPerson?(person.partyID, person.displayName)
                            } onRename: { name in
                                onEvent(PhotosPeopleStateView.renameEvent(person.partyID, name))
                            }
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .contentMargins(.horizontal, CentraidGeometry.pageMargin, for: .scrollContent)
        .navigationTitle("People")
    }

    /// THE QUEUE, AS A ROW WITH ITS NUMBER ON IT.
    ///
    /// "A door that says nothing is a door nobody opens" — the count is what a
    /// member decides on, so it is on the door and not behind it.
    private func faceReviewDoor(count: UInt32) -> some View {
        Button {
            onOpenFaceReview?()
        } label: {
            HStack(spacing: 8) {
                CentraidIconView(iconKey: "UserPlus", tint: Theme.color("text", scheme))
                VStack(alignment: .leading, spacing: 2) {
                    Text(count == 1 ? "1 face to name" : "\(count) faces to name")
                        .centraidType("body")
                    Text("Centraid found these and is waiting for you to say who they are.")
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                }
                Spacer()
                CentraidIconView(iconKey: "ChevronRight", tint: Theme.color("textSoft", scheme))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("photos.people.review")
        .accessibilityLabel("\(count) faces to name")
    }
}

/// ONE PERSON.
///
/// The cover is the bridge's fourth leg, keyed on `cover_asset_id`. When it did
/// not run, did not answer, or answered no path, the ground is the person's
/// INITIAL and never a placeholder photograph: a grey square where a face goes
/// reads as "this failed", and a letter reads as "no picture yet".
private struct PersonRowView: View {
    @Environment(\.colorScheme) private var scheme
    let person: Centraid_Screen_V1_PersonRow
    let onOpen: () -> Void
    let onRename: (String) -> Void

    @State private var renaming = false
    @State private var typedName = ""

    var body: some View {
        HStack(spacing: 10) {
            Button(action: onOpen) {
                HStack(spacing: 10) {
                    initialMark
                    VStack(alignment: .leading, spacing: 2) {
                        Text(person.displayName).centraidType("body")
                        Text(countSentence)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                    }
                    Spacer()
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("photos.people.person.\(person.partyID)")
            .accessibilityLabel("\(person.displayName), \(countSentence)")

            Button {
                typedName = person.displayName
                renaming = true
            } label: {
                CentraidIconView(iconKey: "Pencil", tint: Theme.color("textSoft", scheme))
            }
            .accessibilityLabel("Rename \(person.displayName)")
        }
        .alert("Rename", isPresented: $renaming) {
            TextField("Name", text: $typedName)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                // AN EMPTY NAME IS NOT A RENAME. `core.update_party` puts
                // `minLength: 1` on the column, so the vault would refuse it —
                // and the reducer drops it too, so this is the third guard and
                // the cheapest one.
                let trimmed = typedName.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty, trimmed != person.displayName { onRename(trimmed) }
            }
        }
    }

    /// THE COUNT IS A FLOOR WHEN THE PAGE FILLED, AND SAYS SO.
    ///
    /// The read door has no `COUNT(*)`, so the number is counted off the rows
    /// one page returned. "at least 84" is the honest phrasing and a bare
    /// number over a full page would be a total nobody counted
    /// (`HomeState.ThingCount.capped`).
    private var countSentence: String {
        let count = person.photoCount
        let noun = count == 1 ? "photo" : "photos"
        return person.photoCountCapped ? "at least \(count) \(noun)" : "\(count) \(noun)"
    }

    private var initialMark: some View {
        Color.clear
            .frame(width: 40, height: 40)
            .overlay {
                if person.hasCoverThumbnailPath, !person.coverThumbnailPath.isEmpty {
                    ContentImage(path: person.coverThumbnailPath)
                } else {
                    Text(String(person.displayName.prefix(1)).uppercased())
                        .centraidType("body")
                }
            }
            .background(Theme.color("bgSunken", scheme), in: Circle())
            .clipShape(Circle())
            .accessibilityHidden(true)
    }
}

/// The decoder, in this file rather than in `StateViews.swift`, which is shared
/// and would collide with every other lane adding one.
struct PhotosPeopleStateView {
    let data: Data

    private var state: Centraid_Screen_V1_PhotosPeopleState {
        (try? Centraid_Screen_V1_PhotosPeopleState(serializedBytes: data)) ?? .init()
    }

    /// Loading, a failure with a sentence, or data. Three cases, always —
    /// `ScreenContent` is declared once in `StateViews.swift` and reused here.
    var content: ScreenContent<Centraid_Screen_V1_PhotosPeopleData> {
        switch state.content {
        case let .failure(failure):
            return .failure(failure.sentence, failure.remedy)
        case let .data(data):
            return .data(data)
        // `loading`, and the `nil` a message with no content set decodes to,
        // are the SAME screen — a state that has not read yet. Collapsing them
        // into an empty data case is the fourth state the read law forbids.
        case let .loading(loading):
            return .loading(loading.firstLoad)
        case .none:
            return .loading(true)
        }
    }

    /// THREE EMPTY SCREENS, THREE SENTENCES.
    ///
    /// v0 drew one for all three (`PeopleEmptyState.tsx`) and they have three
    /// different next moves: a setting to change, a wait, or a door to open.
    /// The reason is read off the vault's recognition tier and never off an
    /// absence, which is the whole point of `PhotosPeopleData.empty_reason`.
    /// The sentence a refused rename left, or nil.
    var writeFailure: String? {
        state.hasWriteFailure ? state.writeFailure.sentence : nil
    }

    var emptySentence: String {
        switch state.content {
        case let .data(data):
            switch data.emptyReason {
            case .recognitionOff:
                return "Face recognition is off."
            case .notRunYet:
                return "Centraid has not looked for faces yet."
            case .noneNamed:
                return "Centraid found faces, and none of them has a name yet."
            case .none, .unspecified, .UNRECOGNIZED:
                return "No one here yet."
            }
        default:
            return "No one here yet."
        }
    }

    var emptyRemedy: String {
        switch state.content {
        case let .data(data):
            switch data.emptyReason {
            case .recognitionOff:
                return "Turn it on in Settings and Centraid starts finding people in your photos."
            case .notRunYet:
                return "It looks through your library in the background."
            case .noneNamed:
                return "Open the faces above and tell Centraid who they are."
            case .none, .unspecified, .UNRECOGNIZED:
                return ""
            }
        default:
            return ""
        }
    }

    /// The member retyped somebody's name.
    static func renameEvent(_ partyIdentifier: String, _ name: String) -> Data {
        var event = Centraid_Screen_V1_PhotosPeopleEvent()
        event.renamed = .with {
            $0.partyID = partyIdentifier
            $0.displayName = name
        }
        return (try? event.serializedData()) ?? Data()
    }

    static func openedEvent() -> Data {
        var event = Centraid_Screen_V1_PhotosPeopleEvent()
        event.opened = .init()
        return (try? event.serializedData()) ?? Data()
    }
}
