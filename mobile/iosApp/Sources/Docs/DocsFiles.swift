import AVFoundation
import PDFKit
import SwiftUI
import UniformTypeIdentifiers
import VisionKit

/// PICKING A FILE FOR THE DRIVE'S ADD SHEET (#1047, R-1047-Q4; the `PickFile`
/// effect, #1135). Two things only the shell can do, and nothing else:
///
/// - **The picker and the scanner.** Upload is the system file importer (the
///   picked file copied into this app's temporary directory), Scan is
///   VisionKit's document camera (the pages written to one PDF).
/// - **The bytes.** The copy is streamed through the stage door (`StageDoor`)
///   so a 900 MB scan never exists in memory at once, and the answer carries
///   the hash the core named. Filing the document, naming it, and opening its
///   page are Rust's.
///
/// Exactly one of `FilePicked`, `EffectDone` (the member closed the picker) or
/// `EffectFailed` per ask, with `FileProgress` while the bytes move. A refused
/// camera grant answers `denied`; a phone with no scanner answers `unavailable`.
@MainActor
final class DocsFiles: ObservableObject {
    static let shared = DocsFiles()

    /// The file importer is up.
    @Published var importing = false
    /// The document camera is up.
    @Published var scanning = false

    /// The core the copy is staged into, given with the ask.
    private var core: (any ScreenCore)?

    private var kind: Centraid_Core_V1_PickFile.Kind = .upload
    private var answer: ((Centraid_Core_V1_EffectResult.OneOf_Outcome) -> Void)?

    /// Rust asked for a file: raise the picker or the scanner.
    func pick(
        _ kind: Centraid_Core_V1_PickFile.Kind,
        core: any ScreenCore,
        answer: @escaping (Centraid_Core_V1_EffectResult.OneOf_Outcome) -> Void
    ) {
        self.core = core
        self.kind = kind
        self.answer = answer
        if kind == .scan {
            if VNDocumentCameraViewController.isSupported {
                scanning = true
            } else {
                fail("unavailable")
            }
        } else {
            importing = true
        }
    }

    // MARK: The importer

    func imported(_ result: Result<[URL], Swift.Error>) {
        switch result {
        case let .failure(error):
            if (error as NSError).code == NSUserCancelledError {
                done()
            } else {
                fail("the picker failed")
            }
        case let .success(urls):
            guard let url = urls.first else { return done() }
            // A COPY THIS APP OWNS: the importer's URL is security-scoped and lives
            // only while access is held, and the stage reads from a path, later.
            DispatchQueue.global(qos: .userInitiated).async {
                let copied = DocsFileCopies.copy(url)
                DispatchQueue.main.async {
                    guard let copied else { return self.fail("the file cannot be read") }
                    self.stage(copied.path, name: copied.name, mediaType: copied.mediaType)
                }
            }
        }
    }

    // MARK: The scanner

    func scanned(_ path: String) {
        scanning = false
        stage(path, name: "", mediaType: "application/pdf")
    }

    func scanCancelled() {
        scanning = false
        done()
    }

    /// The scanner gave up: a member who declined the OS's camera question lands
    /// here, and Rust says where to turn it on.
    func scanFailed() {
        scanning = false
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        fail("the scanner failed", denied: status == .denied || status == .restricted)
    }

    // MARK: Staging

    private func stage(_ path: String, name: String, mediaType: String) {
        guard let core else { return fail("no vault is open") }
        let answer = answer
        self.answer = nil
        Task {
            let outcome = await StageDoor.stage(core, file: path, mediaType: mediaType) { sent, total in
                var progress = Centraid_Core_V1_FileProgress()
                progress.stagedBytes = sent
                progress.totalBytes = total
                progress.name = name
                Task { @MainActor in answer?(.fileProgress(progress)) }
            }
            DocsFileCopies.discard(path)
            switch outcome {
            case let .staged(handle):
                var picked = Centraid_Core_V1_FilePicked()
                picked.blob = handle.contentHash
                picked.byteSize = handle.byteSize
                picked.name = name
                picked.mediaType = mediaType
                answer?(.filePicked(picked))
            case .refused:
                // The sentence is Rust's: a refusal is said by the screen that asked.
                var failed = Centraid_Core_V1_EffectFailed()
                failed.reason = "the core refused the file"
                answer?(.failed(failed))
            }
        }
    }

    private func done() {
        answer?(.done(Centraid_Core_V1_EffectDone()))
        answer = nil
    }

    private func fail(_ reason: String, denied: Bool = false) {
        var failed = Centraid_Core_V1_EffectFailed()
        failed.reason = reason
        failed.denied = denied
        answer?(.failed(failed))
        answer = nil
    }
}

/// THE PICKER AND THE SCANNER, hosted at the app's root (`CentraidApp`):
/// a view carries one importer, and a pick can be asked for wherever the member is.
struct DocsFilesRoot: View {
    @ObservedObject var model = DocsFiles.shared

    var body: some View {
        Color.clear
            .fileImporter(isPresented: $model.importing, allowedContentTypes: [.item], allowsMultipleSelection: false) { result in
                model.imported(result)
            }
            .fullScreenCover(isPresented: $model.scanning) {
                DocsScanner(
                    onScanned: { model.scanned($0) },
                    onCancelled: { model.scanCancelled() },
                    onFailed: { model.scanFailed() }
                )
                .ignoresSafeArea()
            }
    }
}

/// Where a picked or scanned file waits for the stage: this app's own temporary
/// directory, under a name nothing else will pick. A copy is deleted once staged.
enum DocsFileCopies {
    struct Copied {
        let path: String
        let name: String
        let mediaType: String
    }

    static var directory: URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("docs-ingest", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func copy(_ url: URL) -> Copied? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let name = url.lastPathComponent
        let target = directory.appendingPathComponent("\(UUID().uuidString)-\(name)")
        do {
            try FileManager.default.copyItem(at: url, to: target)
        } catch {
            return nil
        }
        let mediaType = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? ""
        return Copied(path: target.path, name: name, mediaType: mediaType)
    }

    static func discard(_ path: String) {
        try? FileManager.default.removeItem(atPath: path)
    }

    /// A scan's pages as ONE PDF, at the page's own size.
    static func pdf(_ scan: VNDocumentCameraScan) -> String? {
        let document = PDFDocument()
        for index in 0 ..< scan.pageCount {
            if let page = PDFPage(image: scan.imageOfPage(at: index)) {
                document.insert(page, at: document.pageCount)
            }
        }
        guard document.pageCount > 0 else { return nil }
        let target = directory.appendingPathComponent("\(UUID().uuidString).pdf")
        return document.write(to: target) ? target.path : nil
    }
}

/// VisionKit's document camera, answering once.
struct DocsScanner: UIViewControllerRepresentable {
    let onScanned: (String) -> Void
    let onCancelled: () -> Void
    let onFailed: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let controller = VNDocumentCameraViewController()
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: VNDocumentCameraViewController, context: Context) {}

    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let parent: DocsScanner

        init(_ parent: DocsScanner) { self.parent = parent }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            let parent = parent
            DispatchQueue.global(qos: .userInitiated).async {
                let path = DocsFileCopies.pdf(scan)
                DispatchQueue.main.async {
                    if let path { parent.onScanned(path) } else { parent.onFailed() }
                }
            }
        }

        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
            parent.onCancelled()
        }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Swift.Error) {
            parent.onFailed()
        }
    }
}
