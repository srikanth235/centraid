import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

#if canImport(CentraidShared)
import CentraidShared
#endif

// THE CHAT'S ATTACH PICKERS: three sources, one chip.
//
// "Photo from vault" is the Photos app's own cells; "Photo library" is the
// system's PHPickerViewController, which runs out of process and needs NO photo
// permission (the app sees only the one item the member picks); "Document" is
// the vault's text documents. Whatever is chosen is handed to the chat model by
// NAME (an asset id, a document id) or, for the library, by the bytes of ONE
// image scaled here. Nothing is written beyond a small thumbnail file, in the
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

/// PHPickerViewController, for exactly one image. It needs no permission: the
/// picker is the system's, and the app is handed only what the member picks.
struct LibraryPhotoPicker: UIViewControllerRepresentable {
    /// The picked image's bytes (whatever format the library holds), or nil
    /// when the pick would not load. Not called when the member cancels.
    let onPicked: (Data?) -> Void

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var configuration = PHPickerConfiguration(photoLibrary: .shared())
        configuration.filter = .images
        configuration.selectionLimit = 1
        configuration.preferredAssetRepresentationMode = .compatible
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: PHPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onPicked: onPicked) }

    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let onPicked: (Data?) -> Void

        init(onPicked: @escaping (Data?) -> Void) {
            self.onPicked = onPicked
        }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            guard let provider = results.first?.itemProvider else {
                picker.dismiss(animated: true)
                return
            }
            picker.dismiss(animated: true)
            provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { [onPicked] data, _ in
                DispatchQueue.main.async { onPicked(data) }
            }
        }
    }
}

// MARK: - Vault photographs

/// THE VAULT'S PHOTOGRAPHS, AS A GRID TO CHOOSE ONE FROM. The Photos picker's
/// own cell renderer over its own machine; a tap attaches and closes.
struct ChatVaultPhotoSheet: View {
    @ObservedObject var chat: ChatModel
    let onPicked: (_ assetID: String, _ thumbnail: String) -> Void
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss

    private var state: PhotoPickerStateView { PhotoPickerStateView(data: chat.photoChoiceData) }

    var body: some View {
        NavigationStack {
            ScrollView {
                switch state.content {
                case .loading:
                    ProgressView().padding(.top, 48)
                case let .denied(denied):
                    DeniedGate(denied)
                case let .failure(sentence, remedy):
                    ScreenFailureView(sentence: sentence, remedy: remedy)
                case let .data(cells, packAbsent):
                    // Photographs and scans: a video is not an image to read.
                    let images = cells.filter { $0.kind == .photo || $0.kind == .scan }
                    if images.isEmpty {
                        ScreenEmptyView(sentence: ChatWords.noPhotos)
                            .padding(.top, 24)
                    } else {
                        PhotoCellsGrid(
                            cells: images,
                            packAbsent: packAbsent,
                            onTap: { identifier in
                                let thumbnail = images.first { $0.assetID == identifier }?.thumbnailPath ?? ""
                                onPicked(identifier, thumbnail)
                                dismiss()
                            }
                        )
                    }
                }
            }
            .contentMargins(.horizontal, CentraidGeometry.pageMargin, for: .scrollContent)
            .navigationTitle(ChatWords.pickPhoto)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: {
                        CentraidIconView(iconKey: "X", tint: Theme.color("text", scheme), size: 18)
                    }
                    .accessibilityLabel(ChatWords.close)
                    .accessibilityIdentifier("chat-attach-close")
                }
            }
        }
        .onAppear { chat.openPhotoChoice() }
        .accessibilityIdentifier("chat-vault-photos")
    }
}

// MARK: - Vault documents

/// THE VAULT'S TEXT DOCUMENTS, newest edit first. A PDF is not listed: the
/// core lists only what an attach would not refuse.
struct ChatDocumentSheet: View {
    @ObservedObject var chat: ChatModel
    let onPicked: (_ docID: String, _ title: String) -> Void
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                if !chat.documentsLoaded {
                    ProgressView().padding(.top, 48)
                } else if chat.documents.isEmpty {
                    ScreenEmptyView(sentence: ChatWords.noDocuments)
                        .padding(.top, 24)
                } else {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(chat.documents.enumerated()), id: \.element.docID) { index, document in
                            Button {
                                onPicked(document.docID, document.title)
                                dismiss()
                            } label: {
                                HStack(spacing: 12) {
                                    CentraidIconView(iconKey: "FileText", tint: Theme.color("textSoft", scheme), size: 20)
                                    VStack(alignment: .leading, spacing: 0) {
                                        Text(verbatim: document.title)
                                            .centraidType("smallStrong")
                                            .foregroundStyle(Theme.color("text", scheme))
                                            .lineLimit(2)
                                            .multilineTextAlignment(.leading)
                                        Text(verbatim: String(document.updatedAt.prefix(10)))
                                            .centraidType("mono")
                                            .foregroundStyle(Theme.color("textFaint", scheme))
                                    }
                                    Spacer(minLength: 0)
                                }
                                .padding(.vertical, 8)
                                .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("chat-document-\(index)")
                            Rectangle()
                                .fill(Theme.color("line", scheme))
                                .frame(height: CentraidGeometry.hairline)
                        }
                    }
                }
            }
            .contentMargins(.horizontal, CentraidGeometry.pageMargin, for: .scrollContent)
            .navigationTitle(ChatWords.pickDocument)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: {
                        CentraidIconView(iconKey: "X", tint: Theme.color("text", scheme), size: 18)
                    }
                    .accessibilityLabel(ChatWords.close)
                    .accessibilityIdentifier("chat-attach-close")
                }
            }
        }
        .onAppear { chat.loadDocuments() }
        .accessibilityIdentifier("chat-documents")
    }
}
