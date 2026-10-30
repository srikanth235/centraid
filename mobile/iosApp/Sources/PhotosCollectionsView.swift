import SwiftUI

/// COLLECTIONS, IN SWIFTUI (#1029, the photos port; #1135).
///
/// The hub: every surface this miniapp has that is not the library or search is
/// reached from this list.
///
/// **LAID OUT AS THE SYSTEM PHOTOS APP LAYS OUT ITS COLLECTIONS TAB** (iOS 26): a
/// run of titled sections, each foldable — Pinned as a strip of square covers with
/// the name printed on the photograph, Albums as covers with the name and count
/// beneath, Utilities as a grouped list, and the albums in the trash with their
/// Restore. A member who knows that screen knows this one. What is NOT borrowed is
/// the system's own look: the type, colour and icons are the emitted tables'
/// (DESIGN.md), because a second icon set is a second product.
///
/// **THE VIEW DECIDES NOTHING.** Which section a card lands in, every title, every
/// count, which sections are folded and the route a tap opens are Rust's
/// (`photos::home::collections`); this draws them and sends the taps.
///
/// The Compose twin is `androidApp/.../screens/PhotosCollectionsScreen.kt`.
struct PhotosCollectionsBody: View {
    @Environment(\.colorScheme) private var scheme

    let state: Centraid_Core_V1_PhotosHomeState
    let collections: Centraid_Core_V1_PhotosCollections
    let send: (Centraid_Core_V1_PhotosHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void

    var body: some View {
        // The room's scroll view is this one: the header and band are `AppPlace`'s.
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                switch collections.content {
                case .loading?:
                    RowSkeleton()
                case let .failure(failure)?:
                    ScreenFailureView(sentence: failure.sentence, remedy: failure.remedy)
                case let .data(data)?:
                    // SHOW ALL / COLLAPSE ALL, ONE LINK — v0's Collections menu without
                    // the menu: a bulk fold is a command over this list, not a header verb.
                    if !data.sections.isEmpty {
                        let everyFolded = data.sections.allSatisfy(\.folded)
                        HStack {
                            Spacer(minLength: 0)
                            KitLink(
                                label: everyFolded ? state.chrome.showAllLabel : state.chrome.collapseAllLabel,
                                identifier: "photos.collections.fold-all"
                            ) { send(PhotosHomeEvents.make { $0.foldAll = .init() }) }
                        }
                        .padding(.top, 4)
                    }
                    ForEach(data.sections, id: \.key) { section in
                        sectionView(section)
                    }
                case nil:
                    EmptyView()
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.bottom, 24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDismissesKeyboard(.immediately)
    }

    /// A TITLED, FOLDABLE SECTION — the system's header: the name large and on the
    /// left, a round fold control on the right that points down while the section
    /// is open.
    private func sectionView(_ section: Centraid_Core_V1_PhotosCollectionsSection) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center) {
                Text(section.title)
                    .centraidType("title")
                    .foregroundStyle(Theme.color("text", scheme))
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 8)
                KitIconKey(iconKey: "ChevronDown", label: section.toggleLabel, framed: true) {
                    withAnimation(.easeInOut(duration: CentraidGeometry.durationOne / 1000)) {
                        send(PhotosHomeEvents.make { $0.sectionToggled = section.key })
                    }
                }
                .rotationEffect(.degrees(section.folded ? -90 : 0))
            }
            if !section.folded { sectionBody(section) }
        }
        .padding(.top, 20)
    }

    @ViewBuilder
    private func sectionBody(_ section: Centraid_Core_V1_PhotosCollectionsSection) -> some View {
        switch section.key {
        case "pinned":
            strip { ForEach(section.cards, id: \.id) { PinnedCard(card: $0, open: open) } }
        case "albums":
            if section.hasEmpty {
                EmptySectionCard(
                    iconKey: "album",
                    title: section.empty.headline,
                    caption: section.empty.body,
                    verb: section.empty.actionLabel,
                    onVerb: { send(PhotosHomeEvents.sheet(.newAlbum)) }
                )
            } else {
                strip {
                    ForEach(section.cards, id: \.id) { card in
                        AlbumCard(
                            card: card,
                            open: open,
                            onDelete: { send(PhotosHomeEvents.make { $0.albumDeleteAsked = card.id }) }
                        )
                    }
                }
            }
        case "deleted":
            DeletedGroup(cards: section.cards) { id in send(PhotosHomeEvents.make { $0.albumRestored = id }) }
        default:
            UtilitiesGroup(cards: section.cards, open: open)
        }
    }

    /// A strip that runs to the screen's edges, so a half-shown card says it scrolls.
    private func strip<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: cardGap) { content() }
                .padding(.horizontal, CentraidGeometry.pageMargin)
        }
        .padding(.horizontal, -CentraidGeometry.pageMargin)
    }
}

// MARK: - the measures, and where each came from

/// Home's tile radius: one card corner in the product, not one per screen — the
/// `lg` container rung.
private func cardRadius(_ scheme: ColorScheme) -> CGFloat { Theme.radius("lg", scheme) }
/// The gap between cards in a strip — the system's, measured on its Pinned row.
private let cardGap: CGFloat = 12
/// A Pinned card's side. The system shows three and a sliver on a 402pt phone.
private let pinnedSide: CGFloat = 110
/// An album cover's side: larger than Pinned's, because an album is read by its
/// picture and a pinned shelf by its name.
private let albumSide: CGFloat = 150
/// An empty section's card height.
private let wideCardHeight: CGFloat = 150

/// A cover, or the ground a card without one stands on.
///
/// With no photograph the card is a soft vertical wash rather than a flat block,
/// so a coverless shelf reads as a card waiting for a picture — the system does
/// the same with its grey Map and Favorites cards.
private struct CoverGround: View {
    let card: Centraid_Core_V1_PhotosCollectionCard
    let iconKey: String
    @Environment(\.colorScheme) private var scheme

    private var path: String? {
        card.hasCover && card.cover.hasThumbnailPath && !card.cover.thumbnailPath.isEmpty ? card.cover.thumbnailPath : nil
    }

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Theme.color("bgElev", scheme), Theme.color("lineStrong", scheme)],
                startPoint: .top,
                endPoint: .bottom
            )
            if let path {
                ContentImage(path: path)
            } else {
                CentraidIconView(iconKey: iconKey, tint: Theme.color("textFaint", scheme), size: 28)
            }
        }
        .clipped()
    }
}

/// ONE PINNED CARD: a square, the name printed on the picture over a dark wash, so
/// it reads on any photograph.
private struct PinnedCard: View {
    let card: Centraid_Core_V1_PhotosCollectionCard
    let open: (Centraid_Core_V1_Route) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button {
            if card.hasRoute { open(card.route) }
        } label: {
            ZStack(alignment: .bottomLeading) {
                CoverGround(card: card, iconKey: card.iconKey)
                LinearGradient(
                    colors: [.black.opacity(0), .black.opacity(0.45)],
                    startPoint: .center,
                    endPoint: .bottom
                )
                Text(card.title)
                    .centraidType("smallStrong")
                    .foregroundStyle(.white)
                    .lineLimit(2)
                    .padding(10)
            }
            .frame(width: pinnedSide, height: pinnedSide)
            .clipShape(RoundedRectangle(cornerRadius: cardRadius(scheme)))
            .contentShape(RoundedRectangle(cornerRadius: cardRadius(scheme)))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(card.accessibilityLabel)
        .accessibilityIdentifier("photos.collections.shelf")
    }
}

/// ONE ALBUM: the cover, then the name and the count beneath it. A long press is
/// the system's way to the album's own verbs — here, Delete, which Rust confirms
/// before it writes.
private struct AlbumCard: View {
    let card: Centraid_Core_V1_PhotosCollectionCard
    let open: (Centraid_Core_V1_Route) -> Void
    let onDelete: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button {
            if card.hasRoute { open(card.route) }
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                CoverGround(card: card, iconKey: "album")
                    .frame(width: albumSide, height: albumSide)
                    .clipShape(RoundedRectangle(cornerRadius: cardRadius(scheme)))
                VStack(alignment: .leading, spacing: 0) {
                    Text(card.title)
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color("text", scheme))
                        .lineLimit(1)
                    Text(card.countLabel)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                }
                .frame(width: albumSide, alignment: .leading)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // THE SYSTEM'S LONG-PRESS ON AN ALBUM. Only an album: a standing shelf is
        // carries no `deleteLabel`, and never reaches this card.
        .contextMenu {
            Button(card.deleteLabel, role: .destructive, action: onDelete)
                .accessibilityIdentifier("photos.collections.delete-album")
        }
        .accessibilityLabel(card.accessibilityLabel)
        .accessibilityIdentifier("photos.collections.shelf")
        .accessibilityAction(named: card.deleteLabel, onDelete)
    }
}

/// AN EMPTY SECTION'S CARD: icon and verb across the top, the sentence at the
/// foot. The verb is a real control — the same sheet the toolbar's plus opens.
private struct EmptySectionCard: View {
    let iconKey: String
    let title: String
    let caption: String
    let verb: String
    let onVerb: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top) {
                CentraidIconView(iconKey: iconKey, tint: Theme.color("textFaint", scheme), size: 28)
                Spacer()
                KitOutlineButton(label: verb, action: onVerb)
                    .accessibilityIdentifier("photos.collections.create-album-card")
            }
            Spacer(minLength: 12)
            Text(title)
                .centraidType("smallStrong")
                .foregroundStyle(Theme.color("textSoft", scheme))
            Text(caption)
                .centraidType("small")
                .foregroundStyle(Theme.color("textFaint", scheme))
        }
        .padding(18)
        .frame(maxWidth: .infinity, minHeight: wideCardHeight, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: cardRadius(scheme)).fill(Theme.color("bgElev", scheme)))
    }
}

/// UTILITIES, AS A GROUPED LIST: one rounded card, a row per shelf or door,
/// hairlines between them inset past the icon — the system's inset-grouped list,
/// which is how it draws Archive and Recently Deleted.
private struct UtilitiesGroup: View {
    let cards: [Centraid_Core_V1_PhotosCollectionCard]
    let open: (Centraid_Core_V1_Route) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(cards.enumerated()), id: \.offset) { index, card in
                if index > 0 {
                    Rectangle()
                        .fill(Theme.color("line", scheme))
                        .frame(height: CentraidGeometry.hairline)
                        .padding(.leading, 50)
                }
                row(card)
            }
        }
        .background(RoundedRectangle(cornerRadius: cardRadius(scheme)).fill(Theme.color("bgElev", scheme)))
    }

    private func row(_ card: Centraid_Core_V1_PhotosCollectionCard) -> some View {
        Button {
            if card.hasRoute { open(card.route) }
        } label: {
            HStack(spacing: 12) {
                CentraidIconView(iconKey: card.iconKey, tint: Theme.color("link", scheme), size: 22)
                    .frame(width: 26)
                Text(card.title)
                    .centraidType("body")
                    .foregroundStyle(Theme.color("text", scheme))
                Spacer(minLength: 8)
                if !card.countLabel.isEmpty {
                    Text(card.countLabel)
                        .centraidType("small")
                        .foregroundStyle(Theme.color(card.urgent ? "accent" : "textFaint", scheme))
                }
                CentraidIconView(iconKey: "ChevronRight", tint: Theme.color("textFaint", scheme))
            }
            .padding(.horizontal, 12)
            .frame(minHeight: CentraidGeometry.targetMinCoarse + 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(card.accessibilityLabel)
        .accessibilityIdentifier("photos.collections.door")
    }
}

/// THE ALBUMS IN THE TRASH, as the same grouped list: each with the days left
/// before it is purged and a Restore, which brings the album back with its
/// photographs. Nothing else opens them.
private struct DeletedGroup: View {
    let cards: [Centraid_Core_V1_PhotosCollectionCard]
    let onRestore: (String) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(cards.enumerated()), id: \.offset) { index, card in
                if index > 0 {
                    Rectangle()
                        .fill(Theme.color("line", scheme))
                        .frame(height: CentraidGeometry.hairline)
                        .padding(.leading, 50)
                }
                HStack(spacing: 12) {
                    CentraidIconView(iconKey: card.iconKey, tint: Theme.color("textFaint", scheme), size: 22)
                        .frame(width: 26)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(card.title)
                            .centraidType("body")
                            .foregroundStyle(Theme.color("text", scheme))
                            .lineLimit(1)
                        if !card.countLabel.isEmpty {
                            Text(card.countLabel)
                                .centraidType("small")
                                .foregroundStyle(Theme.color("textFaint", scheme))
                        }
                    }
                    Spacer(minLength: 8)
                    KitLink(label: card.restoreLabel, identifier: "photos.collections.restore-album") { onRestore(card.id) }
                }
                .padding(.horizontal, 12)
                .frame(minHeight: CentraidGeometry.targetMinCoarse + 4)
                .accessibilityElement(children: .contain)
            }
        }
        .background(RoundedRectangle(cornerRadius: cardRadius(scheme)).fill(Theme.color("bgElev", scheme)))
    }
}
