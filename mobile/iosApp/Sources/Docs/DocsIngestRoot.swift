import AVFoundation
import PDFKit
import SwiftUI
import UniformTypeIdentifiers
import VisionKit

#if canImport(CentraidShared)
import CentraidShared
#endif

/// ADDING A DOCUMENT, AT THE APP'S ROOT (#1047, R-1047-Q4; `DocsIngestBridge`'s
/// header). Two things only the shell can do, and nothing else:
///
/// - **The picker and the scanner.** `onPick` is answered here: Upload is the
///   system file importer (the picked file copied into this app's temporary
///   directory, so the bridge OWNS it and deletes it once filed), Scan is
///   VisionKit's document camera (the pages written to one PDF, owned too).
///   Exactly one of `picked`, `pickCancelled` or `pickRefused` per ask.
/// - **The filed push.** When the ingest reaches FILED for a request it has
///   not routed, the document is pushed — its editor for Text, else its page
///   with the state's `parent` as its back word — wherever the member is, and
///   the bridge hears `routed`.
///
/// The status line (words, the bar, Try again, the close key) is drawn by the
/// drive from the same state (`DocsDriveView`).
struct DocsIngestRoot: View {
    @ObservedObject var shell: ShellModel

    /// The importer is up.
    @State private var importing = false
    /// The document camera is up.
    @State private var scanning = false

    private var state: Centraid_Screen_V1_DocsIngestState {
        (try? Centraid_Screen_V1_DocsIngestState(serializedBytes: shell.state(DocsScreens.ingest))) ?? .init()
    }

    var body: some View {
        let state = state
        Color.clear
            .onAppear(perform: seam)
            .onChange(of: RouteKey(state)) { _, _ in route(state) }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: false) { result in
                imported(result)
            }
            .fullScreenCover(isPresented: $scanning) {
                DocsScanner(
                    onScanned: { path in
                        scanning = false
                        answer { $0.picked(path: path, name: "", mediaType: "application/pdf", owned: true) }
                    },
                    onCancelled: {
                        scanning = false
                        answer { $0.pickCancelled() }
                    },
                    onFailed: {
                        scanning = false
                        // The camera grant as it stands now — a member who
                        // declined the OS's question lands here — and the
                        // machine picks the sentence (`scanRefusal`).
                        answer { $0.scanRefused(camera: DocsIngestRoot.cameraPermission) }
                    }
                )
                .ignoresSafeArea()
            }
    }

    /// What the push keys on: the request, its phase, whether it was routed.
    private struct RouteKey: Equatable {
        let seq: UInt32
        let phase: Int
        let routed: Bool

        init(_ state: Centraid_Screen_V1_DocsIngestState) {
            seq = state.requestSeq
            phase = state.phase.rawValue
            routed = state.routed
        }
    }

    private func route(_ state: Centraid_Screen_V1_DocsIngestState) {
        guard state.phase == .filed, !state.routed, !state.documentID.isEmpty else { return }
        if state.openEditor {
            shell.path.append(DocsScreens.editorRoute(state.documentID, state.title))
        } else {
            shell.path.append(DocsScreens.documentRoute(state.documentID, state.title, parent: state.parent))
        }
        #if canImport(CentraidShared)
        DocsScreens.ingestBridge.routed(requestSeq: Int32(state.requestSeq))
        #endif
    }

    /// Install the shell's picker on the bridge.
    private func seam() {
        #if canImport(CentraidShared)
        DocsScreens.ingestBridge.onPick = { kind in
            DispatchQueue.main.async {
                if kind.name == "KIND_SCAN" {
                    if VNDocumentCameraViewController.isSupported {
                        scanning = true
                    } else {
                        answer { $0.pickRefused(sentence: "") }
                    }
                } else {
                    importing = true
                }
            }
        }
        #endif
        route(state)
    }

    private func imported(_ result: Result<[URL], Swift.Error>) {
        switch result {
        case let .failure(error):
            if (error as NSError).code == NSUserCancelledError {
                answer { $0.pickCancelled() }
            } else {
                answer { $0.pickRefused(sentence: DocsIngestRoot.noFile) }
            }
        case let .success(urls):
            guard let url = urls.first else {
                answer { $0.pickCancelled() }
                return
            }
            // A COPY THIS APP OWNS: the importer's URL is security-scoped and
            // lives only while access is held, and the bridge stages from a
            // path, off the main thread, later.
            DispatchQueue.global(qos: .userInitiated).async {
                let copied = DocsIngestFiles.copy(url)
                DispatchQueue.main.async {
                    if let copied {
                        answer { $0.picked(path: copied.path, name: copied.name, mediaType: copied.mediaType, owned: true) }
                    } else {
                        answer { $0.pickRefused(sentence: DocsIngestRoot.noFile) }
                    }
                }
            }
        }
    }

    /// The camera grant as a `DocsCapture.Permission` number (the drive's
    /// `reportPermissions` reads the same status for the Add sheet).
    static var cameraPermission: Int32 {
        let permission: Centraid_Screen_V1_DocsCapture.Permission
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: permission = .granted
        case .denied: permission = .denied
        case .restricted: permission = .restricted
        case .notDetermined: permission = .notAsked
        @unknown default: permission = .notAsked
        }
        return Int32(permission.rawValue)
    }

    #if canImport(CentraidShared)
    private func answer(_ act: (DocsIngestBridge) -> Void) { act(DocsScreens.ingestBridge) }
    static var noFile: String { DocsCopy.shared.INGEST_NO_FILE }
    #else
    private func answer(_ act: (Any) -> Void) {}
    static var noFile: String { "" }
    #endif
}

/// Where a picked or scanned file waits for the bridge: this app's own
/// temporary directory, under a name nothing else will pick.
enum DocsIngestFiles {
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
                let path = DocsIngestFiles.pdf(scan)
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
