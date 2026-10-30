import Foundation
import LocalAuthentication

#if os(iOS)
import UIKit
import UniformTypeIdentifiers
#endif

// THE PLATFORM WORK THE LOCKER ASKS OF THE SHELL (#1135), as generic effects:
// the phone's own owner check, a file the member picks, and a file the member
// saves. None of it decides anything: the answer is an event, and Rust words it.

/// `OwnerCheck`: `LAContext().evaluatePolicy(.deviceOwnerAuthentication, …)`.
/// With `ask` false it only reads what this phone can do and raises nothing.
enum OwnerCheckPerformer {
    static func run(_ check: Centraid_Core_V1_OwnerCheck) async -> Centraid_Core_V1_EffectResult.OneOf_Outcome {
        let context = LAContext()
        var error: NSError?
        let available = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
        var checked = Centraid_Core_V1_OwnerChecked()
        checked.available = available
        switch context.biometryType {
        case .faceID: checked.biometry = .face
        case .touchID: checked.biometry = .touch
        case .opticID: checked.biometry = .optic
        default: checked.biometry = .passcode
        }
        guard check.ask else {
            checked.outcome = .notAsked
            return .ownerChecked(checked)
        }
        guard available else {
            checked.outcome = .unavailable
            return .ownerChecked(checked)
        }
        let outcome: Centraid_Core_V1_OwnerChecked.Outcome = await withCheckedContinuation { continuation in
            context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: check.reason) { ok, error in
                continuation.resume(returning: ok ? .succeeded : Self.outcome(error))
            }
        }
        checked.outcome = outcome
        return .ownerChecked(checked)
    }

    /// THE OUTCOME MAP: a dismissal is not a failure.
    static func outcome(_ error: Swift.Error?) -> Centraid_Core_V1_OwnerChecked.Outcome {
        guard let error = error as? LAError else { return .failed }
        switch error.code {
        case .userCancel, .systemCancel, .appCancel: return .cancelled
        case .passcodeNotSet: return .unavailable
        case .biometryLockout: return .lockedOut
        default: return .failed
        }
    }
}

#if os(iOS)
/// `PickBytes` and `SaveFile`: the system document picker over the frontmost
/// screen. A picked file is read in place from the picker's own URL and handed
/// back as bytes; a saved file goes through a protected temporary file that
/// exists only while the save sheet is up.
@MainActor
enum FilePerformer {
    private static var holders: [PickerHolder] = []

    static func pick(
        _ pick: Centraid_Core_V1_PickBytes,
        _ done: @escaping (Centraid_Core_V1_EffectResult.OneOf_Outcome) -> Void
    ) {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: contentTypes(pick.accept))
        picker.allowsMultipleSelection = false
        let holder = PickerHolder { urls in
            var file = Centraid_Core_V1_BytesPicked()
            if let url = urls.first {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                if let bytes = try? Data(contentsOf: url) {
                    file.name = url.lastPathComponent
                    file.content = bytes
                } else {
                    file.cancelled = true
                }
            } else {
                file.cancelled = true
            }
            done(.bytesPicked(file))
        }
        present(picker, holder)
    }

    /// WHAT `PickBytes.accept` MEANS TO THE PICKER: a media type or an extension (with or without
    /// its dot) becomes the `UTType` the system knows for it. The member is never locked out of a
    /// file Rust asked for: an entry the system cannot map, or an empty `accept`, opens the picker
    /// to every file (`.item`).
    static func contentTypes(_ accept: [String]) -> [UTType] {
        var types: [UTType] = []
        for entry in accept {
            let named = entry.trimmingCharacters(in: .whitespaces)
            if named.isEmpty { continue }
            let type = named.contains("/")
                ? UTType(mimeType: named)
                : UTType(filenameExtension: named.hasPrefix(".") ? String(named.dropFirst()) : named)
            guard let type else { return [.item] }
            types.append(type)
        }
        return types.isEmpty ? [.item] : types
    }

    static func save(
        _ save: Centraid_Core_V1_SaveFile,
        _ done: @escaping (Centraid_Core_V1_EffectResult.OneOf_Outcome) -> Void
    ) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(save.name.isEmpty ? "locker" : save.name)
        do {
            try save.content.write(to: url, options: [.completeFileProtection])
        } catch {
            done(.failed(ScreenStore.failure("could not stage the file")))
            return
        }
        let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
        let holder = PickerHolder { urls in
            try? FileManager.default.removeItem(at: url)
            done(urls.isEmpty ? .failed(ScreenStore.failure("dismissed", cancelled: true)) : .done(Centraid_Core_V1_EffectDone()))
        }
        present(picker, holder)
    }

    private static func present(_ picker: UIDocumentPickerViewController, _ holder: PickerHolder) {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
            var top = scene.windows.first(where: \.isKeyWindow)?.rootViewController
        else {
            holder.finish([])
            return
        }
        while let next = top.presentedViewController { top = next }
        holders.append(holder)
        holder.onFinish = { holders.removeAll { $0 === holder } }
        picker.delegate = holder
        top.present(picker, animated: true)
    }

    final class PickerHolder: NSObject, UIDocumentPickerDelegate {
        private let result: ([URL]) -> Void
        var onFinish: () -> Void = {}

        init(_ result: @escaping ([URL]) -> Void) { self.result = result }

        func finish(_ urls: [URL]) {
            result(urls)
            onFinish()
        }

        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { finish(urls) }
        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finish([]) }
    }
}
#endif
