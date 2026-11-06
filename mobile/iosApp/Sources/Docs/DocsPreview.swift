import ImageIO
import PDFKit
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

/// A preview is decoded from the held file off the main actor. Missing or
/// unsupported bytes retain their honest kind badge instead of sample artwork.
struct DocsThumbnail: View {
    let row: Centraid_Core_V1_DocsRowView
    @Environment(\.colorScheme) private var scheme
    @State private var thumbnail: UIImage?
    @State private var excerpt = ""

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            RoundedRectangle(cornerRadius: Theme.radius("md", scheme)).fill(Theme.color("bgElev", scheme))
            if let thumbnail {
                Image(uiImage: thumbnail).resizable().scaledToFit().padding(4)
            } else if !excerpt.isEmpty {
                Text(excerpt).centraidType("annotLabel").foregroundStyle(Theme.color("text", scheme))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).padding(8).clipped()
            } else {
                CentraidIconView(iconKey: row.kindIconKey, tint: Theme.color("docsText", scheme), size: 30)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            Text(row.kindLabel).centraidType("annotLabel")
                .foregroundStyle(Theme.color("docsText", scheme))
                .padding(.horizontal, 6).padding(.vertical, 3)
                .background(Theme.color("docsTint", scheme), in: RoundedRectangle(cornerRadius: Theme.radius("sm", scheme)))
                .padding(4)
        }
        .clipShape(RoundedRectangle(cornerRadius: Theme.radius("md", scheme)))
        .accessibilityHidden(true)
        .task(id: row.previewPath) {
            thumbnail = nil
            excerpt = ""
            let path = row.previewPath
            let media = row.mediaType
            let loaded = await Task.detached(priority: .utility) { Self.decode(path: path, media: media) }.value
            let text = await Task.detached(priority: .utility) { Self.textPreview(path: path, media: media) }.value
            if !Task.isCancelled { thumbnail = loaded.flatMap { UIImage(data: $0) }; excerpt = text }
        }
    }

    nonisolated private static func textPreview(path: String, media: String) -> String {
        guard !path.isEmpty, media.hasPrefix("text/"), let file = FileHandle(forReadingAtPath: path) else { return "" }
        defer { try? file.close() }
        guard let bytes = try? file.read(upToCount: 4096) else { return "" }
        return String(decoding: bytes, as: UTF8.self)
    }

    // Transfer Data across the task boundary; UIImage's Sendable annotations
    // differ between SDKs. Only a bounded 320px thumbnail reaches the main actor.
    nonisolated private static func decode(path: String, media: String) -> Data? {
        guard !path.isEmpty else { return nil }
        let url = URL(fileURLWithPath: path)
        if media == "application/pdf" {
            return PDFDocument(url: url)?.page(at: 0)?.thumbnail(of: CGSize(width: 320, height: 320), for: .mediaBox).pngData()
        }
        guard media.hasPrefix("image/"), let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 320,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).flatMap { UIImage(cgImage: $0).pngData() }
    }
}

struct DocsLabelChips: View {
    let labels: [Centraid_Core_V1_DocsLabelChip]
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { chips }
            VStack(alignment: .leading, spacing: 4) { chips }
        }
    }
    private var chips: some View {
        ForEach(labels, id: \.tagID) { label in
            HStack(spacing: 4) {
                Circle().fill(Theme.color(label.colorKey, scheme)).frame(width: 8, height: 8).accessibilityHidden(true)
                Text(label.label).centraidType("annotLabel").foregroundStyle(Theme.color("textSoft", scheme))
            }
        }
    }
}

/// The platform's Quick Look renderer; the page keeps Centraid's actions and
/// version history around it. The URL comes exclusively from the core's read.
struct DocsQuickLook: View {
    let path: String
    let title: String
    let media: String
    @State private var copy: URL?
    var body: some View {
        DocsQuickLookController(url: copy ?? URL(fileURLWithPath: path), title: title)
            .task(id: path) {
                if let copy { try? FileManager.default.removeItem(at: copy.deletingLastPathComponent()) }
                copy = nil
                let sourcePath = path
                let sourceTitle = title
                let sourceMedia = media
                let prepared = await Task.detached(priority: .userInitiated) {
                    DocsSharedFile.prepare(path: sourcePath, title: sourceTitle, media: sourceMedia)
                }.value
                if Task.isCancelled {
                    if let prepared { try? FileManager.default.removeItem(at: prepared.deletingLastPathComponent()) }
                } else { copy = prepared }
            }
            .onDisappear {
                if let copy { try? FileManager.default.removeItem(at: copy.deletingLastPathComponent()) }
                copy = nil
            }
    }
}

private struct DocsQuickLookController: UIViewControllerRepresentable {
    let url: URL
    let title: String
    func makeCoordinator() -> Coordinator { Coordinator(url: url, title: title) }
    func makeUIViewController(context: Context) -> QLPreviewController {
        let view = QLPreviewController()
        view.dataSource = context.coordinator
        return view
    }
    func updateUIViewController(_ view: QLPreviewController, context: Context) {
        guard context.coordinator.url != url || context.coordinator.title != title else { return }
        context.coordinator.url = url
        context.coordinator.title = title
        view.reloadData()
    }
    @MainActor
    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var url: URL
        var title: String
        init(url: URL, title: String) { self.url = url; self.title = title }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
            DocsPreviewItem(url: url, title: title)
        }
    }
}

private final class DocsPreviewItem: NSObject, QLPreviewItem {
    let previewItemURL: URL?
    let previewItemTitle: String?
    init(url: URL, title: String) { previewItemURL = url; previewItemTitle = title }
}

/// A named copy gives Quick Look and share extensions the original media type;
/// content-store hashes deliberately have no filename extension.
enum DocsSharedFile {
    nonisolated static func prepare(path: String, title: String, media: String) -> URL? {
        guard !path.isEmpty else { return nil }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("centraid-doc-" + UUID().uuidString, isDirectory: true)
        var name = String(title.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_").prefix(180))
        if name.isEmpty || name == "." || name == ".." { name = "document" }
        if (name as NSString).pathExtension.isEmpty, let suffix = UTType(mimeType: media)?.preferredFilenameExtension { name += "." + suffix }
        let target = directory.appendingPathComponent(name)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: target)
            return target
        } catch {
            try? FileManager.default.removeItem(at: directory)
            return nil
        }
    }
}
