import AVFoundation
import Foundation
import ImageIO
import Photos
import UIKit
import UniformTypeIdentifiers

/// THE ORIGINALS OF A PICK, HANDED TO THE PLATFORM (#1135): the generic
/// `ExportOriginals` performer. "Send a copy" puts copies in the system share
/// sheet; "Download original" puts them in this device's photo library. Neither
/// writes to the vault. Rust (`photos/shelf.rs`) asks for it with the photograph
/// ids, owns every sentence and reads the closed `OriginalsExported` this answers;
/// this file does what only UIKit can: find each original on this phone, take
/// the place out of the bytes, the sheet, the library.
///
/// **HOW AN ORIGINAL IS FOUND.** Two trips through the core's one door:
/// `photos.photo` for each photograph's content item, then the byte door
/// (`ContentUrlRequest`) for where those bytes are on this device. A photograph
/// whose original is not here is counted in `missing`, never silently dropped.
///
/// **THE LOCATION IS TAKEN OUT OF THE BYTES, OR NOTHING IS SENT** (#816). A place
/// left out of the words while the file still carries its coordinates discloses
/// it anyway. A photograph is COPIED through ImageIO with
/// `kCGImageMetadataShouldExcludeGPS` — a copy of the encoded image, not a
/// re-encode, so capture time and orientation survive — and a video is re-muxed
/// with the sharing metadata filter. A file either path cannot clean stops the
/// whole send (`STATUS_LOCATION_NOT_REMOVABLE`).
///
/// Android's twin is `screens/PhotoShelfCopies.kt`.
enum ShelfCopyExport {
    /// One original this device holds, located for a platform hand-off.
    struct LocatedOriginal {
        let path: String
        let mediaType: String
        let isVideo: Bool
    }

    static func run(
        _ export: Centraid_Core_V1_ExportOriginals,
        core: any ScreenCore
    ) async -> Centraid_Core_V1_EffectResult.OneOf_Outcome {
        let (originals, missing) = await locate(export.photoIds, core: core)
        func exported(
            _ status: Centraid_Core_V1_OriginalsExported.Status,
            handed: Int = 0
        ) -> Centraid_Core_V1_EffectResult.OneOf_Outcome {
            .originalsExported(.with {
                $0.status = status
                $0.handed = UInt32(handed)
                $0.missing = UInt32(missing)
            })
        }
        guard !originals.isEmpty else { return exported(.noneHere) }
        switch export.mode {
        case .send:
            guard let files = await prepare(originals, keepLocation: export.keepLocation, export: export) else {
                return exported(.locationNotRemovable)
            }
            await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
                Task { @MainActor in present(files) { done.resume() } }
            }
            return exported(.done, handed: files.count)
        case .save:
            let saved = await saveToLibrary(originals, export: export)
            return saved < 0 ? exported(.failed) : exported(.done, handed: saved)
        default:
            var failed = Centraid_Core_V1_EffectFailed()
            failed.reason = "no export mode"
            return .failed(failed)
        }
    }

    /// WHERE EACH PICKED ORIGINAL IS ON THIS DEVICE, in the pick's order, and how
    /// many are not here.
    private static func locate(
        _ photoIds: [String],
        core: any ScreenCore
    ) async -> (originals: [LocatedOriginal], missing: Int) {
        var seen = Set<String>()
        let ids = photoIds.filter { !$0.isEmpty && seen.insert($0).inserted }
        var known: [(id: String, content: String, isVideo: Bool)] = []
        for id in ids {
            var request = Centraid_Core_V1_Request()
            request.load = .with {
                $0.app = "photos"
                $0.query = "photo"
                $0.params = ["id": .with { $0.text = id }]
            }
            guard
                let response = try? await core.call(request),
                case .load(let load)? = response.kind,
                load.answer.photosPhoto.hasPhoto
            else { continue }
            let cell = load.answer.photosPhoto.photo.cell
            if !cell.contentID.isEmpty { known.append((id, cell.contentID, cell.form == "video")) }
        }
        var found: [LocatedOriginal] = []
        // `ContentUrlRequest`'s own ceiling (`MAX_CONTENT_URLS`), asked in slices.
        for start in stride(from: 0, to: known.count, by: 100) {
            let slice = Array(known[start..<min(start + 100, known.count)])
            var request = Centraid_Core_V1_Request()
            request.contentUrls = .with {
                $0.refs = slice.map { item in
                    .with {
                        $0.contentID = item.content
                        $0.ownerType = "photo"
                        $0.ownerID = item.id
                    }
                }
            }
            guard
                let response = try? await core.call(request),
                case .contentUrls(let answer)? = response.kind
            else { continue }
            // ONE ANSWER PER REF, IN ORDER (`ContentUrls`' own rule), so the zip
            // is by position and a short answer pairs nothing wrongly.
            for (index, item) in slice.enumerated() where index < answer.urls.count {
                let url = answer.urls[index]
                if url.contentID == item.content, url.hasPath, !url.path.isEmpty {
                    found.append(LocatedOriginal(path: url.path, mediaType: url.mediaType, isVideo: item.isVideo))
                }
            }
        }
        return (found, ids.count - found.count)
    }

    /// Copies in the temporary directory, named by type so the receiver can
    /// open them, the location taken out unless the member kept it. Nil when a
    /// file's location could not be taken out.
    private static func prepare(
        _ originals: [LocatedOriginal],
        keepLocation: Bool,
        export: Centraid_Core_V1_ExportOriginals
    ) async -> [URL]? {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("copies", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var files: [URL] = []
        for (index, original) in originals.enumerated() {
            let source = URL(fileURLWithPath: original.path)
            let target = folder.appendingPathComponent(name(for: original, index: index, export: export))
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
    private static func saveToLibrary(_ originals: [LocatedOriginal], export: Centraid_Core_V1_ExportOriginals) async -> Int {
        let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        guard status == .authorized || status == .limited else { return -1 }
        guard let files = await prepare(originals, keepLocation: true, export: export) else { return -1 }
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

    /// `Photo 1.jpg`, `Video 2.mov`: the stems are Rust's (`ExportOriginals`), the
    /// extension from the media type the byte door reported, because the
    /// vault's own file is named by its hash.
    private static func name(for original: LocatedOriginal, index: Int, export: Centraid_Core_V1_ExportOriginals) -> String {
        let stem = original.isVideo ? export.videoStem : export.photoStem
        let fallback = original.isVideo ? "mov" : "jpg"
        let ext = UTType(mimeType: original.mediaType)?.preferredFilenameExtension ?? fallback
        return "\(stem) \(index + 1).\(ext)"
    }

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
