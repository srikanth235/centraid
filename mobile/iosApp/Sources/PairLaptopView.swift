import AVFoundation
import CoreImage
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

#if canImport(CentraidShared)
import CentraidShared
#endif

// PAIR WITH THE LAPTOP, DRAWN (#1047 E5) — `pair.laptop` over
// `PairLaptopBridge`, opened from the More sheet's pairing row.
//
// **THIS VIEW DECIDES NOTHING.** The phase, every sentence, whether the
// primary is enabled and the safety number to compare arrive in the state. What
// is the view's is what only a platform can do: the paste field's keystrokes,
// and the camera — `ScanTapped` is an intent the machine ignores, so the view
// opens its scanner and sends back what it read as `Scanned`, which pairs at
// once. `PhotoTapped` is the same for the photo picker: the view reads the
// square out of the photo chosen and sends `Scanned`, or `PhotoUnread` when it
// holds none. The ticket is spent on first use and expires, so the screen is
// not shielded and pasting is allowed (`screen.proto`).

/// `PairLaptopState`: the paste field and the scan control while WAITING or
/// FAILED, a spinner while PAIRING, the safety number to compare once PAIRED
/// (W15-D5), and the door to the words while NEEDS_WORDS (`WordsTapped`, an
/// intent `ShellModel.sendPairLaptop` routes to the re-key).
struct PairLaptopView: View {
    let data: Data
    let send: (Data) -> Void

    @Environment(\.colorScheme) private var scheme
    @State private var scanning = false
    @State private var choosingPhoto = false
    @State private var photo: PhotosPickerItem?

    private var state: Centraid_Screen_V1_PairLaptopState {
        (try? Centraid_Screen_V1_PairLaptopState(serializedBytes: data)) ?? .init()
    }

    var body: some View {
        let state = state
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                WordsHead(title: state.title, lead: state.body)

                // SCAN FIRST, ON EVERY PHONE: the camera, or the photo picker
                // where there is none (`scan_camera`).
                if !state.scanLabel.isEmpty {
                    KitOutlineButton(label: state.scanLabel) {
                        send(Self.event { $0.scan = .init() })
                        if state.scanCamera { scanning = true } else { choosingPhoto = true }
                    }
                    .accessibilityIdentifier("pair-scan")
                }

                if !state.payloadLabel.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(state.payloadLabel)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                            .accessibilityHidden(true)
                        MachineTextField(placeholder: "", value: state.payload, axis: .vertical) { text in
                            send(Self.event { $0.typed = .with { $0.text = text } })
                        }
                        .lineLimit(2...5)
                        .keyboardType(.asciiCapable)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .centraidType("mono")
                        .padding(10)
                        .background(
                            RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                                .strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline)
                        )
                        .accessibilityLabel(state.payloadLabel)
                        .accessibilityIdentifier("pair-payload")
                    }
                }

                if !state.safetyNumber.isEmpty {
                    // EVERY DIGIT, IN THE LAPTOP'S OWN GROUPS: the comparison
                    // is the member's, so it is drawn to be read, and never
                    // shortened.
                    Text(state.safetyNumber)
                        .centraidType("mono")
                        .foregroundStyle(Theme.color("text", scheme))
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                                .fill(Theme.color("bgSunken", scheme))
                        )
                        .accessibilityIdentifier("pair-safety-number")
                }

                WordsNotice(notice: state.notice)

                if !state.progress.isEmpty {
                    KitSpinner(label: state.progress)
                        .accessibilityIdentifier("pair-progress")
                }

                // THE WORDS DOOR AND THE PRIMARY ARE ALTERNATIVES: one stack.
                KitChoiceStack {
                    WordsControls(
                        primary: state.primaryLabel,
                        primaryEnabled: state.primaryEnabled,
                        secondary: state.secondaryLabel,
                        prefix: "pair",
                        onPrimary: { send(Self.event { $0.primary = .init() }) },
                        onSecondary: { send(Self.event { $0.secondary = .init() }) }
                    )
                    if !state.wordsLabel.isEmpty {
                        KitOutlineButton(label: state.wordsLabel) {
                            send(Self.event { $0.words = .init() })
                        }
                        .accessibilityIdentifier("pair-words")
                    }
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.color("bg", scheme).ignoresSafeArea())
        .accessibilityIdentifier("pair-laptop")
        .fullScreenCover(isPresented: $scanning) {
            PairScanner(
                photoLabel: state.photoLabel,
                onRead: { payload in
                    scanning = false
                    send(Self.event { $0.scanned = .with { $0.payload = payload } })
                },
                onPhoto: { send(Self.event { $0.photo = .init() }) },
                onUnread: {
                    scanning = false
                    send(Self.event { $0.unread = .init() })
                },
                onCancel: { scanning = false }
            )
            .ignoresSafeArea()
        }
        // WITHOUT A CAMERA, SCAN IS THE PHOTO PICKER. The system picker needs
        // no grant: it hands back only the one photo chosen. Backing out sends
        // nothing.
        .photosPicker(isPresented: $choosingPhoto, selection: $photo, matching: .images)
        .onChange(of: photo) { _, item in
            guard let item else { return }
            photo = nil
            Task {
                let data = try? await item.loadTransferable(type: Data.self)
                let code = data.flatMap(PairPhotoReader.read)
                await MainActor.run {
                    send(Self.event {
                        if let code {
                            $0.scanned = .with { $0.payload = code }
                        } else {
                            $0.unread = .init()
                        }
                    })
                }
            }
        }
    }

    static func event(_ build: (inout Centraid_Screen_V1_PairLaptopEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_PairLaptopEvent()
        build(&event)
        return event.encoded
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
