import Foundation
import SwiftProtobuf
import SwiftUI
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
/// **THE FIELD IS NOT HERE.** It is `PhotosSearchBar`, at the foot of the
/// screen where the band would be — the system Photos app's search, which
/// takes the tab bar's place rather than adding a second bar over it. This
/// view is only what the query found.
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
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .padding(.top, 40)
            case let .failure(sentence, remedy):
                ScreenFailureView(sentence: sentence, remedy: remedy)
            case let .hits(cells, packAbsent, matches, topHits):
                if cells.isEmpty, topHits.isEmpty {
                    // NOTHING MATCHED IS NOT NOTHING TYPED. The query is quoted
                    // back, because the one thing a member wants to check first
                    // is whether the words they see are the words they meant —
                    // and the line under it says everywhere search looked (v0's
                    // `SEARCH_COPY.miss`). Centred, as the system draws "No
                    // Results".
                    VStack(spacing: 6) {
                        Text("No results")
                            .centraidType("title")
                            .foregroundStyle(Theme.color("text", scheme))
                        Text("Nothing matches \u{201C}\(state.query)\u{201D}.")
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                            .multilineTextAlignment(.center)
                        Text(PhotosSearchStateView.missBody)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textFaint", scheme))
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 160)
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
        .navigationTitle("Search")
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

/// THE SEARCH FIELD, WHERE THE BAND WAS — the system Photos app's search, in
/// both of its states (measured off its view hierarchy on iOS 26).
///
/// **TYPING:** the field and a round close control, 8 from the screen's sides
/// and 8 above the keyboard — nothing else competes for the row.
///
/// **NOT TYPING** (the keyboard's Search key, or a scroll through the hits):
/// the row drops into the band's own slot — the same 62 box, 21 from the
/// screen's edges — and gains, on its leading end, a circle carrying the mark
/// of the place the member came from. That circle goes back there with the
/// query kept, as leaving a tab keeps it; the close control goes back with the
/// query cleared. Two ways out, one per intent, both a thumb's reach away.
///
/// **THE FIELD IS A UIKIT FIELD** (`BareSearchField`) for one reason: SwiftUI's
/// `TextField` cannot turn off the keyboard's suggestion strip, and a strip of
/// guesses over a query for your own photographs is 44 points of noise between
/// the member's thumb and their results. The system app shows none.
///
/// **THE ONLY PLACE A KEYSTROKE EXISTS BEFORE THE REDUCER HAS IT.** The machine
/// holds the query it last reduced; a character the member has just typed is
/// in neither until this view hands it over.
struct PhotosSearchBar: View {
    /// The query as the reducer last published it.
    let query: String
    /// The mark and the name of the place the member came from.
    let returnIconKey: String
    let returnLabel: String
    let send: (Data) -> Void
    /// Back to that place, the query kept.
    let onReturn: () -> Void
    /// Back to it with the query cleared.
    let onClose: () -> Void

    @State private var typed = ""
    @State private var focused = false
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: focused ? BandMetrics.searchInset : BandMetrics.searchRestGap) {
            if !focused {
                SearchCircle(
                    iconKey: returnIconKey,
                    spoken: "Back to \(returnLabel)",
                    identifier: "photos.search.return",
                    action: onReturn
                )
                .transition(.opacity)
            }
            field
            SearchCircle(
                iconKey: "X",
                spoken: "Close search",
                identifier: "photos.search.close",
                action: onClose
            )
        }
        .padding(.horizontal, focused
            ? BandMetrics.searchInset
            : BandMetrics.inset + BandMetrics.searchRestPad)
        .padding(.vertical, focused ? 0 : BandMetrics.searchRestPad)
        .padding(.top, BandMetrics.topGap)
        // Over the keyboard while typing; in the band's slot, `floor` from the
        // glass, when not.
        .padding(.bottom, focused ? BandMetrics.searchInset : BandMetrics.floorPadding)
        .animation(
            reduceMotion
                ? nil
                : .timingCurve(0.3, 0, 0.4, 1, duration: CentraidGeometry.durationOne / 1000),
            value: focused
        )
        .onAppear {
            // THE FIELD OPENS READY: a member who pressed Search wants to type,
            // and a search page that needs a second tap to take a keystroke is
            // a page that makes them ask twice.
            typed = query
            focused = true
        }
        .onChange(of: typed) { _, query in
            // A QUERY CHANGE IS A DIFFERENCE FROM THE STATE, not an assignment
            // to it. Comparing is what keeps this from re-sending the query the
            // reducer just published back to it, which would be a read per
            // round trip for as long as the screen was open.
            guard query != self.query else { return }
            send(PhotosSearchStateView.queryEvent(query))
        }
    }

    private var field: some View {
        HStack(spacing: BandMetrics.searchTextLead - BandMetrics.searchGlyphLead - BandMetrics.searchGlyph) {
            CentraidIconView(
                iconKey: "Search",
                tint: Theme.color("textSoft", scheme),
                size: BandMetrics.searchGlyph
            )
            .frame(width: BandMetrics.searchGlyph, height: BandMetrics.searchGlyph)
            BareSearchField(
                text: $typed,
                focused: $focused,
                placeholder: "Search your library\u{2026}",
                font: Theme.uiFont("body", scheme),
                color: UIColor(Theme.color("text", scheme)),
                placeholderColor: UIColor(Theme.color("textFaint", scheme))
            )
            .accessibilityIdentifier("photos.search.field")
            if !typed.isEmpty {
                Button {
                    typed = ""
                } label: {
                    CentraidIconView(iconKey: "XCircle", tint: Theme.color("textFaint", scheme), size: 18)
                        .frame(
                            minWidth: CentraidGeometry.targetMinFine,
                            minHeight: CentraidGeometry.targetMinFine
                        )
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.leading, BandMetrics.searchGlyphLead)
        .padding(.trailing, 4)
        .frame(height: BandMetrics.searchHeight)
        .background(Capsule().fill(Theme.color("bgElev", scheme)))
        .overlay(
            Capsule().strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline)
        )
        .contentShape(Capsule())
        // A tap anywhere on the capsule, not only on the text run, starts
        // typing again — the system's field is one target, glyph and all.
        .onTapGesture { focused = true }
    }
}

/// One of the search row's round controls: 48, on the elevated ground, with a
/// hairline — the band's own materials at the system's size.
private struct SearchCircle: View {
    let iconKey: String
    let spoken: String
    let identifier: String
    let action: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: action) {
            CentraidIconView(iconKey: iconKey, tint: Theme.color("text", scheme), size: 20)
                .frame(width: BandMetrics.searchHeight, height: BandMetrics.searchHeight)
                .background(Circle().fill(Theme.color("bgElev", scheme)))
                .overlay(
                    Circle().strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline)
                )
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(spoken)
        .accessibilityIdentifier(identifier)
    }
}

/// A TEXT FIELD WITH NOTHING OVER THE KEYBOARD.
///
/// Suggestions, autocorrection, spell-checking, inline predictions, smart
/// punctuation and the assistant bar's button groups are all off — the
/// combination UIKit needs before it drops the strip. The Search key ends
/// editing (the row then moves into the band's slot); focus is a binding both
/// ways, so SwiftUI can raise the keyboard and the keyboard's own dismissal
/// reaches SwiftUI.
private struct BareSearchField: UIViewRepresentable {
    @Binding var text: String
    @Binding var focused: Bool
    let placeholder: String
    let font: UIFont
    let color: UIColor
    let placeholderColor: UIColor

    func makeUIView(context: Context) -> UITextField {
        let field = UITextField()
        field.font = font
        field.textColor = color
        field.attributedPlaceholder = NSAttributedString(
            string: placeholder,
            attributes: [.foregroundColor: placeholderColor, .font: font]
        )
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.autocapitalizationType = .none
        field.smartDashesType = .no
        field.smartQuotesType = .no
        field.smartInsertDeleteType = .no
        field.inlinePredictionType = .no
        field.returnKeyType = .search
        field.inputAssistantItem.leadingBarButtonGroups = []
        field.inputAssistantItem.trailingBarButtonGroups = []
        field.delegate = context.coordinator
        field.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return field
    }

    func updateUIView(_ field: UITextField, context: Context) {
        context.coordinator.parent = self
        if field.text != text { field.text = text }
        if focused, !field.isFirstResponder {
            DispatchQueue.main.async { field.becomeFirstResponder() }
        } else if !focused, field.isFirstResponder {
            DispatchQueue.main.async { field.resignFirstResponder() }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: BareSearchField
        init(parent: BareSearchField) { self.parent = parent }

        @objc func changed(_ field: UITextField) { parent.text = field.text ?? "" }

        func textFieldDidBeginEditing(_ field: UITextField) {
            if !parent.focused { parent.focused = true }
        }

        func textFieldDidEndEditing(_ field: UITextField) {
            if parent.focused { parent.focused = false }
        }

        /// The Search key: the query is already live, so it only puts the
        /// keyboard away and lets the member look at what it found.
        func textFieldShouldReturn(_ field: UITextField) -> Bool {
            field.resignFirstResponder()
            return false
        }
    }
}

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
                        .accessibilityLabel("Labels you can search for: \(words.joined(separator: ", "))")
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

    /// Four cases, always.
    enum Content {
        case resting(Centraid_Screen_V1_SearchResting)
        case loading(Bool)
        case failure(String, String)
        /// The cells as the wire holds them, whether this device has a
        /// thumbnail pack, why these matched, and the doors above them.
        case hits(
            [Centraid_Screen_V1_PhotoCell],
            Bool,
            [Centraid_Screen_V1_SearchMatch],
            [Centraid_Screen_V1_SearchTopHit]
        )
    }

    var content: Content {
        switch state.content {
        case let .resting(resting):
            return .resting(resting)
        case let .failure(failure):
            return .failure(failure.sentence, failure.remedy)
        case let .hits(hits):
            return .hits(hits.cells, hits.thumbnailPackAbsent, hits.matches, hits.topHits)
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
        "Search finds people, places, albums, labels and the captions you have written."

    /// v0's `SEARCH_COPY.miss.body`, in this build's words for what search reaches.
    static let missBody = "Nothing in captions, people, places, labels or album names."

    /// "Person · 12 photographs", or "Album · at least 500 photographs". A zero
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
        let noun = count == 1 ? "photograph" : "photographs"
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

