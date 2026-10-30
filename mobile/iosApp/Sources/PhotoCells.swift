import SwiftUI

/// ONE CELL RENDERER, FOR EVERY SURFACE THAT DRAWS PHOTOGRAPHS.
///
/// The library grid, a shelf, the picker and search hits all draw the same
/// `PhotoTile` the core finished: the same square ground, the same two
/// empty-cell sentences, the same held overlay and the same download arrow.
/// v0 wrote that four times (`PhotoTile.tsx`, `AlbumDetail.tsx`,
/// `PhotoStateView.tsx`, `PhotosSearch.tsx`) and they drifted — only one of
/// them ever grew the "no pack at all" sentence, and the picker's cells never
/// showed held state at all, so a member could pick a photograph this device
/// did not have.
///
/// **It takes the WIRE TYPE and not a view model.** Every screen's data case
/// carries `repeated PhotoTile`, so a per-screen struct in between would be a
/// second decode of a message that is already decoded, and a fifth place for
/// the held derivation to be spelled differently.
struct PhotoCellsGrid: View {
    let cells: [Centraid_Core_V1_PhotoTile]
    /// The member's selection, when this surface has one.
    var selected: Set<String> = []
    /// Assets this surface cannot pick because they are already where the pick
    /// would put them. Drawn as taken rather than hidden: a member looking for
    /// a photograph they added last week should find it, and find out why it
    /// will not tick.
    var taken: Set<String> = []
    /// What a taken cell is spoken as, Rust's ("Already in this album").
    var takenLabel = ""
    var minimumCell: CGFloat = 96
    var onTap: ((String) -> Void)?
    /// The download arrow. Both ids, because they answer different questions:
    /// the hash addresses the bytes and the asset id keys the cell.
    var onFetch: ((_ assetIdentifier: String, _ contentHash: String) -> Void)?

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: minimumCell), spacing: 2)], spacing: 2) {
            ForEach(cells, id: \.photoID) { cell in
                PhotoCellSquare(
                    cell: cell,
                    isSelected: selected.contains(cell.photoID),
                    isTaken: taken.contains(cell.photoID),
                    takenLabel: takenLabel,
                    onTap: onTap,
                    onFetch: onFetch
                )
            }
        }
    }
}

/// ONE SQUARE. The ground states the geometry and the clip keeps the overflow
/// off the neighbour — `ContentImage` fills and deliberately overflows its
/// frame, so an image asked for its own size would otherwise grow the row.
struct PhotoCellSquare: View {
    @Environment(\.colorScheme) private var scheme
    let cell: Centraid_Core_V1_PhotoTile
    var isSelected = false
    var isTaken = false
    var takenLabel = ""
    var onTap: ((String) -> Void)?
    var onFetch: ((String, String) -> Void)?

    private var path: String? {
        cell.hasThumbnailPath && !cell.thumbnailPath.isEmpty ? cell.thumbnailPath : nil
    }

    private var label: String { cell.accessibilityLabel }

    var body: some View {
        Theme.color("skel", scheme)
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                if let path {
                    ContentImage(path: path)
                } else {
                    Text(label)
                        .multilineTextAlignment(.center)
                        .centraidType("control")
                        .padding(4)
                }
            }
            // WHAT THIS DEVICE HAS OF THIS PHOTOGRAPH, ON TOP OF IT (#1025 S5,
            // D-1025-S7-62). A thumbnail is drawn under every one of these:
            // what the overlay says is whether the FULL-SIZE file is here,
            // moving, or waiting on the member's own rule.
            .overlay(alignment: .bottomLeading) { PhotoHeldMark(cell: cell, onFetch: onFetch) }
            .overlay(alignment: .topTrailing) {
                // TAKEN AND SELECTED MUST NOT READ THE SAME: one says "you are
                // choosing this now", the other "this is already where you are
                // putting it" — so the taken dot is the muted ink.
                if isTaken {
                    PhotoSelectionDot(selected: true, muted: true)
                        .accessibilityLabel(takenLabel)
                } else if isSelected {
                    PhotoSelectionDot(selected: true)
                }
            }
            .overlay(alignment: .bottomTrailing) { PhotoKindLine(cell: cell, rung: PhotoKindLine.minimumRung) }
            .clipped()
            .opacity(isTaken ? 0.45 : 1)
            .contentShape(Rectangle())
            .onTapGesture { if !isTaken { onTap?(cell.photoID) } }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier(path ?? "photos.cell.\(cell.photoID)")
            .accessibilityLabel(label)
            .accessibilityAddTraits(isSelected ? [.isSelected, .isButton] : [.isButton])
    }
}

/// ONE TILE OF THE JUSTIFIED TIMELINE (v0's `PhotoTile.tsx`, #1029 photos port).
///
/// Its box is fixed from the asset record before a byte arrives — `width` and
/// `height` come from Rust's packing (`PhotosPackedTile`) — and every state paints INSIDE it, so
/// nothing reflows when a thumbnail lands. Four overlay slots and nothing else
/// (v0's `tile-overlays.ts`): selection top-trailing, kind bottom-trailing, and
/// the held state bottom-leading. The fourth, v0's vault rule, marked a
/// photograph from a vault other than the member's own inside a MERGED
/// timeline; this grid reads one vault, so every tile would carry it and the
/// mark would say nothing.
struct PhotoTile: View {
    @Environment(\.colorScheme) private var scheme
    let cell: Centraid_Core_V1_PhotoTile
    let width: CGFloat
    let height: CGFloat
    let rung: Int
    let selecting: Bool
    let selected: Bool
    var onTap: () -> Void = {}
    var onLongPress: (() -> Void)?
    var onFetch: ((String, String) -> Void)?

    private var path: String? {
        cell.hasThumbnailPath && !cell.thumbnailPath.isEmpty ? cell.thumbnailPath : nil
    }

    var body: some View {
        // `--skel`, NEVER `--bg-elev`: an absence is not a card (§B), and the
        // ground is what shows before the bytes decode.
        Theme.color("skel", scheme)
            .frame(width: width, height: height)
            .overlay {
                if let path { ContentImage(path: path) }
            }
            .overlay {
                // THE OUTLINE IS DRAWN INSIDE THE BOX: the gutter is 2 and an
                // overhang would paint over the neighbour's edge.
                if selected {
                    Rectangle().strokeBorder(Theme.color("text", scheme), lineWidth: PhotoTileMetrics.outline)
                }
            }
            .overlay(alignment: .bottomLeading) { PhotoHeldMark(cell: cell, onFetch: onFetch) }
            .overlay(alignment: .topTrailing) {
                if selecting || selected { PhotoSelectionDot(selected: selected) }
            }
            .overlay(alignment: .bottomTrailing) { PhotoKindLine(cell: cell, rung: rung) }
            .clipped()
            .contentShape(Rectangle())
            .onTapGesture(perform: onTap)
            .onLongPressGesture(minimumDuration: 0.35) { onLongPress?() }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(cell.accessibilityLabel)
            .accessibilityAddTraits(selected ? [.isImage, .isButton, .isSelected] : [.isImage, .isButton])
            .accessibilityAction(named: selecting ? KitWords.SELECT : KitWords.OPEN, onTap)
            .accessibilityIdentifier(path ?? "photos.tile.\(cell.photoID)")
    }
}

/// The per-cell affordance, and nothing for the states that need none.
///
/// **The download arrow is drawn ONLY for `withheld_by_rule`.** A photograph
/// still on its way gets none — tapping it would ask for something already
/// queued — and `original` and `absent` draw nothing.
///
/// A FETCH IS A LINE AND NOT A SPINNER (DESIGN.md: loading is determinate or
/// static, never a spinner). The byte plane reports completion and not
/// progress (the tile carries no percentage), so the honest mark is words on the
/// tile's own chip — v0's state slot, one quiet mono line on the page colour.
struct PhotoHeldMark: View {
    @Environment(\.colorScheme) private var scheme
    let cell: Centraid_Core_V1_PhotoTile
    var onFetch: ((String, String) -> Void)?

    var body: some View {
        if cell.held == .fetching {
            Text(cell.heldLabel)
                .centraidType("mono")
                .foregroundStyle(Theme.color("textFaint", scheme))
                .lineLimit(1)
                .padding(.horizontal, 3)
                .padding(.vertical, 1)
                .background(Theme.color("bg", scheme), in: RoundedRectangle(cornerRadius: Theme.radius("sm", scheme)))
                .padding(4)
                .accessibilityIdentifier("photos.cell.fetching.\(cell.photoID)")
                .accessibilityLabel(cell.accessibilityLabel)
        } else if cell.held == .withheldByRule, !cell.contentID.isEmpty, let onFetch {
            Button {
                onFetch(cell.photoID, cell.contentID)
            } label: {
                CentraidIconView(iconKey: "Download", tint: Theme.color("text", scheme), size: 14)
                    .padding(3)
                    .background(Theme.color("bg", scheme), in: RoundedRectangle(cornerRadius: Theme.radius("sm", scheme)))
                    .padding(4)
                    // A 44 TARGET AROUND A SMALL CHIP: the mark is the tile's
                    // size, the press is a thumb's.
                    .frame(
                        minWidth: CentraidGeometry.targetMinCoarse,
                        minHeight: CentraidGeometry.targetMinCoarse,
                        alignment: .bottomLeading
                    )
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("photos.cell.download.\(cell.photoID)")
            .accessibilityLabel(cell.heldLabel)
        }
    }
}

/// SLOT 1 — SELECTION (v0's `tile-overlays.ts`): a 20 circle, top-trailing, 6
/// in. Selecting and not picked is an outline in the stage's ink; picked is a
/// filled ink circle with the inverse tick. INK, never a hue: DESIGN.md keeps
/// colour off controls, and a picked photograph is a control's state.
struct PhotoSelectionDot: View {
    @Environment(\.colorScheme) private var scheme
    let selected: Bool
    var muted = false

    var body: some View {
        let ink = Theme.color(muted ? "textSoft" : "text", scheme)
        ZStack {
            if selected {
                Circle().fill(ink)
                CentraidIconView(iconKey: "Check", tint: Theme.color("textInv", scheme), size: 13)
            } else {
                Circle().strokeBorder(Theme.color("onStage", scheme), lineWidth: 1.5)
            }
        }
        .frame(width: PhotoTileMetrics.dot, height: PhotoTileMetrics.dot)
        .padding(PhotoTileMetrics.dotInset)
        .accessibilityHidden(true)
    }
}

/// SLOT 3 — KIND (v0's `kindOverlay`): a video's length or `live`, in mono,
/// bottom-trailing, from rung S up — below it the type would have to shrink
/// past legibility, and DESIGN.md puts the floor there rather than shrinking
/// it. A video whose length the vault does not know still says it is a video,
/// with the catalog's play mark, because that is what changes what a tap does.
struct PhotoKindLine: View {
    @Environment(\.colorScheme) private var scheme
    let cell: Centraid_Core_V1_PhotoTile
    let rung: Int

    /// v0's `KIND_MIN_RUNG`: S.
    static let minimumRung = 1

    private var text: String? {
        if cell.live { return cell.liveLabel }
        if cell.kind == .video, cell.durationSeconds > 0 { return cell.durationLabel }
        return nil
    }

    var body: some View {
        if rung >= Self.minimumRung {
            if let text {
                Text(text)
                    .centraidType("mono")
                    .foregroundStyle(Theme.color("onStage", scheme))
                    // THE STAGE'S OWN INK OVER AN UNPREDICTABLE PHOTOGRAPH
                    // needs a carrier; a shadow is the one that costs no
                    // container.
                    .shadow(color: Theme.color("stage", scheme), radius: 3)
                    .lineLimit(1)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 4)
                    .accessibilityHidden(true)
            } else if cell.kind == .video {
                CentraidIconView(iconKey: "Play", tint: Theme.color("onStage", scheme), size: 14)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 4)
            }
        }
    }
}

/// The tile's measures, v0's (`tile-overlays.ts`). The gutter is Rust's
/// (`photos::home::layout::GAP`), which also packs the rows; the dot and outline
/// are the tile's own paint.
enum PhotoTileMetrics {
    /// The gutter between tiles, both axes — the 4 base rung halved.
    static let gap: CGFloat = 2
    static let dot: CGFloat = 20
    static let dotInset: CGFloat = 6
    static let outline: CGFloat = 2
}

/// THE GRID IS THE LOADING STATE (v0's `PhotosGridSkeleton.tsx`, §14).
///
/// Skeleton tiles at the rung's own geometry, packed by Rust at the width the
/// shell reported, so the photographs land where their placeholders stood. The
/// aspect sequence is FIXED — random aspects would flicker — and nothing moves:
/// DESIGN.md's `Loading` is static skeletons, and a shimmer is
/// attention-seeking about work the product can simply describe.
struct PhotoGridSkeleton: View {
    @Environment(\.colorScheme) private var scheme
    let rows: [Centraid_Core_V1_PhotosPackedRow]
    let label: String

    var body: some View {
        VStack(alignment: .leading, spacing: PhotoTileMetrics.gap) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: PhotoTileMetrics.gap) {
                    ForEach(Array(row.packed.enumerated()), id: \.offset) { _, tile in
                        RoundedRectangle(cornerRadius: Theme.radius("sm", scheme))
                            .fill(Theme.color("skel", scheme))
                            .frame(width: CGFloat(tile.width), height: CGFloat(tile.height))
                    }
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
    }
}

// `ScreenFailureView` and `ScreenEmptyView` moved to `Kit/ReadStates.swift` (K5).
