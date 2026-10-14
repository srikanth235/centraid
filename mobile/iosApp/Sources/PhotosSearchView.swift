import Foundation
import SwiftProtobuf
import SwiftUI

#if canImport(CentraidShared)
import CentraidShared
#endif
import UIKit

/// SEARCH, IN SWIFTUI (#1029, the photos port).
///
/// Three states behind one destination, and the distinction the whole screen
/// exists to keep: **a member who has typed nothing and a member whose query
/// matched nothing must not read the same words.** v0 had two components and
/// two sentences for those (`PhotosSearchRestingState.tsx`,
/// `PhotosSearchEmptyState.tsx`) and a third for the hits; they are one screen
/// with a oneof, and this view is the oneof drawn.
///
/// **THE FIELD IS NOT HERE.** It is the room's search field, under the title
/// where every app's search stands (R-CHROME-2). This view is only what the
/// query found.
///
/// **It takes bytes and a closure, not a `ShellModel`.** Where a tapped cell
/// GOES is the navigator's business and this file routes nothing.
struct PhotosSearchView: View {
    let data: Data
    var send: (Data) -> Void = { _ in }
    var onOpenAsset: (String) -> Void = { _ in }
    /// A person, place or album was tapped — above the grid or on the resting
    /// page. The shelf arrives WHOLE, as encoded `PhotoShelf` bytes the read
    /// built with its name in it, so nothing here composes one.
    var onOpenShelf: (Data) -> Void = { _ in }

    @Environment(\.colorScheme) private var scheme

    var state: PhotosSearchStateView { PhotosSearchStateView(data: data) }

    var body: some View {
        // NO SCROLL VIEW OF ITS OWN: this is drawn inside the photos grid's.
        VStack(alignment: .leading, spacing: 12) {
            switch state.content {
            case let .resting(resting):
                RestingView(resting: resting, onOpenShelf: onOpenShelf)
            case .loading:
                RowSkeleton()
            case let .failure(sentence, remedy):
                ScreenFailureView(sentence: sentence, remedy: remedy)
            case let .hits(cells, packAbsent, matches, topHits, empty):
                if cells.isEmpty, topHits.isEmpty {
                    // NOTHING MATCHED IS NOT NOTHING TYPED. The machine quotes the
                    // query back and says everywhere search looked (v0's
                    // `SEARCH_COPY.miss`), and offers Ask as the one action when
                    // the field names a question (#1097, R-1097-30): the kit's
                    // search empty view draws it, as every app's search does.
                    SearchEmptyView(empty, ask: state.ask)
                        .accessibilityIdentifier("photos-search-no-match")
                } else {
                    // THE DOORS FIRST (v0 §9: "each one tap from the surface
                    // that owns it"), then why the grid matched, then the grid.
                    ForEach(Array(topHits.enumerated()), id: \.offset) { _, hit in
                        TopHitRow(hit: hit, onOpenShelf: onOpenShelf)
                    }
                    if !matches.isEmpty {
                        // WHY THESE MATCHED. HOW MANY FIT IS THE VIEW'S
                        // DECISION: the read hands over every distinct reason
                        // and does not cap them, so the clamp is here, where
                        // the line is.
                        Text(PhotosSearchStateView.reason(matches))
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                            .lineLimit(2)
                    }
                    if !cells.isEmpty {
                        // `onTap` BY NAME AND NOT AS A TRAILING CLOSURE:
                        // `PhotoCellsGrid`'s last property is `onFetch`, so a
                        // trailing closure here would silently wire the
                        // download arrow to the lightbox and leave every cell
                        // tap doing nothing.
                        PhotoCellsGrid(
                            cells: cells,
                            packAbsent: packAbsent,
                            onTap: { identifier in onOpenAsset(identifier) }
                        )
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One door above the grid: the kind's mark, the vault's name for it, and
/// what it holds.
private struct TopHitRow: View {
    let hit: Centraid_Screen_V1_SearchTopHit
    let onOpenShelf: (Data) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let sub = PhotosSearchStateView.topHitSub(hit)
        Button {
            onOpenShelf((try? hit.shelf.serializedData()) ?? Data())
        } label: {
            HStack(spacing: 10) {
                CentraidIconView(
                    iconKey: PhotosSearchStateView.kindIcon(hit.kind),
                    tint: Theme.color("textSoft", scheme),
                    size: 20
                )
                VStack(alignment: .leading, spacing: 2) {
                    Text(hit.label)
                        .centraidType("body")
                        .foregroundStyle(Theme.color("text", scheme))
                        .lineLimit(1)
                    Text(sub)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                CentraidIconView(iconKey: "ChevronRight", tint: Theme.color("textFaint", scheme))
            }
            .frame(minHeight: CentraidGeometry.targetMinCoarse)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Open \(hit.label), \(sub)")
        .accessibilityAddTraits(.isButton)
    }
}

// `SearchCircle` and `BareSearchField` moved to `Kit/CentraidSearchField.swift`,
// where every app's search field draws from them (K5).

/// NOTHING HAS BEEN ASKED YET — so this says what there is to ask FOR.
///
/// One line that is true of every vault — what a search reaches — and then
/// this vault's own vocabulary under it: the people confirmed on its
/// photographs and the places they were taken, each a door to its shelf, and
/// the labels on them as words to type. Never a fixed list of words the
/// product hopes are there; a vault with none of them shows the line alone.
///
/// The line sits where the system Photos app puts its own caveat: a note about
/// the search, small and soft, not a second title.
private struct RestingView: View {
    let resting: Centraid_Screen_V1_SearchResting
    let onOpenShelf: (Data) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(PhotosSearchStateView.restingNote)
                .centraidType("small")
                .foregroundStyle(Theme.color("textSoft", scheme))
            if !resting.people.isEmpty {
                RestingSection(title: "People") {
                    ForEach(resting.people, id: \.partyID) { person in
                        RestingDoor(label: person.displayName, iconKey: "person") {
                            onOpenShelf(PhotosSearchStateView.personShelf(person))
                        }
                    }
                }
            }
            if !resting.places.isEmpty {
                RestingSection(title: "Places") {
                    ForEach(resting.places, id: \.placeID) { place in
                        RestingDoor(label: place.placeName, iconKey: "place") {
                            onOpenShelf(PhotosSearchStateView.placeShelf(place))
                        }
                    }
                }
            }
            if !resting.suggestedLabels.isEmpty {
                // WORDS, NOT DOORS: a label has no shelf of its own, so it is
                // offered as something to type rather than drawn as a control
                // that would open nothing.
                RestingSection(title: "Labels") {
                    let words = resting.suggestedLabels.map(\.label)
                    Text(words.joined(separator: " \u{00B7} "))
                        .centraidType("body")
                        .foregroundStyle(Theme.color("text", scheme))
                        .accessibilityLabel("Labels to search: \(words.joined(separator: ", "))")
                }
            }
        }
        .padding(.vertical, 8)
    }
}

/// A heading over one kind of word.
private struct RestingSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .centraidType("smallStrong")
                .foregroundStyle(Theme.color("textSoft", scheme))
                .padding(.top, 8)
                .padding(.bottom, 4)
                .accessibilityAddTraits(.isHeader)
            content()
        }
    }
}

/// One person or place on the resting page, opening its shelf.
private struct RestingDoor: View {
    let label: String
    let iconKey: String
    let onOpen: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 10) {
                CentraidIconView(iconKey: iconKey, tint: Theme.color("textSoft", scheme), size: 20)
                Text(label)
                    .centraidType("body")
                    .foregroundStyle(Theme.color("text", scheme))
                    .lineLimit(1)
                Spacer(minLength: 0)
                CentraidIconView(iconKey: "ChevronRight", tint: Theme.color("textFaint", scheme))
            }
            .frame(minHeight: CentraidGeometry.targetMinCoarse)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open \(label)")
    }
}

/// The decoder between Search's bytes and the view above.
///
/// Its own file rather than an addition to `StateViews.swift`, which is shared.
/// **`ScreenContent` is not reused here, and this is the one screen where that
/// is right:** this state's oneof has FOUR arms, not three — resting is a real
/// fourth place a member can be and not a variant of loading or of an empty
/// result — so a three-case enum would have had to collapse two of them, which
/// is the language boundary doing exactly what the proto's own comment refuses.
struct PhotosSearchStateView {
    let data: Data

    private var state: Centraid_Screen_V1_PhotosSearchState {
        (try? Centraid_Screen_V1_PhotosSearchState(serializedBytes: data)) ?? .init()
    }

    /// What the member has typed, as the reducer last published it.
    var query: String { state.query }

    /// The question the no-match state offers to send to the assistant, or empty
    /// for no Ask (#1097, R-1097-28).
    var ask: String { state.search.ask }

    /// THE SHARED SEARCH FIELD, as the machine holds it (#1097, R-1097-27): the
    /// term and the words the answer corrected, which the kit's field draws as
    /// "Showing results for". [open] is the grid's destination and the caller's
    /// to state; a field that is not open carries no term and no correction.
    func field(open: Bool) -> Centraid_Screen_V1_SearchField {
        guard open else { return Centraid_Screen_V1_SearchField() }
        var field = state.search
        field.open = true
        field.term = state.query
        return field
    }

    /// Four cases, always.
    enum Content {
        case resting(Centraid_Screen_V1_SearchResting)
        case loading(Bool)
        case failure(String, String)
        /// The cells as the wire holds them, whether this device has a
        /// thumbnail pack, why these matched, the doors above them, and the
        /// no-match state of an answer with none of those.
        case hits(
            [Centraid_Screen_V1_PhotoCell],
            Bool,
            [Centraid_Screen_V1_SearchMatch],
            [Centraid_Screen_V1_SearchTopHit],
            Centraid_Screen_V1_EmptyState
        )
    }

    var content: Content {
        switch state.content {
        case let .resting(resting):
            return .resting(resting)
        case let .failure(failure):
            return .failure(failure.sentence, failure.remedy)
        case let .hits(hits):
            return .hits(hits.cells, hits.thumbnailPackAbsent, hits.matches, hits.topHits, hits.empty)
        case let .loading(loading):
            return .loading(loading.firstLoad)
        // A MESSAGE WITH NO CONTENT SET IS A SCREEN THAT HAS NOT READ, which
        // for this screen is the resting state and not a spinner: search reads
        // nothing until a member types, so a spinner here would never finish.
        case .none:
            return .resting(Centraid_Screen_V1_SearchResting())
        }
    }

    static func queryEvent(_ query: String) -> Data {
        var event = Centraid_Screen_V1_PhotosSearchEvent()
        event.query = .with { $0.query = query }
        return event.encoded
    }

    static func nextPageEvent(_ cursor: String) -> Data {
        var event = Centraid_Screen_V1_PhotosSearchEvent()
        event.nextPage = .with { $0.afterCursor = cursor }
        return event.encoded
    }

    /// `matches`, as a sentence.
    ///
    /// **THE KIND IS THE CONTRACT'S AND THE WORDS ARE THE SHELL'S.** The field
    /// used to be `repeated string matched_on` and it was the one place in this
    /// section that carried a kind as prose — two shells composing their own
    /// "Person: Ada" and "In Lisbon" is two shells wording one fact two ways,
    /// which is how v0's empty states drifted apart. So the enum travels and
    /// this is where iOS spells it; `PhotosSearchScreen.kt` spells the same
    /// five the same way, and the two are kept in step by hand.
    ///
    /// Grouped by kind rather than listed flat, because "Captions: a, b — In:
    /// Lisbon" is one sentence and a flat list of five values with four
    /// prefixes is five.
    static func reason(_ matches: [Centraid_Screen_V1_SearchMatch]) -> String {
        let order: [Centraid_Screen_V1_SearchMatch.Kind] = [.person, .place, .album, .label, .title]
        let parts = order.compactMap { kind -> String? in
            let values = matches.filter { $0.kind == kind }.map(\.value)
            guard !values.isEmpty else { return nil }
            return "\(noun(kind)): " + values.joined(separator: ", ")
        }
        // A KIND THIS SHELL DOES NOT KNOW IS NOT DROPPED SILENTLY. Its values
        // still reach the member, unlabelled, which is the honest thing for a
        // newer core naming a fifth reason — the alternative is a grid that
        // explains some of itself and quietly omits the rest.
        let known = Set(order)
        let rest = matches.filter { !known.contains($0.kind) }.map(\.value)
        let all = parts + (rest.isEmpty ? [] : [rest.joined(separator: ", ")])
        return all.isEmpty ? "" : "Matched " + all.joined(separator: " \u{2014} ")
    }

    /// What a search reaches, true of every vault. `PhotosSearchScreen.kt`
    /// says the same.
    static let restingNote =
        PhotosWords.photosSearchHint


    /// "Person · 12 photos", or "Album · at least 500 photos". A zero
    /// is "not counted" on this door, so it prints the kind alone.
    static func topHitSub(_ hit: Centraid_Screen_V1_SearchTopHit) -> String {
        let kind: String
        switch hit.kind {
        case .person: kind = "Person"
        case .place: kind = "Place"
        case .album: kind = "Album"
        case .label, .title, .unspecified, .UNRECOGNIZED: kind = ""
        }
        let count = hit.photoCount
        guard count > 0 else { return kind }
        let noun = count == 1 ? PhotosWords.tileCountOne : PhotosWords.tileCountMany
        let phrase = hit.photoCountCapped ? "at least \(count) \(noun)" : "\(count) \(noun)"
        return kind.isEmpty ? phrase : "\(kind) \u{00B7} \(phrase)"
    }

    static func kindIcon(_ kind: Centraid_Screen_V1_SearchMatch.Kind) -> String {
        switch kind {
        case .person: return "person"
        case .place: return "place"
        case .album: return "album"
        case .label, .title, .unspecified, .UNRECOGNIZED: return "Search"
        }
    }

    /// A person on the resting page, as the shelf a tap opens — the same
    /// `PhotoStateView.Person` the People screen opens.
    static func personShelf(_ person: Centraid_Screen_V1_PhotoPerson) -> Data {
        var shelf = Centraid_Screen_V1_PhotoShelf()
        shelf.stateView = .with {
            $0.person = .with {
                $0.partyID = person.partyID
                $0.personName = person.displayName
            }
        }
        return (try? shelf.serializedData()) ?? Data()
    }

    /// A place on the resting page arrives AS its shelf's value.
    static func placeShelf(_ place: Centraid_Screen_V1_PhotoShelf.Place) -> Data {
        var shelf = Centraid_Screen_V1_PhotoShelf()
        shelf.place = place
        return (try? shelf.serializedData()) ?? Data()
    }

    private static func noun(_ kind: Centraid_Screen_V1_SearchMatch.Kind) -> String {
        switch kind {
        case .person: return "People"
        case .place: return "Places"
        case .album: return "Albums"
        case .label: return "Labels"
        case .title: return "Captions"
        case .unspecified, .UNRECOGNIZED: return ""
        }
    }
}

