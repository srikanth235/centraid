import SwiftUI

/// ONE CELL RENDERER, FOR EVERY SURFACE THAT DRAWS PHOTOGRAPHS.
///
/// The library grid, a shelf, the picker and search hits all draw the same
/// `PhotoCell` from the same page read: the same square ground, the same two
/// empty-cell sentences, the same held overlay and the same download arrow.
/// v0 wrote that four times (`PhotoTile.tsx`, `AlbumDetail.tsx`,
/// `PhotoStateView.tsx`, `PhotosSearch.tsx`) and they drifted — only one of
/// them ever grew the "no pack at all" sentence, and the picker's cells never
/// showed held state at all, so a member could pick a photograph this device
/// did not have.
///
/// **It takes the WIRE TYPE and not a view model.** Every screen's data case
/// carries `repeated PhotoCell`, so a per-screen struct in between would be a
/// second decode of a message that is already decoded, and a fifth place for
/// the held derivation to be spelled differently.
struct PhotoCellsGrid: View {
    let cells: [Centraid_Screen_V1_PhotoCell]
    /// TWO DIFFERENT EMPTY-CELL SENTENCES (`docs/mobile-offline.md:224`). A
    /// member with no thumbnail pack and a member whose pack has evicted these
    /// must not read the same words.
    let packAbsent: Bool
    /// The member's selection, when this surface has one.
    var selected: Set<String> = []
    /// Assets this surface cannot pick because they are already where the pick
    /// would put them. Drawn as taken rather than hidden: a member looking for
    /// a photograph they added last week should find it, and find out why it
    /// will not tick.
    var taken: Set<String> = []
    var minimumCell: CGFloat = 96
    var onTap: ((String) -> Void)?
    /// The download arrow. Both ids, because they answer different questions:
    /// the hash addresses the bytes and the asset id keys the cell.
    var onFetch: ((_ assetIdentifier: String, _ contentHash: String) -> Void)?

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: minimumCell), spacing: 2)], spacing: 2) {
            ForEach(cells, id: \.assetID) { cell in
                PhotoCellSquare(
                    cell: cell,
                    packAbsent: packAbsent,
                    isSelected: selected.contains(cell.assetID),
                    isTaken: taken.contains(cell.assetID),
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
    let cell: Centraid_Screen_V1_PhotoCell
    let packAbsent: Bool
    var isSelected = false
    var isTaken = false
    var onTap: ((String) -> Void)?
    var onFetch: ((String, String) -> Void)?

    private var path: String? {
        cell.hasThumbnailPath && !cell.thumbnailPath.isEmpty ? cell.thumbnailPath : nil
    }

    private var label: String { PhotoCellLabel.of(cell, packAbsent: packAbsent) }

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
                        .accessibilityLabel("Already in this album")
                } else if isSelected {
                    PhotoSelectionDot(selected: true)
                }
            }
            .overlay(alignment: .bottomTrailing) { PhotoKindLine(cell: cell, rung: PhotoKindLine.minimumRung) }
            .clipped()
            .opacity(isTaken ? 0.45 : 1)
            .contentShape(Rectangle())
            .onTapGesture { if !isTaken { onTap?(cell.assetID) } }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier(path ?? "photos.cell.\(cell.assetID)")
            .accessibilityLabel(label)
            .accessibilityAddTraits(isSelected ? [.isSelected, .isButton] : [.isButton])
    }
}

/// ONE TILE OF THE JUSTIFIED TIMELINE (v0's `PhotoTile.tsx`, #1029 photos port).
///
/// Its box is fixed from the asset record before a byte arrives — `width` and
/// `height` come from `PhotoJustify` — and every state paints INSIDE it, so
/// nothing reflows when a thumbnail lands. Four overlay slots and nothing else
/// (v0's `tile-overlays.ts`): selection top-trailing, kind bottom-trailing, and
/// the held state bottom-leading. The fourth, v0's vault rule, marked a
/// photograph from a vault other than the member's own inside a MERGED
/// timeline; this grid reads one vault, so every tile would carry it and the
/// mark would say nothing.
struct PhotoTile: View {
    @Environment(\.colorScheme) private var scheme
    let cell: Centraid_Screen_V1_PhotoCell
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
            .accessibilityLabel(PhotoCellLabel.of(cell, packAbsent: false))
            .accessibilityAddTraits(selected ? [.isImage, .isButton, .isSelected] : [.isImage, .isButton])
            .accessibilityAction(named: selecting ? "Select" : "Open", onTap)
            .accessibilityIdentifier(path ?? "photos.tile.\(cell.assetID)")
    }
}

/// A GRID CELL IS AN IMAGE-ONLY CONTROL, so it carries a description even when
/// the image is missing — which is when it matters most. A video and a live
/// photograph say so, because that is what changes what a tap does.
enum PhotoCellLabel {
    static func of(_ cell: Centraid_Screen_V1_PhotoCell, packAbsent: Bool) -> String {
        let noun = cell.live ? "Live photo" : (cell.kind == .video ? "Video" : "Photo")
        if cell.hasThumbnailPath && !cell.thumbnailPath.isEmpty { return noun }
        return packAbsent
            ? "\(noun), preview not downloaded to this device"
            : "\(noun), preview no longer on this device"
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
/// progress (`PhotoCell.fetch_percent`), so the honest mark is words on the
/// tile's own chip — v0's state slot, one quiet mono line on the page colour.
struct PhotoHeldMark: View {
    @Environment(\.colorScheme) private var scheme
    let cell: Centraid_Screen_V1_PhotoCell
    var onFetch: ((String, String) -> Void)?

    var body: some View {
        if cell.held == .fetching {
            Text("downloading")
                .centraidType("mono")
                .foregroundStyle(Theme.color("textFaint", scheme))
                .lineLimit(1)
                .padding(.horizontal, 3)
                .padding(.vertical, 1)
                .background(Theme.color("bg", scheme), in: RoundedRectangle(cornerRadius: PhotoTileMetrics.radiusSmall))
                .padding(4)
                .accessibilityIdentifier("photos.cell.fetching.\(cell.assetID)")
                .accessibilityLabel("Downloading")
        } else if cell.held == .withheldByRule, !cell.originalHash.isEmpty, let onFetch {
            Button {
                onFetch(cell.assetID, cell.originalHash)
            } label: {
                CentraidIconView(iconKey: "Download", tint: Theme.color("text", scheme), size: 14)
                    .padding(3)
                    .background(Theme.color("bg", scheme), in: RoundedRectangle(cornerRadius: PhotoTileMetrics.radiusSmall))
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
            .accessibilityIdentifier("photos.cell.download.\(cell.assetID)")
            .accessibilityLabel("Download full-size photo")
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
    let cell: Centraid_Screen_V1_PhotoCell
    let rung: Int

    /// v0's `KIND_MIN_RUNG`: S.
    static let minimumRung = 1

    private var text: String? {
        if cell.live { return "live" }
        if cell.kind == .video, cell.durationSeconds > 0 { return PhotoTileMetrics.clock(Int(cell.durationSeconds)) }
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

/// The tile's measures, v0's (`tile-overlays.ts`, `justify.ts`), and the
/// rungs (`photos-rungs.ts`). Restated for the SPM host build, which links no
/// Kotlin; `PhotosTimeline.RUNG_HEIGHTS` and `kit/PhotoCells.kt` hold the same
/// numbers and must agree.
enum PhotoTileMetrics {
    /// The gutter between tiles, both axes — the 4 base rung halved.
    static let gap: CGFloat = 2
    static let dot: CGFloat = 20
    static let dotInset: CGFloat = 6
    static let outline: CGFloat = 2
    /// The `sm` radius rung.
    static let radiusSmall: CGFloat = 4
    /// The phone's tile heights, XS to L.
    static let rungHeights: [CGFloat] = [64, 88, 120, 168]
    static let rungLabels = ["XS", "S", "M", "L"]

    static func height(rung: Int) -> CGFloat {
        rungHeights[min(max(rung, 0), rungHeights.count - 1)]
    }

    /// `1:04`, `12:07`, `1:02:03` — v0's `mediaClock`.
    static func clock(_ seconds: Int) -> String {
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        let rest = seconds % 60
        return hours > 0
            ? String(format: "%d:%02d:%02d", hours, minutes, rest)
            : String(format: "%d:%02d", minutes, rest)
    }
}

/// A tile's packed box: the cell, and where `PhotoJustify` put its edges.
struct JustifiedTile {
    let cell: Centraid_Screen_V1_PhotoCell
    let width: CGFloat
    let height: CGFloat
}

/// JUSTIFIED ROWS FROM REAL ASPECT RATIOS (v0's `justify.ts`, §4.1).
///
/// Rows pack to a target height and scale to fill the width exactly; nothing
/// crops to a square and nothing reflows when bytes land. The constants are
/// v0's and must stay equal to Compose's `justify` in `kit/PhotoCells.kt`: a 2
/// gutter, a 28% overshoot before a row closes, and a trailing partial row kept
/// at natural height capped at 1.25× so one wide photograph cannot become a
/// banner. A full row's rounding remainder folds into its LAST tile so the row
/// fills the width to the point; the trailing row deliberately does not.
enum PhotoJustify {
    static let overshoot: CGFloat = 0.28
    static let lastRowCap: CGFloat = 1.25

    static func rows(
        _ cells: [Centraid_Screen_V1_PhotoCell],
        width containerWidth: CGFloat,
        target: CGFloat
    ) -> [[JustifiedTile]] {
        guard containerWidth > 0, target > 0 else { return [] }
        let gap = PhotoTileMetrics.gap
        var rows: [[JustifiedTile]] = []
        var row: [(Centraid_Screen_V1_PhotoCell, CGFloat)] = []
        var sum: CGFloat = 0
        for cell in cells {
            let ratio = aspect(cell)
            row.append((cell, ratio))
            sum += ratio
            let spare = containerWidth - gap * CGFloat(row.count - 1)
            if sum * target >= spare + target * overshoot {
                let height = (spare / sum).rounded()
                var widths = row.map { (height * $0.1).rounded() }
                widths[widths.count - 1] += spare - widths.reduce(0, +)
                rows.append(row.enumerated().map { index, entry in
                    JustifiedTile(cell: entry.0, width: widths[index], height: height)
                })
                row.removeAll()
                sum = 0
            }
        }
        if !row.isEmpty {
            let natural = (containerWidth - gap * CGFloat(row.count - 1)) / sum
            let height = min(target * lastRowCap, natural)
            rows.append(row.map { JustifiedTile(cell: $0.0, width: (height * $0.1).rounded(), height: height.rounded()) })
        }
        return rows
    }

    /// The real aspect ratio; an unknown box packs SQUARE — a missing record is
    /// the one case there is nothing to be faithful to.
    static func aspect(_ cell: Centraid_Screen_V1_PhotoCell) -> CGFloat {
        cell.width > 0 && cell.height > 0 ? CGFloat(cell.width) / CGFloat(cell.height) : 1
    }
}

/// THE GRID IS THE LOADING STATE (v0's `PhotosGridSkeleton.tsx`, §14).
///
/// Skeleton tiles at the rung's own geometry, packed by the same
/// `PhotoJustify`, so the photographs land where their placeholders stood. The
/// aspect sequence is FIXED — random aspects would flicker — and nothing moves:
/// DESIGN.md's `Loading` is static skeletons, and a shimmer is
/// attention-seeking about work the product can simply describe.
struct PhotoGridSkeleton: View {
    @Environment(\.colorScheme) private var scheme
    let width: CGFloat
    let target: CGFloat
    var viewport: CGFloat = 800

    private static let aspects: [CGFloat] = [1.5, 1, 4 / 3, 0.75, 1.5, 16 / 9, 1, 2 / 3, 4 / 3, 1, 1.5, 0.75]

    private var rows: [[JustifiedTile]] {
        // BOTH HALVES ROUND UP: too few reads as "the library ends here".
        let perRow = max(1, Int(width / max(target, 1))) + 1
        let count = perRow * max(1, Int(viewport / max(target, 1)) + 1)
        let placeholders = (0..<count).map { index -> Centraid_Screen_V1_PhotoCell in
            var cell = Centraid_Screen_V1_PhotoCell()
            cell.assetID = "skeleton-\(index)"
            cell.width = UInt32(1000 * Self.aspects[index % Self.aspects.count])
            cell.height = 1000
            return cell
        }
        return PhotoJustify.rows(placeholders, width: width, target: target)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: PhotoTileMetrics.gap) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: PhotoTileMetrics.gap) {
                    ForEach(row, id: \.cell.assetID) { tile in
                        RoundedRectangle(cornerRadius: PhotoTileMetrics.radiusSmall)
                            .fill(Theme.color("skel", scheme))
                            .frame(width: tile.width, height: tile.height)
                    }
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Opening your library")
    }
}

/// THE THREE-STATE READ LAW, DRAWN ONCE.
///
/// Every screen in this app has the same three shapes and the same two lines
/// for a failure, and a per-screen copy is a per-screen chance to leave the
/// remedy out — which is the half of a refusal a member can act on.
struct ScreenFailureView: View {
    @Environment(\.colorScheme) private var scheme
    let sentence: String
    let remedy: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(sentence).centraidType("body")
            if !remedy.isEmpty {
                Text(remedy)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// NOTHING HERE, AND WHY. An empty shelf is a screen with a sentence, never a
/// blank frame — and the sentence differs per shelf, so it is a parameter.
struct ScreenEmptyView: View {
    let sentence: String
    var remedy: String = ""

    var body: some View {
        VStack(spacing: 6) {
            Text(sentence).centraidType("body").multilineTextAlignment(.center)
            if !remedy.isEmpty {
                Text(remedy).centraidType("small").multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 32)
    }
}
