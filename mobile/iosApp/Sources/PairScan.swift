#if os(iOS)
import AVFoundation
import CoreImage
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

// THE PERFORMER OF `ScanCode` (#1135): read one QR code.
//
// With a camera, the scanner (`PairScannerController`, below)
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

// MARK: - the photo

/// THE SQUARE, READ OUT OF A PHOTO — the camera-less scan, which is what a
/// phone with no camera (and the simulator) still has. Core Image's QR
/// detector over the image's data; nil when it holds no code.
enum PairPhotoReader {
    static func read(_ data: Data) -> String? {
        guard let image = CIImage(data: data, options: [.applyOrientationProperty: true]),
              let detector = CIDetector(
                  ofType: CIDetectorTypeQRCode,
                  context: nil,
                  options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]
              )
        else { return nil }
        return detector.features(in: image)
            .compactMap { ($0 as? CIQRCodeFeature)?.messageString }
            .first { !$0.isEmpty }
    }
}

// MARK: - the camera

/// THE SQUARE, READ BY THE CAMERA: an `AVCaptureMetadataOutput` for QR codes,
/// answering the first one it reads. AVFoundation rather than VisionKit's
/// `DataScannerViewController`, which needs an A12 and says nothing on the
/// phones below it; a metadata output reads a QR on every camera iOS 17 runs
/// on. The first frame's code is the answer — a scan is a deliberate act.
struct PairScanner: UIViewControllerRepresentable {
    /// The camera screen's "Choose a photo" — a screenshot of the square.
    let photoLabel: String
    let onRead: (String) -> Void
    /// `PhotoTapped`, the intent, as the picker opens.
    let onPhoto: () -> Void
    /// The photo chosen held no square.
    let onUnread: () -> Void
    let onCancel: () -> Void

    /// Whether this phone has a camera to scan with — what `Opened.camera`
    /// tells the machine. The simulator has none.
    static var available: Bool { AVCaptureDevice.default(for: .video) != nil }

    func makeUIViewController(context: Context) -> PairScannerController {
        let controller = PairScannerController()
        controller.photoLabel = photoLabel
        controller.onRead = onRead
        controller.onPhoto = onPhoto
        controller.onUnread = onUnread
        controller.onCancel = onCancel
        return controller
    }

    func updateUIViewController(_ controller: PairScannerController, context: Context) {}
}

final class PairScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate,
    PHPickerViewControllerDelegate {
    var photoLabel = ""
    var onRead: ((String) -> Void)?
    var onPhoto: (() -> Void)?
    var onUnread: (() -> Void)?
    var onCancel: (() -> Void)?

    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?
    private var answered = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        let close = UIButton(type: .close)
        close.accessibilityIdentifier = "pair-scan-close"
        close.addAction(UIAction { [weak self] _ in self?.cancel() }, for: .touchUpInside)
        close.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(close)
        NSLayoutConstraint.activate([
            close.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            close.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
        ])
        // A SCREENSHOT OF THE SQUARE, from the camera screen: the picker is
        // presented over the camera, and backing out of it returns here.
        if !photoLabel.isEmpty {
            var look = UIButton.Configuration.filled()
            look.title = photoLabel
            look.baseBackgroundColor = .white
            look.baseForegroundColor = .black
            look.cornerStyle = .capsule
            look.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 20, bottom: 12, trailing: 20)
            let photo = UIButton(configuration: look)
            photo.accessibilityIdentifier = "pair-scan-photo"
            photo.addAction(UIAction { [weak self] _ in self?.choosePhoto() }, for: .touchUpInside)
            photo.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(photo)
            NSLayoutConstraint.activate([
                photo.centerXAnchor.constraint(equalTo: view.centerXAnchor),
                photo.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
                photo.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            ])
        }
        // THE GRANT IS ASKED FOR HERE, when the member tapped Scan — never at
        // launch. A refusal closes the camera; the paste field is still there.
        AVCaptureDevice.requestAccess(for: .video) { granted in
            DispatchQueue.main.async { granted ? self.start() : self.cancel() }
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        let session = session
        DispatchQueue.global(qos: .userInitiated).async { session.stopRunning() }
    }

    private func start() {
        guard let camera = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: camera),
              session.canAddInput(input)
        else { return cancel() }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return cancel() }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.insertSublayer(layer, at: 0)
        preview = layer
        let session = session
        DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput objects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !answered,
              let code = objects.compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }).first
        else { return }
        answered = true
        onRead?(code)
    }

    private func choosePhoto() {
        onPhoto?()
        var config = PHPickerConfiguration()
        config.filter = .images
        config.selectionLimit = 1
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = self
        present(picker, animated: true)
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let provider = results.first?.itemProvider else { return }
        provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
            let code = data.flatMap(PairPhotoReader.read)
            DispatchQueue.main.async {
                guard !self.answered else { return }
                self.answered = true
                if let code { self.onRead?(code) } else { self.onUnread?() }
            }
        }
    }

    private func cancel() {
        guard !answered else { return }
        answered = true
        onCancel?()
    }
}
#endif
