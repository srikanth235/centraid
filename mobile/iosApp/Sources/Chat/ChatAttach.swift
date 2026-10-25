import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

// THE CHAT'S ATTACH PICKERS: two sources, one chip.
//
// "Photo library" is the system's PHPickerViewController, which runs out of
// process and needs NO photo permission (the app sees only the one item the
// member picks); "Document" is the vault's text documents. Whatever is chosen
// is handed to the chat model by NAME (a document id) or, for the library, by
// the bytes of ONE image scaled here. There is no "Photo from vault" source:
// Photos' picker is Rust's (`photos.picker`) and only adds to an album. Nothing is written beyond a small thumbnail file, in the
// temporary directory, swept on launch, on a new chat and on a vault switch.

/// THUMBNAILS THE COMPOSER DRAWS FOR A LIBRARY PHOTO, and nothing else.
///
/// The temporary directory is not backed up and the system empties it; the
/// sweeps below are so that a photograph the member chose does not sit in the
/// app's container longer than the chat that used it.
enum AttachmentFiles {
    static var directory: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("chat-attach", isDirectory: true)
    }

    /// Remove every thumbnail.
    static func sweep() {
        try? FileManager.default.removeItem(at: directory)
    }

    /// Write `image` as a small JPEG and answer its path.
    static func write(thumbnail image: UIImage) -> String? {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(UUID().uuidString + ".jpg")
        guard let jpeg = image.jpegData(compressionQuality: 0.8) else { return nil }
        do {
            try jpeg.write(to: url, options: .atomic)
            return url.path
        } catch {
            return nil
        }
    }
}

/// A PICKED LIBRARY PHOTO, READY FOR THE CORE.
///
/// The core takes JPEG or PNG; the library hands HEIC. Decoding and redrawing
/// here converts it, applies the camera's orientation (the redraw is upright)
/// and bounds the bytes that cross the ABI: the model reads 448 pixels, so
/// 1024 on the long edge is more than it can use and a few hundred kilobytes.
enum LibraryPhoto {
    static let sendEdge: CGFloat = 1024
    static let thumbEdge: CGFloat = 160

    struct Prepared {
        let jpeg: Data
        let thumbnail: String
    }

    static func prepare(_ data: Data) -> Prepared? {
        guard let source = UIImage(data: data) else { return nil }
        let upright = scaled(source, maxEdge: sendEdge)
        guard let jpeg = upright.jpegData(compressionQuality: 0.85) else { return nil }
        guard let thumbnail = AttachmentFiles.write(thumbnail: scaled(upright, maxEdge: thumbEdge)) else {
            return nil
        }
        return Prepared(jpeg: jpeg, thumbnail: thumbnail)
    }

    /// `image` redrawn so its long edge is at most `maxEdge` points at scale 1.
    static func scaled(_ image: UIImage, maxEdge: CGFloat) -> UIImage {
        let longest = max(image.size.width, image.size.height)
        let factor = longest > maxEdge ? maxEdge / longest : 1
        let size = CGSize(width: (image.size.width * factor).rounded(), height: (image.size.height * factor).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
    }
}

// MARK: - The system picker

/// `PickLibraryPhoto`: PHPickerViewController for exactly one image, over the frontmost screen. It
/// needs no permission: the picker is the system's, and the app is handed only what the member picks.
@MainActor
enum LibraryPhotoPerformer {
    private static var holders: [Holder] = []

    static func pick(_ done: @escaping (Centraid_Core_V1_EffectResult.OneOf_Outcome) -> Void) {
        var configuration = PHPickerConfiguration(photoLibrary: .shared())
        configuration.filter = .images
        configuration.selectionLimit = 1
        configuration.preferredAssetRepresentationMode = .compatible
        let picker = PHPickerViewController(configuration: configuration)
        let holder = Holder(done)
        holder.onFinish = { holders.removeAll { $0 === holder } }
        holders.append(holder)
        picker.delegate = holder
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
            var top = scene.windows.first(where: \.isKeyWindow)?.rootViewController
        else {
            holder.finish(cancelled: true, unreadable: false, picked: nil)
            return
        }
        while let next = top.presentedViewController { top = next }
        top.present(picker, animated: true)
    }

    final class Holder: NSObject, PHPickerViewControllerDelegate {
        private let done: (Centraid_Core_V1_EffectResult.OneOf_Outcome) -> Void
        var onFinish: () -> Void = {}

        init(_ done: @escaping (Centraid_Core_V1_EffectResult.OneOf_Outcome) -> Void) { self.done = done }

        func finish(cancelled: Bool, unreadable: Bool, picked: LibraryPhoto.Prepared?) {
            var result = Centraid_Core_V1_LibraryPhotoPicked()
            result.cancelled = cancelled
            result.unreadable = unreadable
            if let picked {
                result.content = picked.jpeg
                result.mime = "image/jpeg"
                result.thumbnailPath = picked.thumbnail
            }
            done(.libraryPhotoPicked(result))
            onFinish()
        }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            picker.dismiss(animated: true)
            guard let provider = results.first?.itemProvider else {
                finish(cancelled: true, unreadable: false, picked: nil)
                return
            }
            provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { [weak self] data, _ in
                // HEIC to JPEG, bounded and upright, off the main thread.
                let prepared = data.flatMap { LibraryPhoto.prepare($0) }
                DispatchQueue.main.async {
                    self?.finish(cancelled: false, unreadable: prepared == nil, picked: prepared)
                }
            }
        }
    }
}

// MARK: - Vault documents

/// THE VAULT'S TEXT DOCUMENTS, newest edit first, as `ChatState.document_sheet` lists them. A PDF
/// is not listed: the core lists only what an attach would not refuse.
struct ChatDocumentSheet: View {
    let sheet: Centraid_Core_V1_ChatDocumentSheet
    let closeLabel: String
    let onPicked: (_ docID: String, _ title: String) -> Void
    let onClose: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        NavigationStack {
            ScrollView {
                if !sheet.loaded {
                    RowSkeleton(rows: 6).padding(.top, 24)
                } else if sheet.rows.isEmpty {
                    ScreenEmptyView(sentence: sheet.emptyLine)
                        .padding(.top, 24)
                } else {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(sheet.rows.enumerated()), id: \.element.docID) { index, document in
                            Button {
                                onPicked(document.docID, document.title)
                            } label: {
                                HStack(spacing: 12) {
                                    CentraidIconView(iconKey: "FileText", tint: Theme.color("textSoft", scheme), size: 20)
                                    VStack(alignment: .leading, spacing: 0) {
                                        Text(verbatim: document.title)
                                            .centraidType("smallStrong")
                                            .foregroundStyle(Theme.color("text", scheme))
                                            .lineLimit(2)
                                            .multilineTextAlignment(.leading)
                                        Text(verbatim: document.subtitle)
                                            .centraidType("mono")
                                            .foregroundStyle(Theme.color("textFaint", scheme))
                                    }
                                    Spacer(minLength: 0)
                                }
                                .padding(.vertical, 8)
                                .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(KitRowPress())
                            .accessibilityIdentifier("chat-document-\(index)")
                            Rectangle()
                                .fill(Theme.color("line", scheme))
                                .frame(height: CentraidGeometry.hairline)
                        }
                    }
                }
            }
            .contentMargins(.horizontal, CentraidGeometry.pageMargin, for: .scrollContent)
            .navigationTitle(sheet.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(action: onClose) {
                        CentraidIconView(iconKey: "X", tint: Theme.color("text", scheme), size: 18)
                    }
                    .accessibilityLabel(closeLabel)
                    .accessibilityIdentifier("chat-attach-close")
                }
            }
        }
        .accessibilityIdentifier("chat-documents")
    }
}
