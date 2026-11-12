import SwiftUI
import UIKit

/// SHARE ONE DOCUMENT'S FILE (`ShareFile`): the store names a file by its digest, so the receiver
/// would see a hash. Copy it to a temporary file called what the member calls it, and hand that to
/// the system share sheet.
enum DocsShare {
    @MainActor
    static func present(_ share: Centraid_Core_V1_ShareFile) -> Bool {
        let source = URL(fileURLWithPath: share.path)
        return open(name: share.name, fallback: "Document", chooserTitle: share.chooserTitle) { copy in
            try FileManager.default.copyItem(at: source, to: copy)
        }
    }

    /// SHARE ONE SMALL ITEM MADE IN MEMORY (`ShareBytes`: a note as Markdown, a person as a vCard):
    /// write the bytes to a temporary file called what the member calls it and hand that to the
    /// same share sheet. The Compose twin is `performShareBytes`.
    @MainActor
    static func presentBytes(_ share: Centraid_Core_V1_ShareBytes) -> Bool {
        open(name: share.name, fallback: "Shared", chooserTitle: share.chooserTitle) { copy in
            try share.content.write(to: copy)
        }
    }

    @MainActor
    private static func open(
        name raw: String,
        fallback: String,
        chooserTitle: String,
        make: (URL) throws -> Void
    ) -> Bool {
        let name = raw.replacingOccurrences(of: "/", with: "-")
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let copy = folder.appendingPathComponent(name.isEmpty ? fallback : name)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try make(copy)
        } catch {
            return false
        }
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
              var top = scene.windows.first(where: \.isKeyWindow)?.rootViewController
        else { return false }
        while let next = top.presentedViewController { top = next }
        let sheet = UIActivityViewController(activityItems: [copy], applicationActivities: nil)
        if !chooserTitle.isEmpty { sheet.setValue(chooserTitle, forKey: "subject") }
        sheet.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: folder) }
        sheet.popoverPresentationController?.sourceView = top.view
        top.present(sheet, animated: true)
        return true
    }
}
