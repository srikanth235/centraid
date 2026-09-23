import AVFoundation
import Foundation
import ImageIO
import Photos
import UIKit
import UniformTypeIdentifiers

#if canImport(CentraidShared)
import CentraidShared
#endif

/// A COPY OF A PICK, HANDED TO THE PLATFORM (#1029, the photos port) — a
/// shelf's selection or the library's, whichever `CopyExportScreen` asked.
///
/// "Send a copy" puts copies of the originals in the system share sheet;
/// "Download original" puts them in this device's own photo library. Neither
/// writes to the vault, so neither is a reducer's business: `ShelfCopies.kt`
/// finds the originals and owns every sentence, and this file does the one part
/// only UIKit can — the files, the sheet, the library — then reports what it
/// came to through `CopyExportScreen.exportSettled`, which that screen shows in
/// one clause.
///
/// **THE LOCATION IS TAKEN OUT OF THE BYTES, OR NOTHING IS SENT** (#816). A
/// place left out of the words while the file still carries its coordinates
/// discloses it anyway. A photograph is COPIED through ImageIO with
/// `kCGImageMetadataShouldExcludeGPS` — a copy of the encoded image, not a
/// re-encode, so capture time and orientation survive — and a video is
/// re-muxed with the sharing metadata filter. A file either path cannot clean
/// stops the whole send, with `ShelfCopies.LOCATION_NOT_REMOVABLE`.
///
/// Android's twin is `screens/PhotoShelfCopies.kt`; the two are kept in step by
/// hand.
enum ShelfCopyExport {
    enum Kind {
        /// The share sheet. `keepLocation` false takes the place out first.
        case send(keepLocation: Bool)
        /// This device's photo library, bytes as they are.
        case save
    }

    #if canImport(CentraidShared)
    static func run(_ kind: Kind, _ assetIdentifiers: [String], bridge: any CopyExportScreen) {
        bridge.locateOriginals(assetIds: assetIdentifiers) { located in
            let originals = located.originals
            let missing = Int(located.missing)
            guard !originals.isEmpty else {
                bridge.exportSettled(sentence: ShelfCopies.shared.NONE_HERE)
                return
            }
            Task {
                switch kind {
                case let .send(keepLocation):
                    guard let files = await prepare(originals, keepLocation: keepLocation) else {
                        bridge.exportSettled(sentence: ShelfCopies.shared.LOCATION_NOT_REMOVABLE)
                        return
                    }
                    await MainActor.run {
                        present(files) {
                            // THE SHEET SAYS WHAT IT DID; this says only what
                            // did not go, which the sheet cannot know.
                            bridge.exportSettled(sentence: ShelfCopies.shared.missingSentence(missing: Int32(missing)))
                        }
                    }
                case .save:
                    let saved = await saveToLibrary(originals)
                    bridge.exportSettled(
                        sentence: saved < 0
                            ? ShelfCopies.shared.EXPORT_FAILED_SENTENCE
                            : ShelfCopies.shared.savedSentence(count: Int32(saved), missing: Int32(missing))
                    )
                }
            }
        }
    }

    /// Copies in the temporary directory, named by type so the receiver can
    /// open them, the location taken out unless the member kept it. Nil when a
    /// file's location could not be taken out.
    private static func prepare(_ originals: [LocatedOriginal], keepLocation: Bool) async -> [URL]? {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("copies", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var files: [URL] = []
        for (index, original) in originals.enumerated() {
            let source = URL(fileURLWithPath: original.path)
            let target = folder.appendingPathComponent(name(for: original, index: index))
            let copied: Bool
            if keepLocation {
                copied = (try? FileManager.default.copyItem(at: source, to: target)) != nil
            } else if original.isVideo {
                copied = await copyVideoWithoutLocation(from: source, to: target)
            } else {
                copied = copyImageWithoutLocation(from: source, to: target)
            }
            guard copied else { return nil }
            files.append(target)
        }
        return files
    }

    /// A photograph, copied WITHOUT its GPS block. The encoded image is copied
    /// rather than decoded and re-encoded, so nothing but the location changes.
    private static func copyImageWithoutLocation(from source: URL, to target: URL) -> Bool {
        guard
            let image = CGImageSourceCreateWithURL(source as CFURL, nil),
            let type = CGImageSourceGetType(image),
            let destination = CGImageDestinationCreateWithURL(target as CFURL, type, 1, nil)
        else { return false }
        let options = [kCGImageMetadataShouldExcludeGPS: true] as CFDictionary
        return CGImageDestinationCopyImageSource(destination, image, options, nil)
    }

    /// A video, re-muxed (never re-encoded) with the sharing filter, which drops
    /// location and the device's own identifiers.
    private static func copyVideoWithoutLocation(from source: URL, to target: URL) async -> Bool {
        guard let session = AVAssetExportSession(
            asset: AVURLAsset(url: source),
            presetName: AVAssetExportPresetPassthrough
        ) else { return false }
        session.outputURL = target
        session.outputFileType = target.pathExtension.lowercased() == "mp4" ? .mp4 : .mov
        session.metadataItemFilter = AVMetadataItemFilter.forSharing()
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            session.exportAsynchronously { done.resume() }
        }
        return session.status == .completed
    }

    /// The share sheet, over whatever is on top.
    @MainActor
    private static func present(_ files: [URL], completion: @escaping () -> Void) {
        let sheet = UIActivityViewController(activityItems: files, applicationActivities: nil)
        sheet.completionWithItemsHandler = { _, _, _, _ in
            // THE COPIES GO WHEN THE SHEET DOES. They are plaintext outside the
            // vault, and a temporary directory is emptied when the system
            // decides — not when the member is done.
            files.forEach { try? FileManager.default.removeItem(at: $0) }
            completion()
        }
        guard let top = topController() else { return completion() }
        sheet.popoverPresentationController?.sourceView = top.view
        top.present(sheet, animated: true)
    }

    /// Into this device's photo library. The count saved, or -1 when the
    /// library refused (no access, or the write failed).
    private static func saveToLibrary(_ originals: [LocatedOriginal]) async -> Int {
        let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        guard status == .authorized || status == .limited else { return -1 }
        guard let files = await prepare(originals, keepLocation: true) else { return -1 }
        defer { files.forEach { try? FileManager.default.removeItem(at: $0) } }
        do {
            try await PHPhotoLibrary.shared().performChanges {
                for (file, original) in zip(files, originals) {
                    PHAssetCreationRequest.forAsset()
                        .addResource(with: original.isVideo ? .video : .photo, fileURL: file, options: nil)
                }
            }
            return files.count
        } catch {
            return -1
        }
    }

    /// `Photo 1.jpg`, `Video 2.mov` — the extension from the media type the
    /// byte door reported, because the vault's own file is named by its hash.
    private static func name(for original: LocatedOriginal, index: Int) -> String {
        let stem = original.isVideo ? "Video" : "Photo"
        let fallback = original.isVideo ? "mov" : "jpg"
        let ext = UTType(mimeType: original.mediaType)?.preferredFilenameExtension ?? fallback
        return "\(stem) \(index + 1).\(ext)"
    }
    #endif

    @MainActor
    private static func topController() -> UIViewController? {
        let root = UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow }
            .first?.rootViewController
        var top = root
        while let presented = top?.presentedViewController { top = presented }
        return top
    }
}
