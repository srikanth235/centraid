import AVFoundation
import Foundation
import ImageIO
import Photos
import UIKit
import UniformTypeIdentifiers

/// THE PATH THE VIEWER'S PHOTOGRAPH TAKES OFF THIS PHONE (#816, #1029 photos port).
///
/// v0's `photo-share.ts` and `viewer-export.ts`, and the SwiftUI twin of
/// Android's `PhotoHandOff.kt`. Everything here is platform I/O — reading the
/// original, writing a copy, handing a file to the OS — which is why it is the
/// shell's and not the reducer's: the DECISION (how much of the place travels)
/// is `SHEET_SHARE` and was reduced before any of this runs, and what this
/// reports back is an `Outcome` the screen turns into a `HandOffSettled`.
///
/// **ONE PHOTOGRAPH LEAVES THROUGH HERE, A PICK THROUGH `ShelfCopyExport`.**
/// v0 asserted a single exit with a call-site test; here there are two, one
/// per cardinality: this type hands the viewer's one photograph to the OS, and
/// `ShelfCopyExport.swift` presents the share sheet (or writes the photo
/// library) for a shelf's or the library's selection. No third file under
/// Photos hands bytes to the OS, and in both a place the member chose not to
/// send comes out of the bytes before anything is sent.
enum PhotoHandOff {
    /// What a hand-off did, in the sentence the status line shows.
    struct Outcome {
        let done: Bool
        let sentence: String
    }

    /// `PhotoLightboxBridge.kt`'s sentences, mirrored for the reason
    /// `PhotoLightboxView.swift` mirrors the share rows: Swift cannot call the
    /// Kotlin constants without a bridging layer this screen does not have.
    static let notRemovable = "The location could not be taken out of this file, so nothing was sent."
    static let originalNotHere = "The original is not on this device, so nothing was sent."
    static let exportFailed = "Photograph not exported. Retry."
    static let exportSaved = "Saved to this device's photos."
    static let locationCopied = "Exact location copied."

    // MARK: - Send a copy

    /// SEND A COPY, stripped to the precision the member chose.
    ///
    /// Below `exact` the location comes out of the BYTES, not just off the
    /// screen: ImageIO copies the image with its GPS and XMP left behind — a
    /// copy, never a re-encode, so the capture time and the orientation
    /// survive — and the result is READ BACK and checked before it may leave.
    /// A movie is never transcoded to lose its place; a copy that would carry
    /// a place it was told not to is not sent at all.
    ///
    /// The receipt is stated only when the share sheet says something was
    /// sent: a member who cancelled has sent nothing, and "Sent with no
    /// location." over a cancelled sheet would be a receipt for nothing.
    @MainActor
    static func send(
        _ detail: Centraid_Screen_V1_PhotoDetail,
        precision: PhotoLightboxSharePlace,
        completion: @escaping (Outcome?) -> Void
    ) {
        guard let original = originalURL(detail) else {
            completion(Outcome(done: false, sentence: originalNotHere))
            return
        }
        Task.detached(priority: .userInitiated) {
            let prepared = prepare(detail, original: original, precision: precision)
            await MainActor.run {
                switch prepared {
                case let .refused(sentence):
                    completion(Outcome(done: false, sentence: sentence))
                case let .ready(url):
                    var items: [Any] = [url]
                    // THE NAME TRAVELS AS WORDS, never inside the file.
                    if precision == .name, !detail.placeName.isEmpty {
                        items.append(detail.placeName)
                    }
                    present(items) { completed in
                        completion(
                            completed
                                ? Outcome(done: true, sentence: receipt(precision, detail.placeName))
                                : nil
                        )
                    }
                }
            }
        }
    }

    /// STATED EVERY TIME, `none` included: silence reads as safety. The
    /// words are `sharePlaceReceipt`'s.
    static func receipt(_ precision: PhotoLightboxSharePlace, _ placeName: String) -> String {
        switch precision {
        case .exact: return "Sent with the exact location."
        case .name:
            return placeName.isEmpty
                ? "Sent with no location."
                : "Sent with the place name only — \(placeName)."
        case .none: return "Sent with no location."
        }
    }

    private enum Prepared {
        case ready(URL)
        case refused(String)
    }

    private static func prepare(
        _ detail: Centraid_Screen_V1_PhotoDetail,
        original: URL,
        precision: PhotoLightboxSharePlace
    ) -> Prepared {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("shared-copies", isDirectory: true)
        // ONE COPY AT A TIME: the last hand-off's file is not a thing this
        // phone needs to keep.
        try? FileManager.default.removeItem(at: folder)
        guard (try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true))
            != nil
        else { return .refused(exportFailed) }
        let type = UTType(mimeType: detail.originalMediaType)
        let target = folder.appendingPathComponent(outgoingName(detail, type: type))
        if precision == .exact {
            guard (try? FileManager.default.copyItem(at: original, to: target)) != nil else {
                return .refused(exportFailed)
            }
            return .ready(target)
        }
        guard detail.kind == .photo,
              let source = CGImageSourceCreateWithURL(original as CFURL, nil),
              let sourceType = CGImageSourceGetType(source),
              let destination = CGImageDestinationCreateWithURL(target as CFURL, sourceType, 1, nil)
        else { return .refused(notRemovable) }
        let options: [CFString: Any] = [
            kCGImageMetadataShouldExcludeGPS: true,
            kCGImageMetadataShouldExcludeXMP: true,
        ]
        var error: Unmanaged<CFError>?
        guard CGImageDestinationCopyImageSource(destination, source, options as CFDictionary, &error),
              carriesNoPlace(target)
        else {
            try? FileManager.default.removeItem(at: target)
            return .refused(notRemovable)
        }
        return .ready(target)
    }

    /// THE COPY, READ BACK: no GPS dictionary, and none of IPTC's place
    /// fields. A copy that fails this is not sent — never a share that hides
    /// a place it carries.
    private static func carriesNoPlace(_ url: URL) -> Bool {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        else { return false }
        if properties[kCGImagePropertyGPSDictionary] != nil { return false }
        if let iptc = properties[kCGImagePropertyIPTCDictionary] as? [CFString: Any] {
            let placed: [CFString] = [
                kCGImagePropertyIPTCCity,
                kCGImagePropertyIPTCSubLocation,
                kCGImagePropertyIPTCProvinceState,
                kCGImagePropertyIPTCCountryPrimaryLocationName,
                kCGImagePropertyIPTCCountryPrimaryLocationCode,
            ]
            if placed.contains(where: { iptc[$0] != nil }) { return false }
        }
        return true
    }

    // MARK: - Download

    /// "DOWNLOAD" — THE ORIGINAL INTO THIS DEVICE'S OWN PHOTOS, as v0's
    /// `saveToCameraRoll`. Saving is not a share: the bytes stay on the phone,
    /// so they go as they are, place and all.
    static func saveToPhotos(_ detail: Centraid_Screen_V1_PhotoDetail) async -> Outcome {
        guard let original = originalURL(detail) else {
            return Outcome(done: false, sentence: originalNotHere)
        }
        // THE SAME GRANT THE CAMERA-ROLL BACKUP ASKS FOR, and no second one:
        // the app's usage string already says what the library is used for.
        var status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if status == .notDetermined {
            status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        }
        guard status == .authorized || status == .limited else {
            return Outcome(
                done: false,
                sentence: "Centraid cannot save to Photos. Allow it in Settings."
            )
        }
        do {
            try await PHPhotoLibrary.shared().performChanges {
                let options = PHAssetResourceCreationOptions()
                // A BLOB HAS NO EXTENSION, so the library is told what it is.
                options.uniformTypeIdentifier = UTType(mimeType: detail.originalMediaType)?.identifier
                options.originalFilename = outgoingName(
                    detail,
                    type: UTType(mimeType: detail.originalMediaType)
                )
                PHAssetCreationRequest.forAsset().addResource(
                    with: detail.kind == .video ? .video : .photo,
                    fileURL: original,
                    options: options
                )
            }
            return Outcome(done: true, sentence: exportSaved)
        } catch {
            return Outcome(done: false, sentence: exportFailed)
        }
    }

    // MARK: - Copy exact location

    /// "COPY EXACT LOCATION" — the one way a coordinate leaves this screen, and
    /// only because the member asked (v0's `exactLocation`, five places).
    static func copyLocation(_ detail: Centraid_Screen_V1_PhotoDetail) -> Outcome {
        guard detail.placeHasCoordinate else { return Outcome(done: false, sentence: exportFailed) }
        UIPasteboard.general.string = String(
            format: "%.5f, %.5f",
            detail.placeLatitude,
            detail.placeLongitude
        )
        return Outcome(done: true, sentence: locationCopied)
    }

    // MARK: - The camera

    /// THE CAMERA, OUT OF THE ORIGINAL'S OWN HEADER. The vault's row cannot
    /// say (`PhotoLightboxReads`' doc), and a camera writes its make and model
    /// into the file it makes. Nil for a file with neither.
    static func camera(atPath path: String) -> String? {
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let tiff = properties[kCGImagePropertyTIFFDictionary] as? [CFString: Any]
        else { return nil }
        let make = (tiff[kCGImagePropertyTIFFMake] as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let model = (tiff[kCGImagePropertyTIFFModel] as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        // "Apple iPhone 15 Pro", never "Apple Apple iPhone…".
        let name: String
        if model.isEmpty {
            name = make
        } else if make.isEmpty || model.lowercased().hasPrefix(make.lowercased()) {
            name = model
        } else {
            name = "\(make) \(model)"
        }
        return name.isEmpty ? nil : name
    }

    // MARK: - Plumbing

    private static func originalURL(_ detail: Centraid_Screen_V1_PhotoDetail) -> URL? {
        guard detail.hasOriginalPath, !detail.originalPath.isEmpty,
              FileManager.default.fileExists(atPath: detail.originalPath)
        else { return nil }
        return URL(fileURLWithPath: detail.originalPath)
    }

    /// v0's `outgoingName`: the caption when it is shaped like a file name, a
    /// plain noun when it is not, and the extension the bytes actually are.
    private static func outgoingName(_ detail: Centraid_Screen_V1_PhotoDetail, type: UTType?) -> String {
        let last = detail.title.split(separator: "/").last.map(String.init) ?? ""
        let stem = (last as NSString).deletingPathExtension
            .components(separatedBy: CharacterSet.alphanumerics
                .union(CharacterSet(charactersIn: " ._-")).inverted)
            .joined()
            .trimmingCharacters(in: .whitespaces)
        let base = stem.isEmpty ? (detail.kind == .video ? "video" : "photograph") : stem
        guard let suffix = type?.preferredFilenameExtension else { return base }
        return "\(base).\(suffix == "jpeg" ? "jpg" : suffix)"
    }

    /// THE OS SHARE SHEET, over whatever is on top. Presented from UIKit
    /// rather than a SwiftUI `.sheet`, because the precision sheet that chose
    /// it is still leaving the screen when the copy is ready, and SwiftUI will
    /// not present one sheet while another is dismissing.
    @MainActor
    private static func present(_ items: [Any], completion: @escaping (Bool) -> Void, attempt: Int = 0) {
        guard let top = topController() else {
            completion(false)
            return
        }
        if top.isBeingDismissed || top.isBeingPresented, attempt < 10 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                present(items, completion: completion, attempt: attempt + 1)
            }
            return
        }
        let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
        sheet.completionWithItemsHandler = { _, completed, _, _ in completion(completed) }
        sheet.popoverPresentationController?.sourceView = top.view
        top.present(sheet, animated: true)
    }

    @MainActor
    private static func topController() -> UIViewController? {
        let root = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)?
            .rootViewController
        var top = root
        while let presented = top?.presentedViewController, !presented.isBeingDismissed {
            top = presented
        }
        return top
    }
}
