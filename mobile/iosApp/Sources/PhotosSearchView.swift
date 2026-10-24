import SwiftUI

import CentraidShared

/// SEARCH, IN SWIFTUI (#1029, the photos port; #1135).
///
/// Four states behind one destination, and the distinction the whole screen
/// exists to keep: **a member who has typed nothing and a member whose query
/// matched nothing must not read the same words.** The oneof is which one is
/// showing, and every word in it is Rust's.
///
/// **THE FIELD IS NOT HERE.** It is the room's search field, under the title where
/// every app's search stands (R-CHROME-2). This view is only what the query found:
/// the doors (places and albums the words name), the photographs, and the reason
/// line.
///
/// The Compose twin is `androidApp/.../screens/PhotosSearchScreen.kt`.
struct PhotosSearchBody: View {
    @Environment(\.colorScheme) private var scheme

    let search: Centraid_Core_V1_PhotosSearchView
    let send: (Centraid_Core_V1_PhotosHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                switch search.content {
                case let .resting(resting)?:
                    RestingView(resting: resting, send: send, open: open)
                case .loading?:
                    RowSkeleton()
                case let .failure(failure)?:
                    ScreenFailureView(sentence: failure.sentence, remedy: failure.remedy)
                case let .hits(hits)?:
                    if hits.hasEmpty {
                        // NOTHING MATCHED IS NOT NOTHING TYPED. Rust quotes the query
                        // back and says everywhere search looked.
                        EmptyStateView(hits.empty.legacy)
                            .accessibilityIdentifier("photos-search-no-match")
                    } else {
                        // THE DOORS FIRST (v0 §9: "each one tap from the surface that
                        // owns it"), then why the grid matched, then the grid.
                        ForEach(Array(hits.doors.enumerated()), id: \.offset) { _, door in
                            DoorRow(door: door, open: open)
                        }
                        if !hits.matchedLabel.isEmpty {
                            Text(hits.matchedLabel)
                                .centraidType("small")
                                .foregroundStyle(Theme.color("textSoft", scheme))
                                .lineLimit(2)
                        }
                        // `onTap` BY NAME AND NOT AS A TRAILING CLOSURE:
                        // `PhotoCellsGrid`'s last property is `onFetch`, so a trailing
                        // closure here would silently wire the download arrow to the
                        // lightbox and leave every cell tap doing nothing.
                        PhotoCellsGrid(
                            cells: hits.tiles,
                            onTap: { photoID in open(PhotosHomeEvents.lightbox(hits.open, photoID)) },
                            onFetch: { photoID, _ in send(PhotosHomeEvents.make { $0.originalRequested = photoID }) }
                        )
                    }
                case nil:
                    EmptyView()
                }
                // THE ASK ROW closes the answer, matched or not (#1135).
                if search.hasAsk { SearchAskRow(ask: search.ask.legacy) }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        // A SCROLL THROUGH THE HITS PUTS THE KEYBOARD AWAY, as the system's search
        // does: the member has stopped typing and started looking.
        .scrollDismissesKeyboard(.immediately)
    }
}

/// One door above the grid: the kind's mark, the vault's name for it, and what it holds.
private struct DoorRow: View {
    let door: Centraid_Core_V1_PhotosSearchDoor
    let open: (Centraid_Core_V1_Route) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let sub = [door.kindLabel, door.countLabel].filter { !$0.isEmpty }.joined(separator: " \u{00B7} ")
        Button {
            open(door.route)
        } label: {
            HStack(spacing: 10) {
                CentraidIconView(iconKey: door.iconKey, tint: Theme.color("textSoft", scheme), size: 20)
                VStack(alignment: .leading, spacing: 2) {
                    Text(door.label)
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
        .accessibilityLabel(door.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
    }
}

/// NOTHING HAS BEEN ASKED YET — so this says what there is to ask FOR.
///
/// One line that is true of every vault — what a search reaches — and then this
/// vault's own vocabulary under it: the places its photographs were taken, each a
/// door to its shelf, and the labels on them, each a word to search for. Never a
/// fixed list of words the product hopes are there; a vault with none of them
/// shows the line alone.
private struct RestingView: View {
    let resting: Centraid_Core_V1_PhotosSearchResting
    let send: (Centraid_Core_V1_PhotosHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(resting.hint)
                .centraidType("small")
                .foregroundStyle(Theme.color("textSoft", scheme))
            if !resting.places.isEmpty {
                section(resting.placesTitle) {
                    ForEach(resting.places, id: \.id) { place in
                        RestingDoor(label: place.label, iconKey: "place") {
                            if place.hasRoute { open(place.route) }
                        }
                    }
                }
            }
            if !resting.labels.isEmpty {
                // A LABEL HAS NO SHELF OF ITS OWN: tapping one searches for that word.
                section(resting.labelsTitle) {
                    ForEach(resting.labels, id: \.id) { label in
                        KitLink(label: label.label) {
                            send(PhotosHomeEvents.make { $0.searchTerm = label.label })
                        }
                    }
                }
            }
        }
        .padding(.vertical, 8)
    }

    /// A heading over one kind of word.
    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
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

/// One place on the resting page, opening its shelf.
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
        .accessibilityLabel(label)
    }
}
