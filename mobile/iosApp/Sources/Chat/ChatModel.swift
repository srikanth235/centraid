import Combine
import Foundation
import SwiftProtobuf
import SwiftUI
import UIKit

#if canImport(CentraidShared)
import CentraidShared
#endif

/// WHAT HOLDS THE CHAT TAB'S SHARED MACHINE ON iOS.
///
/// Its own `ObservableObject`, not more `@Published` fields on `ShellModel`: a
/// streamed answer is a state per token, and every state republished through
/// the shell would re-evaluate Home — which decodes its own state on every
/// pass — for each of them. `ChatView` observes this and nothing else does.
///
/// Like `ShellModel`, it is thin on purpose. The machine (`ChatMachine`), the
/// core's assistant plane and the phases are in `CentraidShared`; this class
/// holds the bridge, hands the states to SwiftUI as bytes, and performs the two
/// platform acts the machine asks for: the model download and the clipboard.
@MainActor
final class ChatModel: ObservableObject {
    /// The last finished `ChatState`, encoded. Empty bytes decode as the
    /// machine's own initial state (phase unspecified, nothing drawn).
    @Published private(set) var data = Data()

    /// The vault's photographs, drawn in the attach picker. It is the Photos
    /// app's own picker machine over the session's core — the same cells, the
    /// same held states — opened on no album, and its "pick" is the chat's
    /// "attach this one": nothing it holds is ever added to anything.
    @Published private(set) var photoChoiceData = Data()

    /// The vault's text documents, for the attach picker. Empty until asked.
    @Published private(set) var documents: [Centraid_Core_V1_AssistDocument] = []
    @Published private(set) var documentsLoaded = false

    /// The vault the thread belongs to, so a switch to another vault starts a
    /// new chat instead of asking a core that has never heard of the session.
    private var vaultID = ""
    /// What the tab last told the machine, so a repeat is not a second `open`.
    private(set) var opened = false

    #if canImport(CentraidShared)
    private var bridge = ChatBridge()
    private let photoChoice = PhotoPickerBridge()
    private weak var session: HomeSession?
    #endif

    init() {
        observeBridge()
        AttachmentFiles.sweep()
        let downloader = ChatModelDownloader.shared
        downloader.onProgress = { [weak self] asset, done, total in
            #if canImport(CentraidShared)
            if asset.isVision {
                self?.bridge.visionDownloadProgress(doneBytes: done, totalBytes: total)
            } else {
                self?.bridge.downloadProgress(doneBytes: done, totalBytes: total)
            }
            #endif
        }
        downloader.onFinished = { [weak self] asset, ok in
            #if canImport(CentraidShared)
            if asset.isVision {
                self?.bridge.visionDownloadFinished(ok: ok)
            } else {
                self?.bridge.downloadFinished(ok: ok)
            }
            #endif
        }
        // A transfer that finished while the app was away is delivered to the
        // session's delegate, which has to exist to hear it.
        downloader.reconnect()
    }

    /// The finished state, decoded for a view.
    var state: Centraid_Screen_V1_ChatState {
        (try? Centraid_Screen_V1_ChatState(serializedBytes: data)) ?? .init()
    }

    #if canImport(CentraidShared)
    private func observeBridge() {
        bridge.observe { [weak self] bytes in
            #if DEBUG
            if ChatPreview.mode != nil { return }
            #endif
            self?.data = bytes.data
        }
    }

    /// ATTACH THE BRIDGE TO THE HOME SESSION — ONCE PER SESSION.
    ///
    /// `core` is a SUPPLIER and not a handle: the shelf moves the foreground on
    /// a vault switch, and a bridge holding one core would go on asking a vault
    /// the member has left.
    func attach(session: HomeSession) {
        self.session = session
        attachBridge()
        photoChoice.attach(session: session)
        photoChoice.observe { [weak self] bytes in self?.photoChoiceData = bytes.data }
    }

    private func attachBridge() {
        guard let session else { return }
        bridge.attach(
            core: { [weak session] in session?.shelf.core() },
            modelPath: { ChatModelStore.modelPath },
            timeZone: { TimeZone.current.identifier },
            startDownload: { ChatModelDownloader.shared.start(.model) },
            copyToClipboard: { text in
                DispatchQueue.main.async { UIPasteboard.general.string = text }
            },
            projectorPath: { ChatModelStore.projectorPath },
            startVisionDownload: { ChatModelDownloader.shared.start(.vision) },
            // The device's clock, for "5 min ago" in the drawer: read at every
            // list, never captured.
            nowMillis: { KotlinLong(value: Int64(Date().timeIntervalSince1970 * 1000)) }
        )
    }

    /// THE FOREGROUND VAULT CHANGED. The thread, the session and the cards all
    /// belong to the vault that was in front, so the chat starts over on the
    /// one that is. The shared bridge attaches once, so a new bridge takes its
    /// place; the old one is CLOSED, which stops its running turn, cancels
    /// its event collector (it would otherwise listen to the previous
    /// core's stream for the life of the process).
    func vaultChanged(to id: String) {
        defer { vaultID = id }
        guard opened, !vaultID.isEmpty, id != vaultID else { return }
        // `close` stops a turn the core is still running, then releases.
        bridge.close()
        bridge = ChatBridge()
        opened = false
        data = Data()
        documents = []
        documentsLoaded = false
        AttachmentFiles.sweep()
        observeBridge()
        attachBridge()
    }
    #else
    private func observeBridge() {}
    func vaultChanged(to id: String) { vaultID = id }
    #endif

    // MARK: Intents

    /// THE TAB APPEARED, scoped to `app` or to everything (empty), under the
    /// foreground vault's name. A tab appearing never changes a chat that has
    /// something in it; `scopeChosen` is the composer's menu, which starts a
    /// new chat when the scope differs.
    func open(app: String, vaultName: String, scopeChosen: Bool = false) {
        opened = true
        #if DEBUG
        if let preview = ChatPreview.mode {
            data = ChatPreview.state(preview)
            return
        }
        #endif
        #if canImport(CentraidShared)
        bridge.open(
            app: app,
            modelBytes: ChatModelStore.expectedBytes,
            vaultName: vaultName,
            scopeChosen: scopeChosen
        )
        // A model that was mid-download when the app was killed is still
        // arriving: say so, so the tab draws its progress and not the offer.
        ChatModelDownloader.shared.reportRunning()
        #endif
    }

    func send(_ text: String) {
        #if canImport(CentraidShared)
        bridge.send(text: text)
        #endif
    }

    func stop() {
        #if canImport(CentraidShared)
        bridge.stop()
        #endif
    }

    func regenerate() {
        #if canImport(CentraidShared)
        bridge.regenerate()
        #endif
    }

    func newChat() {
        #if canImport(CentraidShared)
        bridge.doNewChat()
        #endif
        AttachmentFiles.sweep()
    }

    // MARK: History and the drawer

    /// THE DRAWER'S CONTROL, ITS SCRIM, OR THE CHAT TAB PRESSED WHILE CHAT SHOWS.
    func toggleDrawer(_ open: Bool) {
        #if canImport(CentraidShared)
        bridge.toggleDrawer(open: open)
        #endif
    }

    func openThread(_ id: String) {
        #if canImport(CentraidShared)
        bridge.openThread(threadId: id)
        #endif
        AttachmentFiles.sweep()
    }

    func renameThread(_ id: String, title: String) {
        #if canImport(CentraidShared)
        bridge.renameThread(threadId: id, title: title)
        #endif
    }

    func deleteThread(_ id: String) {
        #if canImport(CentraidShared)
        bridge.deleteThread(threadId: id)
        #endif
        AttachmentFiles.sweep()
    }

    func deleteAllThreads() {
        #if canImport(CentraidShared)
        bridge.deleteAllThreads()
        #endif
        AttachmentFiles.sweep()
    }

    /// WHETHER THE ROW A TAPPED CARD NAMES IS STILL IN THE VAULT. A card is a
    /// snapshot with no reference to its row, so the question is asked at the
    /// tap; the answer arrives on the main queue.
    func cardLive(_ card: Centraid_Screen_V1_ChatCard, _ answer: @escaping (Bool) -> Void) {
        #if canImport(CentraidShared)
        bridge.cardLive(app: card.app, entity: card.entity, id: card.id) { live in
            DispatchQueue.main.async { answer(live.boolValue) }
        }
        #else
        answer(true)
        #endif
    }

    func copy(_ messageID: UInt64) {
        #if canImport(CentraidShared)
        bridge.doCopy(messageId: Int64(bitPattern: messageID))
        #endif
    }

    func downloadTapped() {
        #if canImport(CentraidShared)
        bridge.downloadTapped()
        #endif
    }

    // MARK: A proposed write

    /// CONFIRM on the card that names `id`: the core runs the parked write, once.
    func confirmPending(_ id: String) {
        #if canImport(CentraidShared)
        bridge.confirmPending(pendingId: id)
        #endif
    }

    /// CANCEL on the card that names `id`: nothing is written.
    func cancelPending(_ id: String) {
        #if canImport(CentraidShared)
        bridge.cancelPending(pendingId: id)
        #endif
    }

    // MARK: Attachments

    /// The photo reader's download step was tapped.
    func visionDownloadTapped() {
        #if canImport(CentraidShared)
        bridge.visionDownloadTapped()
        #endif
    }

    func removeAttachment(_ id: UInt64) {
        #if canImport(CentraidShared)
        bridge.removeAttachment(id: Int64(bitPattern: id))
        #endif
    }

    /// A photograph from the vault, by asset id. `thumbnail` is the file the
    /// picker already drew it from; nothing is copied.
    func attachVaultPhoto(assetID: String, thumbnail: String) {
        forward { event in
            event.attached = .with {
                $0.vaultPhoto = .with { $0.assetID = assetID }
                $0.thumbnailPath = thumbnail
            }
        }
    }

    /// A photograph the member picked from their library: JPEG bytes (the
    /// picker's HEIC converted and scaled), and the small thumbnail file the
    /// chip draws. The bytes cross once, with the send.
    func attachLibraryPhoto(jpeg: Data, thumbnail: String) {
        forward { event in
            event.attached = .with {
                $0.libraryPhoto = .with {
                    $0.content = jpeg
                    $0.mime = "image/jpeg"
                }
                $0.thumbnailPath = thumbnail
            }
        }
    }

    func attachDocument(docID: String, title: String) {
        forward { event in
            event.attached = .with {
                $0.vaultDocument = .with { $0.docID = docID }
                $0.label = title
            }
        }
    }

    private func forward(_ build: (inout Centraid_Screen_V1_ChatEvent) -> Void) {
        #if canImport(CentraidShared)
        var event = Centraid_Screen_V1_ChatEvent()
        build(&event)
        guard let bytes = try? event.serializedData() else { return }
        bridge.sendEncoded(event: bytes.kotlin)
        #endif
    }

    /// OPEN THE VAULT PHOTO PICKER: the Photos picker machine, on no album.
    func openPhotoChoice() {
        #if canImport(CentraidShared)
        photoChoice.opened(collectionId: "", collectionName: "", alreadyInAlbumAssetIds: [])
        #endif
    }

    /// One tap in the vault photo picker.
    func photoChoiceSend(_ event: Data) {
        #if canImport(CentraidShared)
        photoChoice.send(event: event.kotlin)
        #endif
    }

    /// ASK THE CORE FOR THE TEXT DOCUMENTS THE CHAT CAN READ.
    func loadDocuments() {
        #if canImport(CentraidShared)
        bridge.loadDocuments { [weak self] bytes in
            let listed = try? Centraid_Core_V1_AssistDocuments(serializedBytes: bytes.data)
            DispatchQueue.main.async {
                self?.documents = listed?.documents ?? []
                self?.documentsLoaded = true
            }
        }
        #endif
    }
}
