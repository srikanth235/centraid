import SwiftUI

#if canImport(CentraidShared)
import CentraidShared
#endif

/// DOCS, REGISTERED (K5; #1046). Its one line is in `AppRegistry.apps`.
///
/// Five routes over four machines: the drive at its band (`docs.drive`), a
/// folder page pushed over it (a second `DocsDriveBridge` under
/// `docs.folder`, so the drive under it keeps its own tab, filters and
/// scroll), a document, the text editor and the trash. A route's parameter is
/// the screen's own `Opened` event, encoded; `open` sends it on every
/// appearance, so a pop back re-reads.
///
/// **INTENTS ARE THE SHELL'S** (`DocsBridges.kt`): `FolderPicked`,
/// `DocumentPicked`, `EditRequested`, `TrashOpened` push here; `AddRequested`
/// starts the ingest (`DocsIngestBridge`), whose picker and filed push are
/// the root's (`DocsIngestRoot`).
enum DocsScreens: AppScreens {
    static let appID = "docs"

    /// `DocsDriveMachine.SCREEN_ID`.
    static let drive = "docs.drive"
    /// The folder page: the drive's machine on its own bridge.
    static let folder = "docs.folder"
    /// `DocsDocumentMachine.SCREEN_ID`.
    static let document = "docs.document"
    /// `DocsEditorMachine.SCREEN_ID`.
    static let editor = "docs.editor"
    static let trash = "docs.trash"
    /// `DocsIngestMachine`: adding a document, observed at the app's root.
    static let ingest = "docs.ingest"

    #if canImport(CentraidShared)
    /// ONE INGEST FOR THE APP'S LIFE: the drive and the folder page start it,
    /// the root answers its picker and pushes what it files (`DocsIngestRoot`).
    static let ingestBridge = DocsIngestBridge()
    #endif

    static let driveRoute = ShellModel.Route.screen(
        drive,
        Centraid_Screen_V1_DocsDriveEvent.with { $0.opened = .with { $0.destination = .all } }.encoded
    )

    /// `parent` is the PUSHING page's own title: the folder page's back says it (#1047).
    static func folderRoute(_ folderID: String, _ name: String, parent: String = "") -> ShellModel.Route {
        .screen(folder, Centraid_Screen_V1_DocsDriveEvent.with {
            $0.opened = .with { $0.destination = .folders; $0.folderID = folderID; $0.folderName = name; $0.parent = parent }
        }.encoded)
    }

    static func documentRoute(_ documentID: String, _ title: String, parent: String = "") -> ShellModel.Route {
        .screen(document, Centraid_Screen_V1_DocsDocumentEvent.with {
            $0.opened = .with { $0.documentID = documentID; $0.title = title; $0.parent = parent }
        }.encoded)
    }

    static func editorRoute(_ documentID: String, _ title: String) -> ShellModel.Route {
        .screen(editor, Centraid_Screen_V1_DocsEditorEvent.with {
            $0.opened = .with { $0.documentID = documentID; $0.title = title }
        }.encoded)
    }

    /// The trash names its own title and back words (`TrashListState`).
    static let trashRoute = ShellModel.Route.screen(trash, Data())

    @MainActor
    static func register(into shell: ShellModel) {
        #if canImport(CentraidShared)
        shell.register(.of(drive, DocsDriveBridge()))
        shell.register(.of(folder, DocsDriveBridge()))
        shell.register(.of(document, DocsDocumentBridge()))
        shell.register(.of(editor, DocsEditorBridge()))
        shell.register(.of(trash, DocsTrashBridge()))
        shell.register(ScreenPort(
            id: ingest,
            send: { ingestBridge.send(event: $0.kotlin) },
            attach: { ingestBridge.attach(session: $0) },
            observe: { onState in ingestBridge.observe { onState($0.data) } }
        ))
        #endif
        /// The drive's capture rows start an ingest; its status line puts it away.
        func ingestPort(_ shell: ShellModel?) -> DocsIngestHooks {
            DocsIngestHooks(
                state: { [weak shell] in shell?.state(ingest) ?? Data() },
                request: { key, folderID, parent in
                    #if canImport(CentraidShared)
                    ingestBridge.requestFor(actionKey: key, folderId: folderID, parent: parent)
                    #endif
                },
                retry: {
                    #if canImport(CentraidShared)
                    ingestBridge.retry()
                    #endif
                },
                dismiss: {
                    #if canImport(CentraidShared)
                    ingestBridge.dismiss()
                    #endif
                }
            )
        }

        func push(_ shell: ShellModel?) -> (ShellModel.Route) -> Void {
            { [weak shell] route in shell?.path.append(route) }
        }
        func pop(_ shell: ShellModel?) -> () -> Void {
            { [weak shell] in
                guard let shell, !shell.path.isEmpty else { return }
                shell.path.removeLast()
            }
        }
        func sender(_ shell: ShellModel?, _ id: String) -> (Data) -> Void {
            { [weak shell] in shell?.send(screen: id, event: $0) }
        }

        // THE DRIVE RE-OPENS WHERE IT WAS LEFT: a pop back from a document
        // lands on Starred if Starred was where the member was.
        shell.route(
            drive,
            open: { [weak shell] parameter in
                guard let shell else { return }
                let held = (try? Centraid_Screen_V1_DocsDriveState(serializedBytes: shell.state(drive))) ?? .init()
                var event = (try? Centraid_Screen_V1_DocsDriveEvent(serializedBytes: parameter)) ?? .init()
                if held.destination != .unspecified { event.opened.destination = held.destination }
                shell.send(screen: drive, event: event.encoded)
            },
            view: { shell, _ in
                AnyView(DocsDriveView(
                    data: shell.state(drive),
                    screen: drive,
                    parentTitle: nil,
                    ingest: ingestPort(shell),
                    send: sender(shell, drive),
                    push: push(shell),
                    onBack: pop(shell),
                    onHome: { [weak shell] in shell?.path.removeAll() }
                ))
            }
        )
        shell.route(
            folder,
            open: { [weak shell] parameter in shell?.send(screen: folder, event: parameter) },
            view: { shell, _ in
                AnyView(DocsDriveView(
                    data: shell.state(folder),
                    screen: folder,
                    parentTitle: folderParent(shell),
                    ingest: ingestPort(shell),
                    send: sender(shell, folder),
                    push: push(shell),
                    onBack: pop(shell),
                    onHome: { [weak shell] in shell?.path.removeAll() }
                ))
            }
        )
        shell.route(
            document,
            open: { [weak shell] parameter in shell?.send(screen: document, event: parameter) },
            view: { shell, _ in
                AnyView(DocsDocumentView(
                    data: shell.state(document),
                    send: sender(shell, document),
                    push: push(shell),
                    onBack: pop(shell),
                    onDeparted: { [weak shell] in shell?.departed(document) }
                ))
            }
        )
        shell.route(
            editor,
            open: { [weak shell] parameter in shell?.send(screen: editor, event: parameter) },
            view: { shell, parameter in
                AnyView(DocsEditorView(
                    data: shell.state(editor),
                    opened: parameter,
                    send: sender(shell, editor),
                    onClose: pop(shell),
                    onDeparted: { [weak shell] in shell?.departed(editor) }
                ))
            }
        )
        shell.route(
            trash,
            open: { [weak shell] _ in
                shell?.send(screen: trash, event: TrashListView.event { $0.opened = .init() })
            },
            view: { shell, _ in
                AnyView(TrashListView(
                    data: shell.state(trash),
                    send: sender(shell, trash),
                    onBack: pop(shell)
                ))
            }
        )
    }

    /// A folder page's back words are the machine's (`chrome.back`, #1047).
    @MainActor
    static func folderParent(_ shell: ShellModel) -> String {
        let page = (try? Centraid_Screen_V1_DocsDriveState(serializedBytes: shell.state(folder))) ?? .init()
        return page.chrome.back
    }

    static func tileRoute(_ tile: Centraid_Screen_V1_HomeTile) -> ShellModel.Route? { driveRoute }

    /// THE FILED PUSH AND THE PICKER, at the root (`DocsIngestRoot`).
    @MainActor
    static func global(_ shell: ShellModel) -> AnyView? { AnyView(DocsIngestRoot(shell: shell)) }
}
