import SwiftUI
import UIKit

/// SHARE ONE DOCUMENT'S FILE (`ShareFile`): the store names a file by its digest, so the receiver
/// would see a hash. Copy it to a temporary file called what the member calls it, and hand that to
/// the system share sheet.
enum DocsShare {
    @MainActor
    static func present(_ share: Centraid_Core_V1_ShareFile) -> Bool {
        let source = URL(fileURLWithPath: share.path)
        let name = share.name.replacingOccurrences(of: "/", with: "-")
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let copy = folder.appendingPathComponent(name.isEmpty ? "Document" : name)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: source, to: copy)
        } catch {
            return false
        }
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
              var top = scene.windows.first(where: \.isKeyWindow)?.rootViewController
        else { return false }
        while let next = top.presentedViewController { top = next }
        let sheet = UIActivityViewController(activityItems: [copy], applicationActivities: nil)
        if !share.chooserTitle.isEmpty { sheet.setValue(share.chooserTitle, forKey: "subject") }
        sheet.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: folder) }
        sheet.popoverPresentationController?.sourceView = top.view
        top.present(sheet, animated: true)
        return true
    }
}
