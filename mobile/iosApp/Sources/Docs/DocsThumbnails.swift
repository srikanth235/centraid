import ImageIO
import PDFKit
import SwiftUI
import UIKit

// DOCS' PICTURES AND PALETTE (#1173). A document's thumbnail is the file the core hands out
// (`thumbnail_path`): an image, or a PDF's first page. Both are decoded off the main thread, at
// the size they are drawn, and kept in a cache the system may empty. A label's colour is a key of
// the one list palette (`color_key`, always set by Rust); this only looks the colour set up.

/// The list-palette colour set a `DocsLabelChip.colorKey` / `DocsRowView.dotColorKey` names.
func docsListColor(_ key: String) -> Color {
    guard let first = key.first else { return Color(CentraidAsset.listGraphite) }
    return Color("CentraidList\(first.uppercased())\(key.dropFirst())")
}

/// Decoded thumbnails by path and side. `UIImage(contentsOfFile:)` is never used: the store's
/// files have no extension, so ImageIO and PDFKit are handed the file and sniff it.
final class DocsThumbnailCache: @unchecked Sendable {
    static let shared = DocsThumbnailCache()

    private let cache = NSCache<NSString, UIImage>()

    private init() { cache.countLimit = 160 }

    func cached(_ path: String, _ side: CGFloat) -> UIImage? {
        cache.object(forKey: "\(path)@\(Int(side))" as NSString)
    }

    /// Decode `path` to at most `side` points on its long edge. A PDF draws its first page.
    func load(_ path: String, pdf: Bool, side: CGFloat, scale: CGFloat) -> UIImage? {
        let key = "\(path)@\(Int(side))" as NSString
        if let hit = cache.object(forKey: key) { return hit }
        let url = URL(fileURLWithPath: path)
        let pixels = side * scale
        var image: UIImage?
        if pdf {
            if let page = PDFDocument(url: url)?.page(at: 0) {
                image = page.thumbnail(of: CGSize(width: pixels, height: pixels * 1.25), for: .cropBox)
            }
        } else if let source = CGImageSourceCreateWithURL(url as CFURL, nil) {
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: pixels,
            ]
            image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { UIImage(cgImage: $0) }
        }
        if let image { cache.setObject(image, forKey: key) }
        return image
    }
}

/// A document's picture, or nothing while it decodes (or when the file will not open).
struct DocsThumbnail: View {
    let path: String
    let pdf: Bool
    let side: CGFloat

    @State private var image: UIImage?
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            }
        }
        .task(id: path) {
            if let hit = DocsThumbnailCache.shared.cached(path, side) {
                image = hit
                return
            }
            let (path, pdf, side, scale) = (path, pdf, side, displayScale)
            image = await Task.detached(priority: .utility) {
                DocsThumbnailCache.shared.load(path, pdf: pdf, side: side, scale: scale)
            }.value
        }
        .accessibilityHidden(true)
    }
}

/// THE KIND BADGE on a thumbnail: "PDF", "MD", "XLSX".
struct DocsBadge: View {
    let text: String

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Text(text)
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(Color.white)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(RoundedRectangle(cornerRadius: Theme.radius("sm", scheme)).fill(Color(CentraidAsset.textInk)))
    }
}

/// A label's colour dot.
struct DocsDot: View {
    let colorKey: String
    var size: CGFloat = 8

    var body: some View {
        Circle()
            .fill(docsListColor(colorKey))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// THE LABEL CHIPS over a shelf: a dot and a word each, the one filtering tinted in the app's colour.
struct DocsLabelChips: View {
    let chips: [Centraid_Core_V1_DocsLabelChip]
    let onPick: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(chips, id: \.tagID) { chip in
                    Button { onPick(chip.label) } label: {
                        HStack(spacing: 6) {
                            DocsDot(colorKey: chip.colorKey)
                            Text(chip.label)
                                .centraidType("annotLabel")
                                .foregroundStyle(Color(chip.selected ? CentraidAsset.appDocsText : CentraidAsset.textBody))
                                .lineLimit(1)
                        }
                        .padding(.horizontal, 10)
                        .frame(minHeight: 32)
                        .background(
                            Capsule().fill(chip.selected
                                ? Color(CentraidAsset.appDocs).opacity(0.16)
                                : Color(CentraidAsset.surfaceLine))
                        )
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(chip.label)
                    .accessibilityAddTraits(chip.selected ? [.isButton, .isSelected] : .isButton)
                    .accessibilityIdentifier("docs-label-chip-\(chip.label)")
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 4)
        }
    }
}

/// ONE TILE OF THE GRID: a 96 x 120 page with its thumbnail (or its kind's icon) and badge, the
/// title under it, and the meta line led by the first label's dot.
struct DocsGridTile: View {
    let row: Centraid_Core_V1_DocsRowView
    let onTap: () -> Void
    let onMenu: () -> Void
    let menuLabel: String

    @Environment(\.colorScheme) private var scheme

    private var isPDF: Bool { row.badge == "PDF" }

    var body: some View {
        Button(action: onTap) {
            VStack(spacing: 6) {
                ZStack(alignment: .bottomLeading) {
                    RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                        .fill(Color(CentraidAsset.surfaceCard))
                    if row.thumbnailPath.isEmpty {
                        CentraidIconView(iconKey: row.kindIconKey, tint: Theme.color("textSoft", scheme), size: 30)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .accessibilityHidden(true)
                    } else {
                        DocsThumbnail(path: row.thumbnailPath, pdf: isPDF, side: 120)
                            .frame(width: 96, height: 120)
                            .clipped()
                    }
                    DocsBadge(text: row.badge).padding(6)
                }
                .frame(width: 96, height: 120)
                .clipShape(RoundedRectangle(cornerRadius: Theme.radius("md", scheme)))
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                        .strokeBorder(Color(CentraidAsset.surfaceBorder), lineWidth: CentraidGeometry.hairline)
                )
                Text(row.title)
                    .centraidType("smallStrong")
                    .foregroundStyle(Theme.color("text", scheme))
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                HStack(spacing: 4) {
                    if !row.dotColorKey.isEmpty { DocsDot(colorKey: row.dotColorKey, size: 6) }
                    Text(row.meta)
                        .centraidType("annotLabel")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.accessibilityLabel.isEmpty ? row.title : row.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("docs-row-\(row.documentID)")
        .contextMenu {
            Button(menuLabel, action: onMenu)
        }
    }
}

/// A FOLDER'S TILE in Browse's grid: the folder drawn in the app's colour, its name and count.
struct DocsFolderTile: View {
    let node: Centraid_Core_V1_DocsFolderNode
    let onTap: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: onTap) {
            VStack(spacing: 6) {
                CentraidIconView(iconKey: "Folder", tint: Color(CentraidAsset.appDocs), size: 56)
                    .frame(width: 96, height: 120)
                    .accessibilityHidden(true)
                Text(node.name)
                    .centraidType("smallStrong")
                    .foregroundStyle(Theme.color("text", scheme))
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                Text(node.countLabel)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textFaint", scheme))
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(node.accessibilityLabel.isEmpty ? node.name : node.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("docs-folder-\(node.folderID)")
    }
}
