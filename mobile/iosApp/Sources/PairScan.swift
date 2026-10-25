#if os(iOS)
import AVFoundation
import PhotosUI
import UIKit
import UniformTypeIdentifiers

// THE PERFORMER OF `ScanCode` (#1135): read one QR code.
//
// With a camera, the scanner (`PairScannerController`, in `PairLaptopView.swift`)
// is presented over the frontmost screen, its "choose a photo" control labelled
// by Rust (`photo_label`) so a screenshot of the square is one tap away. With
// none (the simulator) the system photo picker is raised and the square is read
// out of the photo chosen. A code read is `CodeScanned{text}`; a photo that holds
// no square is `CodeScanned{}` (an outcome, not a failure); backing out, and a
// camera grant that was refused, are `EffectFailed.cancelled` — Rust leaves the
// paste field as it was. This file decides nothing and writes no copy.

@MainActor
enum PairScan {
    /// What a member sees raise: held so the picker's delegate outlives the call.
    private static var picker: PairPhotoPicker?

    static func run(
        _ scan: Centraid_Core_V1_ScanCode,
        done: @escaping (Centraid_Core_V1_EffectResult.OneOf_Outcome) -> Void
    ) {
        guard let top = frontmost() else {
            done(.failed(ScreenStore.failure("no screen to present over")))
            return
        }
        if PairScanner.available {
            let controller = PairScannerController()
            controller.modalPresentationStyle = .fullScreen
            controller.photoLabel = scan.photoLabel
            controller.onRead = { code in
                controller.dismiss(animated: true)
                done(.codeScanned(Self.scanned(code)))
            }
            controller.onUnread = {
                controller.dismiss(animated: true)
                done(.codeScanned(Self.scanned("")))
            }
            controller.onCancel = {
                controller.dismiss(animated: true)
                done(.failed(ScreenStore.failure("scan closed", cancelled: true)))
            }
            // The camera screen's photo choice is the controller's own; Rust is told
            // only what it reads.
            controller.onPhoto = {}
            top.present(controller, animated: true)
        } else {
            let chosen = PairPhotoPicker { code, cancelled in
                picker = nil
                if cancelled {
                    done(.failed(ScreenStore.failure("scan closed", cancelled: true)))
                } else {
                    done(.codeScanned(Self.scanned(code ?? "")))
                }
            }
            picker = chosen
            chosen.present(over: top)
        }
    }

    private static func scanned(_ text: String) -> Centraid_Core_V1_CodeScanned {
        var scanned = Centraid_Core_V1_CodeScanned()
        scanned.text = text
        return scanned
    }

    private static func frontmost() -> UIViewController? {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
              var top = scene.windows.first(where: \.isKeyWindow)?.rootViewController
        else { return nil }
        while let next = top.presentedViewController { top = next }
        return top
    }
}

/// The system photo picker, for a phone with no camera: it needs no grant, and
/// hands back only the one photo chosen.
private final class PairPhotoPicker: NSObject, PHPickerViewControllerDelegate {
    private let finish: (String?, Bool) -> Void

    init(finish: @escaping (String?, Bool) -> Void) { self.finish = finish }

    func present(over top: UIViewController) {
        var config = PHPickerConfiguration()
        config.filter = .images
        config.selectionLimit = 1
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = self
        top.present(picker, animated: true)
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let provider = results.first?.itemProvider else {
            DispatchQueue.main.async { self.finish(nil, true) }
            return
        }
        provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
            let code = data.flatMap(PairPhotoReader.read)
            DispatchQueue.main.async { self.finish(code, false) }
        }
    }
}
#endif
