import Combine
import Foundation
import SwiftUI

/// WHAT HOLDS THE CHAT TAB ON iOS (#1135): a forwarder, nothing more.
///
/// The chat is a Rust screen (`chat.home`, the root of the `chat` tab). Every
/// decision a member sees, the phases, the thread, the labels, the drawer, the
/// confirm cards, is in `ChatState`, and this class does three things only:
/// it hands the latest state to SwiftUI, it sends the member's gestures as
/// `ChatEvent`s to the chat's instance in the `ScreenStore`, and it reports the
/// model download the shell performs (`ModelDownload`) back to that instance.
///
/// Its own `ObservableObject`, not more `@Published` fields on `ShellModel`: a
/// streamed answer is a state per token, and every state republished through
/// the shell would re-evaluate Home for each of them. `ChatView` observes this
/// and nothing else does.
@MainActor
final class ChatModel: ObservableObject {
    /// The last finished `ChatState` Rust pushed for the chat's instance.
    @Published private(set) var state = Centraid_Core_V1_ChatState()

    /// What the tab last told Rust, so a repeat is not a second `opened`.
    private(set) var opened = false

    private weak var store: ScreenStore?
    private var subscription: AnyCancellable?

    init() {
        AttachmentFiles.sweep()
        let downloader = ChatModelDownloader.shared
        downloader.onProgress = { [weak self] vision, done, total in
            self?.send(.downloadProgress(.with {
                $0.doneBytes = UInt64(max(done, 0))
                $0.totalBytes = UInt64(max(total, 0))
                $0.vision = vision
            }))
        }
        downloader.onFinished = { [weak self] vision, ok in
            self?.send(.downloadFinished(.with {
                $0.ok = ok
                $0.vision = vision
            }))
        }
        // A transfer that finished while the app was away is delivered to the
        // session's delegate, which has to exist to hear it.
        downloader.reconnect()
    }

    /// ATTACH THE SCREEN STORE of the session that is in front. One per vault: a
    /// new store is a new Rust runtime, so the chat there starts over.
    func attach(store: ScreenStore) {
        self.store = store
        subscription = store.$views.sink { [weak self] views in
            guard let self, let instance = self.instance,
                case .chat(let state)? = views[instance]?.kind
            else { return }
            self.state = state
        }
        // The store may already hold the chat's first view.
        if let instance, case .chat(let state)? = store.views[instance]?.kind { self.state = state }
    }

    /// The chat tab's root instance, once Rust has opened it.
    private var instance: UInt64? {
        store?.entries(of: "chat").first?.instance
    }

    /// Send one gesture to the chat.
    func send(_ kind: Centraid_Core_V1_ChatEvent.OneOf_Kind) {
        guard let store, let instance else { return }
        var event = Centraid_Core_V1_ChatEvent()
        event.kind = kind
        store.send(instance, .chat(event))
    }

    /// THE FOREGROUND VAULT CHANGED. The thread, the session and the cards belong to the vault that
    /// was in front, and its runtime went with its store: the chat opens again on the one that is.
    func vaultChanged(to id: String) {
        opened = false
        state = Centraid_Core_V1_ChatState()
        AttachmentFiles.sweep()
    }

    // MARK: Intents

    /// THE TAB APPEARED, scoped to `app` or to everything (empty), under the foreground vault's name.
    /// `scopeChosen` is the composer's menu, which starts a new chat when the scope differs.
    func open(
        app: String,
        vaultName: String,
        scopeChosen: Bool = false,
        asking question: String? = nil,
        thread: String? = nil,
        title: String = ""
    ) {
        opened = true
        ChatModelStore.prepareDirectory()
        send(.opened(.with {
            $0.app = app
            $0.vaultName = vaultName
            $0.scopeChosen = scopeChosen
            $0.modelsDir = ChatModelStore.directory.path
        }))
        // A search's Ask: Rust waits for the chat to be ready, then asks once.
        if let question {
            send(.asked(.with {
                $0.scope = app
                $0.question = question
            }))
        }
        if let thread {
            send(.threadOpened(.with {
                $0.threadID = thread
                $0.title = title
            }))
        }
        // A model that was mid-download when the app was killed is still arriving: say so, so the
        // tab draws its progress and not the offer.
        ChatModelDownloader.shared.reportRunning()
    }

    func sendText(_ text: String) { send(.sent(.with { $0.text = text })) }
    func stop() { send(.stopped(.init())) }
    func regenerate() { send(.regenerated(.init())) }

    func newChat() {
        send(.newChat(.init()))
        AttachmentFiles.sweep()
    }

    // MARK: History and the drawer

    func toggleDrawer(_ open: Bool) { send(.drawer(.with { $0.opened = open })) }

    func openThread(_ id: String, title: String = "") {
        send(.threadOpened(.with {
            $0.threadID = id
            $0.title = title
        }))
        AttachmentFiles.sweep()
    }

    func openDrawerSearch() { send(.drawerSearchOpened(.init())) }
    func drawerSearch(_ term: String) { send(.drawerSearchTerm(.with { $0.term = term })) }
    func closeDrawerSearch() { send(.drawerSearchClosed(.init())) }

    func renameThread(_ id: String, title: String) {
        send(.threadRenamed(.with {
            $0.threadID = id
            $0.title = title
        }))
    }

    func deleteThread(_ id: String) {
        send(.threadDeleted(.with { $0.threadID = id }))
        AttachmentFiles.sweep()
    }

    func deleteAllThreads() {
        send(.allThreadsDeleted(.init()))
        AttachmentFiles.sweep()
    }

    /// A card was tapped: Rust asks whether its row is still there and opens the page (`OpenRoute`).
    func cardTapped(message: UInt64, index: Int) {
        send(.cardTapped(.with {
            $0.messageID = message
            $0.index = UInt32(index)
        }))
    }

    func copy(_ messageID: UInt64) { send(.copied(.with { $0.messageID = messageID })) }
    func downloadTapped() { send(.download(.with { $0.vision = false })) }

    // MARK: A proposed write

    func confirmPending(_ id: String) { send(.pendingConfirmed(.with { $0.pendingID = id })) }
    func cancelPending(_ id: String) { send(.pendingCancelled(.with { $0.pendingID = id })) }

    // MARK: Attachments

    func visionDownloadTapped() { send(.download(.with { $0.vision = true })) }
    func removeAttachment(_ id: UInt64) { send(.attachmentRemoved(.with { $0.id = id })) }
    func libraryPhotoTapped() { send(.libraryPhotoTapped(.init())) }
    func openDocuments() { send(.documentsOpened(.init())) }
    func closeDocuments() { send(.documentsClosed(.init())) }

    func attachDocument(docID: String, title: String) {
        send(.attached(.with {
            $0.vaultDocument = .with { $0.docID = docID }
            $0.label = title
        }))
    }
}
