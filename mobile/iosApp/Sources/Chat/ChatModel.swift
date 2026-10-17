import Combine
import Foundation
import SwiftProtobuf
import SwiftUI
import UIKit

import CentraidShared

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

    private var bridge = ChatBridge()
    private let photoChoice = PhotoPickerBridge()
    private weak var session: HomeSession?

    init() {
        observeBridge()
        AttachmentFiles.sweep()
        let downloader = ChatModelDownloader.shared
        downloader.onProgress = { [weak self] asset, done, total in
            if asset.isVision {
                self?.bridge.visionDownloadProgress(doneBytes: done, totalBytes: total)
            } else {
                self?.bridge.downloadProgress(doneBytes: done, totalBytes: total)
            }
        }
        downloader.onFinished = { [weak self] asset, ok in
            if asset.isVision {
                self?.bridge.visionDownloadFinished(ok: ok)
            } else {
                self?.bridge.downloadFinished(ok: ok)
            }
        }
        // A transfer that finished while the app was away is delivered to the
        // session's delegate, which has to exist to hear it.
        downloader.reconnect()
    }

    /// The finished state, decoded for a view.
    var state: Centraid_Screen_V1_ChatState {
        (try? Centraid_Screen_V1_ChatState(serializedBytes: data)) ?? .init()
    }

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

    // MARK: Intents

    /// THE TAB APPEARED, scoped to `app` or to everything (empty), under the
    /// foreground vault's name. A tab appearing never changes a chat that has
    /// something in it; `scopeChosen` is the composer's menu, which starts a
    /// new chat when the scope differs.
    func open(
        app: String,
        vaultName: String,
        scopeChosen: Bool = false,
        asking question: String? = nil,
        thread: String? = nil,
        title: String = ""
    ) {
        opened = true
        #if DEBUG
        if let preview = ChatPreview.mode {
            data = ChatPreview.state(preview)
            return
        }
        #endif
        if let thread {
            // Opened and then that past chat opened, in that order, on the bridge
            // (search's chat row): the thread is opened against the chat `open`
            // made. The hit's title is the header until the thread is read.
            bridge.openThreadFrom(
                app: app,
                modelBytes: ChatModelStore.expectedBytes,
                vaultName: vaultName,
                threadId: thread,
                title: title
            )
        } else if let question {
            // Opened and then asked, in that order, on the bridge: the question
            // is sent the moment the chat can take it, never before.
            bridge.openAsking(
                app: app,
                modelBytes: ChatModelStore.expectedBytes,
                vaultName: vaultName,
                text: question
            )
        } else {
            bridge.open(
                app: app,
                modelBytes: ChatModelStore.expectedBytes,
                vaultName: vaultName,
                scopeChosen: scopeChosen
            )
        }
        // A model that was mid-download when the app was killed is still
        // arriving: say so, so the tab draws its progress and not the offer.
        ChatModelDownloader.shared.reportRunning()
    }

    func send(_ text: String) {
        bridge.send(text: text)
    }

    func stop() {
        bridge.stop()
    }

    func regenerate() {
        bridge.regenerate()
    }

    func newChat() {
        bridge.doNewChat()
        AttachmentFiles.sweep()
    }

    // MARK: History and the drawer

    /// THE DRAWER'S CONTROL, ITS SCRIM, OR THE CHAT TAB PRESSED WHILE CHAT SHOWS.
    func toggleDrawer(_ open: Bool) {
        bridge.toggleDrawer(open: open)
    }

    func openThread(_ id: String, title: String = "") {
        bridge.openThread(threadId: id, title: title)
        AttachmentFiles.sweep()
    }

    // MARK: The drawer's search (#1097, R-1097-24)

    /// The drawer's search opener was tapped.
    func openDrawerSearch() {
        bridge.openDrawerSearch()
    }

    /// The drawer's field changed; the machine reads the core and drops what a
    /// newer term has overtaken.
    func drawerSearch(_ term: String) {
        bridge.drawerSearch(term: term)
    }

    /// The drawer's field was closed.
    func closeDrawerSearch() {
        bridge.closeDrawerSearch()
    }

    func renameThread(_ id: String, title: String) {
        bridge.renameThread(threadId: id, title: title)
    }

    func deleteThread(_ id: String) {
        bridge.deleteThread(threadId: id)
        AttachmentFiles.sweep()
    }

    func deleteAllThreads() {
        bridge.deleteAllThreads()
        AttachmentFiles.sweep()
    }

    /// WHETHER THE ROW A TAPPED CARD NAMES IS STILL IN THE VAULT. A card is a
    /// snapshot with no reference to its row, so the question is asked at the
    /// tap; the answer arrives on the main queue.
    func cardLive(_ card: Centraid_Screen_V1_ChatCard, _ answer: @escaping (Bool) -> Void) {
        bridge.cardLive(app: card.app, entity: card.entity, id: card.id) { live in
            DispatchQueue.main.async { answer(live.boolValue) }
        }
    }

    func copy(_ messageID: UInt64) {
        bridge.doCopy(messageId: Int64(bitPattern: messageID))
    }

    func downloadTapped() {
        bridge.downloadTapped()
    }

    // MARK: A proposed write

    /// CONFIRM on the card that names `id`: the core runs the parked write, once.
    func confirmPending(_ id: String) {
        bridge.confirmPending(pendingId: id)
    }

    /// CANCEL on the card that names `id`: nothing is written.
    func cancelPending(_ id: String) {
        bridge.cancelPending(pendingId: id)
    }

    // MARK: Attachments

    /// The photo reader's download step was tapped.
    func visionDownloadTapped() {
        bridge.visionDownloadTapped()
    }

    func removeAttachment(_ id: UInt64) {
        bridge.removeAttachment(id: Int64(bitPattern: id))
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
        var event = Centraid_Screen_V1_ChatEvent()
        build(&event)
        guard let bytes = try? event.serializedData() else { return }
        bridge.sendEncoded(event: bytes.kotlin)
    }

    /// OPEN THE VAULT PHOTO PICKER: the Photos picker machine, on no album.
    func openPhotoChoice() {
        photoChoice.opened(collectionId: "", collectionName: "", alreadyInAlbumAssetIds: [])
    }

    /// One tap in the vault photo picker.
    func photoChoiceSend(_ event: Data) {
        photoChoice.send(event: event.kotlin)
    }

    /// ASK THE CORE FOR THE TEXT DOCUMENTS THE CHAT CAN READ.
    func loadDocuments() {
        bridge.loadDocuments { [weak self] bytes in
            let listed = try? Centraid_Core_V1_AssistDocuments(serializedBytes: bytes.data)
            DispatchQueue.main.async {
                self?.documents = listed?.documents ?? []
                self?.documentsLoaded = true
            }
        }
    }
}
